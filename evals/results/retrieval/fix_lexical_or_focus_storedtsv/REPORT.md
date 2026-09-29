# Retrieval eval (fix_lexical_or_focus_storedtsv)

- Date 2026-09-29T21:51:46+00:00 | commit `d0e01c1-dirty` | 51 answerable questions | 360 chunks (avg 15765 chars) | limit 30 | RRF k=60
- Embeddings: bge-small-en-v1.5 (ONNX, 384-d) (stand-in for gemini-embedding-001) | prompt version 2026-09-29.2 | LLM calls: 0 | cost $0
- 'Visible to generator/grader' = share of gold lines present in the exact prompt text built by prompts.generate_user / grade_user for the top 30 chunks.

| Retriever | Recall@5 | Recall@10 | Recall@30 | MRR | nDCG@10 | Gold lines in retrieved chunks | Visible to generator | Visible to grader | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| vector_only | 0.34 | 0.393 | 0.441 | 0.28 | 0.286 | 0.45 | 0.16 | 0.129 | 17.34 | 22.2 |
| fts_only | 0.675 | 0.779 | 0.852 | 0.614 | 0.628 | 0.855 | 0.453 | 0.39 | 19.33 | 23.57 |
| hybrid_rrf | 0.547 | 0.757 | 0.874 | 0.449 | 0.493 | 0.877 | 0.441 | 0.376 | 35.97 | 44.98 |

## Recall@10 by question type

| Type | n | vector | fts | hybrid |
|---|---|---|---|---|
| comparison | 3 | 0.167 | 0.444 | 0.444 |
| count | 8 | 0.672 | 0.777 | 0.807 |
| entity | 11 | 0.394 | 0.879 | 0.758 |
| first | 5 | 0.6 | 1.0 | 1.0 |
| last | 1 | 1.0 | 1.0 | 1.0 |
| root_cause | 3 | 0.111 | 1.0 | 0.889 |
| time_range | 3 | 0.167 | 0.167 | 0.167 |
| why | 17 | 0.294 | 0.765 | 0.784 |
