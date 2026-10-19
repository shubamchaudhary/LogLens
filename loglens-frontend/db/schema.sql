-- DeepLogLens showcase database (any Postgres 15+ with pgvector, e.g. Neon).
-- Loaded once by scripts/demo/load-db.mjs; read by the /api/ask function.

CREATE EXTENSION IF NOT EXISTS vector;

-- Every WARN/ERROR record of the log (stack traces and Detail lines kept in body)
-- plus notable INFO events (deploys, rollbacks, failovers, config changes).
CREATE TABLE IF NOT EXISTS log_events (
  line_no    integer PRIMARY KEY,          -- first line of the record in the file
  line_end   integer NOT NULL,             -- last line (multi-line records)
  ts         timestamptz NOT NULL,
  level      text NOT NULL,
  service    text NOT NULL,
  pod        text,
  tenant     text,
  logger     text,
  message    text NOT NULL,
  body       text NOT NULL,
  signature  text NOT NULL,                -- failure template id (signatures.id)
  tsv        tsvector GENERATED ALWAYS AS (
               to_tsvector('simple', service || ' ' || coalesce(logger, '') || ' ' ||
                 regexp_replace(message, '[^A-Za-z0-9_]+', ' ', 'g'))) STORED
);
CREATE INDEX IF NOT EXISTS log_events_tsv ON log_events USING gin (tsv);
CREATE INDEX IF NOT EXISTS log_events_ts ON log_events (ts);
CREATE INDEX IF NOT EXISTS log_events_sig ON log_events (signature, line_no);

-- Distinct failure templates with exact counts over the whole file.
CREATE TABLE IF NOT EXISTS signatures (
  id          text PRIMARY KEY,
  level       text NOT NULL,
  service     text NOT NULL,
  template    text NOT NULL,
  sample      text NOT NULL,
  count       integer NOT NULL,
  first_line  integer NOT NULL,
  last_line   integer NOT NULL,
  first_ts    timestamptz NOT NULL,
  last_ts     timestamptz NOT NULL,
  top_tenants jsonb,                       -- [[tenant, count], ...]
  top_pods    jsonb,
  embedding   vector(768)
);

-- One row per minute: counts from the production parsers plus a digest that is embedded for search.
CREATE TABLE IF NOT EXISTS minutes (
  bucket     timestamptz PRIMARY KEY,
  lines      integer NOT NULL,
  errors     integer NOT NULL,
  warns      integer NOT NULL,
  flagged    boolean NOT NULL,             -- anomaly gate verdict
  rules      text[],
  digest     text NOT NULL,
  embedding  vector(768)
);

-- Incidents found by the pipeline (deterministic evidence + LLM explanation).
CREATE TABLE IF NOT EXISTS incidents (
  id         text PRIMARY KEY,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  title      text NOT NULL,
  summary    text,
  doc        jsonb NOT NULL
);

-- Ask: answer cache and per-visitor daily quota.
CREATE TABLE IF NOT EXISTS ask_cache (
  question   text PRIMARY KEY,             -- normalised question
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ask_usage (
  visitor    text NOT NULL,                -- salted hash of the client IP
  day        date NOT NULL,
  count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor, day)
);
