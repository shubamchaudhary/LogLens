#!/usr/bin/env node
// One streaming pass over the 1 GB log. Writes to scripts/demo/.data/:
//   events.jsonl      every WARN/ERROR record (stack traces and Detail lines attached)
//                     plus notable INFO events (deploys, rollbacks, failovers, config
//                     changes, restarts, consumer-group changes), with exact line numbers
//   signatures.json   each distinct failure message template: count, first/last line, per-minute counts
//   minutes.json      per minute: lines, ERROR/WARN records, top signatures
//   index.json        byte offset of every 1,000th line (lets the preview fetch any line by HTTP Range)
//
// Usage (from loglens-frontend/): node scripts/demo/extract.mjs

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '.data');
const LOG = resolve(DATA, 'deeploglens-1gb.log');
const INDEX_EVERY = 1000;

const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /;
const RECORD =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) (\w+)\s+\[([\w-]+)\] pod=(\S+) trace=(\w+) tenant=(\S+) - (\S+) : (.*)$/;
const NOTABLE =
  /rolled out image|rolled back|Reloaded truststore|Applied consumer config|Flash sale started|Started \w+Application|LeaveGroup|Revoke previously assigned|\(Re-\)joining group|Reconnected to|Log export started/;

/** Message → template: ids, numbers, hex, IPs and quoted text become placeholders. */
export function template(msg) {
  return msg
    .replace(/"[^"]*"/g, '"*"')
    .replace(/\b[a-z]+(?:-[a-z]+)*-[0-9a-f]{6}-[a-z0-9]{5}\b/g, '<pod>')
    .replace(/\?q=[^\s]+/g, '?q=*')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/<[^>\s]+@[^>\s]+>/g, '<id>')
    .replace(/\b[A-Z]+-\d+\b/g, (m) => m.replace(/\d+/, '<n>'))
    .replace(/\d+(\.\d+)?/g, '<n>');
}

const sigId = (key) => createHash('sha1').update(key).digest('hex').slice(0, 10);

const events = createWriteStream(resolve(DATA, 'events.jsonl'));
const signatures = new Map();
const minutes = new Map();
const index = [0];
const services = new Set();
const tenants = new Set();

let lineNo = 0;
let bytes = 0;
let current = null; // record being assembled: { first line fields, body lines }

function minute(iso) {
  return iso.slice(0, 16) + ':00Z';
}

function flush() {
  if (!current) return;
  const r = current;
  current = null;
  const m = minutes.get(r.minute);
  if (r.level === 'ERROR') m.errors++;
  if (r.level === 'WARN') m.warns++;
  const tpl = template(r.message);
  const key = `${r.level}|${r.service}|${r.logger}|${tpl}`;
  const id = sigId(key);
  let s = signatures.get(id);
  if (!s) {
    s = {
      id,
      level: r.level,
      service: r.service,
      logger: r.logger,
      template: tpl,
      count: 0,
      firstLine: r.lineNo,
      firstTs: r.ts,
      sample: r.message,
      perMinute: {},
    };
    signatures.set(id, s);
  }
  s.count++;
  s.lastLine = r.lineNo;
  s.lastTs = r.ts;
  s.perMinute[r.minute] = (s.perMinute[r.minute] || 0) + 1;
  m.sigs[id] = (m.sigs[id] || 0) + 1;
  events.write(
    JSON.stringify({
      line_no: r.lineNo,
      line_end: r.lineNo + r.body.length - 1,
      ts: r.ts,
      level: r.level,
      service: r.service,
      pod: r.pod,
      tenant: r.tenant,
      logger: r.logger,
      message: r.message,
      body: r.body.join('\n'),
      signature: id,
    }) + '\n'
  );
}

const rl = createInterface({ input: createReadStream(LOG, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });
for await (const line of rl) {
  lineNo++;
  if (lineNo % INDEX_EVERY === 1 && lineNo > 1) index.push(bytes);
  bytes += line.length + 1; // the file is ASCII
  if (!TS.test(line)) {
    if (current) current.body.push(line); // stack frame / Detail line of the record above
    continue;
  }
  flush();
  const ts = `${line.slice(0, 10)}T${line.slice(11, 23)}Z`;
  const min = minute(ts);
  let m = minutes.get(min);
  if (!m) {
    m = { bucket: min, lines: 0, errors: 0, warns: 0, sigs: {} };
    minutes.set(min, m);
  }
  m.lines++;
  services.add(line.slice(31, line.indexOf(']', 31)));
  const tn = line.indexOf(' tenant=');
  if (tn > 0) tenants.add(line.slice(tn + 8, line.indexOf(' ', tn + 8)));
  const level = line.slice(24, 29).trim();
  if (level !== 'WARN' && level !== 'ERROR' && !(level === 'INFO' && NOTABLE.test(line))) continue;
  const p = RECORD.exec(line);
  if (!p) continue;
  current = {
    lineNo,
    ts,
    minute: min,
    level: p[3],
    service: p[4],
    pod: p[5],
    tenant: p[7],
    logger: p[8],
    message: p[9],
    body: [line],
  };
}
flush();
await new Promise((r) => events.end(r));

writeFileSync(resolve(DATA, 'signatures.json'), JSON.stringify([...signatures.values()]));
writeFileSync(resolve(DATA, 'minutes.json'), JSON.stringify([...minutes.values()]));
const people = [...tenants].filter((t) => t !== '-' && t !== 'system');
writeFileSync(
  resolve(DATA, 'index.json'),
  JSON.stringify({ every: INDEX_EVERY, lines: lineNo, bytes, services: [...services].sort(), tenants: people.sort(), offsets: index })
);
console.log(
  `${lineNo} lines, ${bytes} bytes, ${minutes.size} minutes, ${signatures.size} signatures, ` +
    `${[...signatures.values()].reduce((s, x) => s + x.count, 0)} events`
);
