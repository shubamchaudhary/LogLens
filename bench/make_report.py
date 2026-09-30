#!/usr/bin/env python3
"""Render bench/BENCHMARKS.md from the JSON results in bench/results/."""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "results")


def load(name):
    p = os.path.join(R, name)
    return json.load(open(p)) if os.path.exists(p) else None


def full_gc_live_set(run) -> tuple[int | None, int | None]:
    """Max and median heap AFTER full GCs (the live set) from the run's unified GC log."""
    import re
    import statistics
    name = f"ingest-{run['file']}-{run['heap_xmx']}-c{run['part_concurrency']}"
    path = os.path.join(HERE, ".work", f"chaos-{name}.gc.log")
    if not os.path.exists(path):  # committed extract: only the full-GC lines
        path = os.path.join(R, "gc", f"{name}.full-gc.txt")
    if not os.path.exists(path):
        return None, None
    after = [int(m.group(1)) for m in re.finditer(r"Pause Full \((?!Metadata)[^)]*\) \d+M->(\d+)M", open(path).read())]
    return (max(after), int(statistics.median(after))) if after else (None, None)


def chaos_rows(doc, label):
    out = []
    for r in (doc or {}).get("runs", []):
        x = r["result"]
        out.append(f"| {label} | {r['scenario']} | {x['chunks']} | {x['line_sum']} | {x['duplicate_line_starts']} | "
                   f"{x['metric_count_sum']} | {x['finding_occurrences']} | {x['enriched_windows']}/{x['total_windows']} | "
                   f"{x['status']} | {r.get('redelivery_skip_logs', r.get('skip_logs', ''))} |")
    return out


def main():
    L = ["# LogLens benchmarks", "",
         "All numbers come from the scripts in this folder, run against the **real backend jar**, local Kafka 3.8.0 "
         "(KRaft, 1 broker), Postgres 16.10 + pgvector 0.8.0 (shared_buffers 512 MB), MinIO, and `llm_stub.py` "
         "instead of Groq/Gemini (so the numbers describe LogLens, not a provider's rate limits, and cost $0).",
         "",
         "**Hardware:** 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, one VM shared by app + Postgres + Kafka + MinIO. "
         "**JVM:** OpenJDK 21.0.10, SerialGC (as in the production Dockerfile).",
         "", "Reproduce: `docker compose up -d`, `bench/fetch_model.sh`, `python bench/llm_stub.py --embed bge &`, then "
         "`bash bench/run_all.sh` (the ingest runs, then `run_rest.sh`; finished steps are skipped). Data: `evals/generate_corpus.py` (seeded; 20 lines/s Spring-style logs).", ""]

    ing = load("ingest.json")
    if ing:
        runs = [r for r in ing["runs"] if r["heap_xmx"] == "256m"]
        L += ["## Ingest throughput and heap (fixed -Xmx256m, part-concurrency 3)", "",
              "Timed from upload confirm until the session reaches ENRICHING (every part parsed + committed, "
              "finalizer done). Heap sampled every 250 ms with `jstat -gc` (S0U+S1U+EU+OU). Embeddings off "
              "(`--loglens.embedding.enabled=false`), so this is the parse-and-store path. The jar was built at "
              "`c5ea7d9` (robust gate + exactly-once fixes, before the `73c1fbd` line caps); the `commit` field in "
              "`ingest.json` is the checkout at run time.", "",
              "| File | Bytes | Lines | Chunks | Ingest s | MB/s | Lines/s | Live set after full GC, max / median MB | "
              "Peak heap used MB | Peak RSS MB | GC pauses (count / max ms / total ms) | Status |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in runs:
            g = r["gc"]
            live_max, live_med = full_gc_live_set(r)
            r["live_max"], r["live_med"] = live_max, live_med
            L.append(f"| {r['file']} | {r['bytes']:,} | {r['lines_ingested']:,} | {r['chunks']} | {r['ingest_s']} | "
                     f"{r['mb_per_s']} | {r['lines_per_s']:,} | {live_max} / {live_med} | {r['peak_heap_used_mb']} | "
                     f"{r['peak_rss_mb']} | {g.get('count')} / {g.get('max_ms')} / {g.get('total_ms')} | "
                     f"{r['final_status']} |")
        L += ["", "*Live set* = heap still in use right after a full collection: what the process really holds. "
                  "*Peak heap used* is occupancy just before a collection, so it mostly shows how far the JVM lets the "
                  "heap fill under the 256 MB cap, not what is live.", ""]
        if runs:
            xs = ", ".join(f'"{r["file"].replace("bench_", "").replace(".log", "")}"' for r in runs)
            ys = ", ".join(str(r["live_max"] or 0) for r in runs)
            L += ["```mermaid", "xychart-beta", '  title "Live set after full GC vs input size, Xmx 256 MB"',
                  f"  x-axis [{xs}]", '  y-axis "MB" 0 --> 256', f"  bar [{ys}]", "```", ""]

    par = load("parallelism.json")
    if par:
        runs = sorted(par["runs"], key=lambda r: r["part_concurrency"])
        base = runs[0]["mb_per_s"]
        L += ["## Parallelism (1 GB file, -Xmx1g, 8 partitions, 4 vCPUs)", "",
              "| part-concurrency | Ingest s | MB/s | Speed-up | Lines/s | Live set after full GC, max / median MB | "
              "Peak heap used MB | Peak RSS MB |", "|---|---|---|---|---|---|---|---|"]
        for r in runs:
            live_max, live_med = full_gc_live_set(r)
            L.append(f"| {r['part_concurrency']} | {r['ingest_s']} | {r['mb_per_s']} | {r['mb_per_s'] / base:.2f}x | "
                     f"{r['lines_per_s']:,} | {live_max} / {live_med} | {r['peak_heap_used_mb']} | {r['peak_rss_mb']} |")
        L += ["", "Throughput stops scaling at the number of vCPUs (regex parsing is CPU-bound and shares the box "
                  "with Postgres and Kafka); the live set grows with part-concurrency, not with file size.", "",
              "```mermaid", "xychart-beta", '  title "Ingest MB/s vs consumer threads, 1 GB"',
              f"  x-axis [{', '.join(chr(34) + str(r['part_concurrency']) + chr(34) for r in runs)}]", '  y-axis "MB/s" 0 --> 3',
              f"  bar [{', '.join(str(r['mb_per_s']) for r in runs)}]", "```", ""]

    vec = load("vector_isolation.json")
    if vec:
        L += ["## Vector isolation: shared table + filter vs per-session tables", "",
              f"{vec['vectors']:,} vectors, {vec['dim']}-d ({vec['embed_model']}), HNSW m=16 ef_construction=64, "
              f"pgvector {vec['pgvector']}. Recall@10 against exact search over the session's own rows; 50 queries "
              "per session (held-out lines of that session).", "",
              "| Session (share of table) | Layout | ef_search | Recall@10 | Avg rows returned | p50 ms | p95 ms |",
              "|---|---|---|---|---|---|---|"]
        for x in vec["results"]:
            L.append(f"| {x['session']} ({x['session_share']:.2%}) | {x['layout']} | {x['ef_search']} | "
                     f"{x['recall_at_10']} | {x['avg_rows_returned']} | {x['p50_ms']} | {x['p95_ms']} |")
        b = vec["build"]
        L += ["", f"Index build: shared HNSW {b['shared_hnsw']['build_s']} s "
                  f"({b['shared_hnsw']['index_bytes'] / 1e6:.0f} MB); partitioned {b['partitioned']['build_s']} s; "
                  f"per-session tables (3) {b['per_session_table']['build_s_total']} s.", ""]

    L += ["## Exactly-once effects under fault injection (`chaos.py`)", "",
          "Each scenario ingests the 6 h medium-noise archive (5.7 MB, small 256 KB parts so there are ~22 parts to "
          "crash between) and compares with a clean baseline run on the same jar.", "",
          "| Jar | Scenario | Chunks | Line sum | Dup line starts | Metric sum | Finding occurrences | Enriched/total | "
          "Status | Redelivery skips logged |", "|---|---|---|---|---|---|---|---|---|---|"]
    L += chaos_rows(load("chaos_before.json"), "before fixes (`85ae40a`)")
    L += chaos_rows(load("chaos_after.json"), "after fixes")
    L += chaos_rows(load("chaos_before_replay.json"), "before fixes, replay")
    L += ["", "Notes: before/after baselines differ in metric sum and occurrences because the anomaly gate changed "
              "(robust mode flags 77 windows instead of 155). What matters is each scenario vs its own baseline.",
          "`replay_ingest_before_part_fix`: data unchanged, but the replay later flipped 4 DONE sessions to FAILED "
          "(fixed in `c5ea7d9`, see `ExactlyOnceIT.replayAfterTheStagedBlobIsDeletedIsASilentNoOp`).", ""]

    def rob_cell(x):
        if x is None:
            return "-"
        if x["case"] == "poison_message":
            return (f"DLQ offsets {x['dlq_offsets_before']} -> {x['dlq_offsets_after']}; "
                    f"next upload {x['next_upload_status']}")
        note = (x.get("error") or "; ".join(x.get("app_errors", [])[:1]) or "").replace("|", "/")[:140]
        return (f"**{x['status']}** in {x['seconds']} s, chunks {x['chunks']}, lines {x['lines_stored']}"
                f"{', JVM died' if not x['jvm_alive'] else ''}{': ' + note if note else ''}")

    before, after = load("robustness_before.json"), load("robustness_after.json")
    if before or after:
        idx = lambda d: {x["case"]: x for x in (d or {}).get("results", [])}
        b, a = idx(before), idx(after)
        L += ["## Robustness: bad inputs (-Xmx256m)", "",
              "Before = jar built at `c5ea7d9`; after = current code (`73c1fbd` line caps, NUL handling, gzip "
              "check, chunk caps + the NUL-safe failure marker). A good outcome is a clear final state: parsed "
              "(ENRICHING/CORRELATING/DONE) or FAILED with a reason, never stuck.", "",
              "| Case | Bytes | Before | After |", "|---|---|---|---|"]
        for case in list(dict.fromkeys(list(b) + list(a))):
            size = (b.get(case) or a.get(case)).get("bytes")
            L.append(f"| {case} | {f'{size:,}' if size is not None else '-'} | {rob_cell(b.get(case))} | "
                     f"{rob_cell(a.get(case))} |")
        L.append("")

    L += ["## Other measured numbers", "",
          "| Metric | Value | How |", "|---|---|---|",
          "| Upload → DONE, owner 10k-line log | 21.2 s | `client.py` smoke run, stub LLM, bge embeddings |",
          "| Upload → parsed (ENRICHING), same | 2.1 s | same |",
          "| Hybrid retrieval p50 / p95 | 36.0 / 45.0 ms | `evals/run_retrieval.py`, stored tsvector |",
          "| Lexical leg p50, expression vs stored tsvector | 1,374 → 19.3 ms | same |",
          "| Consumer recovery after kill -9 | ~30 s | time until 'already processed' logs after restart (session timeout) |",
          ""]
    open(os.path.join(HERE, "BENCHMARKS.md"), "w").write("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
