// The replay timeline: the progress events the backend's SSE stream would send
// ({status, enriched, total}) plus a console line for each step the pipeline takes.
// Every count comes from the fixture (the production parsers' output for the
// sample file); only the timing is staged. ~20 s end to end.

import { fmtBytes } from '../utils/format';

const fmt = (n) => n.toLocaleString('en-US');
const hhmm = (iso) => iso.slice(11, 16);

export function buildReplay(f) {
  const s = f.stats;
  const total = s.workItems;
  const steps = [];
  let at = 0;
  const log = (stage, text, gap = 450) => {
    at += gap;
    steps.push({ at, log: { stage, text } });
  };
  const progress = (status, enriched = 0, gap = 0) => {
    at += gap;
    steps.push({ at, progress: { status, enriched, total: status === 'ENRICHING' || enriched ? total : 0 } });
  };

  progress('CHUNKING');
  log('upload', `presigned PUT → blob storage · ${fmtBytes(f.file.bytes)} straight from the browser`, 0);
  log('upload', 'confirm → 202 Accepted · pointer published to Kafka log.ingest.requests', 300);
  log('split', `splitter · one streaming pass → ${s.parts} window-aligned part (target 5 MB) → log.ingest.parts`, 900);

  progress('PARSING', 0, 700);
  log('parse', `part 1/${s.parts} · ranged GET → ${fmt(s.lines)} lines → ${s.windows} windows of 60 s`, 500);
  log('parse', `8 parsers (API, SQL, ERRORS, PERFORMANCE, AUTH, LIFECYCLE, TRAFFIC, SIGNATURE) → ${s.metricRows} metric rows`, 800);
  log('parse', 'commit · metrics + chunks + part marker in one transaction (a redelivery is a no-op)', 700);
  log('gate', `anomaly gate (robust rules) · ${s.flagged} of ${s.windows} windows flagged`, 700);
  const rules = Object.entries(s.anomalyRules)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => `${rule} ×${n}`)
    .join(' · ');
  log('gate', `rules fired: ${rules}`, 300);
  log(
    'gate',
    `finalizer · ${total} work items → llm.enrich.requests (${s.flagged} ENRICH_WINDOW + ${s.embedBatches} EMBED_BATCH)`,
    600
  );

  // Enrichment: one progress tick per work item, embeddings interleaved.
  progress('ENRICHING', 0, 500);
  const items = s.flaggedWindows.map((w) => ({
    stage: 'enrich',
    text: `enrich ${hhmm(w.bucket)} window · ${w.llmCalls} chat call${w.llmCalls === 1 ? '' : 's'} · ${w.reasons.join(', ')}`,
  }));
  for (let b = 0; b < s.embedBatches; b++) {
    const size = Math.min(80, s.windows - b * 80);
    items.splice(Math.round(((b + 1) * items.length) / (s.embedBatches + 1)), 0, {
      stage: 'embed',
      text: `embed batch ${b + 1}/${s.embedBatches} · ${size} chunks → 768-d vectors → pgvector`,
    });
  }
  items.forEach((item, i) => {
    log(item.stage, item.text, 420);
    steps.push({ at, progress: { status: 'ENRICHING', enriched: i + 1, total } });
  });
  const saved = Math.round((1 - s.llmCallsGated / s.llmCallsUngated) * 1000) / 10;
  log('enrich', `LLM calls: ${s.llmCallsGated} with the gate vs ${s.llmCallsUngated} without → ${saved}% fewer`, 400);

  progress('CORRELATING', total, 600);
  log('graph', `LangGraph · cluster ${f.findings.length} findings → correlate → ${f.incidents.length} incidents`, 900);
  log('graph', 'ground-check · an LLM judge checks every claim against the cited chunks', 1100);

  progress('REPORTING', total, 700);
  log('report', 'compose report · Summary, Key Metrics (from SQL, not the model), Incidents, Recommendations', 900);

  at += 1300;
  steps.push({ at, log: { stage: 'done', text: `done · ${f.incidents.length} incidents · report ready` } });
  steps.push({ at, progress: { status: 'DONE', enriched: total, total } });
  return steps;
}
