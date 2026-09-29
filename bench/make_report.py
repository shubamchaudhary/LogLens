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
         "`bash bench/run_all.sh`. Data: `evals/generate_corpus.py` (seeded; 20 lines/s Spring-style logs).", ""]

    ing = load("ingest.json")
    if ing:
        runs = [r for r in ing["runs"] if r["heap_xmx"] == "256m"]
        L += ["## Ingest throughput and heap (fixed -Xmx256m, part-concurrency 3)", "",
              "Timed from upload confirm until the session reaches ENRICHING (every part parsed + committed, "
              "finalizer done). Heap sampled every 250 ms with `jstat -gc` (S0U+S1U+EU+OU).", "",
              "| File | Bytes | Lines | Chunks | Ingest s | MB/s | Lines/s | Peak heap MB | Peak old gen MB | Peak RSS MB | "
              "GC pauses (count / max ms / total ms) | Status |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in runs:
            g = r["gc"]
            L.append(f"| {r['file']} | {r['bytes']:,} | {r['lines_ingested']:,} | {r['chunks']} | {r['ingest_s']} | "
                     f"{r['mb_per_s']} | {r['lines_per_s']:,} | {r['peak_heap_used_mb']} | {r['peak_old_gen_mb']} | "
                     f"{r['peak_rss_mb']} | {g.get('count')} / {g.get('max_ms')} / {g.get('total_ms')} | "
                     f"{r['final_status']} |")
        if runs:
            xs = ", ".join(f'"{r["file"].replace("bench_", "").replace(".log", "")}"' for r in runs)
            ys = ", ".join(str(r["peak_heap_used_mb"]) for r in runs)
            L += ["", "```mermaid", "xychart-beta", '  title "Peak heap vs input size at -Xmx256m"',
                  f"  x-axis [{xs}]", '  y-axis "Peak heap MB" 0 --> 256', f"  bar [{ys}]", "```", ""]

    par = load("parallelism.json")
    if par:
        L += ["## Parallelism (1 GB file, -Xmx1g, 8 partitions)", "",
              "| part-concurrency | Ingest s | MB/s | Lines/s | Peak heap MB |", "|---|---|---|---|---|"]
        for r in par["runs"]:
            L.append(f"| {r['part_concurrency']} | {r['ingest_s']} | {r['mb_per_s']} | {r['lines_per_s']:,} | "
                     f"{r['peak_heap_used_mb']} |")
        L.append("")

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

    rob = load("robustness.json")
    if rob:
        L += ["## Robustness (-Xmx256m)", "", "| Case | Bytes | Outcome | Error / notes | JVM alive |", "|---|---|---|---|---|"]
        for x in rob["results"]:
            if x["case"] == "poison_message":
                L.append(f"| poison message (not JSON) on log.ingest.parts | - | next upload: {x['next_upload_status']} | "
                         f"DLQ offsets {x['dlq_offsets_before']} -> {x['dlq_offsets_after']} | yes |")
            else:
                note = (x.get("error") or "; ".join(x.get("app_errors", [])[:1]) or "").replace("|", "/")[:160]
                L.append(f"| {x['case']} | {x['bytes']:,} | {x['status']} (chunks {x['chunks']}, lines {x['lines_stored']}) "
                         f"| {note} | {x['jvm_alive']} |")
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
