#!/usr/bin/env node
// Replaces the hand-written AI text in src/demo/fixture.json with a RECORDED live
// run: findings, incidents, report, evidence and drill-down answers exactly as the
// real backend + models returned them.
//
// 1. Run the stack locally with real GROQ_API_KEYS / GEMINI_API_KEYS (see README).
// 2. Create a session and upload evals/datasets/owner_sample_10k.log; wait for DONE.
// 3. From loglens-frontend/:
//      node scripts/demo/capture-fixture.mjs --api http://localhost:8080/api/v1 \
//        --email you@example.com --password '...' --session <session-uuid>
//
// The suggested questions are asked live (one drill-down call each). Pipeline stats
// (windows, flagged, LLM calls) stay from build-fixture.mjs: they describe the same file.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../src/demo/fixture.json');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const help = process.argv.includes('--help');
if (help || !args.api || !args.session || !(args.token || (args.email && args.password))) {
  console.log('usage: capture-fixture.mjs --api <base, e.g. http://localhost:8080/api/v1> --session <uuid>');
  console.log('                           (--token <jwt> | --email <email> --password <password>)');
  process.exit(help ? 0 : 1);
}

async function call(method, path, token, body) {
  const resp = await fetch(`${args.api}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`${method} ${path} -> ${resp.status} ${await resp.text()}`);
  return resp.status === 204 ? null : resp.json();
}

const token =
  args.token || (await call('POST', '/auth/login', null, { email: args.email, password: args.password })).token;
const s = `/sessions/${args.session}`;

const session = await call('GET', s, token);
if (session.analysisStatus !== 'DONE') throw new Error(`session is ${session.analysisStatus}, wait for DONE`);

const [metrics, findings, incidents, report] = await Promise.all([
  call('GET', `${s}/metrics`, token),
  call('GET', `${s}/findings`, token),
  call('GET', `${s}/incidents`, token),
  call('GET', `${s}/report`, token),
]);
if (!report) throw new Error('session has no report yet');

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const qa = [];
for (const q of fixture.qa) {
  console.log(`asking: ${q.question}`);
  const r = await call('POST', `${s}/drilldown`, token, { question: q.question });
  qa.push({ question: q.question, keywords: q.keywords, answer: r.answer, citations: r.citations || [] });
}

const ids = [...new Set([...findings.flatMap((f) => f.evidenceChunkIds || []), ...qa.flatMap((q) => q.citations)])];
const chunks = {};
for (let i = 0; i < ids.length; i += 50) {
  const qs = ids.slice(i, i + 50).map((id) => `chunkIds=${id}`).join('&');
  for (const row of await call('GET', `${s}/evidence?${qs}`, token)) chunks[row.chunkId] = row;
}

const out = {
  ...fixture,
  provenance: {
    ...fixture.provenance,
    kind: 'recorded',
    narratives: `Recorded from a live run on ${new Date().toISOString().slice(0, 10)} (real backend, real models)`,
  },
  session: { ...session, title: fixture.session.title },
  documentId: Object.values(chunks)[0]?.documentId ?? fixture.documentId,
  metrics,
  findings,
  incidents,
  report,
  chunks,
  qa,
};
writeFileSync(FIXTURE, JSON.stringify(out) + '\n');
console.log(
  `wrote ${FIXTURE}: ${metrics.length} metric rows, ${findings.length} findings, ${incidents.length} incidents, ` +
    `${Object.keys(chunks).length} chunks, ${qa.length} answers`
);
