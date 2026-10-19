#!/usr/bin/env node
// Builds src/demo/fixture.json, the data the in-browser demo replays.
//
// Inputs:
//   - the sample log (evals/datasets/owner_sample_10k.log)
//   - windows.json: the PRODUCTION Layer-1 output for that log (chunker, the
//     parsers, AnomalyDetector), produced by WindowEvalCli:
//       ./gradlew :loglens-backend:printTestClasspath
//       java -cp "$(cat loglens-backend/build/test-classpath.txt)" com.loglens.ingest.WindowEvalCli \
//         evals/datasets/owner_sample_10k.log loglens-frontend/scripts/demo/windows.json 60 5000 robust
//   - narratives.mjs: the hand-written AI text, with placeholders for numbers
//
// So metrics, anomaly flags and LLM-call counts are real; counts, time ranges,
// tenants and hosts quoted in the prose are computed from the log here.
//
// Usage (from loglens-frontend/): node scripts/demo/build-fixture.mjs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as narratives from './narratives.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOG = resolve(here, '../../../evals/datasets/owner_sample_10k.log');
const WINDOWS = resolve(here, 'windows.json');
const OUT = resolve(here, '../../src/demo/fixture.json');

const SESSION_ID = '5d1c3a9e-7b42-4f0e-9c61-2a8d4e6f0b17';
const DOCUMENT_ID = '8e2f6b10-3c5d-4a7e-b9f1-0d4c2e8a6b35';
const EMBED_BATCH_SIZE = 80; // loglens.embedding.batch-size default
const SEVERITY_ORDER = { CRITICAL: 0, ERROR: 1, WARN: 2, INFO: 3 };

/** Deterministic UUID (v4 layout) from a string, so ids are stable across rebuilds. */
function uuidOf(s) {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (\w+) \[([\w-]+)\].*?tenantId=(\S+).*?host=(\S+)/;

const raw = readFileSync(LOG, 'utf8').split('\n');
if (raw.at(-1) === '') raw.pop();
const lines = raw.map((text, i) => {
  const m = LINE.exec(text);
  return {
    no: i + 1,
    text,
    iso: m ? `${m[1]}T${m[2]}Z` : null,
    time: m ? m[2] : null,
    level: m ? m[3] : null,
    tenant: m ? m[5] : null,
    host: m ? m[6] : null,
  };
});

const cli = JSON.parse(readFileSync(WINDOWS, 'utf8'));
const windows = cli.windows.map((w) => ({ ...w, chunkId: uuidOf(`chunk:${w.bucket}`) }));
const windowByHHMM = new Map(windows.map((w) => [w.bucket.slice(11, 16), w]));
const windowOfLine = (no) => windows.find((w) => no >= w.lineStart && no <= w.lineEnd);

// ---- metrics: the /metrics API shape, one row per (bucket, category, metric) ----
const metrics = windows
  .flatMap((w) =>
    w.metrics.map((m) => ({
      timeBucket: w.bucket,
      category: m.category,
      metric: m.metric,
      count: m.count,
      sumMs: m.sumMs,
      avgMs: m.avgMs,
      p95Ms: m.p95Ms,
      sampleChunkIds: [w.chunkId],
    }))
  )
  .sort((a, b) =>
    a.timeBucket.localeCompare(b.timeBucket) || a.category.localeCompare(b.category) || a.metric.localeCompare(b.metric)
  );

const total = (cat, metric) =>
  metrics.filter((m) => m.category === cat && m.metric === metric).reduce((s, m) => s + m.count, 0);

const flagged = windows.filter((w) => w.anomalous);
const embedBatches = Math.ceil(windows.length / EMBED_BATCH_SIZE);
const reasonCounts = {};
for (const w of flagged) for (const r of w.reasons) reasonCounts[r] = (reasonCounts[r] || 0) + 1;

const stats = {
  lines: cli.lines,
  bytes: statSync(LOG).size,
  windows: windows.length,
  flagged: flagged.length,
  llmCallsGated: flagged.reduce((s, w) => s + w.llmCalls, 0),
  llmCallsUngated: windows.reduce((s, w) => s + w.llmCalls, 0),
  embedBatches,
  workItems: flagged.length + embedBatches,
  metricRows: metrics.length,
  parts: 1, // 1.6 MB file, loglens.ingest.part-target-bytes = 5 MB
  layer1Millis: cli.layer1Millis,
  errorLines: total('ERRORS', 'errors'),
  warnLines: total('LEVEL', 'warn_lines'),
  anomalyRules: reasonCounts,
  flaggedWindows: flagged.map((w) => ({ bucket: w.bucket, reasons: w.reasons, llmCalls: w.llmCalls })),
};

// ---- findings: matched against the log, so counts/ranges/evidence are real ----
const uniq = (xs) => [...new Set(xs)].sort();
const facts = {};
const findings = narratives.findings.map((f) => {
  const hits = lines.filter((l) => f.match.test(l.text));
  if (hits.length === 0) throw new Error(`finding ${f.key} matches no lines`);
  const evidence = uniq(hits.map((l) => windowOfLine(l.no).bucket))
    .map((b) => windows.find((w) => w.bucket === b))
    .sort((a, b) => Number(b.anomalous) - Number(a.anomalous) || a.bucket.localeCompare(b.bucket))
    .slice(0, 3)
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
  facts[f.key] = {
    n: hits.length,
    start: hits[0].time,
    end: hits.at(-1).time,
    startIso: hits[0].iso,
    endIso: hits.at(-1).iso,
    tenants: uniq(hits.map((l) => l.tenant)),
    hosts: uniq(hits.map((l) => l.host)),
  };
  return { def: f, evidence };
});

const fmtInt = (n) => n.toLocaleString('en-US');
const joinList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function metricsTable() {
  const peak = (cat, metric) => {
    const rows = metrics.filter((m) => m.category === cat && m.metric === metric);
    const top = rows.reduce((a, b) => (b.count > a.count ? b : a), rows[0]);
    return top ? `${fmtInt(top.count)} at ${top.timeBucket.slice(11, 16)}` : '—';
  };
  const gc = metrics.filter((m) => m.category === 'PERFORMANCE' && m.metric === 'gc_pause_ms');
  const rows = [
    ['Log lines (TRAFFIC.lines)', fmtInt(stats.lines), '—'],
    ['ERROR lines (ERRORS.errors)', fmtInt(stats.errorLines), peak('ERRORS', 'errors')],
    ['WARN lines (LEVEL.warn_lines)', fmtInt(stats.warnLines), peak('LEVEL', 'warn_lines')],
    ['401 responses (AUTH.auth_401)', fmtInt(total('AUTH', 'auth_401')), peak('AUTH', 'auth_401')],
    ['403 responses (AUTH.auth_403)', fmtInt(total('AUTH', 'auth_403')), peak('AUTH', 'auth_403')],
    ['OutOfMemoryError (PERFORMANCE.oom)', fmtInt(total('PERFORMANCE', 'oom')), peak('PERFORMANCE', 'oom')],
    [
      'GC pauses (PERFORMANCE.gc_pause_ms)',
      `${fmtInt(total('PERFORMANCE', 'gc_pause_ms'))}, p95 ${fmtInt(Math.max(...gc.map((m) => m.p95Ms)))} ms`,
      peak('PERFORMANCE', 'gc_pause_ms'),
    ],
    ['Deploys (LIFECYCLE.deploys)', fmtInt(total('LIFECYCLE', 'deploys')), peak('LIFECYCLE', 'deploys')],
    ['Windows flagged by the anomaly gate', `${stats.flagged} of ${stats.windows}`, '—'],
  ];
  return ['| Metric | Value | Peak minute (UTC) |', '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`)].join(
    '\n'
  );
}

function fill(text) {
  return text.replace(/\{\{(\w+)(?::(\w+))?\}\}/g, (all, kind, key) => {
    if (kind === 'metricsTable') return metricsTable();
    if (kind === 'stat') {
      if (!(key in stats)) throw new Error(`unknown stat ${key}`);
      return fmtInt(stats[key]);
    }
    const f = facts[key];
    if (!f) throw new Error(`unknown finding key in ${all}`);
    switch (kind) {
      case 'n':
        return fmtInt(f.n);
      case 'start':
        return f.start;
      case 'end':
        return f.end;
      case 'range':
        return `${f.start}–${f.end} UTC`;
      case 'tenants':
        return joinList(f.tenants);
      case 'tenantCount':
        return String(f.tenants.length);
      case 'hosts':
        return joinList(f.hosts);
      default:
        throw new Error(`unknown placeholder ${all}`);
    }
  });
}

const CREATED = '2026-07-15T11:52:41Z';
const findingRows = findings
  .map(({ def, evidence }) => ({
    id: uuidOf(`finding:${def.key}`),
    category: def.category,
    severity: def.severity,
    title: def.title,
    explanation: fill(def.explanation),
    evidenceChunkIds: evidence.map((w) => w.chunkId),
    timeRangeStart: facts[def.key].startIso,
    timeRangeEnd: facts[def.key].endIso,
    occurrenceCount: facts[def.key].n,
    confidence: def.confidence,
    createdAt: CREATED,
  }))
  .sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.timeRangeStart.localeCompare(b.timeRangeStart)
  );

const incidentRows = narratives.incidents
  .map((inc) => {
    const fs = inc.findings.map((k) => facts[k]);
    return {
      id: uuidOf(`incident:${inc.key}`),
      timeRangeStart: fs.map((f) => f.startIso).sort()[0],
      timeRangeEnd: fs.map((f) => f.endIso).sort().at(-1),
      findingIds: inc.findings.map((k) => uuidOf(`finding:${k}`)),
      narrative: fill(inc.narrative),
      rootCauseHypothesis: fill(inc.rootCause),
      createdAt: CREATED,
    };
  })
  .sort((a, b) => a.timeRangeStart.localeCompare(b.timeRangeStart));

const qa = narratives.qa.map((q) => ({
  question: q.question,
  keywords: q.keywords,
  answer: fill(q.answer),
  citations: q.cite.map((hhmm) => {
    const w = windowByHHMM.get(hhmm);
    if (!w) throw new Error(`no window at ${hhmm}`);
    return w.chunkId;
  }),
  trace: q.trace,
}));

// ---- evidence: raw chunk rows for every window the UI can cite ----
const cited = new Set([...findingRows.flatMap((f) => f.evidenceChunkIds), ...qa.flatMap((q) => q.citations)]);
const chunks = {};
for (const w of windows) {
  if (!cited.has(w.chunkId)) continue;
  chunks[w.chunkId] = {
    chunkId: w.chunkId,
    documentId: DOCUMENT_ID,
    timeBucket: w.bucket,
    lineStart: w.lineStart,
    lineEnd: w.lineEnd,
    content: lines.slice(w.lineStart - 1, w.lineEnd).map((l) => l.text).join('\n'),
    anomalous: w.anomalous,
  };
}

const fixture = {
  provenance: {
    kind: 'sample', // 'recorded' once capture-fixture.mjs has replaced the AI text with a live run
    metrics: 'Production Layer-1 code (chunker, parsers, AnomalyDetector) run by WindowEvalCli on this file',
    narratives: 'Hand-written in the pipeline output format; numbers in them are computed from the file',
  },
  file: {
    name: basename(LOG),
    bytes: stats.bytes,
    lines: stats.lines,
    services: uniq(raw.map((t) => /\[([\w-]+)\]/.exec(t)?.[1]).filter(Boolean)).length,
    tenants: uniq(lines.map((l) => l.tenant).filter(Boolean)).length,
    from: lines.find((l) => l.iso).iso,
    to: lines.findLast((l) => l.iso).iso,
  },
  stats,
  session: {
    id: SESSION_ID,
    title: 'checkout-platform · prod · 15 Jul',
    analysisStatus: 'DONE',
    totalWindows: stats.workItems,
    enrichedWindows: stats.workItems,
    errorMessage: null,
    createdAt: '2026-07-15T11:52:10Z',
    updatedAt: CREATED,
  },
  documentId: DOCUMENT_ID,
  metrics,
  findings: findingRows,
  incidents: incidentRows,
  report: { generatedAt: CREATED, contentMd: fill(narratives.report) },
  chunks,
  qa,
};

writeFileSync(OUT, JSON.stringify(fixture) + '\n');
console.log(
  `wrote ${OUT}: ${metrics.length} metric rows, ${findingRows.length} findings, ${incidentRows.length} incidents, ` +
    `${Object.keys(chunks).length} chunks, ${qa.length} answers; ${stats.flagged}/${stats.windows} windows flagged, ` +
    `${stats.llmCallsGated} vs ${stats.llmCallsUngated} LLM calls`
);
