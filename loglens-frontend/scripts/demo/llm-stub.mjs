#!/usr/bin/env node
// TEST STUB ONLY: speaks just enough of the Groq chat API and the Gemini embedding
// API to run the Ask pipeline and the loaders without keys. Answers are canned
// (they cite the first lines of the context); embeddings are hashed bag-of-words
// vectors, so similarity still loosely tracks shared words. Never deploy this.
//
//   node scripts/demo/llm-stub.mjs   (listens on :8089)
//   GROQ_BASE_URL=http://localhost:8089/openai/v1 GEMINI_BASE_URL=http://localhost:8089/v1beta \
//   GROQ_API_KEYS=stub GEMINI_API_KEYS=stub ...

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

function bowVector(text, dim = 768) {
  const v = new Array(dim).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) || []) {
    const h = createHash('md5').update(w).digest();
    v[h.readUInt16BE(0) % dim] += 1;
  }
  return v;
}

function chat(body) {
  const system = body.messages[0].content;
  const user = body.messages.at(-1).content;
  if (/search keywords/.test(system)) return { keywords: ['error', 'timeout'] };
  const lines = [...user.matchAll(/\bL(\d+)\b/g)].map((m) => Number(m[1]));
  if (/incident entry/.test(system)) {
    return {
      title: 'Stub title (run enrich-incidents.mjs with a real key)',
      summary: 'Stub summary.',
      impact: 'Stub impact.',
      causes: [{ cause: 'Stub cause', likelihood: 'most likely', why: 'Stub.', lines: lines.slice(0, 2) }],
      fix: ['Stub fix'],
    };
  }
  return {
    answer: 'Stub answer: the cited lines below are what retrieval found for this question.',
    points: [{ text: 'First retrieved evidence.', lines: lines.slice(0, 2), types: ['S1'] }],
    confidence: 'medium',
    abstain: false,
  };
}

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/chat/completions')) {
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(chat(body)) } }], usage: { total_tokens: 0 } }));
  } else if (req.url.includes(':batchEmbedContents')) {
    res.end(JSON.stringify({ embeddings: body.requests.map((r) => ({ values: bowVector(r.content.parts[0].text) })) }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
}).listen(8089, () => console.log('llm stub on :8089'));
