# Retrieval eval (baseline)

- Date 2026-09-29T21:47:56+00:00 | commit `d0e01c1-dirty` | 51 answerable questions | 360 chunks (avg 15765 chars) | limit 30 | RRF k=60
- Embeddings: bge-small-en-v1.5 (ONNX, 384-d) (stand-in for gemini-embedding-001) | LLM calls: 0 | cost $0

| Retriever | Recall@5 | Recall@10 | Recall@30 | MRR | nDCG@10 | Gold lines in retrieved chunks | Visible to generator (800 chars) | Visible to grader (500) | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| vector_only | 0.34 | 0.393 | 0.441 | 0.28 | 0.286 | 0.45 | 0.107 | 0.069 | 15.76 | 19.36 |
| fts_only | 0.626 | 0.723 | 0.777 | 0.56 | 0.574 | 0.779 | 0.08 | 0.049 | 2070.96 | 2274.18 |
| hybrid_rrf | 0.34 | 0.393 | 0.441 | 0.28 | 0.286 | 0.45 | 0.107 | 0.069 | 703.8 | 789.29 |

## Recall@10 by question type

| Type | n | vector | fts | hybrid |
|---|---|---|---|---|
| comparison | 3 | 0.167 | 0.278 | 0.167 |
| count | 8 | 0.672 | 0.777 | 0.672 |
| entity | 11 | 0.394 | 0.758 | 0.394 |
| first | 5 | 0.6 | 1.0 | 0.6 |
| last | 1 | 1.0 | 1.0 | 1.0 |
| root_cause | 3 | 0.111 | 1.0 | 0.111 |
| time_range | 3 | 0.167 | 0.167 | 0.167 |
| why | 17 | 0.294 | 0.706 | 0.294 |
