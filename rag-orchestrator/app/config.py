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

# One dedicated Gemini key for this service (separate from the Java lane's pool).
# langchain-google-genai also honours GOOGLE_API_KEY; we accept either.
GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""

GEN_MODEL: str = os.environ.get("ORCH_GEN_MODEL", "gemini-2.5-flash")
EMBED_MODEL: str = os.environ.get("ORCH_EMBED_MODEL", "models/text-embedding-004")

# Graph tuning.
MAX_CORRELATE_ATTEMPTS: int = _int("ORCH_MAX_CORRELATE_ATTEMPTS", 3)  # initial + 2 regenerations
MAX_REWRITES: int = _int("ORCH_MAX_REWRITES", 2)
RETRIEVE_LIMIT: int = _int("ORCH_RETRIEVE_LIMIT", 30)
TOP_METRICS_LIMIT: int = _int("ORCH_TOP_METRICS_LIMIT", 40)


def has_api_key() -> bool:
    return bool(GEMINI_API_KEY)
