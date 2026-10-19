#!/usr/bin/env node
// Serves the Vercel functions in api/ locally on :3001 (Vite proxies /api here in dev).
//   DATABASE_URL=... GROQ_API_KEYS=... GEMINI_API_KEYS=... LOG_FILE_PATH=... node scripts/dev-api.mjs

import { createServer } from 'node:http';

const routes = {
  '/api/ask': (await import('../api/ask.js')).default,
  '/api/log': (await import('../api/log.js')).default,
};

createServer(async (req, res) => {
  const handler = routes[new URL(req.url, 'http://x').pathname];
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  req.body = raw ? JSON.parse(raw) : {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  await handler(req, res);
}).listen(Number(process.env.PORT || 3001), () => console.log(`api on http://localhost:${process.env.PORT || 3001}`));
