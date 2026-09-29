#!/usr/bin/env python3
"""Retrieval eval + ablation over the golden Q&A set (no chat LLM, $0).

Runs the orchestrator's REAL retrieval code (rag-orchestrator/app/db.py) against
a session holding the fixed eval archive, and scores each retriever against the
gold supporting lines:

  vector_only   pgvector cosine kNN on the question embedding
  fts_only      retrieve_chunks() with no embedding (FTS + OR fallback), as in prod
                when question embedding fails
  hybrid_rrf    retrieve_chunks() with embedding: vector + FTS fused by RRF (k=60)

Metrics (gold chunk = a chunk whose line range contains a gold line):
  recall@5/10/30, MRR, nDCG@10, and EVIDENCE VISIBILITY: the share of gold lines
  whose text is inside what the LLM is actually shown (generate_user shows the
  first 800 chars of each retrieved chunk; grade_user shows 500).
Also records per-retriever latency (the hybrid fusion cost).

Embeddings: local bge-small-en-v1.5 (stand-in for gemini-embedding-001). The
session's chunk vectors must come from the same model: run the backend with
bench/llm_stub.py --embed bge.

Usage:
  python evals/run_retrieval.py                 # ingests the archive via the API, then evaluates
  python evals/run_retrieval.py --session <id>  # reuse an ingested session
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import statistics
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, "bench"))
sys.path.insert(0, os.path.join(ROOT, "rag-orchestrator"))
os.environ.setdefault("DATABASE_URL", "postgresql://loglens:loglens123@localhost:5434/loglens_db")
from common import git_sha, write_report  # noqa: E402
from embedder import MODEL_NAME, LocalEmbedder  # noqa: E402

from app import db, prompts  # noqa: E402

QA = os.path.join(ROOT, "evals", "datasets", "golden_qa.json")
ARCHIVE = os.path.join(ROOT, "evals", "datasets", "synthetic", "eval_mediumnoise.log")
GEN_CHARS, GRADE_CHARS = 800, 500  # prompts.generate_user / grade_user slices


def ensure_session(session: str | None) -> str:
    if session:
        return session
    from client import Client, watch
    c = Client()
    sid = c.create_session("retrieval-eval")
    c.upload(sid, ARCHIVE)
    tl = watch(sid, timeout_s=3600)
    if tl["final"]["status"] != "DONE":
        raise SystemExit(f"ingest did not finish: {tl}")
    return sid


def vector_only(sid, vec, k):
    table = db.chunk_table(sid)
    v = "[" + ",".join(map(str, vec)) + "]"
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT chunk_id, line_start, line_end, content FROM {table} WHERE embedding IS NOT NULL "
                    f"ORDER BY embedding <=> %s::vector LIMIT %s", (v, k))
        return cur.fetchall()


def metrics_for(ranked, gold_chunks, gold_lines, lines_text, question):
    ids = [str(r["chunk_id"]) for r in ranked]
    out = {}
    for k in (5, 10, 30):
        out[f"recall@{k}"] = len(set(ids[:k]) & gold_chunks) / len(gold_chunks) if gold_chunks else None
    rr = 0.0
    for i, cid in enumerate(ids):
        if cid in gold_chunks:
            rr = 1 / (i + 1)
            break
    out["mrr"] = rr
    dcg = sum(1 / math.log2(i + 2) for i, cid in enumerate(ids[:10]) if cid in gold_chunks)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(10, len(gold_chunks))))
    out["ndcg@10"] = dcg / idcg if idcg else None
    # evidence visibility: gold line text inside the slice the LLM sees
    # exactly the text the production prompt builders put in front of the model
    shown_gen = prompts.generate_user(question, ranked[:30])
    shown_grade = prompts.grade_user(question, ranked[:30])
    full = " \n".join((r.get("content") or "") for r in ranked[:30])
    gl = [lines_text[n - 1] for n in gold_lines]
    out["gold_lines_in_retrieved_chunks"] = sum(1 for t in gl if t in full) / len(gl) if gl else None
    out["gold_lines_visible_to_generator"] = sum(1 for t in gl if t in shown_gen) / len(gl) if gl else None
    out["gold_lines_visible_to_grader"] = sum(1 for t in gl if t in shown_grade) / len(gl) if gl else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--out", default=os.path.join(ROOT, "evals", "results", "retrieval"))
    ap.add_argument("--label", default="baseline")
    args = ap.parse_args()
    sid = ensure_session(args.session)
    qa = json.load(open(QA))
    lines_text = open(ARCHIVE, encoding="utf-8").read().split("\n")
    table = db.chunk_table(sid)
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT chunk_id, line_start, line_end, length(content) AS n FROM {table}")
        chunks = cur.fetchall()
        cur.execute(f"SELECT count(*) AS n FROM {table} WHERE embedding IS NOT NULL")
        embedded = cur.fetchone()["n"]
    emb = LocalEmbedder()
    per_q, lat = [], {"vector_only": [], "fts_only": [], "hybrid_rrf": []}
    for item in qa["items"]:
        if item["type"] == "unanswerable":
            continue
        gold_lines = item["gold_lines"]
        gold_chunks = {str(c["chunk_id"]) for c in chunks
                       if any(c["line_start"] <= n <= c["line_end"] for n in gold_lines)}
        qv = emb.embed_query(item["question"]).tolist() + [0.0] * (768 - 384)
        row = {"id": item["id"], "type": item["type"], "gold_chunks": len(gold_chunks)}
        for name, fn in [("vector_only", lambda: vector_only(sid, qv, args.limit)),
                         ("fts_only", lambda: db.retrieve_chunks(sid, None, item["question"], args.limit)),
                         ("hybrid_rrf", lambda: db.retrieve_chunks(sid, qv, item["question"], args.limit))]:
            t0 = time.perf_counter()
            ranked = fn()
            lat[name].append((time.perf_counter() - t0) * 1000)
            row[name] = metrics_for(ranked, gold_chunks, gold_lines, lines_text, item["question"])
        per_q.append(row)

    def agg(name, key, rows=per_q):
        vals = [r[name][key] for r in rows if r[name][key] is not None]
        return round(statistics.mean(vals), 3) if vals else None

    keys = ["recall@5", "recall@10", "recall@30", "mrr", "ndcg@10", "gold_lines_in_retrieved_chunks",
            "gold_lines_visible_to_generator", "gold_lines_visible_to_grader"]
    summary = {n: {k: agg(n, k) for k in keys} for n in lat}
    for n in lat:
        s = sorted(lat[n])
        summary[n]["p50_ms"] = round(statistics.median(s), 2)
        summary[n]["p95_ms"] = round(s[int(0.95 * len(s)) - 1], 2)
    by_type = {}
    for t in sorted({r["type"] for r in per_q}):
        rows = [r for r in per_q if r["type"] == t]
        by_type[t] = {n: {"recall@10": agg(n, "recall@10", rows), "mrr": agg(n, "mrr", rows)} for n in lat}
        by_type[t]["n"] = len(rows)
    avg_chunk = statistics.mean(c["n"] for c in chunks)
    meta = {"eval": "retrieval", "label": args.label, "date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "commit": git_sha(), "session": sid, "embed_model": MODEL_NAME + " (stand-in for gemini-embedding-001)",
            "questions": len(per_q), "chunks": len(chunks), "embedded_chunks": embedded,
            "avg_chunk_chars": round(avg_chunk), "retrieve_limit": args.limit, "rrf_k": db._RRF_K,
            "llm_calls_made": 0, "cost_usd": 0.0, "golden_set_sha256": qa["archive_sha256"],
            "prompt_version": getattr(prompts, "PROMPT_VERSION", "unversioned")}
    res = {"summary": summary, "by_type": by_type, "per_question": per_q}
    write_report(os.path.join(args.out, args.label), meta, res, render(meta, summary, by_type))


def render(meta, s, by_type):
    L = [f"# Retrieval eval ({meta['label']})", "",
         f"- Date {meta['date']} | commit `{meta['commit']}` | {meta['questions']} answerable questions | "
         f"{meta['chunks']} chunks (avg {meta['avg_chunk_chars']} chars) | limit {meta['retrieve_limit']} | RRF k={meta['rrf_k']}",
         f"- Embeddings: {meta['embed_model']} | prompt version {meta['prompt_version']} | LLM calls: 0 | cost $0",
         "- 'Visible to generator/grader' = share of gold lines present in the exact prompt text built by "
         "prompts.generate_user / grade_user for the top 30 chunks.", "",
         "| Retriever | Recall@5 | Recall@10 | Recall@30 | MRR | nDCG@10 | Gold lines in retrieved chunks | "
         "Visible to generator | Visible to grader | p50 ms | p95 ms |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    for n, m in s.items():
        L.append(f"| {n} | {m['recall@5']} | {m['recall@10']} | {m['recall@30']} | {m['mrr']} | {m['ndcg@10']} | "
                 f"{m['gold_lines_in_retrieved_chunks']} | {m['gold_lines_visible_to_generator']} | "
                 f"{m['gold_lines_visible_to_grader']} | {m['p50_ms']} | {m['p95_ms']} |")
    L += ["", "## Recall@10 by question type", "", "| Type | n | vector | fts | hybrid |", "|---|---|---|---|---|"]
    for t, v in by_type.items():
        L.append(f"| {t} | {v['n']} | {v['vector_only']['recall@10']} | {v['fts_only']['recall@10']} | "
                 f"{v['hybrid_rrf']['recall@10']} |")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
