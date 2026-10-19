// The guest session's pipeline run: the progress events the backend's SSE stream
// sends ({status, enriched, total}) plus a console line for each step. Every
// number comes from the fixture, i.e. from the production parsers and anomaly
// gate run over the 1 GB file; the pacing is compressed to ~25 s.

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

  // 1. Split
  progress('CHUNKING');
  log('upload', `presigned PUT → object storage · ${fmtBytes(f.file.bytes)} sent straight from the browser`, 0);
  log('upload', 'confirm → 202 Accepted · file pointer queued on Kafka (log.ingest.requests)', 400);
  log('split', `one streaming pass → ${s.parts} parts of ~5 MB, each cut on a 1-minute boundary → log.ingest.parts`, 900);

  // 2. Parse + detect
  progress('PARSING', 0, 600);
  const perPart = Math.round(s.lines / s.parts);
  for (const p of [1, Math.round(s.parts / 3), Math.round((2 * s.parts) / 3), s.parts]) {
    log('parse', `part ${p}/${s.parts} · ranged GET (~5 MB) → ~${fmt(perPart)} lines → parsed → committed`, 550);
  }
  log(
    'parse',
    `8 parsers (HTTP, SQL, errors, JVM/GC, auth, deploys, traffic, message templates) → ${fmt(s.lines)} lines in ` +
      `${fmt(s.chunks)} chunks → ${fmt(s.metricRows)} metric rows`,
    600
  );
  log('parse', "exactly-once: each part's rows and a done-marker commit in one transaction", 500);
  log('detect', `robust anomaly rules over ${s.minutes} minutes → ${s.flaggedMinutes} minutes flagged`, 700);
  const rules = Object.entries(s.anomalyRules)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([rule, n]) => `${rule} ×${n}`)
    .join(' · ');
  log('detect', `rules fired: ${rules}`, 350);
  log(
    'fan-out',
    `${fmt(s.flaggedChunks)} flagged chunks to explain + ${s.embedBatches} embedding batches → llm.enrich.requests (one partition per API key)`,
    600
  );

  // 3. Explain (LLM) + embed: one tick per work item, a console line per incident window.
  progress('ENRICHING', 0, 500);
  const lines = f.incidents.map((inc) => ({
    stage: 'explain',
    text: `${hhmm(inc.start)}–${hhmm(inc.end)} · ${inc.flaggedMinutes} flagged minutes · ${fmt(inc.llmCalls)} chat calls → findings (JSON)`,
  }));
  for (let b = 1; b <= s.embedBatches; b += Math.max(1, Math.floor(s.embedBatches / 4))) {
    lines.splice(Math.min(lines.length, Math.round((b / s.embedBatches) * lines.length)), 0, {
      stage: 'embed',
      text: `batch ${b}/${s.embedBatches} · 80 chunks → 768-d vectors → pgvector`,
    });
  }
  const tickGap = Math.max(25, Math.round(9000 / total));
  let li = 0;
  for (let i = 1; i <= total; i++) {
    at += tickGap;
    steps.push({ at, progress: { status: 'ENRICHING', enriched: i, total } });
    if (li < lines.length && i >= ((li + 1) * total) / (lines.length + 1)) {
      steps.push({ at, log: lines[li++] });
    }
  }
  const saved = Math.round((1 - s.llmCallsGated / s.llmCallsUngated) * 1000) / 10;
  log('explain', `LLM calls: ${fmt(s.llmCallsGated)} with the anomaly gate vs ${fmt(s.llmCallsUngated)} without → ${saved}% fewer`, 300);

  // 4. Correlate, 5. Report
  progress('CORRELATING', total, 500);
  log('correlate', `LangGraph groups the findings across services → ${f.incidents.length} incidents`, 900);
  log('verify', 'an LLM judge checks every claim against the log lines it cites; unsupported claims are dropped', 1000);
  progress('REPORTING', total, 600);
  log('report', 'rank incidents by impact · probable causes · follow-up actions', 900);

  at += 1200;
  steps.push({ at, log: { stage: 'done', text: `${f.incidents.length} incidents ready · ask questions about the file` }, final: true });
  steps.push({ at, progress: { status: 'DONE', enriched: total, total } });
  return steps;
}
