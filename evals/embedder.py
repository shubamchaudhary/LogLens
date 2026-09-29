"""Local embedding model for $0, offline retrieval evals and vector benchmarks.

bge-small-en-v1.5 (384-d) exported to ONNX by Qdrant's fastembed project.
Production uses gemini-embedding-001 at 768-d; results measured with this model
are a stand-in and are labelled as such in every report.

Model files: set LOGLENS_EMBED_MODEL_DIR, or run bench/fetch_model.sh which
downloads storage.googleapis.com/qdrant-fastembed/fast-bge-small-en-v1.5.tar.gz
(sha256 3858004b3822f64f940280874b8f2d2dc25b34a4f3eb3cdf617bdceeb21ed9ed).
"""
from __future__ import annotations

import os

import numpy as np

DEFAULT_DIR = os.environ.get(
    "LOGLENS_EMBED_MODEL_DIR",
    os.path.join(os.path.dirname(__file__), ".models", "fast-bge-small-en-v1.5"))
MODEL_NAME = "bge-small-en-v1.5 (ONNX, 384-d)"


class LocalEmbedder:
    def __init__(self, model_dir: str = DEFAULT_DIR, max_tokens: int = 512):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tok.enable_truncation(max_tokens)
        self.tok.enable_padding()
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) - 1)
        self.sess = ort.InferenceSession(os.path.join(model_dir, "model_optimized.onnx"), opts,
                                         providers=["CPUExecutionProvider"])

    def embed(self, texts: list[str], batch: int = 32) -> np.ndarray:
        out = []
        for i in range(0, len(texts), batch):
            enc = self.tok.encode_batch(texts[i:i + batch])
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            am = np.array([e.attention_mask for e in enc], dtype=np.int64)
            cls = self.sess.run(None, {"input_ids": ids, "attention_mask": am,
                                       "token_type_ids": np.zeros_like(ids)})[0][:, 0]
            out.append(cls / np.linalg.norm(cls, axis=1, keepdims=True))
        return np.vstack(out) if out else np.zeros((0, 384), dtype=np.float32)

    def embed_query(self, q: str) -> np.ndarray:
        # bge convention: instruction prefix for short queries
        return self.embed(["Represent this sentence for searching relevant passages: " + q])[0]
