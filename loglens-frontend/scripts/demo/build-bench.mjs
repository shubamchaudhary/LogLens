#!/usr/bin/env node
// Turns the measured results in the repo root (bench/results, evals/results) into the
// small src/demo/bench.json the landing page, the benchmarks page and the
// "Under the hood" tab render. Nothing here is typed by hand.
//
//   sizes / threads   ingest runs: jstat heap samples (the GC sawtooth) and the live set,
//                     the heap left after each full GC (read from the GC logs; the
//                     Metadata-threshold pauses at startup are skipped)
//   vector            recall@10 and latency per table layout at ef_search 40
//   chaos, replay     fault-injection runs on the current build
//   robustness        bad-input runs on the current build
//   gate, retrieval   the anomaly-gate and retrieval evals
//
// Usage (from loglens-frontend/): node scripts/demo/build-bench.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const read = (f) => JSON.parse(readFileSync(resolve(ROOT, f), 'utf8'));

const SIZE = { 'bench_100m.log': '100 MB', 'bench_500m.log': '500 MB', 'bench_1g.log': '1 GB', 'bench_2g.log': '2 GB' };
const MAX_POINTS = 500; // keep every sample: decimating a sawtooth drops its peaks

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function liveSet(run) {
  const log = readFileSync(resolve(ROOT, `bench/results/gc/ingest-${run.file}-${run.heap_xmx}-c${run.part_concurrency}.full-gc.txt`), 'utf8');
  const after = [...log.matchAll(/Pause Full \((?!Metadata)[^)]*\) \d+M->(\d+)M/g)].map((m) => Number(m[1]));
  return { max: Math.max(...after), median: Math.floor(median(after)), fullGcs: after.length };
}

function run(r) {
  const step = Math.max(1, Math.ceil(r.heap_series.length / MAX_POINTS));
  return {
    size: SIZE[r.file],
    xmxMb: Number.parseInt(r.heap_xmx, 10) * (r.heap_xmx.endsWith('g') ? 1024 : 1),
    threads: r.part_concurrency,
    lines: r.lines_ingested,
    chunks: r.chunks,
    ingestS: r.ingest_s,
    mbPerS: r.mb_per_s,
    linesPerS: r.lines_per_s,
    peakHeapMb: r.peak_heap_used_mb,
    peakRssMb: Math.round(r.peak_rss_mb),
    live: liveSet(r),
    heap: r.heap_series.filter((_, i) => i % step === 0).map(([t, mb]) => [Math.round(t), Math.round(mb)]),
  };
}

const ingest = read('bench/results/ingest.json');
const parallel = read('bench/results/parallelism.json');
const vector = read('bench/results/vector_isolation.json');
const chaos = read('bench/results/chaos_after.json');
const replay = read('bench/results/chaos_replay_enrich_after.json');
const robust = read('bench/results/robustness_after.json');
const gate = read('evals/results/anomaly_gating_robust/results.json');
const retrieval = read('evals/results/retrieval/fix_lexical_or_focus_storedtsv/results.json');

const sizes = ingest.runs.map(run);
const baseMbPerS = parallel.runs[0].mb_per_s;
const chaosRow = (r) => ({
  scenario: r.scenario,
  events: r.events.length,
  chunks: r.result.chunks,
  lineSum: r.result.line_sum,
  metricSum: r.result.metric_count_sum,
  occurrences: r.result.finding_occurrences,
  enriched: `${r.result.enriched_windows}/${r.result.total_windows}`,
  status: r.result.status,
  skips: r.redelivery_skip_logs,
});

const out = {
  date: ingest.runs[0].date.slice(0, 10),
  setup: {
    hardware: '4 vCPU Xeon 2.1 GHz · 15 GB RAM · one VM for app, Postgres, Kafka and MinIO',
    jvm: 'OpenJDK 21 · SerialGC',
    stack: 'Kafka 3.8 (KRaft) · Postgres 16.10 + pgvector 0.8.0 · MinIO · stub LLM',
  },
  sizes,
  threads: parallel.runs.map((r) => ({
    threads: r.part_concurrency,
    ingestS: r.ingest_s,
    mbPerS: r.mb_per_s,
    speedup: Math.round((r.mb_per_s / baseMbPerS) * 100) / 100,
    linesPerS: r.lines_per_s,
    peakHeapMb: r.peak_heap_used_mb,
    peakRssMb: Math.round(r.peak_rss_mb),
    live: liveSet(r),
  })),
  vector: {
    vectors: vector.vectors,
    dim: vector.dim,
    model: vector.embed_model,
    rows: vector.results
      .filter((r) => r.ef_search === 40)
      .map((r) => ({ session: r.session, share: r.session_share, layout: r.layout, recall: r.recall_at_10, p50: r.p50_ms, p95: r.p95_ms })),
  },
  chaos: {
    file: chaos.file,
    bytes: chaos.bytes,
    // the enrich replay comes from its own run, measured to lag 0 (chaos_after's waited a fixed 40 s)
    rows: [
      ...chaos.runs.filter((r) => !['replay_ingest_before_part_fix', 'replay_enrich'].includes(r.scenario)),
      ...replay.runs.filter((r) => r.scenario === 'replay_enrich'),
    ].map(chaosRow),
  },
  robustness: robust.results.map((r) =>
    r.case === 'poison_message'
      ? { case: r.case, status: 'DLQ', note: `sent to the DLQ; next upload ${r.next_upload_status}` }
      : { case: r.case, bytes: r.bytes, status: r.status, seconds: r.seconds, lines: r.lines_stored, error: r.error }
  ),
  gate: {
    synthetic: gate.results.synthetic.map((d) => ({
      dataset: d.dataset,
      lines: d.lines,
      precision: d.window.precision,
      recall: d.window.recall,
      f1: d.window.f1,
      falseAlarmsPerHour: d.false_alarms_per_hour,
      incidentRecall: d.incident_recall,
      incidents: d.incidents.length,
      callReduction: d.gating?.call_reduction,
    })),
    heldout: gate.results.heldout.map((d) => ({ dataset: d.dataset, f1: d.window.f1, incidentRecall: d.incident_recall, callReduction: d.gating.call_reduction })),
    volume: gate.results.volume_sensitivity.map((d) => ({ linesPerS: d.lines_per_s, f1: d.window.f1, callReduction: d.gating.call_reduction })),
    bgl: (() => {
      const b = gate.results.loghub.find((d) => d.dataset.includes('BGL'));
      return { f1: b.window?.f1 ?? null, recall: b.window?.recall ?? null, callReduction: b.gating.call_reduction };
    })(),
    sample: { lines: gate.results.owner_sample.lines, callReduction: gate.results.owner_sample.gating.call_reduction },
  },
  retrieval: {
    questions: retrieval.meta.questions,
    model: retrieval.meta.embed_model,
    rows: Object.entries(retrieval.results.summary).map(([k, v]) => ({
      retriever: k,
      r5: v['recall@5'],
      r10: v['recall@10'],
      r30: v['recall@30'],
      mrr: v.mrr,
      p50: v.p50_ms,
      p95: v.p95_ms,
    })),
  },
};

writeFileSync(resolve(here, '../../src/demo/bench.json'), JSON.stringify(out) + '\n');
for (const s of out.sizes) console.log(`${s.size}: live set ${s.live.max}/${s.live.median} MB, peak heap ${s.peakHeapMb} MB, ${s.heap.length} points`);
for (const t of out.threads) console.log(`${t.threads} threads: live set ${t.live.max} MB, ${t.mbPerS} MB/s, ${t.speedup}x`);
console.log('gate synthetic', out.gate.synthetic.map((d) => `${d.dataset} f1=${d.f1} cut=${d.callReduction}`).join(' | '));
console.log('bgl', out.gate.bgl, 'chaos rows', out.chaos.rows.length, 'robustness', out.robustness.length, 'vector rows', out.vector.rows.length);
