"""Thin wrappers over Gemini via langchain-google-genai.

Chat and embedding clients are created lazily so the service still imports and
serves `/health` when no key is configured; the LLM nodes raise a clear error
only when they actually try to call the model.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any

from . import config


class MissingApiKey(RuntimeError):
    pass


def _require_key() -> str:
    if not config.has_api_key():
        raise MissingApiKey(
            "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set — the orchestrator "
            "cannot call Gemini for correlation/report/drilldown."
        )
    return config.GEMINI_API_KEY


@lru_cache(maxsize=1)
def _chat():
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=config.GEN_MODEL,
        google_api_key=_require_key(),
        temperature=0.3,
    )


@lru_cache(maxsize=1)
def _embeddings():
    from langchain_google_genai import GoogleGenerativeAIEmbeddings

    return GoogleGenerativeAIEmbeddings(
        model=config.EMBED_MODEL,
        google_api_key=_require_key(),
    )


def chat(system: str, user: str) -> str:
    """Single-turn chat completion, returns the raw text."""
    from langchain_core.messages import HumanMessage, SystemMessage

    resp = _chat().invoke([SystemMessage(content=system), HumanMessage(content=user)])
    return resp.content if isinstance(resp.content, str) else str(resp.content)


def chat_json(system: str, user: str) -> Any:
    """Chat completion parsed as JSON (tolerates ```json fences and prose)."""
    return _extract_json(chat(system, user))


def embed_query(text: str) -> list[float]:
    return _embeddings().embed_query(text)


# ── JSON extraction ────────────────────────────────────────────────────────

_FENCE = re.compile(r"^```[a-zA-Z]*\n?|```$", re.MULTILINE)


def _extract_json(raw: str) -> Any:
    s = _FENCE.sub("", raw).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # Fall back to the first balanced object/array in the text.
        start = min([i for i in (s.find("{"), s.find("[")) if i != -1], default=-1)
        if start == -1:
            raise
        end = max(s.rfind("}"), s.rfind("]"))
        if end <= start:
            raise
        return json.loads(s[start : end + 1])
