"""Postgres access for both graphs (psycopg 3, one connection per call).

The per-session chunk table name is built ONLY from a validated UUID — the same
injection guard the Java side enforces — so a caller can never splice arbitrary
text into SQL.
"""
from __future__ import annotations
import re
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


def count_findings(session_id: str) -> int:
    """Cheap count used to size Graph 1's recursion budget before invoking it."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) AS n FROM log_findings WHERE session_id = %s", (session_id,))
        row = cur.fetchone()
        return int(row["n"]) if row else 0


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
    grounded: Optional[bool] = None,
    judge_reason: Optional[str] = None,
) -> None:
    sql = (
        "INSERT INTO incidents "
        "(session_id, time_range_start, time_range_end, finding_ids, narrative, root_cause_hypothesis, "
        "grounded, judge_reason) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
    )
    ids = [str(x) for x in finding_ids]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, (session_id, time_start, time_end, ids, narrative, root_cause, grounded, judge_reason))


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

# Reciprocal Rank Fusion constant. Standard default (Cormack et al. 2009): damps
# the weight of very-top ranks so a chunk ranked highly by BOTH retrievers beats
# one ranked #1 by only one. Larger k = flatter weighting.
_RRF_K = 60


def _rrf_fuse(
    ranked_lists: list[list[dict[str, Any]]], limit: int
) -> list[dict[str, Any]]:
    """
    Reciprocal Rank Fusion: merge several independently-ranked result lists into
    one. Each chunk scores Σ 1/(k + rank) over the lists it appears in (rank is
    0-based within each list), so items ranked highly by EITHER retriever — and
    especially by BOTH — rise to the top, without needing the retrievers' raw
    scores to be comparable (cosine distance vs ts_rank are different units).
    """
    fused: dict[Any, dict[str, Any]] = {}
    scores: dict[Any, float] = {}
    for ranked in ranked_lists:
        for rank, row in enumerate(ranked):
            cid = row["chunk_id"]
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (_RRF_K + rank)
            fused.setdefault(cid, row)
    ordered = sorted(fused.values(), key=lambda r: scores[r["chunk_id"]], reverse=True)
    for r in ordered:
        r["score"] = round(scores[r["chunk_id"]], 6)
    return ordered[:limit]


# Question words that carry no evidence. The 'simple' text-search config keeps
# every word, so without this list a question like "Which upstream provider
# throttled payment requests?" requires the chunk to contain "which" too.
_STOPWORDS = frozenset("""
a an the and or of to in on at by for from with as is are was were be been being do does did done
what which who whom whose when where why how many much any some there their it its this that these those
around about during between before after first last time times happen happened went wrong
please show list tell me my our we you your i can could would should will shall may might
""".split())

_TSV_COLUMN_CACHE: dict[str, bool] = {}


def lexical_terms(question: str) -> list[str]:
    """Distinct, lower-cased, non-stopword terms of a question, in order."""
    seen: list[str] = []
    for t in re.findall(r"[A-Za-z0-9_.]+", question.lower()):
        t = t.strip(".")
        if len(t) < 2 or t in _STOPWORDS or t in seen:
            continue
        seen.append(t)
    return seen


def _tsv_expr(table: str) -> str:
    """Stored `content_tsv` column when the table has one (new sessions), else the expression."""
    if table not in _TSV_COLUMN_CACHE:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM information_schema.columns WHERE table_name = %s AND column_name = 'content_tsv'",
                        (table,))
            _TSV_COLUMN_CACHE[table] = cur.fetchone() is not None
    return "content_tsv" if _TSV_COLUMN_CACHE[table] else "to_tsvector('simple', content)"


def retrieve_chunks(
    session_id: str,
    query_embedding: Optional[list[float]],
    query_text: str,
    limit: int,
) -> list[dict[str, Any]]:
    """
    Hybrid retrieval over one session's chunk table, fused with Reciprocal Rank
    Fusion (RRF): pgvector kNN on the embedded question AND GIN full-text on the
    question's meaningful terms are each ranked independently, then merged by
    RRF so a chunk strong on either signal (and especially both) ranks highest.

    The lexical leg ORs the question's terms (stopwords removed). It used to AND
    every word via websearch_to_tsquery, which matched nothing for natural
    questions, so "hybrid" silently ran as vector-only (retrieval eval, LL-04).
    """
    table = chunk_table(session_id)  # validated UUID -> safe
    ranked_lists: list[list[dict[str, Any]]] = []

    # Retriever 1 — semantic (vector kNN), already ordered best-first by distance.
    if query_embedding is not None:
        vec = "[" + ",".join(str(x) for x in query_embedding) + "]"
        knn_sql = (
            f"SELECT chunk_id, line_start, line_end, time_bucket, content "
            f"FROM {table} WHERE embedding IS NOT NULL "
            f"ORDER BY embedding <=> %s::vector LIMIT %s"
        )
        with connect() as conn, conn.cursor() as cur:
            cur.execute(knn_sql, (vec, limit))
            ranked_lists.append(cur.fetchall())

    # Retriever 2 — lexical (full-text) over the OR of meaningful terms, ranked
    # by ts_rank so RRF gets real ranks. Terms are passed as tsquery lexemes
    # (quoted) so punctuation in log tokens cannot break the query syntax.
    terms = lexical_terms(query_text)
    if terms:
        tsv = _tsv_expr(table)
        or_query = " | ".join("'" + t.replace("'", "") + "'" for t in terms)
        fts_sql = (
            f"SELECT chunk_id, line_start, line_end, time_bucket, content "
            f"FROM {table} "
            f"WHERE {tsv} @@ to_tsquery('simple', %s) "
            f"ORDER BY ts_rank({tsv}, to_tsquery('simple', %s)) DESC "
            f"LIMIT %s"
        )
        with connect() as conn, conn.cursor() as cur:
            cur.execute(fts_sql, (or_query, or_query, limit))
            ranked_lists.append(cur.fetchall())

    return _rrf_fuse(ranked_lists, limit)
