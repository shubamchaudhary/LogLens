# Retrieval eval (embed_digest)

- Date 2026-09-29T22:24:23+00:00 | commit `7d139bc-dirty` | 51 answerable questions | 360 chunks (avg 15765 chars) | limit 30 | RRF k=60
- Embeddings: bge-small-en-v1.5 (ONNX, 384-d) (stand-in for gemini-embedding-001) | prompt version 2026-09-29.2 | LLM calls: 0 | cost $0
- 'Visible to generator/grader' = share of gold lines present in the exact prompt text built by prompts.generate_user / grade_user for the top 30 chunks.

| Retriever | Recall@5 | Recall@10 | Recall@30 | MRR | nDCG@10 | Gold lines in retrieved chunks | Visible to generator | Visible to grader | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| vector_only | 0.4 | 0.488 | 0.568 | 0.305 | 0.337 | 0.571 | 0.332 | 0.307 | 21.01 | 45.55 |
| fts_only | 0.675 | 0.779 | 0.846 | 0.612 | 0.625 | 0.848 | 0.447 | 0.384 | 22.14 | 34.53 |
| hybrid_rrf | 0.604 | 0.79 | 0.895 | 0.437 | 0.497 | 0.897 | 0.461 | 0.396 | 43.44 | 56.88 |

## Recall@10 by question type

| Type | n | vector | fts | hybrid |
|---|---|---|---|---|
| comparison | 3 | 0.5 | 0.444 | 0.778 |
| count | 8 | 0.672 | 0.777 | 0.768 |
| entity | 11 | 0.606 | 0.879 | 0.879 |
| first | 5 | 0.8 | 1.0 | 1.0 |
| last | 1 | 1.0 | 1.0 | 1.0 |
| root_cause | 3 | 0.778 | 1.0 | 0.889 |
| time_range | 3 | 0.167 | 0.167 | 0.167 |
| why | 17 | 0.206 | 0.765 | 0.765 |
