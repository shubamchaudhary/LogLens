-- Run ONCE against an existing LogLens database BEFORE deploying the 2026-09-30 changes
-- (branch claude/peaceful-curie-43xyiu). New databases get the same objects from schema-v2.sql.
-- Idempotent: running it twice is harmless.
--
--   psql "$DATABASE_URL" -f migration_2026_09_30_exactly_once.sql
--
-- Without it the new backend fails every enrichment item (no enrich_work_done table) and the
-- orchestrator fails to store incidents (no grounded / judge_reason columns).

BEGIN;

-- Exactly-once marker for the LLM enrichment lane (EnrichWorkLedger): inserted in the same
-- transaction as the item's findings, embeddings and the enriched_windows increment.
CREATE TABLE IF NOT EXISTS enrich_work_done (
    work_id    UUID PRIMARY KEY,
    session_id UUID NOT NULL,
    done_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_enrich_work_session ON enrich_work_done(session_id);

-- Judge verdict persisted with each incident (false = force-accepted after the last attempt).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS grounded BOOLEAN;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS judge_reason TEXT;

COMMIT;

-- Notes
-- * Per-session chunk tables created before this deploy keep their GIN expression index and have
--   no content_tsv column. They keep working: the orchestrator checks each table for content_tsv
--   and falls back to to_tsvector('simple', content). New sessions get the stored column.
-- * Enrichment items finished by the old code have no enrich_work_done row. Do not rewind the
--   llm-workers consumer group to offsets older than this deploy, or those items run again.
