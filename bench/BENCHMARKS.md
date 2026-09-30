# LogLens benchmarks

All numbers come from the scripts in this folder, run against the **real backend jar**, local Kafka 3.8.0 (KRaft, 1 broker), Postgres 16.10 + pgvector 0.8.0 (shared_buffers 512 MB), MinIO, and `llm_stub.py` instead of Groq/Gemini (so the numbers describe LogLens, not a provider's rate limits, and cost $0).

**Hardware:** 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, one VM shared by app + Postgres + Kafka + MinIO. **JVM:** OpenJDK 21.0.10, SerialGC (as in the production Dockerfile).

Reproduce: `docker compose up -d`, `bench/fetch_model.sh`, `python bench/llm_stub.py --embed bge &`, then `bash bench/run_all.sh` (the ingest runs, then `run_rest.sh`; finished steps are skipped). Data: `evals/generate_corpus.py` (seeded; 20 lines/s Spring-style logs).

## Ingest throughput and heap (fixed -Xmx256m, part-concurrency 3)

Timed from upload confirm until the session reaches ENRICHING (every part parsed + committed, finalizer done). Heap sampled every 250 ms with `jstat -gc` (S0U+S1U+EU+OU). Embeddings off (`--loglens.embedding.enabled=false`), so this is the parse-and-store path. The jar was built at `c5ea7d9` (robust gate + exactly-once fixes, before the `73c1fbd` line caps); the `commit` field in `ingest.json` is the checkout at run time.

| File | Bytes | Lines | Chunks | Ingest s | MB/s | Lines/s | Live set after full GC, max / median MB | Peak heap used MB | Peak RSS MB | GC pauses (count / max ms / total ms) | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bench_100m.log | 100,000,022 | 783,064 | 653 | 61.21 | 1.63 | 12,792 | 76 / 69 | 186.0 | 554.2 | 316 / 189.5 / 2156.3 | ENRICHING |
| bench_500m.log | 500,000,058 | 3,891,710 | 3244 | 278.79 | 1.79 | 13,959 | 91 / 75 | 227.8 | 579.7 | 1388 / 203.8 / 8293.9 | ENRICHING |
| bench_1g.log | 1,000,000,111 | 7,776,324 | 6482 | 494.13 | 2.02 | 15,737 | 92 / 76 | 226.8 | 633.1 | 2762 / 202.6 / 16696.7 | ENRICHING |
| bench_2g.log | 2,000,000,095 | 15,502,276 | 12920 | 976.78 | 2.05 | 15,870 | 81 / 70 | 203.6 | 562.0 | 5904 / 196.3 / 33951.2 | ENRICHING |

*Live set* = heap still in use right after a full collection: what the process really holds. *Peak heap used* is occupancy just before a collection, so it mostly shows how far the JVM lets the heap fill under the 256 MB cap, not what is live.

```mermaid
xychart-beta
  title "Live set after full GC vs input size, Xmx 256 MB"
  x-axis ["100m", "500m", "1g", "2g"]
  y-axis "MB" 0 --> 256
  bar [76, 91, 92, 81]
```

## Parallelism (1 GB file, -Xmx1g, 8 partitions, 4 vCPUs)

| part-concurrency | Ingest s | MB/s | Speed-up | Lines/s | Live set after full GC, max / median MB | Peak heap used MB | Peak RSS MB |
|---|---|---|---|---|---|---|---|
| 1 | 1235.59 | 0.81 | 1.00x | 6,293 | 56 / 52 | 133.0 | 515.4 |
| 2 | 742.55 | 1.35 | 1.67x | 10,472 | 81 / 63 | 199.2 | 570.9 |
| 4 | 465.94 | 2.15 | 2.65x | 16,689 | 111 / 90 | 272.6 | 617.7 |
| 8 | 444.79 | 2.25 | 2.78x | 17,483 | 163 / 116 | 398.4 | 806.3 |

Throughput stops scaling at the number of vCPUs (regex parsing is CPU-bound and shares the box with Postgres and Kafka); the live set grows with part-concurrency, not with file size.

```mermaid
xychart-beta
  title "Ingest throughput vs part-concurrency, 1 GB"
  x-axis ["1 consumers", "2 consumers", "4 consumers", "8 consumers"]
  y-axis "MB/s" 0 --> 3
  bar [0.81, 1.35, 2.15, 2.25]
```

## Exactly-once effects under fault injection (`chaos.py`)

Each scenario ingests the 6 h medium-noise archive (5.7 MB, small 256 KB parts so there are ~22 parts to crash between) and compares with a clean baseline run on the same jar.

| Jar | Scenario | Chunks | Line sum | Dup line starts | Metric sum | Finding occurrences | Enriched/total | Status | Redelivery skips logged |
|---|---|---|---|---|---|---|---|---|---|
| before fixes (`85ae40a`) | baseline | 360 | 43703 | 0 | 134485 | 621 | 191/191 | DONE | 0 |
| before fixes (`85ae40a`) | crash_after_part_commit | 360 | 43703 | 0 | 134485 | 621 | 191/191 | DONE | 4 |
| before fixes (`85ae40a`) | rebalance | 360 | 43703 | 0 | 134485 | 621 | 191/191 | DONE | 0 |
| before fixes (`85ae40a`) | replay_ingest | 360 | 43703 | 0 | 134485 | 621 | 191/191 | DONE | 0 |
| before fixes (`85ae40a`) | crash_after_enrich_commit | 360 | 43703 | 0 | 134485 | 657 | 191/191 | DONE | 0 |
| before fixes (`85ae40a`) | replay_enrich | 360 | 43703 | 0 | 134485 | 621 | 191/191 | DONE | 0 |
| after fixes | baseline | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 0 |
| after fixes | crash_after_part_commit | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 11 |
| after fixes | crash_after_enrich_commit | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 0 |
| after fixes | replay_ingest_before_part_fix | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 0 |
| after fixes | replay_ingest | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 266 |
| after fixes | replay_enrich | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 1970 |
| after fixes | rebalance | 360 | 43703 | 0 | 139485 | 315 | 113/113 | DONE | 1 |

Notes: before/after baselines differ in metric sum and occurrences because the anomaly gate changed (robust mode flags 77 windows instead of 155). What matters is each scenario vs its own baseline.
`replay_ingest_before_part_fix`: data unchanged, but the replay later flipped 4 DONE sessions to FAILED (fixed in `c5ea7d9`, see `ExactlyOnceIT.replayAfterTheStagedBlobIsDeletedIsASilentNoOp`).

## Robustness: bad inputs (-Xmx256m)

Before = jar built at `c5ea7d9`; after = current code (`73c1fbd` line caps, NUL handling, gzip check, chunk caps + the NUL-safe failure marker). A good outcome is a clear final state: parsed (ENRICHING/CORRELATING/DONE) or FAILED with a reason, never stuck.

| Case | Bytes | Before | After |
|---|---|---|---|
| malformed_lines.log | 47,574 | **CORRELATING** in 1.2 s, chunks 10, lines 686 | **CORRELATING** in 0.6 s, chunks 10, lines 686 |
| non_utf8.log | 34,209 | **CORRELATING** in 0.6 s, chunks 10, lines 601 | **DONE** in 0.6 s, chunks 10, lines 601 |
| nul_bytes.log | 34,206 | **PARSING** in 300.4 s, chunks 0, lines 0: org.springframework.kafka.KafkaException: Seek to current after exception | **DONE** in 0.6 s, chunks 10, lines 601 |
| empty.log | 0 | **DONE** in 0.6 s, chunks 0, lines 0 | **DONE** in 0.6 s, chunks 0, lines 0 |
| archive.log.gz | 2,649 | **PARSING** in 300.2 s, chunks 0, lines 0: org.springframework.kafka.KafkaException: Seek to current after exception | **FAILED** in 0.6 s, chunks 0, lines 0: Ingest failed: Compressed archive (gzip/zip) is not supported: upload the plain-text log |
| huge_single_line.log | 104,857,634 | **CHUNKING** in 301.5 s, chunks 0, lines 0: java.lang.OutOfMemoryError: Java heap space | **DONE** in 7.7 s, chunks 1, lines 1 |
| busy_minute.log | 14,148,619 | **CREATED** in 300.8 s, chunks 0, lines 0 | **DONE** in 17.5 s, chunks 60, lines 120000 |
| poison_message | - | DLQ offsets log.ingest.dlq:0:304 -> log.ingest.dlq:0:305; next upload CREATED | DLQ offsets log.ingest.dlq:0:305 -> log.ingest.dlq:0:306; next upload DONE |

## Other measured numbers

| Metric | Value | How |
|---|---|---|
| Upload → DONE, owner 10k-line log | 21.2 s | `client.py` smoke run, stub LLM, bge embeddings |
| Upload → parsed (ENRICHING), same | 2.1 s | same |
| Hybrid retrieval p50 / p95 | 36.0 / 45.0 ms | `evals/run_retrieval.py`, stored tsvector |
| Lexical leg p50, expression vs stored tsvector | 1,374 → 19.3 ms | same |
| Consumer recovery after kill -9 | ~30 s | time until 'already processed' logs after restart (session timeout) |
