#!/usr/bin/env node
// One streaming pass over the 1 GB log. Writes to scripts/demo/.data/:
//   events.jsonl      every WARN/ERROR record (stack traces and Detail lines attached)
//                     plus notable INFO events (deploys, rollbacks, failovers, config
//                     changes, restarts, consumer-group changes), with exact line numbers
//   signatures.json   each distinct failure message template: count, first/last line, per-minute counts
//   minutes.json      per minute: lines, ERROR/WARN records, top signatures
//   index.json        byte offset of every 1,000th line (lets the preview fetch any line by HTTP Range)
//   api/_lib/log-profile.json
//                     what the system in the log looks like, from every line (INFO and DEBUG too):
//                     services and what they log most, tenants and their traffic, gateway routes,
//                     dependencies named in the lines (upstream=, provider=, Redis, SQL tables,
//                     Kafka topics, SMTP) and deployments, each with an example line number.
//                     Ask uses it for questions about the system rather than its failures.
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

// ---- log profile ----------------------------------------------------------------
const prof = { services: new Map(), tenants: new Map(), routes: new Map(), deps: new Map(), deploys: [], from: null, to: null };
const NOISE = /HealthEndpoint|^gc$/; // health checks and GC pauses say nothing about what a service does
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\S+) status=(\d{3}) latency=(\d+)ms/;
const clipLine = (l) => (l.length > 320 ? `${l.slice(0, 320)}…` : l);

function bucket(map, key, make) {
  let v = map.get(key);
  if (!v) map.set(key, (v = make()));
  return v;
}

function dep(from, to, kind, ln, line) {
  const d = bucket(prof.deps, `${from}|${to}|${kind}`, () => ({ from, to, kind, count: 0, line: ln, sample: clipLine(line) }));
  d.count++;
}

function profileLine(ln, line, p) {
  const [, , , level, service, pod, , tenant, logger, message] = p;
  const short = logger.split('.').pop();
  const svc = bucket(prof.services, service, () => ({ lines: 0, levels: {}, pods: new Set(), tenants: new Set(), templates: new Map(), tables: new Set() }));
  svc.lines++;
  svc.levels[level] = (svc.levels[level] || 0) + 1;
  svc.pods.add(pod);
  if (tenant !== '-' && tenant !== 'system') svc.tenants.add(tenant);
  if (!NOISE.test(short)) {
    const t = bucket(svc.templates, `${level} ${short}: ${template(message)}`, () => ({ count: 0, line: ln, sample: clipLine(line) }));
    t.count++;
  }

  if (tenant !== '-' && tenant !== 'system') {
    const tn = bucket(prof.tenants, tenant, () => ({ lines: 0, errors: 0, warns: 0, requests: 0, s4xx: 0, s5xx: 0, routes: new Map(), services: new Map() }));
    tn.lines++;
    if (level === 'ERROR') tn.errors++;
    if (level === 'WARN') tn.warns++;
    tn.services.set(service, (tn.services.get(service) || 0) + 1);
  }

  const r = ROUTE.exec(message);
  if (r) {
    const path = r[2].split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}');
    const key = `${r[1]} ${path}`;
    const status = Number(r[3]);
    const route = bucket(prof.routes, key, () => ({ count: 0, s4xx: 0, s5xx: 0, ms: 0, upstream: new Map(), line: ln }));
    route.count++;
    route.ms += Number(r[4]);
    if (status >= 500) route.s5xx++;
    else if (status >= 400) route.s4xx++;
    const up = /upstream=([\w-]+)/.exec(message);
    if (up) {
      route.upstream.set(up[1], (route.upstream.get(up[1]) || 0) + 1);
      dep(service, up[1], 'routes requests to (named on failed requests only)', ln, line);
    }
    if (tenant !== '-' && tenant !== 'system') {
      const tn = prof.tenants.get(tenant);
      tn.requests++;
      if (status >= 500) tn.s5xx++;
      else if (status >= 400) tn.s4xx++;
      tn.routes.set(key, (tn.routes.get(key) || 0) + 1);
    }
  }

  // Dependencies the line itself names.
  const provider = /provider=([\w.-]+)/.exec(message);
  if (provider) dep(service, provider[1], 'calls external API', ln, line);
  if (/RedisCache|Lettuce|Redis|Cache (?:HIT|MISS)/.test(short + ' ' + message)) dep(service, 'Redis', 'caches in', ln, line);
  if (/SqlStatement|HikariPool|SQL executed|PSQLException/.test(short + ' ' + message)) {
    dep(service, 'PostgreSQL', 'reads and writes', ln, line);
    for (const m of message.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/g)) svc.tables.add(m[1]);
  }
  const topic = /records from ([a-z][\w.-]*?)(?:-\d+)? in /.exec(message) || /topic[= ]([a-z][\w.-]+)/.exec(message);
  if (topic) dep(service, `Kafka topic ${topic[1]}`, 'consumes', ln, line);
  if (/SMTP|Email sent|relay=/.test(message)) dep(service, 'SMTP relay', 'sends email via', ln, line);
  if (/rolled out image|rolled back to/.test(message)) prof.deploys.push({ line: ln, text: clipLine(message) });
}

function writeProfile(totalLines, totalBytes) {
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const profile = {
    file: { name: 'deeploglens-1gb.log', lines: totalLines, bytes: totalBytes, from: prof.from, to: prof.to },
    services: [...prof.services.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([name, s]) => ({
        name,
        lines: s.lines,
        levels: s.levels,
        pods: s.pods.size,
        tenants: s.tenants.size,
        tables: [...s.tables].sort(),
        logs: [...s.templates.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 6)
          .map(([tpl, t]) => ({ template: tpl, count: t.count, line: t.line, sample: t.sample })),
      })),
    tenants: [...prof.tenants.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([name, t]) => ({
        name,
        lines: t.lines,
        requests: t.requests,
        errors: t.errors,
        warns: t.warns,
        s4xx: t.s4xx,
        s5xx: t.s5xx,
        routes: top(t.routes, 4).map(([route, count]) => ({ route, count })),
        services: top(t.services, 9).map(([service, count]) => ({ service, count })),
      })),
    routes: [...prof.routes.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 16)
      .map(([route, r]) => ({ route, count: r.count, s4xx: r.s4xx, s5xx: r.s5xx, avgMs: Math.round(r.ms / r.count), upstream: top(r.upstream, 3).map(([service, count]) => ({ service, count })), line: r.line })),
    deps: [...prof.deps.values()].sort((a, b) => b.count - a.count),
    deploys: prof.deploys.slice(0, 20),
  };
  writeFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../api/_lib/log-profile.json'), JSON.stringify(profile));
  return profile;
}

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
  const p = RECORD.exec(line);
  if (p) {
    prof.from ??= ts;
    prof.to = ts;
    profileLine(lineNo, line, p);
  }
  if (level !== 'WARN' && level !== 'ERROR' && !(level === 'INFO' && NOTABLE.test(line))) continue;
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
const profile = writeProfile(lineNo, bytes);
console.log(
  `profile: ${profile.services.length} services, ${profile.tenants.length} tenants, ${profile.routes.length} routes, ${profile.deps.length} dependencies, ${profile.deploys.length} deploys`
);
console.log(
  `${lineNo} lines, ${bytes} bytes, ${minutes.size} minutes, ${signatures.size} signatures, ` +
    `${[...signatures.values()].reduce((s, x) => s + x.count, 0)} events`
);
