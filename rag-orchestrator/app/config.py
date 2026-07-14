"""Environment-driven configuration for the orchestrator."""
from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


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
GROQ_API_KEY: str = os.environ.get("GROQ_API_KEY", "")
GROQ_BASE_URL: str = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_GEN_MODEL: str = os.environ.get("ORCH_GROQ_GEN_MODEL", "llama-3.3-70b-versatile")
GROQ_EMBED_MODEL: str = os.environ.get("ORCH_GROQ_EMBED_MODEL", "nomic-embed-text-v1_5")

# Gemini (fallback provider). langchain-google-genai also honours GOOGLE_API_KEY.
GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
GEN_MODEL: str = os.environ.get("ORCH_GEN_MODEL", "gemini-3.1-flash-lite")
EMBED_MODEL: str = os.environ.get("ORCH_EMBED_MODEL", "gemini-embedding-001")
# schema-v2 stores chunk vectors as vector(768). nomic-embed-text-v1_5 is
# natively 768; gemini-embedding-001 truncates via outputDimensionality.
EMBED_DIM: int = _int("ORCH_EMBED_DIM", 768)

# LLM client tuning. A low retry count means a persistent 429 surfaces quickly
# as a graceful FAILED instead of hanging on minutes of exponential backoff.
LLM_MAX_RETRIES: int = _int("ORCH_LLM_MAX_RETRIES", 2)
LLM_TIMEOUT: int = _int("ORCH_LLM_TIMEOUT", 60)

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


def embed_api_key() -> str:
    return GROQ_API_KEY if embed_is_groq() else GEMINI_API_KEY


def has_api_key() -> bool:
    return bool(active_api_key())
