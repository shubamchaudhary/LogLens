// DeepLogLens AI's building blocks. graph.js wires them into a LangGraph decision graph:
//
//   understand: one small LLM call reads the conversation so far and decides whether the
//               message is a follow-up (and rewrites it as a standalone question), what kind
//               of question it is (chat, system, logs, general, web) and its language
//   chat:       greets, says what it is and what it can do
//   system:     services, tenants, routes, dependencies, deployments, from log-profile.json
//               (computed by extract.mjs over every line), citing its example lines
//   general:    engineering knowledge, labelled as not coming from the log
//   web:        Groq browser search, with the pages it read
//   logs:       the grounded pipeline below
//   nearest:    when the log can't answer, say so and give the closest facts it does hold
//
// The grounded pipeline:
//   retrieve:  failure types (pgvector + full-text, RRF-fused), matching log lines
//              (full-text, optionally narrowed to times named in the question),
//              busiest matching minutes (pgvector over minute digests), incidents
//   grade:     too little evidence → ask the model for better search terms, retrieve once more
//   generate:  JSON answer whose every point cites line numbers / failure types from the context
//   verify:    drop citations that weren't in the context; no valid citation → abstain;
//              numbers the context doesn't contain lower the confidence

import { readFileSync } from 'node:fs';
import { db } from './db.js';
import { chatJson, chatWeb, vec, CHAT_MODEL } from './llm.js';

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

// ---- the log profile: what the system in this log looks like -------------------------

const profile = JSON.parse(readFileSync(new URL('./log-profile.json', import.meta.url), 'utf8'));
const num = (n) => Number(n).toLocaleString('en-US');
const day = profile.file.from.slice(0, 10);

/** Example lines the profile can cite, by line number. */
const profileLines = new Map();
for (const s of profile.services) for (const l of s.logs) profileLines.set(l.line, { text: l.sample, service: s.name });
for (const d of profile.deps) profileLines.set(d.line, { text: d.sample, service: d.from });

const FILE_SUMMARY =
  `${profile.file.name}: ${num(profile.file.lines)} lines, ${(profile.file.bytes / 2 ** 30).toFixed(1)} GB, ` +
  `${profile.file.from.slice(0, 16).replace('T', ' ')} to ${profile.file.to.slice(11, 16)} UTC, from an e-commerce platform. ` +
  `Services: ${profile.services.map((s) => s.name).join(', ')}. Tenants (customer accounts): ${profile.tenants.map((t) => t.name).join(', ')}.`;

function profileText() {
  const svc = profile.services.map((s) => {
    const lv = ['ERROR', 'WARN'].filter((l) => s.levels[l]).map((l) => `${num(s.levels[l])} ${l}`).join(', ');
    const logs = s.logs.slice(0, 3).map((l) => `"${l.template.slice(0, 110)}" ×${num(l.count)} (e.g. L${l.line})`).join('; ');
    return `- ${s.name}: ${num(s.lines)} lines${lv ? ` (${lv})` : ''}, ${s.pods} pod(s), serves ${s.tenants} tenants${s.tables.length ? `, SQL tables: ${s.tables.join(', ')}` : ''}. Logs most: ${logs}`;
  });
  const ten = profile.tenants.map(
    (t) =>
      `- ${t.name}: ${num(t.requests)} gateway requests (${num(t.s5xx)} 5xx, ${num(t.s4xx)} 4xx), ${num(t.errors)} ERROR lines; top routes: ${t.routes.map((r) => `${r.route} ${num(r.count)}`).join(', ')}`
  );
  const routes = profile.routes.map(
    (r) => `- ${r.route}: ${num(r.count)} requests, avg ${r.avgMs} ms, ${num(r.s5xx)} 5xx${r.upstream.length ? `, failures name upstream ${r.upstream.map((u) => `${u.service} ×${num(u.count)}`).join(', ')}` : ''}`
  );
  const deps = profile.deps.map((d) => `- ${d.from} → ${d.to} (${d.kind}) ×${num(d.count)}, e.g. L${d.line}`);
  const deploys = profile.deploys.map((d) => `- L${d.line}: ${d.text}`);
  return [
    `FILE: ${FILE_SUMMARY}`,
    '',
    'SERVICES (what each one logs most shows what it does):',
    ...svc,
    '',
    'TENANTS (customer accounts; every request line carries tenant=<name>):',
    ...ten,
    '',
    'GATEWAY ROUTES:',
    ...routes,
    '',
    'DEPENDENCIES NAMED IN THE LINES:',
    ...deps,
    '',
    'DEPLOYMENTS:',
    ...deploys,
  ].join('\n');
}
const PROFILE_TEXT = profileText();

// Incident titles from the pipeline, so chat and general answers name real events.
let incidentList = null;
export async function incidents() {
  if (incidentList) return incidentList;
  try {
    const { rows } = await db().query('SELECT starts_at, ends_at, title FROM incidents ORDER BY starts_at');
    incidentList = rows.map((r) => `${hhmmss(r.starts_at).slice(0, 5)}–${hhmmss(r.ends_at).slice(0, 5)} ${r.title}`).join('; ');
  } catch {
    incidentList = '';
  }
  return incidentList;
}

export const persona = (language) => `You are DeepLogLens AI, the assistant inside DeepLogLens, a log-analysis app. The user has opened one log archive:
${FILE_SUMMARY}
Incidents DeepLogLens found: ${incidentList || 'see the context'}.
DeepLogLens has already parsed every line into exact counts, flagged the unusual minutes and grouped them into incidents. You help the user understand this log: what failed and why, what the system looks like (services, tenants, routes, dependencies, deployments), and engineering questions around it. Be warm, direct and smart, like a senior SRE colleague. Reply in ${language || 'the language the user wrote in'}; keep JSON keys in English. Plain text, no markdown headings or bold.`;

export const history = (turns) =>
  turns.length ? `CONVERSATION SO FAR:\n${turns.map((t) => `User: ${t.question}\nYou: ${t.answer}`).join('\n')}\n\n` : '';

// ---- understand: follow-up or new question, and which kind -----------------------

const UNDERSTAND = `You are the first step of DeepLogLens AI, an assistant that answers questions about one application log archive.
Read the conversation so far and the new message, then decide:
1. "followup": true only if the message depends on earlier turns to make sense (pronouns like "it", "they", "that", "and for acme?", "why?", "more detail"). A complete question is not a follow-up, even if it is on the same topic, and nothing that comes after a greeting is a follow-up of the greeting.
2. "standalone": the message rewritten as a complete question that makes sense without the conversation (resolve every reference using the earlier turns). If it already stands alone, repeat it.
3. "route", for the standalone question:
   - "chat": greetings, thanks, small talk, or questions about you and what you can do.
   - "system": the system in the log rather than its failures: services and what they do, tenants or customers, endpoints and traffic, dependencies, databases and tables, deployments and versions.
   - "logs": failures, errors, incidents, causes, timings, error counts, what happened when, which tenants were hit.
   - "general": general engineering knowledge that does not need this log (what is X, how does Y work, how to fix Z in general).
   - "web": needs current information from the internet (latest versions, news, vendor docs, status pages).
   A follow-up usually stays on the topic of the turn it follows.
4. "language": the language the user wrote in (e.g. "English", "Hindi", "Hinglish", "Spanish").
Return only JSON: {"followup": false, "standalone": "...", "route": "chat" | "system" | "logs" | "general" | "web", "language": "..."}`;

export async function understand(question, turns) {
  try {
    const { json } = await chatJson(UNDERSTAND, `${history(turns)}NEW MESSAGE: ${question}`, { maxTokens: 300, temperature: 0 });
    return {
      followup: Boolean(json.followup) && turns.length > 0,
      standalone: String(json.standalone || question).slice(0, 400),
      route: ['chat', 'system', 'logs', 'general', 'web'].includes(json.route) ? json.route : 'logs',
      language: String(json.language || 'English').slice(0, 30),
    };
  } catch {
    return { followup: false, standalone: question, route: 'logs', language: 'English' };
  }
}

// ---- chat, general, web ---------------------------------------------------------------

export async function chat(question, turns, language) {
  const { json, usage } = await chatJson(
    `${persona(language)}
The user is chatting, not asking about the data yet. Answer naturally: greet them back if they greeted you, say in one or two sentences who you are and what you can do for this log, and offer three example questions this log can actually answer, each on its own line starting with "• ": one about one of the listed incidents, one about the services or tenants listed above, one about a cause. Do not invent links between services. Keep it under 90 words.
Return only JSON: {"answer": "..."}`,
    `${history(turns)}USER: ${question}`,
    { maxTokens: 500, temperature: 0.5 }
  );
  return { mode: 'assistant', answer: String(json.answer || '').trim(), usage };
}

export async function general(question, turns, language) {
  const { json, usage } = await chatJson(
    `${persona(language)}
Answer this from general engineering knowledge in 2-5 sentences. If it connects to this log (its services, tenants or incidents), add one sentence saying how, using only the file summary above.
Return only JSON: {"answer": "..."}`,
    `${history(turns)}QUESTION: ${question}`,
    { maxTokens: 700, temperature: 0.3 }
  );
  return { mode: 'general', answer: String(json.answer || '').trim(), usage };
}

export async function web(question, turns, language) {
  const { text, sources, usage } = await chatWeb(
    `${persona(language)}
Search the web for this and answer in 2-5 plain sentences. Mention where the information comes from.`,
    `${history(turns)}QUESTION: ${question}`
  );
  return { mode: 'web', answer: text, sources, usage };
}

// ---- system: answers from the log profile ---------------------------------------------

// A cited example line must share a meaningful word with the point it backs.
const words = (t) => new Set((t.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter((w) => !STOP.has(w)));
function related(point, line) {
  const lw = words(line);
  return [...words(point)].some((w) => lw.has(w) || [...lw].some((x) => x.startsWith(w) || w.startsWith(x)));
}

export async function system(question, turns, language) {
  const { json, usage } = await chatJson(
    `${persona(language)}
Answer from the LOG PROFILE below. It was computed by parsers over all ${num(profile.file.lines)} lines, so its counts are exact.
Rules:
- Use the profile's numbers as they are; never estimate.
- Tenants are customer accounts that share the same services. They do not depend on each other unless the profile shows it; say so if asked.
- You may infer what a service does from what it logs and which tables and systems it uses, and how routes map to services from their names; say "likely" for such inferences.
- Put lists and numbers in the answer itself. Use points only for facts that one of the profile's example lines shows, and cite those lines (as integers).
- If the profile does not cover the question, set "abstain": true and say in one friendly sentence what you can tell instead.
Return only JSON: {"answer": "2-5 plain sentences", "points": [{"text": "one supporting fact", "lines": [123]}], "confidence": "high" | "medium" | "low", "abstain": false}
Give 0-4 points.

LOG PROFILE:
${PROFILE_TEXT}`,
    `${history(turns)}QUESTION: ${question}`,
    { maxTokens: 1100, temperature: 0.2 }
  );
  const points = (Array.isArray(json.points) ? json.points : [])
    .map((p) => ({
      text: String(p.text || ''),
      lines: (p.lines || [])
        .map(Number)
        .filter((n) => profileLines.has(n) && related(String(p.text || ''), profileLines.get(n).text))
        .slice(0, 2)
        .map((n) => ({ no: n, end: n, service: profileLines.get(n).service, text: profileLines.get(n).text })),
      types: [],
    }))
    .filter((p) => p.text && p.lines.length)
    .slice(0, 4);
  return {
    mode: 'system',
    answer: String(json.answer || '').trim(),
    abstained: Boolean(json.abstain),
    confidence: ['high', 'medium', 'low'].includes(json.confidence) ? json.confidence : 'medium',
    points,
    usage,
  };
}

// ---- logs: grounded answers over the failure records ----------------------------------

export const logsSystem = (language) => `${persona(language)}
Answer from the CONTEXT: incidents the pipeline found, failure types with exact counts for the whole file, and log lines with their line numbers.
Rules:
- Every point must cite evidence: line numbers from LOG LINES (as integers) and/or failure types (as "S1", "S2", ...).
- Counts must be copied from FAILURE TYPES or counted from the listed lines. Never estimate or round.
- Separate what the logs show from what you infer; say "likely" for inferences.
- Answer the question directly. If it asks which tenants, services or pods, name them with their counts from the context (FAILURE TYPES list the top tenants of each failure type).
- "background" is optional: one or two sentences of general engineering knowledge that help (for example what an exception means). Leave it empty if not needed.
- If the context cannot answer, set "abstain": true and write one friendly sentence saying what the logs do contain.
Return only JSON:
{"answer": "2-4 plain sentences", "points": [{"text": "one supporting fact", "lines": [123], "types": ["S1"]}], "background": "", "confidence": "high" | "medium" | "low", "abstain": false}
Give 1-4 points.`;

// ---- nearest: an honest answer when the log can't answer ------------------------------

/**
 * The log doesn't hold the answer: say so plainly, then give the closest facts the profile
 * does hold. Numbers must come from the profile; if the reply invents one, it's replaced.
 */
export async function nearest(question, turns, language) {
  const { json, usage } = await chatJson(
    `${persona(language)}
The question cannot be answered from this log. Say so in one sentence, then give the closest useful facts the LOG PROFILE does contain (for example the metrics, services or incidents nearest to what was asked), and suggest one question that the log can answer. Copy any number exactly from the profile; never invent one. 2-4 sentences.
Return only JSON: {"answer": "..."}

LOG PROFILE:
${PROFILE_TEXT}`,
    `${history(turns)}QUESTION: ${question}`,
    { maxTokens: 600, temperature: 0.2 }
  );
  let text = String(json.answer || '').trim();
  const invented = (text.match(/\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b/g) || []).filter((n) => !PROFILE_TEXT.includes(n) && !(incidentList || '').includes(n));
  if (invented.length || !text) {
    text = `That isn't in this log. It records ${num(profile.file.lines)} lines from ${profile.services.length} services (${profile.services
      .slice(0, 8)
      .map((x) => x.name)
      .join(', ')}) and ${profile.tenants.length} tenants, with the incidents listed in the Incidents tab. Try asking what failed, why, or what a service depends on.`;
  }
  return { mode: 'nearest', answer: text, abstained: true, usage };
}

export { profile, PROFILE_TEXT, num, day, STOP };
