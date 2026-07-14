"""Thin provider-agnostic wrappers over the chat + embedding models.

Provider is selected by LLM_PROVIDER (see config.py) and MUST match the Java
lane's chunkai.llm.provider — especially for embeddings, where the drill-down
question must be embedded by the same model that embedded the chunks at ingest.

Clients are created lazily so the service still imports and serves `/health`
when no key is configured; the LLM nodes raise a clear error only when they
actually try to call the model.

Embeddings go through each provider's REST endpoint directly (not langchain):
- groq:   OpenAI-compatible /embeddings with nomic-embed-text-v1_5 (768-dim native)
- gemini: embedContent with outputDimensionality=768 (Matryoshka truncation)
Vectors are L2-normalised here; pgvector cosine ops are scale-invariant so this
is safe for both providers.
"""
from __future__ import annotations

import json
import math
import re
import urllib.request
from functools import lru_cache
from typing import Any

from . import config


class MissingApiKey(RuntimeError):
    pass


def _require_key() -> str:
    if not config.has_api_key():
        raise MissingApiKey(
            f"No API key set for provider '{config.LLM_PROVIDER}' — set "
            f"{'GROQ_API_KEY' if config.is_groq() else 'GEMINI_API_KEY'} so the "
            "orchestrator can call the model for correlation/report/drilldown."
        )
    return config.active_api_key()


@lru_cache(maxsize=1)
def _chat():
    if config.is_groq():
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=config.GROQ_GEN_MODEL,
            api_key=_require_key(),
            base_url=config.GROQ_BASE_URL,
            temperature=0.3,
            max_retries=config.LLM_MAX_RETRIES,
            timeout=config.LLM_TIMEOUT,
        )
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=config.GEN_MODEL,
        google_api_key=_require_key(),
        temperature=0.3,
        max_retries=config.LLM_MAX_RETRIES,
        timeout=config.LLM_TIMEOUT,
    )


def chat(system: str, user: str) -> str:
    """Single-turn chat completion, returns the raw text."""
    from langchain_core.messages import HumanMessage, SystemMessage

    resp = _chat().invoke([SystemMessage(content=system), HumanMessage(content=user)])
    return resp.content if isinstance(resp.content, str) else str(resp.content)


def chat_json(system: str, user: str) -> Any:
    """Chat completion parsed as JSON (tolerates ```json fences and prose)."""
    return _extract_json(chat(system, user))


# ── Embeddings ───────────────────────────────────────────────────────────────

_GEMINI_EMBED_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent?key={key}"
)


def embed_query(text: str) -> list[float]:
    """Embed `text` to a unit-length vector matching schema-v2's vector(768)."""
    key = _require_key()
    if config.is_groq():
        values = _groq_embed(text, key)
    else:
        values = _gemini_embed(text, key)
    return _l2_normalize(values)


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
