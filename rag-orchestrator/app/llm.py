"""Thin provider-agnostic wrappers over the chat + embedding models.

Provider is selected by LLM_PROVIDER (see config.py) and MUST match the Java
lane's chunkai.llm.provider — especially for embeddings, where the drill-down
question must be embedded by the same model that embedded the chunks at ingest.

Clients are created lazily so the service still imports and serves `/health`
when no key is configured; the LLM nodes raise a clear error only when they
actually try to call the model.

Embeddings use EMBEDDING_PROVIDER (default gemini — Groq serves no embedding
models as of 2026-07), independent of the chat provider, via REST directly:
- gemini: embedContent with outputDimensionality=768 (Matryoshka truncation)
- groq:   OpenAI-compatible /embeddings (kept in case Groq ships embeddings)
Vectors are L2-normalised here; pgvector cosine ops are scale-invariant so this
is safe for both providers.
"""
from __future__ import annotations

import json
import logging
import math
import re
import time
import urllib.error
import urllib.request
from functools import lru_cache
from itertools import count
from typing import Any

from . import config

log = logging.getLogger("orchestrator.llm")


class MissingApiKey(RuntimeError):
    pass


class ProviderRateLimited(RuntimeError):
    """Every key in the pool returned 429 — surfaced to the API as HTTP 429."""


_RATE_LIMIT_MARKERS = (
    "429",
    "rate limit",
    "rate_limit",
    "resource_exhausted",
    "quota",
    "too many requests",
)


def _is_rate_limit(exc: Exception) -> bool:
    msg = str(exc).lower()
    if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
        return True
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if status == 429:
        return True
    return any(m in msg for m in _RATE_LIMIT_MARKERS)


def _require_key() -> str:
    if not config.has_api_key():
        raise MissingApiKey(
            f"No API key set for provider '{config.LLM_PROVIDER}' — set "
            f"{'GROQ_API_KEYS' if config.is_groq() else 'GEMINI_API_KEYS'} so the "
            "orchestrator can call the model for correlation/report/drilldown."
        )
    return config.active_api_keys()[0]


# Round-robin cursor shared across all chat calls so consecutive requests spread
# over the key pool instead of hammering one account's daily budget.
_chat_cursor = count()


@lru_cache(maxsize=None)
def _chat_for_key(key: str):
    if config.is_groq():
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=config.GROQ_GEN_MODEL,
            api_key=key,
            base_url=config.GROQ_BASE_URL,
            temperature=0.3,
            max_retries=0,  # rotation across keys replaces per-key backoff
            timeout=config.LLM_TIMEOUT,
        )
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=config.GEN_MODEL,
        google_api_key=key,
        temperature=0.3,
        max_retries=0,
        timeout=config.LLM_TIMEOUT,
    )


def chat(system: str, user: str) -> str:
    """Single-turn chat completion, returns the raw text.

    Round-robins across every configured key; on a 429 it rotates to the next
    key (after a short delay) and retries, so a single account's daily token cap
    no longer fails the whole request. Only when EVERY key is rate-limited does
    it raise ProviderRateLimited (→ HTTP 429), distinct from a real outage.
    """
    from langchain_core.messages import HumanMessage, SystemMessage

    keys = config.active_api_keys()
    if not keys:
        _require_key()  # raises MissingApiKey with a clear message
    msgs = [SystemMessage(content=system), HumanMessage(content=user)]
    n = len(keys)
    attempts = max(config.LLM_MAX_RETRIES + 1, n)
    start = next(_chat_cursor)
    last_err: Exception | None = None
    for i in range(attempts):
        key = keys[(start + i) % n]
        try:
            resp = _chat_for_key(key).invoke(msgs)
            return resp.content if isinstance(resp.content, str) else str(resp.content)
        except Exception as exc:  # noqa: BLE001 — inspect + rotate
            if not _is_rate_limit(exc):
                raise
            last_err = exc
            log.warning(
                "chat 429 on key #%d/%d (attempt %d/%d) — rotating",
                (start + i) % n + 1, n, i + 1, attempts,
            )
            if i < attempts - 1:
                time.sleep(config.LLM_RETRY_DELAY)
    raise ProviderRateLimited(
        f"all {n} '{config.LLM_PROVIDER}' key(s) rate-limited: {last_err}"
    )


def chat_json(system: str, user: str) -> Any:
    """Chat completion parsed as JSON (tolerates ```json fences and prose)."""
    return _extract_json(chat(system, user))


# ── Embeddings ───────────────────────────────────────────────────────────────

_GEMINI_EMBED_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent?key={key}"
)

# Round-robin cursor for embedding keys, shared across drill-down calls.
_embed_cursor = count()


def embed_query(text: str) -> list[float]:
    """Embed `text` to a unit-length vector matching schema-v2's vector(768).

    Uses EMBEDDING_PROVIDER (default gemini — Groq serves no embedding models),
    which is deliberately independent of the chat provider and must match the
    model that embedded the chunks at ingest. Round-robins across every embed
    key; on a 429 it rotates to the next key (after a short delay) and retries,
    so a single key's daily quota no longer starves drill-down retrieval.
    """
    keys = config.embed_api_keys()
    if not keys:
        raise MissingApiKey(
            f"No API key for embedding provider '{config.EMBEDDING_PROVIDER}' — set "
            f"{'GROQ_API_KEYS' if config.embed_is_groq() else 'GEMINI_API_KEYS'}."
        )
    n = len(keys)
    attempts = max(config.LLM_MAX_RETRIES + 1, n)
    start = next(_embed_cursor)
    last_err: Exception | None = None
    for i in range(attempts):
        key = keys[(start + i) % n]
        try:
            values = _groq_embed(text, key) if config.embed_is_groq() else _gemini_embed(text, key)
            return _l2_normalize(values)
        except Exception as exc:  # noqa: BLE001 — inspect + rotate
            if not _is_rate_limit(exc):
                raise
            last_err = exc
            log.warning(
                "embed 429 on key #%d/%d (attempt %d/%d) — rotating",
                (start + i) % n + 1, n, i + 1, attempts,
            )
            if i < attempts - 1:
                time.sleep(config.LLM_RETRY_DELAY)
    raise ProviderRateLimited(
        f"all {n} embedding key(s) rate-limited: {last_err}"
    )


def _groq_embed(text: str, key: str) -> list[float]:
    payload = {"model": config.GROQ_EMBED_MODEL, "input": [text]}
    req = urllib.request.Request(
        f"{config.GROQ_BASE_URL}/embeddings",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["data"][0]["embedding"]


def _gemini_embed(text: str, key: str) -> list[float]:
    model_id = config.EMBED_MODEL.split("/")[-1]
    payload = {
        "model": f"models/{model_id}",
        "content": {"parts": [{"text": text}]},
        "outputDimensionality": config.EMBED_DIM,
    }
    req = urllib.request.Request(
        _GEMINI_EMBED_URL.format(model=model_id, key=key),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=config.LLM_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["embedding"]["values"]


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


# ── JSON extraction ────────────────────────────────────────────────────────

_FENCE = re.compile(r"^```[a-zA-Z]*\n?|```$", re.MULTILINE)


def _extract_json(raw: str) -> Any:
    s = _FENCE.sub("", raw).strip()
    # strict=False tolerates literal control characters (raw newlines/tabs) inside
    # string values, which Groq/Gemini models routinely emit inside explanation
    # fields — a strict json.loads raises "Invalid control character" and would
    # otherwise crash report generation.
    try:
        return json.loads(s, strict=False)
    except json.JSONDecodeError:
        # Fall back to the first balanced object/array in the text.
        start = min([i for i in (s.find("{"), s.find("[")) if i != -1], default=-1)
        if start == -1:
            raise
        end = max(s.rfind("}"), s.rfind("]"))
        if end <= start:
            raise
        return json.loads(s[start : end + 1], strict=False)
