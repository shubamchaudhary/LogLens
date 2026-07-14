# ChunkAI

Log intelligence pipeline. Upload a production log archive; get back exact metrics, classified failures, correlated incidents with root-cause narratives, and a generated report — every claim cited back to the actual log lines.

Built for the question class where standard RAG structurally fails: **whole-corpus analytical questions**. "What defect patterns appeared this week?" isn't answerable from top-10 retrieved chunks — the answer is spread across thousands. ChunkAI analyzes the entire archive once at ingest, materializes the findings, and answers questions instantly from them.

## Design positions

- **LLMs never count.** Counts, latencies, and distributions come from deterministic parsers — exact, free, fast. LLM calls are spent only where semantics matter: explaining anomalies, classifying errors, correlating events into incidents. Numbers from parsers, narratives from the model.
- **Compute understanding once, not per question.** The heavy LLM work (thousands of enrichment calls per corpus) runs at ingest time through durable queues and lands in structured tables. User queries are SQL over those tables — milliseconds, and hallucination-proof by construction, with a grounded RAG drill-down to the raw log lines as the escape hatch.
- **Rate limits are an architecture problem, not a retry problem.** Enrichment bursts run against per-key API quotas. Work is partitioned one-Kafka-partition-per-API-key — preserving per-key rate limits across any number of workers — with delayed-retry topics for 429s and replayable history for rebuilding anything derived.
- **A session is a corpus, not a chat.** One session holds one archive (10⁵–10⁶ chunks) in its own physical table with its own vector index: search cost scales with that corpus only, other tenants' data is never touched, and deleting a corpus is a `DROP TABLE`.

## Stack

| Technology | Role |
|---|---|
| Spring Boot / Java | API, auth, ingestion pipeline, parsers, Kafka consumers |
| PostgreSQL + pgvector | System of record: sessions, chunks (per-session tables with vector + full-text indexes), metrics, findings, incidents, reports |
| Apache Kafka | Durable analysis queues; partition-per-API-key LLM lanes; replayable history |
| MinIO | Temporary staging for uploaded archives — self-hosted, free, S3-compatible; chunker streams and deletes, Postgres holds the durable copy |
| LangGraph / Python | Correlation & report graphs; grounded drill-down Q&A |
| Google Gemini | Enrichment, correlation, report generation |
| React + Vite | Frontend: progress, report, fixed-param queries |

Postgres is the only stateful system of record; everything derived (findings, incidents, reports) is rebuildable by replaying Kafka. Uploaded files are staging, not storage — deleted once processed. Deliberately absent: Elasticsearch, a dedicated vector DB, managed cloud storage — each solved a problem this design doesn't have (the cut list with reasoning is in `docs/02`, §4).

## High-level flow

```
 ANALYSIS (once per archive — heavy, async)
 ───────────────────────────────────────────────────────────────
 upload ──▶ API ──▶ Kafka ──▶ chunk by time window
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
              Layer 1: PARSERS              Layer 2: LLM ENRICHMENT
              exact counts/latencies        anomalous windows only,
              → log_metrics                 via per-key Kafka lanes
                     │                      → log_findings
                     └──────────┬───────────┘
                                ▼
                     CORRELATION (LangGraph)
                     findings → incidents → REPORT

 QUERY (per question — light, instant)
 ───────────────────────────────────────────────────────────────
 fixed-param question ──▶ SQL over metrics/findings/incidents ──▶ answer
 "show me the lines"  ──▶ evidence drill-down (vector + full-text search, grounded RAG)
```

Details — schemas, Kafka topics, extraction taxonomy, trade-off analysis, migration phases — live in [`docs/`](docs/), starting at [`docs/HANDOVER.md`](docs/HANDOVER.md). Document Q&A over PDFs/slides (the v1 feature set) remains a secondary mode on the same machinery.

## Running locally

Java 17+, Node 18+, Docker, and a free Gemini API key ([aistudio.google.com](https://aistudio.google.com/)). Entire stack is free and self-hosted.

```bash
cp .env.example .env                        # add GEMINI_API_KEYS
docker-compose up -d                        # postgres+pgvector (kafka/minio join as phases land)
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
