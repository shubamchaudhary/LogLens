// POST /api/ask {question, conversationId, first?} → DeepLogLens AI's answer (graph.js).
// With "Accept: application/x-ndjson" the response streams one JSON line per step
// ({"step": "Searching …"}) and ends with {"result": {...}} or {"error": "..."}.
// Guards: 300-char questions, a per-visitor daily quota, a global daily cap, and an
// answer cache for opening questions (identical ones never reach the model twice).

import { createHash } from 'node:crypto';
import { db } from './_lib/db.js';
import { runAsk } from './_lib/graph.js';
import { addTurn } from './_lib/memory.js';

const PER_VISITOR = Number(process.env.ASK_DAILY_LIMIT || 25);
const GLOBAL = Number(process.env.ASK_GLOBAL_DAILY_LIMIT || 1500);

const normalise = (q) => q.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();

function visitor(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  return createHash('sha256').update(`${process.env.ASK_SALT || 'deeploglens'}:${ip}`).digest('hex').slice(0, 24);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const question = String(body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (question.length > 300) return res.status(400).json({ error: 'Keep questions under 300 characters.' });
  const conversationId = /^[\w-]{8,64}$/.test(body.conversationId || '') ? body.conversationId : null;
  // Only an opening question can be answered from the cache: later ones depend on the conversation.
  const first = body.first !== false;

  const streaming = String(req.headers.accept || '').includes('application/x-ndjson');
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  const reply = (status, obj) => {
    if (!streaming) return res.status(status).json(obj);
    send(status === 200 ? { result: obj } : { error: obj.error, status });
    return res.end();
  };
  if (streaming) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
  }

  try {
    const pool = db();
    // Bump the prefix when answers change shape, so older cached answers are not served.
    const key = `v2:${normalise(question)}`;
    if (first) {
      const cached = await pool.query('SELECT response FROM ask_cache WHERE question = $1', [key]);
      if (cached.rows.length) {
        const r = cached.rows[0].response;
        await addTurn(conversationId, { question, standalone: question, mode: r.mode, answer: String(r.answer || '').slice(0, 600), at: new Date().toISOString() }).catch(() => {});
        return reply(200, { ...r, cached: true });
      }
    }

    const who = visitor(req);
    const usage = await pool.query(
      `INSERT INTO ask_usage (visitor, day, count) VALUES ($1, current_date, 1)
       ON CONFLICT (visitor, day) DO UPDATE SET count = ask_usage.count + 1
       RETURNING count, (SELECT coalesce(sum(count), 0) FROM ask_usage WHERE day = current_date) AS total`,
      [who]
    );
    const { count, total } = usage.rows[0];
    if (count > PER_VISITOR || Number(total) > GLOBAL) {
      return reply(429, { error: 'Daily question limit reached. The suggested questions still answer instantly.' });
    }

    const result = await runAsk(question, conversationId, streaming ? (step) => send({ step }) : undefined);
    if (first && !result.standalone) {
      await pool.query('INSERT INTO ask_cache (question, response) VALUES ($1, $2) ON CONFLICT (question) DO NOTHING', [key, result]);
    }
    return reply(200, result);
  } catch (e) {
    console.error('ask failed', e);
    const status = e.status === 429 ? 429 : 502;
    return reply(status, {
      error: status === 429 ? 'The model is busy right now, try again in a minute.' : 'Could not answer right now.',
    });
  }
}
