// Grounded Q&A over the showcase log.
//
//   retrieve:  failure types (pgvector + full-text, RRF-fused), matching log lines
//              (full-text, optionally narrowed to times named in the question),
//              busiest matching minutes (pgvector over minute digests), incidents
//   grade:     too little evidence → ask the model for better search terms, retrieve once more
//   generate:  JSON answer whose every point cites line numbers / failure types from the context
//   verify:    drop citations that weren't in the context; no valid citation → abstain;
//              numbers the context doesn't contain lower the confidence

import { db } from './db.js';
import { chatJson, embed, vec, CHAT_MODEL } from './llm.js';

const STOP = new Set(
  'a an and are as at be by did do does for from had has have how i in is it its many me of on or so that the their them then there these they this to was we were what when where which who why will with you your around about after before during any much happen happened cause caused show tell give'.split(
    ' '
  )
);

// Everyday words → the vocabulary that actually appears in these logs.
const EXPAND = {
  oom: ['outofmemoryerror', 'oomkilled', 'heap'],
  memory: ['outofmemoryerror', 'heap', 'oomkilled'],
  crash: ['oomkilled', 'crashloopbackoff', 'outofmemoryerror'],
  restart: ['oomkilled', 'crashloopbackoff', 'started'],
  ssl: ['sslhandshakeexception', 'pkix', 'certificate'],
  tls: ['sslhandshakeexception', 'pkix', 'certificate'],
  certificate: ['certificateexpiredexception', 'pkix', 'truststore'],
  cert: ['certificate', 'pkix', 'truststore'],
  payment: ['payment', 'partner'],
  payments: ['payment', 'partner'],
  pool: ['hikaripool', 'connection'],
  database: ['hikaripool', 'postgres', 'deadlock', 'sql'],
  db: ['hikaripool', 'postgres', 'deadlock', 'sql'],
  slow: ['duration', 'slow', 'latency'],
  deadlock: ['deadlock', 'cannotacquirelockexception'],
  lock: ['deadlock', 'cannotacquirelockexception'],
  kafka: ['consumer', 'leavegroup', 'commitfailedexception', 'lag'],
  rebalance: ['leavegroup', 'revoke', 'joining', 'commitfailedexception'],
  lag: ['lag', 'consumer'],
  redis: ['redis', 'lettuce', 'redistimeoutexception', 'sentinel'],
  cache: ['redis', 'lettuce', 'cache'],
  failover: ['switch', 'sentinel', 'odown', 'sdown'],
  deploy: ['deployment', 'rolled'],
  release: ['deployment', 'rolled'],
  rollback: ['rolled', 'back'],
  checkout: ['checkout'],
  email: ['smtp', 'email'],
  timeout: ['timeout', 'timed'],
};

const STATUS = /^[1-5]\d\d$/; // HTTP status codes are the only bare numbers worth searching

export function terms(question) {
  const words = question.toLowerCase().match(/[a-z0-9_.-]+/g) || [];
  const out = new Set();
  for (const w of words) {
    const t = w.replace(/^[.-]+|[.-]+$/g, '');
    if (t.length < 3 || STOP.has(t) || /^\d{1,2}:\d{2}$/.test(t)) continue;
    if (/^\d+$/.test(t) && !STATUS.test(t)) continue;
    // naive singular: "deadlocks" must find "deadlock", "timeouts" → "timeout"
    const base = t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
    out.add(base.replace(/[^a-z0-9]/g, ''));
    for (const x of EXPAND[base] || EXPAND[t] || []) out.add(x);
  }
  return [...out].filter(Boolean).slice(0, 14);
}

/** "around 10:45" → [{from, to}] ±6 minutes, on the log's day. */
export function timeWindows(question, day) {
  const out = [];
  for (const m of question.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)) {
    const t = Date.parse(`${day}T${m[1].padStart(2, '0')}:${m[2]}:00Z`);
    out.push({ from: new Date(t - 6 * 60_000).toISOString(), to: new Date(t + 6 * 60_000).toISOString() });
  }
  return out.slice(0, 3);
}

const tsQuery = (ts) => ts.map((t) => (t.length >= 4 && !/^\d+$/.test(t) ? `${t}:*` : t)).join(' | ');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const hhmmss = (d) => new Date(d).toISOString().slice(11, 19);

/** First lines of a record, keeping the exception chain readable but short. */
function compactBody(body) {
  const lines = body.split('\n');
  const keep = [lines[0], ...lines.slice(1).filter((l) => /Caused by|Detail:|Where:/.test(l)).slice(0, 2)];
  return clip(keep.join(' ⏎ '), 420);
}

export async function retrieveOnce(q, qv, ts, windows) {
  const pool = db();
  const tq = ts.length ? tsQuery(ts) : null;

  // Failure types: vector + lexical, fused with reciprocal rank fusion (k = 60).
  const [vecSigs, lexSigs] = await Promise.all([
    qv
      ? pool.query(
          `SELECT id, 1 - (embedding <=> $1::vector) AS sim FROM signatures
           WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 8`,
          [vec(qv)]
        )
      : { rows: [] },
    tq
      ? pool.query(
          `SELECT signature AS id, count(*) AS n FROM log_events
           WHERE tsv @@ to_tsquery('simple', $1) GROUP BY signature ORDER BY n DESC LIMIT 8`,
          [tq]
        )
      : { rows: [] },
  ]);
  const incidents = await pool.query(`SELECT id, starts_at, ends_at, title, summary, doc FROM incidents ORDER BY starts_at`);
  const incidentSigs = new Set(incidents.rows.flatMap((inc) => (inc.doc.signatures || []).map((x) => x.id)));

  // Reciprocal rank fusion. A failure type found only by vector similarity must be part
  // of an incident or a top-2 vector hit; otherwise background noise crowds the context.
  const lexIds = new Set(lexSigs.rows.map((r) => r.id));
  const rrf = new Map();
  vecSigs.rows.forEach((r, i) => {
    if (lexIds.has(r.id) || incidentSigs.has(r.id) || i < 2) rrf.set(r.id, (rrf.get(r.id) || 0) + 1 / (60 + i));
  });
  lexSigs.rows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) || 0) + 1 / (60 + i)));
  const sigIds = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
  const maxSim = Math.max(0, ...vecSigs.rows.map((r) => Number(r.sim)));

  // Log lines: lexical hits (inside the named times if any), else the first records of the top failure types.
  const timeSql = windows.length ? `AND (${windows.map((_, i) => `ts BETWEEN $${i * 2 + 2} AND $${i * 2 + 3}`).join(' OR ')})` : '';
  const timeArgs = windows.flatMap((w) => [w.from, w.to]);
  let lexEvents = { rows: [] };
  if (tq) {
    lexEvents = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (signature) line_no, line_end, ts, level, service, tenant, body, signature,
                ts_rank(tsv, to_tsquery('simple', $1)) AS rank
         FROM log_events WHERE tsv @@ to_tsquery('simple', $1) ${timeSql}
         ORDER BY signature, ts
       ) x ORDER BY rank DESC, ts LIMIT 10`,
      [tq, ...timeArgs]
    );
  } else if (windows.length) {
    lexEvents = await pool.query(
      `SELECT DISTINCT ON (signature) line_no, line_end, ts, level, service, tenant, body, signature
       FROM log_events WHERE TRUE ${timeSql.replace(/\$(\d+)/g, (_, n) => `$${n - 1}`)} ORDER BY signature, ts LIMIT 10`,
      timeArgs
    );
  }
  const sigEvents = sigIds.length
    ? await pool.query(
        `SELECT DISTINCT ON (signature) line_no, line_end, ts, level, service, tenant, body, signature
         FROM log_events WHERE signature = ANY($1) ORDER BY signature, line_no`,
        [sigIds]
      )
    : { rows: [] };

  const events = new Map();
  for (const e of [...lexEvents.rows, ...sigEvents.rows]) if (!events.has(e.line_no)) events.set(e.line_no, e);
  const allSigIds = [...new Set([...sigIds, ...[...events.values()].map((e) => e.signature)])].slice(0, 8);

  const sigs = await pool.query(`SELECT * FROM signatures WHERE id = ANY($1)`, [allSigIds]);
  // Incidents that the question's times fall in, or whose failure types matched.
  const inWindow = (inc) =>
    windows.some((w) => Date.parse(w.from) <= new Date(inc.ends_at).getTime() && Date.parse(w.to) >= new Date(inc.starts_at).getTime());
  const lexTimes = lexEvents.rows.map((e) => new Date(e.ts).getTime());
  const relevantIncidents = incidents.rows.filter(
    (inc) =>
      inWindow(inc) ||
      (inc.doc.signatures || []).some((x) => sigIds.slice(0, 3).includes(x.id)) ||
      lexTimes.some((t) => t >= new Date(inc.starts_at).getTime() && t <= new Date(inc.ends_at).getTime())
  );

  // The incidents' own key lines (the change before it, first failure, fix) are prime evidence.
  const keyLines = relevantIncidents.flatMap((inc) =>
    (inc.doc.evidence || []).filter((e) => e.role !== 'sample').slice(0, 4).map((e) => e.line)
  );
  if (keyLines.length) {
    const rows = await pool.query(
      `SELECT line_no, line_end, ts, level, service, tenant, body, signature FROM log_events WHERE line_no = ANY($1)`,
      [keyLines]
    );
    for (const e of rows.rows) events.set(e.line_no, e);
  }

  return {
    sigs: sigs.rows.sort((a, b) => allSigIds.indexOf(a.id) - allSigIds.indexOf(b.id)),
    events: [...events.values()].sort((a, b) => a.line_no - b.line_no).slice(0, 20),
    incidents: relevantIncidents.slice(0, 4),
    lexicalHits: lexEvents.rows.length,
    maxSim,
  };
}

export function buildContext(r) {
  const refs = new Map(); // "S1" -> signature row
  const sigLines = r.sigs.map((s, i) => {
    refs.set(`S${i + 1}`, s);
    const tenants = (s.top_tenants || []).slice(0, 5).map(([t, n]) => `${t} ${n}`).join(', ');
    return `S${i + 1} | ${s.level} ${s.service} | count=${s.count} | first ${hhmmss(s.first_ts)} (L${s.first_line}) | last ${hhmmss(s.last_ts)} (L${s.last_line}) | top tenants: ${tenants || '-'}\n   "${clip(s.sample, 260)}"`;
  });
  const incLines = r.incidents.map(
    (inc) => `- ${hhmmss(inc.starts_at)}–${hhmmss(inc.ends_at)} ${inc.title}${inc.summary ? `: ${clip(inc.summary, 300)}` : ''}`
  );
  const evLines = r.events.map((e) => `L${e.line_no} ${compactBody(e.body)}`);
  const text = [
    'INCIDENTS FOUND BY THE PIPELINE:',
    incLines.join('\n') || '(none matched)',
    '',
    'FAILURE TYPES (exact counts over the whole file):',
    sigLines.join('\n') || '(none matched)',
    '',
    'LOG LINES (cite as L<number>):',
    evLines.join('\n') || '(none matched)',
  ].join('\n');
  return { text, refs, lineSet: new Set(r.events.map((e) => e.line_no)) };
}

const SYSTEM = `You are DeepLogLens, an SRE assistant. You answer questions about ONE log file: 15 Jul 2026, 08:00–17:50 UTC, an e-commerce platform of 10 services, 5.37 million lines.
Use ONLY the context. It holds incidents the pipeline found, failure types with exact counts for the whole file, and log lines with their line numbers.
Rules:
- Every point must cite evidence: line numbers from LOG LINES (as integers) and/or failure types (as "S1", "S2", ...).
- Counts must be copied from FAILURE TYPES or counted from the listed lines. Never estimate or round.
- Separate what the logs show from what you infer; say "likely" for inferences.
- If the context cannot answer the question, set "abstain": true and say briefly what the logs do contain instead.
Return only JSON:
{"answer": "2-4 plain sentences, no markdown", "points": [{"text": "one supporting fact", "lines": [123], "types": ["S1"]}], "confidence": "high" | "medium" | "low", "abstain": false}
Give 1-4 points.`;

export async function answer(question) {
  const started = Date.now();
  const trace = [];
  const day = '2026-07-15';
  let ts = terms(question);
  const windows = timeWindows(question, day);

  let qv = null;
  try {
    [qv] = await embed([question], 'RETRIEVAL_QUERY');
  } catch (e) {
    trace.push(`embed failed (${e.status || 'error'}), lexical search only`);
  }

  let r = await retrieveOnce(question, qv, ts, windows);
  trace.push(
    `retrieve · ${r.sigs.length} failure types (vector + full-text, RRF) · ${r.events.length} log lines${windows.length ? ` · time filter ${windows.length}` : ''}`
  );

  // Grade: nothing lexical and nothing semantically close → rewrite the query once.
  if (r.lexicalHits === 0 && r.maxSim < 0.55 && windows.length === 0) {
    trace.push(`grade → weak (0 matching lines, best similarity ${r.maxSim.toFixed(2)})`);
    try {
      const { json } = await chatJson(
        'Turn a question about application logs into search keywords that would appear in log lines (exception names, service names, HTTP status codes, component names). Return JSON {"keywords": ["..."]} with at most 8 single words.',
        question,
        { maxTokens: 80 }
      );
      const extra = (json.keywords || []).flatMap((k) => terms(String(k)));
      if (extra.length) {
        ts = [...new Set([...ts, ...extra])].slice(0, 16);
        trace.push(`rewrite → ${extra.slice(0, 6).join(', ')}`);
        r = await retrieveOnce(question, qv, ts, windows);
        trace.push(`re-retrieve · ${r.sigs.length} failure types · ${r.events.length} log lines`);
      }
    } catch (e) {
      trace.push(`rewrite skipped (${e.status || 'error'})`);
    }
  } else {
    trace.push(`grade → ${r.lexicalHits} lexical hits, best similarity ${r.maxSim.toFixed(2)}`);
  }

  const ctx = buildContext(r);
  const { json, usage } = await chatJson(SYSTEM, `QUESTION: ${question}\n\nCONTEXT:\n${ctx.text}`);

  // Verify: keep only citations that exist in the context.
  const byLine = new Map(r.events.map((e) => [e.line_no, e]));
  let dropped = 0;
  const points = (Array.isArray(json.points) ? json.points : [])
    .map((p) => {
      const lines = (p.lines || []).map(Number).filter((n) => ctx.lineSet.has(n));
      const types = (p.types || []).map(String).filter((t) => ctx.refs.has(t));
      dropped += (p.lines || []).length + (p.types || []).length - lines.length - types.length;
      return {
        text: String(p.text || ''),
        lines: lines.map((n) => {
          const e = byLine.get(n);
          return { no: n, end: e.line_end, ts: e.ts, level: e.level, service: e.service, text: e.body };
        }),
        types: types.map((t) => {
          const s = ctx.refs.get(t);
          return {
            ref: t, level: s.level, service: s.service, template: s.template, sample: s.sample, count: s.count,
            firstTs: s.first_ts, lastTs: s.last_ts, firstLine: s.first_line, lastLine: s.last_line,
          };
        }),
      };
    })
    .filter((p) => p.text && (p.lines.length || p.types.length));

  let abstained = Boolean(json.abstain);
  let text = String(json.answer || '').trim();
  let confidence = ['high', 'medium', 'low'].includes(json.confidence) ? json.confidence : 'low';
  if (!abstained && points.length === 0) {
    abstained = true;
    text = "I couldn't find log lines that support an answer to that, so I won't guess.";
  }
  // Numbers in the answer that appear nowhere in the context are a hallucination signal.
  const unsupported = (text.match(/\b\d{2,}(?:,\d{3})*\b/g) || []).filter(
    (n) => !ctx.text.includes(n) && !ctx.text.includes(n.replace(/,/g, ''))
  );
  if (unsupported.length) confidence = 'low';
  trace.push(
    `generate · ${CHAT_MODEL()} · ${points.length} cited point${points.length === 1 ? '' : 's'}` +
      (dropped ? ` · ${dropped} unverifiable citation${dropped === 1 ? '' : 's'} removed` : '')
  );
  if (abstained) trace.push('abstain · not enough evidence in the logs');

  return {
    question,
    answer: text,
    abstained,
    confidence,
    points: abstained ? [] : points,
    unsupportedNumbers: unsupported,
    trace,
    model: CHAT_MODEL(),
    tokens: usage?.total_tokens ?? null,
    ms: Date.now() - started,
  };
}
