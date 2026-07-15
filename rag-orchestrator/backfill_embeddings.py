"""One-off backfill: embed chunks whose `embedding` is NULL for a session.

Runs inside the orchestrator container (has psycopg, the 6-key Gemini pool, and
the round-robin/fail-fast embed_query). Cosine ops are scale-invariant so the
L2-normalised backfill vectors mix safely with any vectors stored at ingest.

Usage: python backfill_embeddings.py <session_id>
"""
from __future__ import annotations

import sys
import time

import psycopg
from psycopg.rows import dict_row

from app import config, db, llm


def main(session_id: str) -> int:
    table = db.chunk_table(session_id)  # validates the UUID
    with psycopg.connect(config.DATABASE_URL, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT chunk_id, content FROM {table} WHERE embedding IS NULL")
            rows = cur.fetchall()
        total = len(rows)
        print(f"[backfill] {total} unembedded chunk(s) in {table}", flush=True)
        done = 0
        failed = 0
        for i, row in enumerate(rows, 1):
            try:
                vec = llm.embed_query(row["content"])  # already L2-normalised
                with conn.cursor() as cur:
                    cur.execute(
                        f"UPDATE {table} SET embedding = %s::vector WHERE chunk_id = %s",
                        (_to_vec(vec), row["chunk_id"]),
                    )
                conn.commit()
                done += 1
            except llm.ProviderRateLimited as exc:
                failed += 1
                print(f"[backfill] chunk {i}/{total} rate-limited (all keys): {exc}", flush=True)
                time.sleep(2)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"[backfill] chunk {i}/{total} FAILED: {exc}", flush=True)
            if i % 10 == 0 or i == total:
                print(f"[backfill] progress {i}/{total} (ok={done}, failed={failed})", flush=True)
    print(f"[backfill] DONE ok={done} failed={failed} of {total}", flush=True)
    return 0 if failed == 0 else 1


def _to_vec(vec: list[float]) -> str:
    return "[" + ",".join(repr(x) for x in vec) + "]"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python backfill_embeddings.py <session_id>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
