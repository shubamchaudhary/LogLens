#!/usr/bin/env python3
"""pgvector isolation benchmark: is a table per session worth it?

Question: LogLens gives every session its own chunk table + HNSW index. The
simpler design is ONE shared table with a session_id column. With an HNSW index
on the shared table, `WHERE session_id = $1 ORDER BY embedding <=> $q LIMIT 10`
walks the graph first and filters after ("post-filtering"), so a small session
can come back with fewer than 10 rows or the wrong ones.

This script builds the same vectors into every layout and measures, per layout
and per ef_search: recall@10 against exact search over that session's rows,
rows returned, p50/p95 latency, index build time and size.

Layouts
  shared_hnsw          one table, one HNSW, filter by session_id (default planner: it
                       may pick the B-tree + exact sort for small sessions)
  shared_hnsw_forced   same, but only the HNSW walk + post-filter is possible
  shared_iterative     same + pgvector 0.8 hnsw.iterative_scan = relaxed_order
  shared_btree_exact   one table, B-tree on session_id, exact distance sort
  partial_hnsw         a copy of the table with one partial HNSW index per queried session
  partitioned          PARTITION BY LIST (session_id), HNSW per partition
  per_session_table    LogLens's layout: its own table + HNSW per session

Vectors: bge-small-en-v1.5 (384-d) embeddings of synthetic app-log lines. All
sessions come from the same generator with different seeds, so tenants look
alike, which is the realistic worst case for post-filtering.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import statistics
import sys
import time

import numpy as np
import psycopg
from pgvector.psycopg import register_vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "evals"))
from common import git_sha  # noqa: E402

# local docker-compose default (same as .env.example); override with DATABASE_URL
DB = os.environ.get("DATABASE_URL", "postgresql://loglens:loglens123@localhost:5434/loglens_db")
CACHE = os.path.join(HERE, ".work", "vectors")


def build_corpus(n_small: int, small_rows: int, big_rows: int, queries_per_session: int):
    """Lines from many seeded 'tenants'; cache embeddings as .npy."""
    os.makedirs(CACHE, exist_ok=True)
    key = f"{n_small}x{small_rows}_{big_rows}_{queries_per_session}"
    vec_f, meta_f = os.path.join(CACHE, f"vec_{key}.npy"), os.path.join(CACHE, f"meta_{key}.json")
    if os.path.exists(vec_f):
        return np.load(vec_f), json.load(open(meta_f))
    from embedder import LocalEmbedder
    import subprocess
    gen = os.path.join(ROOT, "evals", "generate_corpus.py")
    tmp = os.path.join(HERE, ".work", "vec_src")
    os.makedirs(tmp, exist_ok=True)
    sessions = [("big", big_rows)] + [(f"s{i:03d}", small_rows) for i in range(n_small)]
    texts, session_of, is_query = [], [], []
    for idx, (name, rows) in enumerate(sessions):
        need = rows + queries_per_session
        path = os.path.join(tmp, f"{name}.log")
        if not os.path.exists(path):
            hours = max(0.2, need / 2 / 3600 * 1.3)
            subprocess.run([sys.executable, gen, "--name", name, "--out-dir", tmp, "--hours", str(hours), "--rate", "2",
                            "--seed", str(1000 + idx), "--noise", "medium", "--incidents", "12", "--no-labels"],
                           check=True, stdout=subprocess.DEVNULL)
        lines = [ln.split(" - ", 1)[-1] if " - " in ln else ln for ln in open(path).read().splitlines()[4:need + 4]]
        # strip the unique-per-line trace ids so near-duplicate lines embed near each other
        for j, ln in enumerate(lines):
            texts.append(f"[{name}] " + ln if False else ln)
            session_of.append(name)
            is_query.append(j >= rows)
    emb = LocalEmbedder()
    t0 = time.time()
    vecs = emb.embed(texts, batch=64).astype(np.float32)
    meta = {"session_of": session_of, "is_query": is_query, "embed_seconds": round(time.time() - t0, 1),
            "texts_sample": texts[:3]}
    np.save(vec_f, vecs)
    json.dump(meta, open(meta_f, "w"))
    return vecs, meta


def q(conn, sql, *a):
    return conn.execute(sql, a)


def table_size(conn, name):
    return q(conn, "SELECT pg_relation_size(%s)", name).fetchone()[0]


def load_layouts(conn, vecs, meta, query_sessions, m=16, efc=64):
    sess = meta["session_of"]
    rows = [(i, sess[i], vecs[i]) for i in range(len(sess)) if not meta["is_query"][i]]
    info = {}
    # Docker's default /dev/shm is 64 MB; parallel HNSW builds need more. Build single-threaded.
    q(conn, "SET max_parallel_maintenance_workers = 0")
    q(conn, "SET maintenance_work_mem = '512MB'")
    q(conn, "DROP TABLE IF EXISTS vb_shared, vb_shared_p, vb_part CASCADE")
    for s in set(sess):
        q(conn, f"DROP TABLE IF EXISTS vb_s_{s}")
    q(conn, "CREATE TABLE vb_shared (id int PRIMARY KEY, session_id text NOT NULL, embedding vector(384))")
    with conn.cursor().copy("COPY vb_shared (id, session_id, embedding) FROM STDIN WITH (FORMAT BINARY)") as cp:
        cp.set_types(["int4", "text", "vector"])
        for r in rows:
            cp.write_row(r)
    q(conn, "CREATE INDEX vb_shared_sess ON vb_shared (session_id)")
    t0 = time.time()
    q(conn, f"CREATE INDEX vb_shared_hnsw ON vb_shared USING hnsw (embedding vector_cosine_ops) "
            f"WITH (m={m}, ef_construction={efc})")
    info["shared_hnsw"] = {"build_s": round(time.time() - t0, 2), "index_bytes": table_size(conn, "vb_shared_hnsw"),
                           "rows": len(rows)}
    q(conn, "ANALYZE vb_shared")
    # partial indexes for the queried sessions only (one per session in real use), on a copy of
    # the table so the plain shared layout can't use them
    q(conn, "DROP TABLE IF EXISTS vb_shared_p")
    q(conn, "CREATE TABLE vb_shared_p AS SELECT * FROM vb_shared")
    t0 = time.time()
    for s in query_sessions:
        q(conn, f"CREATE INDEX vb_partial_{s} ON vb_shared_p USING hnsw (embedding vector_cosine_ops) "
                f"WITH (m={m}, ef_construction={efc}) WHERE session_id = '{s}'")
    q(conn, "ANALYZE vb_shared_p")
    info["partial_hnsw"] = {"build_s_total": round(time.time() - t0, 2),
                            "index_bytes": {s: table_size(conn, f"vb_partial_{s}") for s in query_sessions}}
    # list partitioning
    q(conn, "CREATE TABLE vb_part (id int, session_id text NOT NULL, embedding vector(384)) "
            "PARTITION BY LIST (session_id)")
    for s in sorted(set(sess)):
        q(conn, f"CREATE TABLE vb_part_{s} PARTITION OF vb_part FOR VALUES IN ('{s}')")
    q(conn, "INSERT INTO vb_part SELECT * FROM vb_shared")
    t0 = time.time()
    q(conn, f"CREATE INDEX vb_part_hnsw ON vb_part USING hnsw (embedding vector_cosine_ops) "
            f"WITH (m={m}, ef_construction={efc})")
    info["partitioned"] = {"build_s": round(time.time() - t0, 2)}
    q(conn, "ANALYZE vb_part")
    # per-session tables (LogLens), only for the queried sessions
    t0 = time.time()
    for s in query_sessions:
        q(conn, f"CREATE TABLE vb_s_{s} AS SELECT id, embedding FROM vb_shared WHERE session_id = '{s}'")
        q(conn, f"CREATE INDEX ON vb_s_{s} USING hnsw (embedding vector_cosine_ops) WITH (m={m}, ef_construction={efc})")
        q(conn, f"ANALYZE vb_s_{s}")
    info["per_session_table"] = {"build_s_total": round(time.time() - t0, 2)}
    conn.commit()
    return info


def exact_truth(vecs, meta, session, qv, k=10):
    """True similarity of every row of the session + the k-th best similarity.

    Log lines repeat, so many rows tie with the k-th best (133 on average for a 1,000-row
    session here). Recall therefore counts a returned row as correct when its true
    similarity reaches the k-th best, instead of comparing with one arbitrary top-k set."""
    sess = meta["session_of"]
    idx = [i for i in range(len(sess)) if sess[i] == session and not meta["is_query"][i]]
    sims = vecs[idx] @ qv
    return dict(zip(idx, sims.tolist())), float(np.sort(sims)[::-1][k - 1])


def tie_aware_recall(ids, truth, k=10, eps=1e-5):
    sim_of, kth = truth
    return min(k, sum(1 for i in ids if i in sim_of and sim_of[i] >= kth - eps)) / k


LAYOUT_SQL = {
    "shared_hnsw": ("SELECT id FROM vb_shared WHERE session_id = %s ORDER BY embedding <=> %s LIMIT 10", {}),
    # `session_id || '' = $1` hides the predicate from the B-tree, so the only non-seq plan is the
    # HNSW walk + filter: this is the post-filtering path we want to measure.
    "shared_hnsw_forced": ("SELECT id FROM vb_shared WHERE session_id || '' = %s ORDER BY embedding <=> %s LIMIT 10",
                           {"enable_bitmapscan": "off", "enable_seqscan": "off"}),
    "shared_iterative": ("SELECT id FROM vb_shared WHERE session_id || '' = %s ORDER BY embedding <=> %s LIMIT 10",
                         {"hnsw.iterative_scan": "relaxed_order", "enable_bitmapscan": "off", "enable_seqscan": "off"}),
    "shared_btree_exact": ("SELECT id FROM vb_shared WHERE session_id = %s ORDER BY embedding <=> %s LIMIT 10",
                           {"enable_indexscan": "off", "enable_seqscan": "off"}),
    # enable_sort=off: the B-tree plan needs a Sort for ORDER BY distance, the partial HNSW doesn't
    "partial_hnsw": ("SELECT id FROM vb_shared_p WHERE session_id = %s ORDER BY embedding <=> %s LIMIT 10",
                     {"enable_bitmapscan": "off", "enable_seqscan": "off", "enable_sort": "off"}),
    "partitioned": ("SELECT id FROM vb_part WHERE session_id = %s ORDER BY embedding <=> %s LIMIT 10", {}),
    "per_session_table": ("SELECT id FROM vb_s_{s} ORDER BY embedding <=> %s LIMIT 10", {}),
}


def run_queries(conn, layout, session, queries, ef):
    sql, gucs = LAYOUT_SQL[layout]
    conn.execute("RESET ALL")
    conn.execute(f"SET hnsw.ef_search = {ef}")
    for k, v in gucs.items():
        conn.execute(f"SET {k} = '{v}'")
    if layout == "partial_hnsw":
        pass  # planner picks the partial index whose predicate matches the literal below
    res, lat = [], []
    for qv in queries:
        t0 = time.perf_counter()
        if layout == "per_session_table":
            ids = [r[0] for r in conn.execute(sql.format(s=session), (qv,)).fetchall()]
        elif layout == "partial_hnsw":
            ids = [r[0] for r in conn.execute(
                f"SELECT id FROM vb_shared_p WHERE session_id = '{session}' ORDER BY embedding <=> %s LIMIT 10",
                (qv,)).fetchall()]
        else:
            ids = [r[0] for r in conn.execute(sql, (session, qv)).fetchall()]
        lat.append((time.perf_counter() - t0) * 1000)
        res.append(ids)
    plan = conn.execute("EXPLAIN " + (sql.format(s=session) if layout == "per_session_table" else
                                      (f"SELECT id FROM vb_shared_p WHERE session_id = '{session}' ORDER BY embedding <=> %s LIMIT 10"
                                       if layout == "partial_hnsw" else sql)),
                        ((queries[0],) if layout in ("per_session_table", "partial_hnsw") else (session, queries[0]))
                        ).fetchall()
    return res, lat, " / ".join(r[0].strip() for r in plan[:3])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--small-sessions", type=int, default=100)
    ap.add_argument("--small-rows", type=int, default=1000)
    ap.add_argument("--big-rows", type=int, default=20000)
    ap.add_argument("--queries", type=int, default=50)
    ap.add_argument("--ef", default="40,100,200,400")
    args = ap.parse_args()
    vecs, meta = build_corpus(args.small_sessions, args.small_rows, args.big_rows, args.queries)
    sess = meta["session_of"]
    query_sessions = ["big", "s000", "s050"]
    conn = psycopg.connect(DB, autocommit=True)
    register_vector(conn)
    info = load_layouts(conn, vecs, meta, query_sessions)
    results = []
    for s in query_sessions:
        qidx = [i for i in range(len(sess)) if sess[i] == s and meta["is_query"][i]][:args.queries]
        queries = [vecs[i] for i in qidx]
        truth = [exact_truth(vecs, meta, s, vecs[i]) for i in qidx]
        share = sum(1 for i in range(len(sess)) if sess[i] == s and not meta["is_query"][i]) / \
            sum(1 for x in meta["is_query"] if not x)
        for layout in LAYOUT_SQL:
            for ef in [int(x) for x in args.ef.split(",")]:
                if layout in ("shared_btree_exact",) and ef != 40:
                    continue
                run_queries(conn, layout, s, queries[:5], ef)  # warm
                ids, lat, plan = run_queries(conn, layout, s, queries, ef)
                rec = statistics.mean(tie_aware_recall(r, t) for r, t in zip(ids, truth))
                results.append({"session": s, "session_share": round(share, 4), "layout": layout, "ef_search": ef,
                                "recall_at_10": round(rec, 3),
                                "avg_rows_returned": round(statistics.mean(len(r) for r in ids), 2),
                                "p50_ms": round(statistics.median(lat), 2),
                                "p95_ms": round(sorted(lat)[int(0.95 * len(lat)) - 1], 2), "plan": plan})
                print(json.dumps(results[-1]), flush=True)
    out = {"date": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "commit": git_sha(),
           "pgvector": conn.execute("SELECT extversion FROM pg_extension WHERE extname='vector'").fetchone()[0],
           "postgres": conn.execute("SHOW server_version").fetchone()[0],
           "vectors": int(sum(1 for x in meta["is_query"] if not x)), "dim": int(vecs.shape[1]),
           "embed_model": "bge-small-en-v1.5 (ONNX)", "embed_seconds": meta["embed_seconds"],
           "hnsw": {"m": 16, "ef_construction": 64}, "build": info, "results": results}
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    json.dump(out, open(os.path.join(HERE, "results", "vector_isolation.json"), "w"), indent=2)


if __name__ == "__main__":
    main()
