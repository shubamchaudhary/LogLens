"""Postgres access for both graphs (psycopg 3, one connection per call).

The per-session chunk table name is built ONLY from a validated UUID — the same
injection guard the Java side enforces — so a caller can never splice arbitrary
text into SQL.
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from typing import Any, Iterator, Optional

import psycopg
from psycopg.rows import dict_row

from . import config


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(config.DATABASE_URL, row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def chunk_table(session_id: str) -> str:
    """`log_chunks_s_<tid>` for a validated UUID (hyphens -> underscores)."""
    canonical = str(uuid.UUID(str(session_id)))  # raises ValueError if not a UUID
    return "log_chunks_s_" + canonical.replace("-", "_")


# ── Graph 1 reads ──────────────────────────────────────────────────────────

def load_findings(session_id: str) -> list[dict[str, Any]]:
    sql = (
        "SELECT id, category, severity, title, explanation, evidence_chunk_ids, "
        "time_range_start, time_range_end, occurrence_count, confidence "
        "FROM log_findings WHERE session_id = %s "
        "ORDER BY time_range_start NULLS LAST, category"
    )
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, (session_id,))
        return cur.fetchall()


def load_top_metrics(session_id: str, limit: int) -> list[dict[str, Any]]:
    sql = (
        "SELECT category, metric, SUM(count) AS total, "
        "MAX(p95_ms) AS max_p95, MAX(avg_ms) AS max_avg "
        "FROM log_metrics WHERE session_id = %s "
        "GROUP BY category, metric ORDER BY total DESC LIMIT %s"
    )
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, (session_id, limit))
        return cur.fetchall()


# ── Graph 1 writes ─────────────────────────────────────────────────────────

def insert_incident(
    session_id: str,
    time_start: Any,
    time_end: Any,
    finding_ids: list[Any],
    narrative: str,
    root_cause: Optional[str],
) -> None:
    sql = (
        "INSERT INTO incidents "
        "(session_id, time_range_start, time_range_end, finding_ids, narrative, root_cause_hypothesis) "
        "VALUES (%s, %s, %s, %s, %s, %s)"
    )
    ids = [str(x) for x in finding_ids]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, (session_id, time_start, time_end, ids, narrative, root_cause))


def upsert_report(session_id: str, content_md: str, content_json: str) -> None:
    sql = (
        "INSERT INTO reports (session_id, content_md, content_json, generated_at) "
        "VALUES (%s, %s, %s::jsonb, NOW()) "
        "ON CONFLICT (session_id) DO UPDATE SET "
        "content_md = EXCLUDED.content_md, content_json = EXCLUDED.content_json, "
        "generated_at = NOW()"
    )
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, (session_id, content_md, content_json))


def clear_incidents(session_id: str) -> None:
    """Idempotent re-run guard: drop any incidents from a previous attempt."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM incidents WHERE session_id = %s", (session_id,))


def set_status(session_id: str, status: str, error_message: Optional[str] = None) -> None:
    sql = "UPDATE sessions SET analysis_status = %s, error_message = %s WHERE id = %s"
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, (status, error_message, session_id))


def session_exists(session_id: str) -> bool:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM sessions WHERE id = %s", (session_id,))
        return cur.fetchone() is not None


# ── Graph 2 retrieval ──────────────────────────────────────────────────────

def retrieve_chunks(
    session_id: str,
    query_embedding: Optional[list[float]],
    query_text: str,
    limit: int,
) -> list[dict[str, Any]]:
    """
    Hybrid recall over one session's chunk table: pgvector kNN on the embedded
    question UNION GIN full-text on the raw question, de-duplicated by chunk_id.
    Falls back to FTS-only if no embedding is available.
    """
    table = chunk_table(session_id)  # validated UUID -> safe
    results: dict[Any, dict[str, Any]] = {}

    if query_embedding is not None:
        vec = "[" + ",".join(str(x) for x in query_embedding) + "]"
        knn_sql = (
            f"SELECT chunk_id, line_start, line_end, time_bucket, content, "
            f"1 - (embedding <=> %s::vector) AS score "
            f"FROM {table} WHERE embedding IS NOT NULL "
            f"ORDER BY embedding <=> %s::vector LIMIT %s"
        )
        with connect() as conn, conn.cursor() as cur:
            cur.execute(knn_sql, (vec, vec, limit))
            for row in cur.fetchall():
                results[row["chunk_id"]] = row

    fts_sql = (
        f"SELECT chunk_id, line_start, line_end, time_bucket, content, "
        f"NULL::float8 AS score "
        f"FROM {table} "
        f"WHERE to_tsvector('simple', content) @@ websearch_to_tsquery('simple', %s) "
        f"LIMIT %s"
    )
    with connect() as conn, conn.cursor() as cur:
        cur.execute(fts_sql, (query_text, limit))
        for row in cur.fetchall():
            results.setdefault(row["chunk_id"], row)

    return list(results.values())[:limit]
