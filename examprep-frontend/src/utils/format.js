// Shared, dependency-free formatting helpers for analysis data.

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function fmtRange(start, end) {
  if (!start && !end) return '—';
  if (start && end) return `${fmtTime(start)} → ${fmtTime(end)}`;
  return fmtTime(start || end);
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtNum(n) {
  if (n == null) return '—';
  const num = typeof n === 'string' ? Number(n) : n;
  if (Number.isNaN(num)) return String(n);
  return Number.isInteger(num) ? num.toLocaleString() : num.toFixed(2);
}
