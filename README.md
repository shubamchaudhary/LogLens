# ChunkAI

Grounded Q&A over your own documents. Upload PDFs, slide decks, scanned notes in bulk; ask questions; get answers generated strictly from that content, with file and page/slide citations on every claim.

## What it solves

- **Grounding.** Answers come from retrieved document context only. Every response cites its sources. If the documents don't cover the question, the system says so or falls back to web-grounded search — explicitly, never silently.
- **Context overflow.** A hundred slide decks won't fit in any model's window. Retrieval is recall-first, then hierarchically compressed until it fits — precision problems are cheaper to fix than missing facts.
- **Ingestion at rate-limit scale.** Bulk uploads produce thousands of LLM calls against per-key API quotas. Work is queued durably, partitioned across API keys, retried with backoff, and survives process restarts. Bursts buffer; they don't fail.
- **Retrieval quality.** Lexical and semantic search fail on different query classes. Both run on every query and fuse by rank — exact identifiers and paraphrased questions land on the same chunks.

## Stack

| Technology | Role |
|---|---|
| Spring Boot / Java | API — auth, uploads, chats, document lifecycle |
| PostgreSQL + pgvector | System of record: users, documents, chunks, embeddings |
| Apache Kafka | Durable work queues; one partition per API key preserves per-key rate limits across any number of workers; replayable on failure |
| Elasticsearch | Hybrid retrieval — BM25 + dense kNN, rank-fused |
| LangGraph / Python | Query orchestration: rewrite → retrieve → grade → generate → groundedness check, with retry loops |
| Google Gemini | Embeddings, summarization, generation |
| MinIO / S3 | Object storage |
| React + Vite | Frontend |

Postgres is the single source of truth. Kafka topics and the ES index are projections — both rebuildable from it.

## High-level flow

```
 INGESTION
 ┌──────┐   files    ┌─────────┐  ingest req   ┌───────┐
 │ User │ ─────────▶ │   API   │ ────────────▶ │ Kafka │
 └──────┘            └────┬────┘               └───┬───┘
                          │ metadata               │ partition-per-key
                          ▼                        ▼
                   ┌────────────┐            ┌──────────┐   embed    ┌────────┐
                   │ PostgreSQL │ ◀───────── │ Workers  │ ─────────▶ │ Gemini │
                   └────────────┘  chunks +  │ extract  │            └────────┘
                          │        vectors   │ chunk    │
                          │                  └────┬─────┘
                          │                       │ index
                          │                       ▼
                          │                ┌───────────────┐
                          │                │ Elasticsearch │
                          │                └───────┬───────┘
 QUERY                    │                        │
 ┌──────┐  question  ┌────┴────┐   orchestrate ┌───┴──────────────┐
 │ User │ ─────────▶ │   API   │ ────────────▶ │ RAG Orchestrator │
 └──────┘            └─────────┘               │    (LangGraph)   │
     ▲                                         └───┬──────────────┘
     │      answer + citations                     │ hybrid search, then
     └─────────────────────────────────────────────┘ generate + self-check
```

Two independent paths. Ingestion: upload → Kafka → extract, chunk, embed, index. Query: rewrite → hybrid retrieve → grade relevance → generate → verify groundedness against sources → answer with citations. Kafka decouples bursty producers from rate-limited consumers on both.

The codebase is mid-migration to this design. Current architecture, target architecture with trade-off analysis, and the phased plan are in [`docs/`](docs/) — start at [`docs/HANDOVER.md`](docs/HANDOVER.md).

## Running locally

Java 17+, Node 18+, Docker, and a Gemini API key ([aistudio.google.com](https://aistudio.google.com/)). Entire stack is free and self-hosted.

```bash
cp .env.example .env                        # add GEMINI_API_KEYS
docker-compose up -d                        # postgres+pgvector (kafka/es join as phases land)
./gradlew :deepdocai-backend:bootRun        # api on :8080
cd examprep-frontend && npm i && npm run dev
```

## Layout

```
deepdocai-backend/    Spring Boot backend
examprep-frontend/    React frontend
docs/                 architecture, decisions, migration plan
init.sql              database schema
```
