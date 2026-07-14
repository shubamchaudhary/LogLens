# HANDOVER — ChunkAI modernization (multi-session)

> **Protocol for every agent/session:** read this file FIRST, then the two architecture docs. Do the work. Before ending the session, update **Current state**, **Next steps**, and append one row to the **Session log**. Keep this file short — it's a pointer board, not a diary. Details belong in the numbered docs.

## Project intent (stable — don't re-litigate)

Owner (Shubam) is building this for **interview-portfolio strength**; every technology must be justifiable problem-first (justifications live in the docs).

**Finalized positioning (2026-07-14): log intelligence pipeline.** Analyze production log archives at ingest time — deterministic parsers for exact metrics, LLM enrichment (via Kafka partition-per-API-key lanes) for anomaly explanations and incident correlation — materialize into structured tables, generate a report, answer fixed-param user queries from those tables via SQL, with a grounded RAG drill-down to raw log lines. "Ingest-time RAG." Document Q&A (v1 feature set) stays as a secondary mode. This supersedes the earlier "generic RAG upgrade" direction.

## Key docs

| File | Contents |
|---|---|
| [01-current-architecture.md](01-current-architecture.md) | Verified deep-dive of the v1 system: schema, data flows, key-slot worker pool, recursive summarization, limitations (§9), interview Q&A |
| [02-target-architecture.md](02-target-architecture.md) | **FINAL target design**: log-intelligence positioning, whiteboard diagram (§3), cut list (§4), two-layer extraction + taxonomy, data model + ER + file lifecycle (§6), Kafka lanes, LangGraph graphs, query model, interview Q&A (§12) |
| [03-implementation-spec.md](03-implementation-spec.md) | **Code-level spec, agent-executable**: global binding decisions, message schemas, topics, Phases 0–5 each sized for one PR with new-files/deletions/definition-of-done. Execute in order. |
| [/schema-v2.sql](../schema-v2.sql) | The v2 table-creation script (fresh DB; replaces init.sql in compose) incl. per-session chunk-table template |

## Locked design decisions (with their defense in 02)

1. **Two-layer extraction** — parsers for numbers, LLMs for meaning; enrich anomalous windows only (02 §5).
2. **Kafka partition-per-API-key** for LLM lanes; at-least-once + idempotent handlers (fingerprint dedup, natural-key upserts); retry topic for 429s; DLQ. Four topics total (02 §7).
3. **Table-per-session for raw chunks** (`log_chunks_s_{sessionId}`, own HNSW **+ GIN full-text**) — justified by corpus-scale sessions (10⁵–10⁶ chunks); ceiling ~tens-of-thousands of tables; exit = hash partitioning; names from validated UUIDs only (02 §6).
4. **Query time = SQL over materialized tables**; drill-down RAG (Graph 2, session-scoped pgvector + GIN) is the only query-time LLM path (02 §9).
5. **CUT LIST (refinement pass, do not re-add without cause):** Elasticsearch, RRF/hybrid fusion, durable object storage (see #8), query-time recursive summarization (legacy doc-QA mode only), async query API + status topic (SSE reads the DB status row), dedicated vector DB, Kafka exactly-once. Reasons in 02 §4 — that section is interview material.
6. **Chunk logs by time window**, not by page/size.
7. **$0 constraint**: whole stack free/self-hosted; Gemini free tier.
8. **Staging blob lifecycle (owner-specified):** uploads land in **MinIO** (self-hosted, S3-compatible, free — one docker-compose service, used from local dev through prod, no separate "local disk" code path); chunker *streams* the file (never whole-in-memory); after processing the staged file is **deleted** (`documents.staged_file_deleted`) — the chunks in Postgres are the durable copy (02 §6).
9. **Core entity tables (owner-specified):** `users` (user_id PK, email, password_hash, full_name, created_at, last_login_at, is_active — matches v1 init.sql), `sessions` (session_id PK, user_id FK, status+counters), `documents` (document_id PK, user_id FK, session_id FK, file_url, status). ER diagram in 02 §6.

## Facts that save you an hour of re-reading

- Backend = ONE Gradle module `deepdocai-backend`, packages `api/common/core/data/llm`.
- Key concurrency today is **thread-pinned key slots** (NOT round-robin) — 5 keys, 7.5s/key, 429 → re-enqueue + 60s sleep. Maps 1:1 to Kafka partition-per-key; that's the central migration insight.
- Job queue today = `processing_jobs` table + 3s polling + lock leases (`ProcessingJobWorker`). Phase 1 deletes it.
- DB on port **5434** via docker-compose; schema in `init.sql` (no Flyway yet).
- Transactions deliberately split around long LLM calls (short TX → no TX → short TX) — preserve in refactors.
- Existing prompts already log-analysis flavored (`DocumentAnalysisPrompts` mentions stack traces, thread states, pool events) — the pivot matches the code's direction.
- Vector search today: `ORDER BY embedding <=> :q LIMIT 500` two-query pattern in `DocumentChunkRepositoryImpl`; known issues: could be single query; no `ef_search` tuning; `LIMIT 500` > default `ef_search=40` is incoherent. Superseded by target design's per-session tables.
- Frontend `examprep-frontend` still has old naming; low priority. Git branch `main`; write real commit messages (history is full of "m").

## Current state (update each session)

**2026-07-14 (end of session 1):** Design finalized, then **refined** — ES/S3/async-query/RRF/recursive-summarization cut (see locked decision #5); doc 02 restructured with ASCII line diagrams and a "what we deliberately don't use" section (§4). Final stack: Spring Boot + Postgres/pgvector + Kafka + LangGraph sidecar + Gemini + React. Migration is now 5 phases (02 §11). `docs/` holds 01 (current, verified), 02 (final refined target), this file. Root cleaned: stale `ARCHITECTURE.md` + 19 old .md files deleted; README repositioned to log intelligence and synced with the cut. **No code changes yet. Everything uncommitted** (including the owner's earlier examprep→deepdocai restructure deletions).

## Next steps (in order)

1. Commit the current working tree (restructure + docs + schema-v2.sql) as a clean baseline.
2. **Execute [03-implementation-spec.md](03-implementation-spec.md) Phases 0→5, in order** — each phase is one PR-sized, self-contained task with its own definition-of-done and deletion list. NOTE: spec's phase numbering supersedes 02 §11's coarser plan.
3. **Owner decision recorded 2026-07-15: v1 doc-QA mode is DELETED during implementation** (not kept as secondary mode — overrides earlier statements in 02/README). Git history is the archive.
4. Skip tests during implementation (owner: separate pass, cheaper model). Frontend after backend completes.
5. Cleanup backlog: Flyway, frontend rename, real commit messages, lag-aware partitioner, golden-corpus regression set.

## Session log

| Date | Session summary |
|---|---|
| 2026-07-14 | Explored codebase; wrote docs 01/02 + handover. Cleaned root md files; README rewritten twice (HLD, then senior tone). Long design exploration: pgvector top-k/filtered-ANN, table-per-session (accepted with corpus-scale defense), positioning pivot to log intelligence, two-layer extraction + materialized findings. 02 rewritten as FINAL; README repositioned; decisions locked above. |
| 2026-07-15 | Clarity pass on 02: §6 data model expanded (ER diagram, plain-word per-table definitions, evidence-chain mental model). §3 rebuilt as THE single interview whiteboard diagram — numbered arrows 1–12 (analysis) + Q1–Q3 (query), single top-down spine, no subgraphs (subgraph layouts scrambled in the owner's renderer). §10 is now a step-by-step narrative table keyed to those same numbers ("say these sentences while drawing the arrows"). Keep this structure — owner wants diagrams reproducible on a whiteboard. No code changes. |
| 2026-07-15 (later) | Data model amendments from owner (users/documents/sessions attributes, staging blob lifecycle → locked decisions #8/#9); MinIO chosen as staging store for local AND prod. Implementation prep: wrote **schema-v2.sql** (real DDL, fresh-DB, per-session table template) and **docs/03-implementation-spec.md** (agent-executable Phases 0–5 with binding global decisions, message schemas, per-phase deletions + definition-of-done). Owner decided: delete v1 doc-QA mode entirely; no tests during implementation. Still no code changes to src/. |
