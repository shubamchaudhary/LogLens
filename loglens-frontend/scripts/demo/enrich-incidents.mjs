#!/usr/bin/env node
// Has the LLM explain each incident from its evidence: title, summary, impact,
// ranked probable causes (each citing evidence line numbers) and fixes. Counts,
// times and evidence lines are computed by build-dataset.mjs; the model only
// interprets them, and any cause whose cited lines aren't in the evidence (or are only
// the lines that fixed it) is dropped.
//
//   GROQ_API_KEYS=... node scripts/demo/enrich-incidents.mjs
//
// Updates src/demo/fixture.json (and .data/incidents.json) in place.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, CHAT_MODEL } from '../../api/_lib/llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../src/demo/fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const hhmmss = (iso) => iso.slice(11, 19);

const SYSTEM = `You are an SRE writing the incident entry for a log-analysis report. You get the evidence one incident left in the logs: failure types with exact counts, who was affected, and key log lines with their line numbers.
Write for an engineer who has not seen the logs. Plain English, specific, no hype, no markdown.
Rules:
- Use only the evidence. Every cause must cite the line numbers that support it.
- Counts and times must be copied from the evidence, never estimated.
- Rank causes: the first is the most likely. Say what in the evidence points to it.
- A deploy or config change shortly before the start is a prime suspect. Lines after the start that fix it (rollback, reload, restart) are how it ended, never a cause.
- If something is an inference (not directly visible in a line), say so.
Return only JSON:
{"title": "max 9 words, names what broke and why",
 "summary": "2-3 sentences: what failed, for whom, from when to when, how it ended",
 "impact": "1 sentence with the user-facing effect and counts",
 "causes": [{"cause": "short statement", "likelihood": "most likely" | "possible", "why": "1-2 sentences tied to the evidence", "lines": [123]}],
 "fix": ["2-3 concrete follow-up actions"]}`;

function evidenceText(inc) {
  const failures = inc.failures
    .map(
      (f) =>
        `- ${f.level} ${f.service}: "${f.sample.slice(0, 220)}" | ${f.count} times between ${hhmmss(f.first)} and ${hhmmss(f.last)} (first L${f.firstLine}, last L${f.lastLine})`
    )
    .join('\n');
  const lines = inc.evidence
    .map((e) => `L${e.line} [${e.role}] ${e.text.split('\n').slice(0, 9).join(' ⏎ ').slice(0, 700)}`)
    .join('\n');
  const endpoints = inc.endpoints.map((e) => `${e.endpoint} ×${e.count}`).join(', ');
  return [
    `Window: ${hhmmss(inc.start)}–${hhmmss(inc.end)} UTC on 15 Jul 2026 (${inc.flaggedMinutes} minutes flagged by the anomaly gate).`,
    `Failing log records in the window: ${inc.failingLines}. Peak: ${inc.peak?.lines} in the minute ${inc.peak ? hhmmss(inc.peak.minute).slice(0, 5) : '-'}.`,
    `Services: ${inc.services.join(', ')}. Tenants with failing requests: ${inc.tenants}.`,
    `User-facing responses: ${endpoints || 'none logged by the gateway'}.`,
    '',
    'FAILURE TYPES:',
    failures,
    '',
    'KEY LOG LINES (roles: warning/change = before the start, first = first occurrence, sample = full record, last = last occurrence, fix/event = during or after):',
    lines,
  ].join('\n');
}

for (const inc of fixture.incidents) {
  const { json } = await chatJson(SYSTEM, evidenceText(inc), { maxTokens: 900, temperature: 0.2 });
  const valid = new Set(inc.evidence.map((e) => e.line));
  const fixLines = new Set(inc.evidence.filter((e) => e.role === 'fix').map((e) => e.line));
  const causes = (json.causes || [])
    .map((c) => ({
      cause: String(c.cause || ''),
      likelihood: c.likelihood === 'most likely' ? 'most likely' : 'possible',
      why: String(c.why || ''),
      lines: (c.lines || []).map(Number).filter((n) => valid.has(n)),
    }))
    // a cause resting only on the lines that ended the incident is the fix, not a cause
    .filter((c) => c.cause && c.lines.length && !c.lines.every((n) => fixLines.has(n)));
  Object.assign(inc, {
    title: String(json.title || inc.title),
    summary: String(json.summary || ''),
    impact: String(json.impact || ''),
    causes,
    fix: (json.fix || []).map(String).slice(0, 3),
    explainedBy: CHAT_MODEL(),
  });
  console.log(`${inc.id}: ${inc.title} (${causes.length} cited causes)`);
}

writeFileSync(FIXTURE, JSON.stringify(fixture) + '\n');
writeFileSync(resolve(here, '.data/incidents.json'), JSON.stringify(fixture.incidents, null, 1));
