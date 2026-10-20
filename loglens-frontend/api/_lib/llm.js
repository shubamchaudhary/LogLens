// Groq (chat, JSON output) and Gemini (embeddings) over plain fetch, with key
// rotation: keys come comma-separated (GROQ_API_KEYS / GEMINI_API_KEYS), each call
// starts at a random key and moves on when one is rate-limited (429) or rejected.
// Base URLs can be overridden to point at a local stub for tests.

const GROQ_URL = () => process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GEMINI_URL = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
export const CHAT_MODEL = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// gpt-oss reasons before answering and those tokens count against max_tokens.
const reasoning = (model) => (model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {});
const EMBED_MODEL = 'gemini-embedding-001';
export const EMBED_DIM = 768;

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function keys(name) {
  const raw = process.env[`${name}_API_KEYS`] || process.env[`${name}_API_KEY`] || '';
  const list = raw.split(',').map((k) => k.trim()).filter(Boolean);
  if (list.length === 0) throw new LlmError(`${name}_API_KEYS is not set`, 500);
  return list;
}

async function withKeys(name, call) {
  const list = keys(name);
  const start = Math.floor(Math.random() * list.length);
  let last;
  for (let i = 0; i < list.length; i++) {
    const resp = await call(list[(start + i) % list.length]);
    if (resp.ok) return resp.json();
    last = new LlmError(`${name} ${resp.status}: ${(await resp.text()).slice(0, 300)}`, resp.status);
    if (![401, 403, 429, 500, 502, 503].includes(resp.status)) break; // a bad request won't succeed on another key
  }
  throw last;
}

/** Chat completion that must return a JSON object; returns the parsed object. */
export async function chatJson(system, user, { maxTokens = 700, temperature = 0.1 } = {}) {
  const data = await withKeys('GROQ', (key) =>
    fetch(`${GROQ_URL()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL(),
        ...reasoning(CHAT_MODEL()),
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
  );
  const text = data.choices?.[0]?.message?.content || '';
  try {
    return { json: JSON.parse(text), usage: data.usage };
  } catch {
    throw new LlmError('model returned invalid JSON', 502);
  }
}

/**
 * Chat completion with Groq's built-in web search (gpt-oss models only). Returns the
 * answer text without the model's inline citation marks, plus the pages it read.
 */
export async function chatWeb(system, user, { maxTokens = 900 } = {}) {
  if (!CHAT_MODEL().startsWith('openai/gpt-oss')) throw new LlmError('web search needs a gpt-oss model', 400);
  const data = await withKeys('GROQ', (key) =>
    fetch(`${GROQ_URL()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL(),
        ...reasoning(CHAT_MODEL()),
        max_tokens: maxTokens,
        tools: [{ type: 'browser_search' }],
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
  );
  const msg = data.choices?.[0]?.message || {};
  const text = String(msg.content || '')
    .replace(/【[^】]*】/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
  // search_results is normally {results: [{title, url}]}; older responses sent a Python-style string.
  const sources = [];
  const add = (title, url) => {
    if (!url || /exa\.ai\/search/.test(url) || /viewing lines/.test(title) || sources.some((x) => x.url === url)) return;
    sources.push({ title: String(title || '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120), url });
  };
  for (const t of msg.executed_tools || []) {
    const sr = t.search_results;
    if (sr && typeof sr === 'object') for (const r of sr.results || []) add(r.title, r.url);
    else for (const m of String(sr || '').matchAll(/'title': (['"])(.*?)\1, 'url': '(https?:\/\/[^']+)'/g)) add(m[2], m[3]);
  }
  return { text, sources: sources.slice(0, 4), usage: data.usage };
}

const normalise = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

/** Embeds texts with gemini-embedding-001 at 768 dims (normalised, as Google advises below 3072). */
export async function embed(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const data = await withKeys('GEMINI', (key) =>
      fetch(`${GEMINI_URL()}/models/${EMBED_MODEL}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${EMBED_MODEL}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: EMBED_DIM,
          })),
        }),
      })
    );
    for (const e of data.embeddings) out.push(normalise(e.values));
  }
  return out;
}

/** pgvector literal for a vector. */
export const vec = (v) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;
