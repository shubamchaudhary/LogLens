// POST /api/ask {question, history?} → DeepLogLens AI's answer about the showcase log.
// Guards: 300-char questions, a per-visitor daily quota, a global daily cap, and an
// answer cache (identical questions never reach the model twice).

import { createHash } from 'node:crypto';
import { db } from './_lib/db.js';
import { answer } from './_lib/answer.js';

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

  try {
    // The last few turns, so follow-ups ("and for acme?") make sense. Answers that depend
    // on a conversation are not cached.
    const turns = (Array.isArray(body.history) ? body.history : [])
      .slice(-3)
      .map((t) => ({ question: String(t.question || '').slice(0, 300), answer: String(t.answer || '').slice(0, 600) }))
      .filter((t) => t.question);
    const pool = db();
    const key = normalise(question);
    if (!turns.length) {
      const cached = await pool.query('SELECT response FROM ask_cache WHERE question = $1', [key]);
      if (cached.rows.length) return res.status(200).json({ ...cached.rows[0].response, cached: true });
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
      return res.status(429).json({ error: 'Daily question limit reached. The suggested questions still answer instantly.' });
    }

    const result = await answer(question, turns);
    if (!turns.length) {
      await pool.query('INSERT INTO ask_cache (question, response) VALUES ($1, $2) ON CONFLICT (question) DO NOTHING', [key, result]);
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('ask failed', e);
    const status = e.status === 429 ? 429 : 502;
    return res.status(status).json({
      error: status === 429 ? 'The model is busy right now, try again in a minute.' : 'Could not answer right now.',
    });
  }
}
