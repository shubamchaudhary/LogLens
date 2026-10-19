#!/usr/bin/env node
// Loads the showcase database (any Postgres with pgvector, e.g. Neon) from the
// outputs of extract.mjs / build-dataset.mjs / enrich-incidents.mjs, and embeds
// failure types and per-minute digests with Gemini (gemini-embedding-001, 768-d).
//
//   npm run demo:generate && npm run demo:extract     # ~75 s, recreates .data/
//   DATABASE_URL=... GEMINI_API_KEYS=... node scripts/demo/load-db.mjs
//
// Re-runnable: it truncates and reloads everything except ask_usage.

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { embed, vec } from '../../api/_lib/llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '.data');
const read = (f) => JSON.parse(readFileSync(resolve(DATA, f), 'utf8'));

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

await client.query(readFileSync(resolve(here, '../../db/schema.sql'), 'utf8'));
await client.query('TRUNCATE log_events, signatures, minutes, incidents, ask_cache');
step('schema ready');

// ---- log events (batched multi-row inserts) ----------------------------------
const COLS = ['line_no', 'line_end', 'ts', 'level', 'service', 'pod', 'tenant', 'logger', 'message', 'body', 'signature'];
const tenantsBySig = new Map();
const podsBySig = new Map();
const bump = (map, sig, key) => {
  if (!key || key === '-' || key === 'system') return;
  const m = map.get(sig) || new Map();
  m.set(key, (m.get(key) || 0) + 1);
  map.set(sig, m);
};
let batch = [];
let loaded = 0;
async function flush() {
  if (!batch.length) return;
  const params = [];
  const rows = batch.map((e, i) => {
    COLS.forEach((c) => params.push(e[c]));
    return `(${COLS.map((_, j) => `$${i * COLS.length + j + 1}`).join(',')})`;
  });
  await client.query(`INSERT INTO log_events (${COLS.join(',')}) VALUES ${rows.join(',')}`, params);
  loaded += batch.length;
  batch = [];
}
const rl = createInterface({ input: createReadStream(resolve(DATA, 'events.jsonl')), crlfDelay: Infinity });
for await (const line of rl) {
  const e = JSON.parse(line);
  bump(tenantsBySig, e.signature, e.tenant);
  bump(podsBySig, e.signature, e.pod);
  batch.push(e);
  if (batch.length === 1000) {
    await flush();
    if (loaded % 20000 === 0) step(`${loaded} events`);
  }
}
await flush();
step(`${loaded} events loaded`);

// ---- failure types ----------------------------------------------------------------
const sigs = read('signatures.json');
const top = (map, id) => [...(map.get(id) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const sigVecs = await embed(sigs.map((s) => `${s.level} ${s.service} ${s.logger}: ${s.sample}`));
for (const [i, s] of sigs.entries()) {
  await client.query(
    `INSERT INTO signatures (id, level, service, template, sample, count, first_line, last_line, first_ts, last_ts,
                             top_tenants, top_pods, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector)`,
    [s.id, s.level, s.service, s.template, s.sample, s.count, s.firstLine, s.lastLine, s.firstTs, s.lastTs,
      JSON.stringify(top(tenantsBySig, s.id)), JSON.stringify(top(podsBySig, s.id)), vec(sigVecs[i])]
  );
}
step(`${sigs.length} failure types embedded`);

// ---- minutes: production counts + a digest of what happened that minute ------------
const fixture = JSON.parse(readFileSync(resolve(here, '../../src/demo/fixture.json'), 'utf8'));
const extractMinutes = new Map(read('minutes.json').map((m) => [m.bucket, m]));
const sigById = new Map(sigs.map((s) => [s.id, s]));
// Rules that fired per minute come from the parser run; it is optional here (slow to
// recompute), the flagged/unflagged verdict itself is already in the fixture timeline.
const flagReasons = new Map();
const windowsFile = resolve(DATA, 'windows.json');
if (existsSync(windowsFile)) {
  for (const w of read('windows.json').windows) {
    if (!w.anomalous) continue;
    const set = flagReasons.get(w.bucket) || new Set();
    w.reasons.forEach((r) => set.add(r));
    flagReasons.set(w.bucket, set);
  }
}
const minutes = fixture.timeline.map((b) => {
  const m = extractMinutes.get(b.bucket);
  const topSigs = Object.entries(m?.sigs || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, n]) => `${sigById.get(id).service} ${sigById.get(id).level}: ${sigById.get(id).sample.slice(0, 160)} (×${n})`);
  const rules = [...(flagReasons.get(b.bucket) || [])];
  const digest =
    `${b.bucket.slice(11, 16)} UTC on 15 Jul 2026: ${b.lines} log lines, ${b.errors} ERROR, ${b.warns} WARN. ` +
    (b.flagged ? `Anomaly gate flagged this minute (${rules.join(', ')}). ` : '') +
    (topSigs.length ? `Most frequent: ${topSigs.join('; ')}` : 'No warnings or errors.');
  return { ...b, rules, digest };
});
const minVecs = await embed(minutes.map((m) => m.digest));
for (const [i, m] of minutes.entries()) {
  await client.query(
    `INSERT INTO minutes (bucket, lines, errors, warns, flagged, rules, digest, embedding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
    [m.bucket, m.lines, m.errors, m.warns, m.flagged, m.rules, m.digest, vec(minVecs[i])]
  );
}
step(`${minutes.length} minutes embedded`);

// ---- incidents ------------------------------------------------------------------------
for (const inc of fixture.incidents) {
  await client.query(`INSERT INTO incidents (id, starts_at, ends_at, title, summary, doc) VALUES ($1,$2,$3,$4,$5,$6)`, [
    inc.id,
    inc.start,
    inc.end,
    inc.title,
    inc.summary,
    JSON.stringify({ ...inc, signatures: inc.failures.map((f) => ({ id: f.id })), evidence: inc.evidence.map((e) => ({ line: e.line, role: e.role })) }),
  ]);
}
step(`${fixture.incidents.length} incidents`);
await client.query('ANALYZE');
await client.end();
step('done');
