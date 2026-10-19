import pg from 'pg';

// One small pool per function instance. Serverless instances are reused between
// requests, so the pool lives at module scope; max 2 keeps a free-tier Postgres
// (Neon) well under its connection limit even when many instances are warm.
let pool;

export function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10_000, // TLS comes from the URL (?sslmode=require), certificates verified
  });
  return pool;
}
