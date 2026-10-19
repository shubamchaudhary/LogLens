// Shared, dependency-free formatting helpers for analysis data.
//
// Times are shown in UTC: the backend stores log timestamps without a zone as
// UTC, so UTC is what matches the text of the log lines themselves.

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

function parse(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "09:30:04" (UTC). */
export function fmtClock(iso) {
  const d = parse(iso);
  return d ? CLOCK.format(d) : '—';
}

/** "15 Jul 2026, 09:30:04 UTC". */
export function fmtTime(iso) {
  const d = parse(iso);
  return d ? `${DATE.format(d)}, ${CLOCK.format(d)} UTC` : '—';
}

/** "15 Jul 2026, 09:30:04 → 09:34:08 UTC" (date shown once when both ends share it). */
export function fmtRange(start, end) {
  const a = parse(start);
  const b = parse(end);
  if (!a && !b) return '—';
  if (!a || !b) return fmtTime(start || end);
  if (DATE.format(a) === DATE.format(b)) {
    return `${DATE.format(a)}, ${CLOCK.format(a)} → ${CLOCK.format(b)} UTC`;
  }
  return `${fmtTime(start)} → ${fmtTime(end)}`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtNum(n) {
  if (n == null) return '—';
  const num = typeof n === 'string' ? Number(n) : n;
  if (Number.isNaN(num)) return String(n);
  return Number.isInteger(num) ? num.toLocaleString('en-US') : num.toFixed(2);
}
