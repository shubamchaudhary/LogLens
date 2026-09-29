#!/usr/bin/env python3
"""Offline experiment: what should a 60 s window's embedding be computed from?

Production embeds the first 8,000 chars of the window (the model truncates
further). A busy minute's evidence is often past that point. Alternative:
embed a DIGEST: the window's distinct line templates (numbers, ids and
key=values removed), WARN/ERROR/exception templates first, then the rest, in
first-seen order.

The script copies an ingested session's chunk table under a new session id,
recomputes every embedding with the chosen text, and prints the command to run
evals/run_retrieval.py against the copy. Same chunks, same line ranges, same
golden set: only the embedding input changes.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import uuid

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "rag-orchestrator"))
os.environ.setdefault("DATABASE_URL", "postgresql://loglens:loglens123@localhost:5434/loglens_db")
from embedder import LocalEmbedder  # noqa: E402

from app import db  # noqa: E402

TS = re.compile(r"^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s*")
KV = re.compile(r"(\w+)=(\"[^\"]*\"|\S+)")
NUM = re.compile(r"\d+")
NOTABLE = re.compile(r"\b(WARN|WARNING|ERROR|FATAL|SEVERE)\b|Exception|Error\b")


def template(line: str) -> str:
    s = TS.sub("", line)
    s = KV.sub(r"\1=*", s)
    return re.sub(r"\s+", " ", NUM.sub("#", s)).strip()


def digest(content: str, max_chars: int = 2000) -> str:
    seen, notable, rest = set(), [], []
    for ln in content.split("\n"):
        t = template(ln)
        if not t or t in seen:
            continue
        seen.add(t)
        (notable if NOTABLE.search(ln) else rest).append(t)
    out, used = [], 0
    for t in notable + rest:
        if used + len(t) + 1 > max_chars:
            break
        out.append(t)
        used += len(t) + 1
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--mode", choices=["digest", "prefix"], default="digest")
    args = ap.parse_args()
    src = db.chunk_table(args.session)
    new_sid = str(uuid.uuid4())
    dst = db.chunk_table(new_sid)
    emb = LocalEmbedder()
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(f"CREATE TABLE {dst} (LIKE {src} INCLUDING ALL)")
        cols = "chunk_id, document_id, time_bucket, line_start, line_end, content, embedding, is_anomalous, created_at"
        cur.execute(f"INSERT INTO {dst} ({cols}) SELECT {cols} FROM {src}")
        cur.execute(f"SELECT chunk_id, content FROM {dst}")
        rows = cur.fetchall()
        texts = [digest(r["content"]) if args.mode == "digest" else r["content"][:8000] for r in rows]
        vecs = emb.embed(texts)
        for r, v in zip(rows, vecs):
            cur.execute(f"UPDATE {dst} SET embedding = %s::vector WHERE chunk_id = %s",
                        ("[" + ",".join(map(str, list(v) + [0.0] * (768 - len(v)))) + "]", r["chunk_id"]))
    print(f"copy session {new_sid} ({args.mode}); avg embed input {sum(map(len, texts)) / len(texts):.0f} chars")
    print(f"python evals/run_retrieval.py --session {new_sid} --label embed_{args.mode}")


if __name__ == "__main__":
    main()
