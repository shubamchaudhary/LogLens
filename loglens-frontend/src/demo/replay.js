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
  log('upload', `Received upload of ${f.file.name} (${fmtBytes(f.file.bytes)}) - sent from the browser straight to the blob store`, 0);
  log('upload', 'Upload confirmed, returning 202 Accepted - queued the file on Kafka topic log.ingest.requests', 400);
  log('split', `Split the file into ${s.parts} parts of about 5 MB, each cut at a minute boundary - published to log.ingest.parts`, 900);

  // 2. Parse + detect
  progress('PARSING', 0, 600);
  const perPart = Math.round(s.lines / s.parts);
  for (const p of [1, Math.round(s.parts / 3), Math.round((2 * s.parts) / 3), s.parts]) {
    log('parse', `Part ${p}/${s.parts}: read 5 MB from the blob store, parsed ~${fmt(perPart)} lines, saved to the database`, 550);
  }
  log(
    'parse',
    `Parsing complete: ${fmt(s.lines)} lines read, grouped into ${fmt(s.chunks)} time windows, ${fmt(s.metricRows)} metric rows stored`,
    600
  );
  log('parse', 'Each part is saved in a single database transaction, so a retry can never double-count', 500);
  log('detect', `Compared ${s.minutes} minutes against the log's normal behaviour: ${s.flaggedMinutes} minutes look unusual`, 700);
  const rules = Object.entries(s.anomalyRules)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([rule, n]) => `${rule} ×${n}`)
    .join(' · ');
  log('detect', `Rules that triggered: ${rules}`, 350);
  log(
    'fan-out',
    `Queued ${fmt(s.flaggedChunks)} unusual windows for the AI to explain, plus ${s.embedBatches} embedding batches - one queue lane per API key`,
    600
  );

  // 3. Explain (LLM) + embed: one tick per work item, a console line per incident window.
  progress('ENRICHING', 0, 500);
  const lines = f.incidents.map((inc) => ({
    stage: 'explain',
    text: `Explained ${hhmm(inc.start)}-${hhmm(inc.end)}: ${inc.flaggedMinutes} unusual minutes, ${fmt(inc.llmCalls)} AI calls, findings saved`,
  }));
  for (let b = 1; b <= s.embedBatches; b += Math.max(1, Math.floor(s.embedBatches / 4))) {
    lines.splice(Math.min(lines.length, Math.round((b / s.embedBatches) * lines.length)), 0, {
      stage: 'embed',
      text: `Embedding batch ${b}/${s.embedBatches}: 80 windows turned into vectors and stored for search`,
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
  log('explain', `Used ${fmt(s.llmCallsGated)} AI calls instead of ${fmt(s.llmCallsUngated)} by skipping quiet minutes (${saved}% fewer)`, 300);

  // 4. Correlate, 5. Report
  progress('CORRELATING', total, 500);
  log('correlate', `Grouped related findings across services into ${f.incidents.length} incidents`, 900);
  log('verify', 'Checking every claim against the log lines it cites - dropping anything the log does not support', 1000);
  progress('REPORTING', total, 600);
  log('report', 'Ranking incidents by impact and writing probable causes and follow-up actions', 900);

  at += 1200;
  steps.push({ at, log: { stage: 'done', text: `Analysis complete: ${f.incidents.length} incidents ready - you can now ask questions about the log` }, final: true });
  steps.push({ at, progress: { status: 'DONE', enriched: total, total } });
  return steps;
}
