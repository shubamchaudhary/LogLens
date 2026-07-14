-- ============================================================
-- ChunkAI v2 — Log Intelligence Pipeline schema
-- Target design: docs/02-target-architecture.md §6
-- Apply to a FRESH database (prototype: data loss from v1 acceptable).
-- Replaces init.sql for v2. Per-session chunk tables are created at
-- runtime from the template at the bottom of this file.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- USERS — unchanged from v1 (auth code carries over)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(255),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    is_active       BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================
-- SESSIONS — one workspace = one log corpus (replaces v1 "chats")
-- analysis_status drives the SSE progress stream.
-- total_windows / enriched_windows = idempotent completion counter.
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title            TEXT NOT NULL DEFAULT 'New Session',
    analysis_status  VARCHAR(20) NOT NULL DEFAULT 'CREATED',
    total_windows    INTEGER DEFAULT 0,
    enriched_windows INTEGER DEFAULT 0,
    error_message    TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_analysis_status CHECK (analysis_status IN
        ('CREATED','CHUNKING','PARSING','ENRICHING','CORRELATING','REPORTING','DONE','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);

-- ============================================================
-- DOCUMENTS — one uploaded archive; file lives in MinIO staging
-- and is deleted after successful processing (staged_file_deleted).
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    original_file_name  VARCHAR(500) NOT NULL,
    file_url            TEXT NOT NULL,            -- s3://staging/{sessionId}/{documentId}
    file_size_bytes     BIGINT NOT NULL,
    processing_status   VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    staged_file_deleted BOOLEAN DEFAULT FALSE,
    error_message       TEXT,
    uploaded_at         TIMESTAMPTZ DEFAULT NOW(),
    processed_at        TIMESTAMPTZ,
    CONSTRAINT valid_processing_status CHECK (processing_status IN
        ('PENDING','PROCESSING','COMPLETED','FAILED')),
    -- duplicate-upload detection per session
    CONSTRAINT uq_doc_per_session UNIQUE (session_id, original_file_name, file_size_bytes)
);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);

-- ============================================================
-- LOG_METRICS — Layer-1 parser output. One row = one exact
-- measurement in one time bucket. Upsert key makes at-least-once
-- Kafka delivery safe.
-- ============================================================
CREATE TABLE IF NOT EXISTS log_metrics (
    session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    time_bucket  TIMESTAMPTZ NOT NULL,
    category     VARCHAR(30) NOT NULL,     -- API|DATABASE|ERRORS|DEPENDENCY|PERFORMANCE|AUTH|LIFECYCLE|TRAFFIC
    metric       VARCHAR(100) NOT NULL,    -- e.g. sql_failures, ff_api_calls, gc_pause
    count        BIGINT NOT NULL DEFAULT 0,
    sum_ms       BIGINT,
    avg_ms       NUMERIC(12,2),
    p95_ms       NUMERIC(12,2),
    sample_chunk_ids UUID[],
    PRIMARY KEY (session_id, time_bucket, category, metric)
);
CREATE INDEX IF NOT EXISTS idx_metrics_session_cat ON log_metrics(session_id, category, time_bucket);

-- ============================================================
-- LOG_FINDINGS — Layer-2 LLM output. One row = one insight,
-- grounded via evidence_chunk_ids. Fingerprint dedups repeats
-- (same anomaly again → occurrence_count++, not a new row).
-- ============================================================
CREATE TABLE IF NOT EXISTS log_findings (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    category           VARCHAR(30) NOT NULL,
    severity           VARCHAR(10) NOT NULL,     -- INFO|WARN|ERROR|CRITICAL
    title              TEXT NOT NULL,
    explanation        TEXT NOT NULL,
    evidence_chunk_ids UUID[] NOT NULL,
    time_range_start   TIMESTAMPTZ,
    time_range_end     TIMESTAMPTZ,
    fingerprint        VARCHAR(64) NOT NULL,
    occurrence_count   INTEGER NOT NULL DEFAULT 1,
    confidence         NUMERIC(3,2),
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_finding_fingerprint UNIQUE (session_id, fingerprint),
    CONSTRAINT valid_severity CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL'))
);
CREATE INDEX IF NOT EXISTS idx_findings_session ON log_findings(session_id, severity, category);

-- ============================================================
-- INCIDENTS — LangGraph Graph-1 output: correlated episodes.
-- ============================================================
CREATE TABLE IF NOT EXISTS incidents (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id            UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    time_range_start      TIMESTAMPTZ,
    time_range_end        TIMESTAMPTZ,
    finding_ids           UUID[] NOT NULL,
    narrative             TEXT NOT NULL,
    root_cause_hypothesis TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incidents_session ON incidents(session_id, time_range_start);

-- ============================================================
-- REPORTS — one final report per session.
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
    session_id   UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    content_md   TEXT NOT NULL,
    content_json JSONB
);

-- ============================================================
-- updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_sessions_updated ON sessions;
CREATE TRIGGER trg_sessions_updated BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- PER-SESSION CHUNK TABLE — TEMPLATE (do not run here).
-- Executed at runtime by SessionChunkTableManager on session
-- creation. {tid} = session UUID with '-' replaced by '_'.
-- Table names are built ONLY from validated UUIDs (injection guard).
-- ============================================================
-- CREATE TABLE log_chunks_s_{tid} (
--     chunk_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     document_id  UUID NOT NULL,
--     time_bucket  TIMESTAMPTZ NOT NULL,
--     line_start   INTEGER,
--     line_end     INTEGER,
--     content      TEXT NOT NULL,
--     embedding    vector(768),
--     is_anomalous BOOLEAN DEFAULT FALSE,
--     created_at   TIMESTAMPTZ DEFAULT NOW()
-- );
-- CREATE INDEX idx_lc_{tid}_hnsw ON log_chunks_s_{tid}
--     USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
-- CREATE INDEX idx_lc_{tid}_fts  ON log_chunks_s_{tid}
--     USING gin (to_tsvector('simple', content));
-- CREATE INDEX idx_lc_{tid}_time ON log_chunks_s_{tid} (time_bucket);
-- Session deletion: DROP TABLE IF EXISTS log_chunks_s_{tid};
