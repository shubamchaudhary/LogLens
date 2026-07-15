"""Environment-driven configuration for the orchestrator."""
from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _keys(plural: str, singular: str) -> list[str]:
    """Parse a comma-separated <NAME>S env var into a de-duplicated key list.

    Falls back to the single-key <NAME> var so existing single-key deployments
    keep working. Order is preserved (round-robin cursor walks it in order).
    """
    raw = os.environ.get(plural, "")
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    single = os.environ.get(singular, "").strip()
    if single and single not in keys:
        keys.append(single)
    # de-dup while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for k in keys:
        if k not in seen:
            seen.add(k)
            out.append(k)
    return out


# Postgres. In docker-compose this points at the `postgres` service; for local
# dev it defaults to the host-published port (5434, NOT 5432).
DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql://deepdocai:deepdocai123@localhost:5434/deepdocai_db",
)

# ── Provider switches ────────────────────────────────────────────────────────
# Chat: "groq" (default) or "gemini". MUST match the Java side's
# chunkai.llm.provider.
# Embeddings are SPLIT from chat: Groq serves no embedding models (2026-07), so
# EMBEDDING_PROVIDER defaults to gemini. It MUST match the Java side's
# chunkai.llm.embedding-provider — the drill-down question embedding has to use
# the same model that embedded the chunks at ingest, or cosine is meaningless.
LLM_PROVIDER: str = os.environ.get("LLM_PROVIDER", "groq").strip().lower()
EMBEDDING_PROVIDER: str = os.environ.get("EMBEDDING_PROVIDER", "gemini").strip().lower()

# Groq (OpenAI-compatible). Correlation/report benefit from the larger model;
# free tier: ~30 RPM / 1,000 RPD on llama-3.3-70b-versatile.
# GROQ_API_KEYS (plural, comma-separated) is round-robined across all N keys so
# the daily token cap is the SUM of every key's budget, not a single account's.
# GROQ_API_KEY (singular) is still honoured and folded into the pool.
GROQ_API_KEY: str = os.environ.get("GROQ_API_KEY", "")
GROQ_API_KEYS: list[str] = _keys("GROQ_API_KEYS", "GROQ_API_KEY")
GROQ_BASE_URL: str = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_GEN_MODEL: str = os.environ.get("ORCH_GROQ_GEN_MODEL", "llama-3.3-70b-versatile")
GROQ_EMBED_MODEL: str = os.environ.get("ORCH_GROQ_EMBED_MODEL", "nomic-embed-text-v1_5")

# Gemini (fallback provider). langchain-google-genai also honours GOOGLE_API_KEY.
# GEMINI_API_KEYS (plural) is round-robined for embeddings so the drill-down
# question embedding survives a single key's daily quota exhaustion.
GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
GEMINI_API_KEYS: list[str] = _keys("GEMINI_API_KEYS", "GEMINI_API_KEY") or _keys("GOOGLE_API_KEYS", "GOOGLE_API_KEY")
GEN_MODEL: str = os.environ.get("ORCH_GEN_MODEL", "gemini-3.1-flash-lite")
EMBED_MODEL: str = os.environ.get("ORCH_EMBED_MODEL", "gemini-embedding-001")
# schema-v2 stores chunk vectors as vector(768). nomic-embed-text-v1_5 is
# natively 768; gemini-embedding-001 truncates via outputDimensionality.
EMBED_DIM: int = _int("ORCH_EMBED_DIM", 768)

# LLM client tuning. A low retry count means a persistent 429 surfaces quickly
# as a graceful FAILED instead of hanging on minutes of exponential backoff.
LLM_MAX_RETRIES: int = _int("ORCH_LLM_MAX_RETRIES", 2)
LLM_TIMEOUT: int = _int("ORCH_LLM_TIMEOUT", 60)
# Seconds to wait after a 429 before retrying on the next key in the pool.
LLM_RETRY_DELAY: int = _int("ORCH_LLM_RETRY_DELAY", 5)

# Graph tuning.
MAX_CORRELATE_ATTEMPTS: int = _int("ORCH_MAX_CORRELATE_ATTEMPTS", 3)  # initial + 2 regenerations
MAX_REWRITES: int = _int("ORCH_MAX_REWRITES", 2)
RETRIEVE_LIMIT: int = _int("ORCH_RETRIEVE_LIMIT", 30)
TOP_METRICS_LIMIT: int = _int("ORCH_TOP_METRICS_LIMIT", 40)


def is_groq() -> bool:
    return LLM_PROVIDER == "groq"


def embed_is_groq() -> bool:
    return EMBEDDING_PROVIDER == "groq"


def active_api_key() -> str:
    return GROQ_API_KEY if is_groq() else GEMINI_API_KEY


def active_api_keys() -> list[str]:
    """Chat-provider key pool, round-robined by llm.chat()."""
    return GROQ_API_KEYS if is_groq() else GEMINI_API_KEYS


def embed_api_key() -> str:
    return GROQ_API_KEY if embed_is_groq() else GEMINI_API_KEY


def embed_api_keys() -> list[str]:
    """Embedding-provider key pool, round-robined by llm.embed_query()."""
    return GROQ_API_KEYS if embed_is_groq() else GEMINI_API_KEYS


def has_api_key() -> bool:
    return bool(active_api_keys())
