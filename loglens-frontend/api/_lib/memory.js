// Conversation memory for Ask: the recent turns of each chat, keyed by a conversation id
// the browser makes. Redis when REDIS_URL is set (any Redis, e.g. Upstash: a list per
// conversation, trimmed to the last 20 turns, expiring a day after the last message);
// otherwise a Postgres table, so Ask keeps its memory before Redis is configured.

import { createClient } from 'redis';
import { db } from './db.js';

const KEEP = 20;
const TTL_S = 24 * 3600;
const key = (id) => `ask:chat:${id}`;

let client; // one connection per function instance, reused across requests
async function redis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: false } });
    client.on('error', () => {}); // a lost connection fails the call below, which falls back
    await client.connect();
  }
  return client;
}

let tableReady = false;
async function table() {
  if (!tableReady) {
    await db().query(`CREATE TABLE IF NOT EXISTS ask_turns (
      conversation text NOT NULL, at timestamptz NOT NULL DEFAULT now(), turn jsonb NOT NULL)`);
    await db().query('CREATE INDEX IF NOT EXISTS ask_turns_conv ON ask_turns (conversation, at)');
    tableReady = true;
  }
}

export const memoryBackend = () => (process.env.REDIS_URL ? 'redis' : 'postgres');

/** The last `n` turns of a conversation, oldest first. */
export async function getTurns(id, n = 4) {
  if (!id) return [];
  try {
    const r = await redis();
    if (r) return (await r.lRange(key(id), -n, -1)).map((s) => JSON.parse(s));
  } catch {
    client = null; // reconnect next time
  }
  await table();
  const { rows } = await db().query('SELECT turn FROM ask_turns WHERE conversation = $1 ORDER BY at DESC LIMIT $2', [id, n]);
  return rows.map((x) => x.turn).reverse();
}

/** Appends one turn: what was asked, how it was understood and what was answered. */
export async function addTurn(id, turn) {
  if (!id) return;
  try {
    const r = await redis();
    if (r) {
      await r.multi().rPush(key(id), JSON.stringify(turn)).lTrim(key(id), -KEEP, -1).expire(key(id), TTL_S).exec();
      return;
    }
  } catch {
    client = null;
  }
  await table();
  await db().query('INSERT INTO ask_turns (conversation, turn) VALUES ($1, $2)', [id, turn]);
  // Same lifetime as in Redis: now and then, drop conversations idle for a day.
  if (Math.random() < 0.05) await db().query("DELETE FROM ask_turns WHERE at < now() - interval '1 day'");
}
