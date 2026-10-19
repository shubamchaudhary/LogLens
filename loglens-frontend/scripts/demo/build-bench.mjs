#!/usr/bin/env node
// Turns the ingest benchmark results (bench/results/ in the repo root) into the small
// src/demo/bench.json the landing page and the "Under the hood" tab chart.
//
//   heap   jstat heap-used samples over each run (the sawtooth), downsampled
//   live   the heap left after each full GC, read from the GC log: the memory the
//          program actually holds. Metadata-threshold pauses at startup are skipped.
//
// Usage (from loglens-frontend/): node scripts/demo/build-bench.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(here, '../../../bench/results');
const read = (f) => JSON.parse(readFileSync(resolve(RESULTS, f), 'utf8'));

const SIZE = { 'bench_100m.log': '100 MB', 'bench_500m.log': '500 MB', 'bench_1g.log': '1 GB', 'bench_2g.log': '2 GB' };
const MAX_POINTS = 500; // keep every sample: decimating a sawtooth drops its peaks

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function liveSet(run) {
  const log = readFileSync(resolve(RESULTS, `gc/ingest-${run.file}-${run.heap_xmx}-c${run.part_concurrency}.full-gc.txt`), 'utf8');
  const after = [...log.matchAll(/Pause Full \((?!Metadata)[^)]*\) \d+M->(\d+)M/g)].map((m) => Number(m[1]));
  return { max: Math.max(...after), median: Math.floor(median(after)), fullGcs: after.length };
}

function view(run) {
  const step = Math.max(1, Math.ceil(run.heap_series.length / MAX_POINTS));
  return {
    size: SIZE[run.file],
    xmxMb: Number.parseInt(run.heap_xmx, 10) * (run.heap_xmx.endsWith('g') ? 1024 : 1),
    threads: run.part_concurrency,
    lines: run.lines_ingested,
    chunks: run.chunks,
    ingestS: run.ingest_s,
    mbPerS: run.mb_per_s,
    peakHeapMb: run.peak_heap_used_mb,
    peakRssMb: Math.round(run.peak_rss_mb),
    gcShare: Math.round((run.gc.total_ms / 1000 / run.ingest_s) * 1000) / 10,
    gcMaxPauseMs: Math.round(run.gc.max_ms),
    live: liveSet(run),
    heap: run.heap_series.filter((_, i) => i % step === 0).map(([t, mb]) => [Math.round(t), Math.round(mb)]),
  };
}

const ingest = read('ingest.json');
const parallel = read('parallelism.json');
const out = {
  source: 'bench/results (bench/ingest_bench.py, real backend jar, SerialGC, embeddings off, stub LLM)',
  date: ingest.runs[0].date.slice(0, 10),
  sizes: ingest.runs.map(view),
  threads: parallel.runs.map((r) => ({ threads: r.part_concurrency, mbPerS: r.mb_per_s, live: liveSet(r) })),
};

writeFileSync(resolve(here, '../../src/demo/bench.json'), JSON.stringify(out) + '\n');
for (const s of out.sizes) console.log(`${s.size}: live set ${s.live.max}/${s.live.median} MB, peak heap ${s.peakHeapMb} MB, ${s.heap.length} points`);
for (const t of out.threads) console.log(`${t.threads} threads: live set ${t.live.max} MB, ${t.mbPerS} MB/s`);
