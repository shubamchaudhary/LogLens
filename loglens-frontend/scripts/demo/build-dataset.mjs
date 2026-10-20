#!/usr/bin/env node
// Turns the pipeline outputs for the 1 GB log into incidents and the frontend fixture.
//
// Inputs (scripts/demo/.data/):
//   windows.json      PRODUCTION Layer-1 output (chunker, 8 parsers, robust anomaly gate)
//                     from WindowEvalCli; the anomaly flags and per-minute counts come from here
//   signatures.json, minutes.json, events.jsonl, index.json   from extract.mjs
//   meta.json         from generate_log.py (file facts; the ground truth in it is only
//                     used to print a check at the end, never to build incidents)
//
// Incidents are built deterministically: flagged minutes close together form a
// cluster; failure types whose rate in the cluster is ≥10× their rate elsewhere are
// its signatures; rare events shortly before (deploys, warnings, failovers) are its
// suspects. enrich-incidents.mjs then has an LLM write the explanation.
//
// Outputs: src/demo/fixture.json, .data/incidents.json, api/_lib/log-index.json

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '.data');
const read = (f) => JSON.parse(readFileSync(resolve(DATA, f), 'utf8'));

const meta = read('meta.json');
const cli = read('windows.json');
const sigs = read('signatures.json');
const index = read('index.json');
const sigById = new Map(sigs.map((s) => [s.id, s]));

const MIN = 60_000;
const ms = (iso) => Date.parse(iso);
const minuteIso = (t) => new Date(Math.floor(t / MIN) * MIN).toISOString().replace('.000Z', 'Z');

// ---- per-minute series from the production parsers -------------------------
const buckets = new Map();
for (const w of cli.windows) {
  let b = buckets.get(w.bucket);
  if (!b) {
    b = { bucket: w.bucket, lines: 0, errors: 0, warns: 0, flagged: false, chunks: 0, reasons: {} };
    buckets.set(w.bucket, b);
  }
  b.chunks++;
  for (const m of w.metrics) {
    if (m.category === 'TRAFFIC' && m.metric === 'lines') b.lines += m.count;
    if (m.category === 'ERRORS' && m.metric === 'errors') b.errors += m.count;
    if (m.category === 'LEVEL' && m.metric === 'warn_lines') b.warns += m.count;
  }
  if (w.anomalous) {
    b.flagged = true;
    for (const r of w.reasons) b.reasons[r] = (b.reasons[r] || 0) + 1;
  }
}
const series = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

const flaggedChunks = cli.windows.filter((w) => w.anomalous);
const rules = {};
for (const w of flaggedChunks) for (const r of w.reasons) rules[r] = (rules[r] || 0) + 1;
const metricRows = cli.windows.reduce((s, w) => s + w.metrics.length, 0);
const stats = {
  lines: cli.lines,
  bytes: meta.bytes,
  parts: Math.ceil(meta.bytes / 5_242_880), // loglens.ingest.part-target-bytes
  chunks: cli.windows.length,
  minutes: series.length,
  flaggedMinutes: series.filter((b) => b.flagged).length,
  flaggedChunks: flaggedChunks.length,
  llmCallsGated: flaggedChunks.reduce((s, w) => s + w.llmCalls, 0),
  llmCallsUngated: cli.windows.reduce((s, w) => s + w.llmCalls, 0),
  embedBatches: Math.ceil(cli.windows.length / 80),
  metricRows,
  errorLines: series.reduce((s, b) => s + b.errors, 0),
  warnLines: series.reduce((s, b) => s + b.warns, 0),
  layer1Millis: cli.layer1Millis,
  anomalyRules: rules,
};
stats.workItems = stats.flaggedChunks + stats.embedBatches;

// ---- events by signature (line numbers + timestamps) ------------------------
const occurrences = new Map(); // sig -> [{line, t}]
const rl = createInterface({ input: createReadStream(resolve(DATA, 'events.jsonl')), crlfDelay: Infinity });
const allEvents = [];
for await (const line of rl) {
  const e = JSON.parse(line);
  allEvents.push(e);
  let list = occurrences.get(e.signature);
  if (!list) occurrences.set(e.signature, (list = []));
  list.push({ line: e.line_no, t: ms(e.ts) });
}

// ---- clusters of flagged minutes -------------------------------------------
const flaggedTimes = series.filter((b) => b.flagged).map((b) => ms(b.bucket));
const clusters = [];
for (const t of flaggedTimes) {
  const c = clusters.at(-1);
  if (c && t - c.end <= 3 * MIN) c.end = t;
  else clusters.push({ start: t, end: t });
}

const totalMinutes = series.length;
function elevated(c) {
  const from = c.start - 2 * MIN;
  const to = c.end + 3 * MIN;
  const span = (to - from) / MIN;
  const out = [];
  for (const s of sigs) {
    const occ = occurrences.get(s.id) || [];
    const inside = occ.filter((o) => o.t >= from && o.t < to).length;
    if (inside < 5) continue;
    const baseline = (occ.length - inside) / Math.max(1, totalMinutes - span);
    const ratio = inside / span / Math.max(baseline, 0.05);
    if (ratio >= 10) out.push({ id: s.id, inside, ratio });
  }
  return out.sort((a, b) => b.inside - a.inside);
}

// Merge clusters that share failure types and are close (one incident can flag in bursts).
const scored = clusters.map((c) => ({ ...c, sigs: elevated(c) })).filter((c) => c.sigs.length);
const merged = [];
for (const c of scored) {
  const prev = merged.at(-1);
  if (prev && c.start - prev.end <= 20 * MIN && c.sigs.some((s) => prev.sigs.some((p) => p.id === s.id || sigById.get(p.id).service === sigById.get(s.id).service))) {
    prev.end = c.end;
    prev.sigs = elevated(prev);
  } else merged.push(c);
}
const dismissed = clusters.length - scored.length;

// ---- incidents ----------------------------------------------------------------
const SEV = (s) => (s.level === 'ERROR' ? 2 : s.level === 'WARN' ? 1 : 0);
const rare = new Set(sigs.filter((s) => s.count <= 5).map((s) => s.id));
const eventByLine = new Map();

const incidents = merged.map((c, i) => {
  const keep = c.sigs.slice(0, 8).map((x) => sigById.get(x.id));
  const services = [...new Set(keep.map((s) => s.service))];
  // exact span: first/last occurrence of the kept failure types near the cluster
  const near = (s) => (occurrences.get(s.id) || []).filter((o) => o.t >= c.start - 15 * MIN && o.t < c.end + 15 * MIN);
  const spans = keep.map((s) => near(s));
  const start = Math.min(...spans.map((o) => o[0].t));
  const end = Math.max(...spans.map((o) => o.at(-1).t));

  const failures = keep
    .map((s, k) => {
      const o = spans[k];
      return {
        id: s.id,
        level: s.level,
        service: s.service,
        template: s.template,
        sample: s.sample,
        count: o.length,
        totalCount: s.count,
        first: new Date(o[0].t).toISOString(),
        last: new Date(o.at(-1).t).toISOString(),
        firstLine: o[0].line,
        lastLine: o.at(-1).line,
      };
    })
    .sort((a, b) => SEV(b) - SEV(a) || b.count - a.count);

  // Rare events shortly before / during / right after: deploys, cert warnings, failovers, config changes.
  const mentions = (e) => services.some((svc) => e.message.includes(svc)) || services.includes(e.service);
  const redisRelated = keep.some((s) => /redis|lettuce/i.test(s.template));
  const context = allEvents.filter(
    (e) =>
      rare.has(e.signature) &&
      ms(e.ts) >= start - 90 * MIN &&
      ms(e.ts) <= end + 5 * MIN &&
      (mentions(e) || (e.service === 'redis-sentinel' && redisRelated))
  );

  const evidence = [];
  const add = (e, role) => {
    if (!e || evidence.some((x) => x.line === e.line_no)) return;
    eventByLine.set(e.line_no, e);
    evidence.push({ line: e.line_no, role });
  };
  const byLine = (n) => allEvents.find((e) => e.line_no === n);
  for (const e of context.filter((e) => ms(e.ts) < start)) add(e, e.level === 'WARN' ? 'warning' : 'change');
  for (const f of failures.slice(0, 4)) add(byLine(f.firstLine), 'first');
  // Rarer failure types (restarts, crashes) say a lot per line; show their first occurrence too.
  for (const f of failures.slice(4).filter((f) => f.count <= 50).slice(0, 2)) add(byLine(f.firstLine), 'first');
  // One complete multi-line record (stack trace / Detail) of the worst failure type that has one.
  const traced = failures.find((f) => allEvents.some((e) => e.signature === f.id && e.line_end > e.line_no));
  const withTrace =
    traced && allEvents.find((e) => e.signature === traced.id && e.line_end > e.line_no && ms(e.ts) >= start && ms(e.ts) <= end);
  add(withTrace, 'sample');
  for (const e of context.filter((e) => ms(e.ts) >= start)) add(e, e.level === 'WARN' ? 'event' : 'fix');
  add(byLine(failures[0].lastLine), 'last');
  evidence.sort((a, b) => a.line - b.line);

  // Who was affected: tenants and user-facing endpoints among the failing records.
  const failingIds = new Set(failures.map((f) => f.id));
  const inRange = allEvents.filter((e) => failingIds.has(e.signature) && ms(e.ts) >= start && ms(e.ts) <= end);
  const tenants = new Set(inRange.map((e) => e.tenant).filter((t) => t && t !== '-' && t !== 'system'));
  const endpoints = {};
  for (const e of inRange.filter((e) => e.service === 'api-gateway')) {
    const m = /(GET|POST|PUT|DELETE) (\/[^\s?]+)\S* status=(\d+)/.exec(e.message);
    if (m) endpoints[`${m[1]} ${m[2]} → ${m[3]}`] = (endpoints[`${m[1]} ${m[2]} → ${m[3]}`] || 0) + 1;
  }
  const perMinute = {};
  for (const e of inRange) {
    const k = minuteIso(ms(e.ts));
    perMinute[k] = (perMinute[k] || 0) + 1;
  }
  const peak = Object.entries(perMinute).sort((a, b) => b[1] - a[1])[0];
  const userFacing = Object.values(endpoints).reduce((s, n) => s + n, 0);
  const severity =
    keep.some((s) => /OutOfMemoryError|OOMKilled/.test(s.template)) || userFacing >= 1000
      ? 'CRITICAL'
      : keep.some((s) => s.level === 'ERROR')
        ? 'ERROR'
        : 'WARN';

  return {
    id: `inc-${i + 1}`,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    severity,
    title: `${failures[0].service}: ${failures[0].template.replace(/<n>/g, 'N').slice(0, 90)}`, // replaced by the LLM
    summary: null,
    causes: [],
    impact: null,
    fix: [],
    services,
    failingLines: inRange.length,
    peak: peak ? { minute: peak[0], lines: peak[1] } : null,
    tenants: tenants.size,
    endpoints: Object.entries(endpoints)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => ({ endpoint: k, count: n })),
    flaggedMinutes: series.filter((b) => b.flagged && ms(b.bucket) >= c.start && ms(b.bucket) <= c.end).length,
    llmCalls: flaggedChunks.filter((w) => ms(w.bucket) >= c.start && ms(w.bucket) <= c.end).reduce((n, w) => n + w.llmCalls, 0),
    failures,
    evidence: evidence.map((x) => {
      const e = eventByLine.get(x.line);
      return { line: e.line_no, lineEnd: e.line_end, ts: e.ts, level: e.level, service: e.service, role: x.role, text: e.body };
    }),
  };
});

// ---- fixture -----------------------------------------------------------------
const fixture = {
  product: 'DeepLogLens',
  file: {
    name: meta.file,
    bytes: meta.bytes,
    lines: meta.lines,
    sha256: meta.sha256,
    from: meta.start,
    to: meta.end,
    services: index.services.length,
    tenants: index.tenants.length,
  },
  stats,
  timeline: series.map((b) => ({ bucket: b.bucket, lines: b.lines, errors: b.errors, warns: b.warns, flagged: b.flagged })),
  incidents,
  suggestions: [
    'Why did checkout return 503s after 10:40?',
    'How many payment authorizations failed, and why?',
    'Which tenants use this platform, and how much traffic does each send?',
    'What does notification-service do, and what does it depend on?',
    'What happened right before search-service started crashing?',
    'Which deployments happened that day?',
  ],
  session: {
    id: '5d1c3a9e-7b42-4f0e-9c61-2a8d4e6f0b17',
    title: 'shop-prod · all services · 15 Jul',
    analysisStatus: 'DONE',
    totalWindows: stats.workItems,
    enrichedWindows: stats.workItems,
    errorMessage: null,
    createdAt: meta.end,
    updatedAt: meta.end,
  },
};

writeFileSync(resolve(here, '../../src/demo/fixture.json'), JSON.stringify(fixture) + '\n');
writeFileSync(resolve(DATA, 'incidents.json'), JSON.stringify(incidents, null, 1));
writeFileSync(
  resolve(here, '../../api/_lib/log-index.json'),
  JSON.stringify({ name: meta.file, sha256: meta.sha256, bytes: index.bytes, lines: index.lines, every: index.every, offsets: index.offsets })
);

console.log(
  `${series.length} minutes, ${stats.flaggedMinutes} flagged (${stats.flaggedChunks}/${stats.chunks} chunks), ` +
    `${clusters.length} clusters → ${incidents.length} incidents (${dismissed} dismissed as background noise); ` +
    `LLM calls ${stats.llmCallsGated} gated vs ${stats.llmCallsUngated} ungated`
);
for (const inc of incidents) {
  const truth = meta.incidents.find((t) => ms(t.start) <= ms(inc.end) && ms(t.end) >= ms(inc.start));
  console.log(
    `  ${inc.id} ${inc.start.slice(11, 19)}–${inc.end.slice(11, 19)} ${inc.severity} failing=${inc.failingLines} ` +
      `types=${inc.failures.length} evidence=${inc.evidence.length} ↔ truth: ${truth ? truth.key : 'NONE'}`
  );
}
const missed = meta.incidents.filter((t) => !incidents.some((inc) => ms(t.start) <= ms(inc.end) && ms(t.end) >= ms(inc.start)));
console.log(`missed ground-truth incidents: ${missed.map((t) => t.key).join(', ') || 'none'}`);
