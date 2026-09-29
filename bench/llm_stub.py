#!/usr/bin/env python3
"""Local stand-in for the Groq chat API and the Gemini embedding API.

Why: benchmarks must measure LogLens's own pipeline (Kafka, parsing, Postgres),
not a free-tier provider's rate limits, and must cost $0. The stub speaks just
enough of each wire format for LlmGateway / GroqClient / GeminiClient and the
Python orchestrator, and it COUNTS every call and token so the gating claim can
be checked end to end.

Chat  : POST /openai/v1/chat/completions            (Groq, OpenAI-compatible)
Embed : POST /v1beta/models/<m>:batchEmbedContents   (Gemini)
        POST /v1beta/models/<m>:embedContent
Stats : GET  /stats    Reset: POST /reset

Embeddings: --embed hash  -> fast deterministic pseudo-vectors (throughput runs)
            --embed bge   -> real bge-small-en-v1.5 vectors (384-d, zero-padded to
                             768 so they fit vector(768); cosine is unchanged)
Chat latency can be simulated with --chat-latency-ms.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATS = {"chat_calls": 0, "chat_prompt_chars": 0, "embed_requests": 0, "embed_texts": 0, "embed_chars": 0}
LOCK = threading.Lock()
EMBEDDER = None
ARGS = None


def hash_vec(text: str, dim: int = 768) -> list[float]:
    h = hashlib.sha256(text.encode("utf-8", "replace")).digest()
    seed = int.from_bytes(h[:8], "little")
    out, x = [], seed or 1
    for _ in range(dim):
        x ^= (x << 13) & 0xFFFFFFFFFFFFFFFF
        x ^= x >> 7
        x ^= (x << 17) & 0xFFFFFFFFFFFFFFFF
        out.append(((x % 20001) - 10000) / 10000.0)
    n = sum(v * v for v in out) ** 0.5 or 1.0
    return [v / n for v in out]


def embed(texts: list[str]) -> list[list[float]]:
    if ARGS.embed == "bge":
        vecs = EMBEDDER.embed(texts)
        return [list(map(float, v)) + [0.0] * (768 - len(v)) for v in vecs]
    return [hash_vec(t) for t in texts]


def fake_findings(user: str) -> str:
    """A deterministic, schema-valid finding derived from the prompt text."""
    m = re.search(r"(\w+(?:Exception|Error))", user)
    title = f"{m.group(1)} observed in window" if m else "Elevated warnings in window"
    cat = "ERRORS" if m else "PERFORMANCE"
    return json.dumps([{"category": cat, "severity": "ERROR" if m else "WARN", "title": title,
                        "explanation": "Stub finding generated for benchmarking.", "confidence": 0.5}])


def respond(system: str, user: str) -> str:
    """Pick the JSON shape each prompt in the codebase asks for."""
    ids = re.findall(r"\[id=([0-9a-f-]{36})", user)
    if "grounding judge" in system:
        return json.dumps({"grounded": True, "reason": "stub"})
    if '"narrative"' in system:
        return json.dumps({"narrative": "Stub narrative.", "root_cause": "Stub root cause."})
    if '"markdown"' in system:
        return json.dumps({"markdown": "# Log Analysis Report\n\nStub.", "summary": "stub",
                           "incident_count": 1, "severity": "WARN"})
    if "relevant_ids" in system:
        return json.dumps({"relevant_ids": ids})
    if "Rewrite it" in system:
        return json.dumps({"question": user.splitlines()[-1].split(":", 1)[-1].strip()})
    if '"answer"' in system:
        return json.dumps({"answer": "Stub answer.", "citations": ids[:3]})
    return fake_findings(user)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/stats"):
            with LOCK:
                return self._json(200, dict(STATS))
        self._json(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if self.path.startswith("/reset"):
            with LOCK:
                for k in STATS:
                    STATS[k] = 0
            return self._json(200, {"ok": True})
        body = json.loads(raw or b"{}")
        if self.path.endswith("/chat/completions"):
            msgs = body.get("messages", [])
            user = msgs[-1]["content"] if msgs else ""
            system = msgs[0]["content"] if msgs else ""
            chars = sum(len(m.get("content", "")) for m in msgs)
            with LOCK:
                STATS["chat_calls"] += 1
                STATS["chat_prompt_chars"] += chars
            if ARGS.chat_latency_ms:
                time.sleep(ARGS.chat_latency_ms / 1000)
            return self._json(200, {"id": "stub", "object": "chat.completion", "model": body.get("model"),
                                    "choices": [{"index": 0, "finish_reason": "stop",
                                                 "message": {"role": "assistant",
                                                             "content": respond(system, user)}}],
                                    "usage": {"prompt_tokens": chars // 4, "completion_tokens": 60,
                                              "total_tokens": chars // 4 + 60}})
        if ":batchEmbedContents" in self.path:
            texts = [r["content"]["parts"][0]["text"] for r in body.get("requests", [])]
            with LOCK:
                STATS["embed_requests"] += 1
                STATS["embed_texts"] += len(texts)
                STATS["embed_chars"] += sum(map(len, texts))
            return self._json(200, {"embeddings": [{"values": v} for v in embed(texts)]})
        if ":embedContent" in self.path:
            text = body["content"]["parts"][0]["text"]
            with LOCK:
                STATS["embed_requests"] += 1
                STATS["embed_texts"] += 1
            return self._json(200, {"embedding": {"values": embed([text])[0]}})
        self._json(404, {"error": self.path})


def main():
    global ARGS, EMBEDDER
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8089)
    p.add_argument("--embed", choices=["hash", "bge"], default="hash")
    p.add_argument("--chat-latency-ms", type=int, default=0)
    ARGS = p.parse_args()
    if ARGS.embed == "bge":
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "evals"))
        from embedder import LocalEmbedder
        EMBEDDER = LocalEmbedder()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"llm stub on :{ARGS.port} embed={ARGS.embed}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
