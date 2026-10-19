// Derived views over the /metrics, /findings and /incidents payloads, used by the
// overview tab and the landing-page preview. Works for any session, demo or live.

const sum = (rows) => rows.reduce((s, r) => s + (r.count || 0), 0);

/** Per-minute series: log lines, ERROR lines and WARN lines from the parser metrics. */
export function timeline(metrics = []) {
  const byBucket = new Map();
  for (const m of metrics) {
    const key = m.timeBucket;
    if (!byBucket.has(key)) byBucket.set(key, { bucket: key, lines: 0, errors: 0, warns: 0 });
    const b = byBucket.get(key);
    if (m.category === 'TRAFFIC' && m.metric === 'lines') b.lines += m.count;
    if (m.category === 'ERRORS' && m.metric === 'errors') b.errors += m.count;
    if (m.category === 'LEVEL' && m.metric === 'warn_lines') b.warns += m.count;
  }
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function totals(metrics = []) {
  const pick = (cat, metric) => sum(metrics.filter((m) => m.category === cat && m.metric === metric));
  return {
    lines: pick('TRAFFIC', 'lines'),
    errors: pick('ERRORS', 'errors'),
    warns: pick('LEVEL', 'warn_lines'),
    windows: new Set(metrics.map((m) => m.timeBucket)).size,
  };
}
