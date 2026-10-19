// GET /api/log?line=N&count=C  → lines N..N+C-1 of the 1 GB log, read with an HTTP
// Range request (the same trick the ingest pipeline uses: never read the whole file).
// GET /api/log?info=1          → file facts and the download links.
//
// LOG_FILE_URL: where the raw file is served (any host that honours Range, e.g. a
// GitHub release asset, S3/R2/B2). LOG_FILE_GZ_URL: optional compressed download.
// LOG_FILE_PATH: local file instead of a URL (development).

import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';

// line → byte offset index written by scripts/demo/build-dataset.mjs
const index = JSON.parse(readFileSync(new URL('./_lib/log-index.json', import.meta.url), 'utf8'));

const MAX_LINES = 400;

async function readRange(start, end) {
  if (process.env.LOG_FILE_PATH) {
    const fh = await open(process.env.LOG_FILE_PATH, 'r');
    try {
      const buf = Buffer.alloc(end - start + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  }
  if (!process.env.LOG_FILE_URL) throw Object.assign(new Error('LOG_FILE_URL is not set'), { status: 503 });
  const resp = await fetch(process.env.LOG_FILE_URL, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
  if (resp.status !== 206) throw Object.assign(new Error(`file host answered ${resp.status} to a Range request`), { status: 502 });
  return resp.text();
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.has('info')) {
    return res.status(200).json({
      name: index.name,
      bytes: index.bytes,
      lines: index.lines,
      sha256: index.sha256,
      downloadUrl: process.env.LOG_FILE_URL || null,
      gzipUrl: process.env.LOG_FILE_GZ_URL || null,
      previewAvailable: Boolean(process.env.LOG_FILE_URL || process.env.LOG_FILE_PATH),
    });
  }

  const line = Math.min(Math.max(1, Number(url.searchParams.get('line')) || 1), index.lines);
  const count = Math.min(Math.max(1, Number(url.searchParams.get('count')) || 100), MAX_LINES);
  const last = Math.min(index.lines, line + count - 1);

  // Byte range that covers [line, last] using the line → byte offset index.
  const k0 = Math.floor((line - 1) / index.every);
  const k1 = Math.floor((last - 1) / index.every) + 1;
  const start = index.offsets[k0];
  const end = (k1 < index.offsets.length ? index.offsets[k1] : index.bytes) - 1;

  try {
    const text = await readRange(start, end);
    const all = text.split('\n');
    const from = line - (k0 * index.every + 1);
    const lines = all.slice(from, from + (last - line + 1));
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(200).json({ line, lines, total: index.lines });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
}
