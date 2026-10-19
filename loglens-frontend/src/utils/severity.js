// Finding severity order + styles, shared by the findings, incidents and overview views.

export const SEVERITY_ORDER = ['CRITICAL', 'ERROR', 'WARN', 'INFO'];

export const SEVERITY_STYLES = {
  CRITICAL: { chip: 'bg-rose-50 text-rose-700 border-rose-200', dot: 'bg-rose-500' },
  ERROR: { chip: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  WARN: { chip: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-400' },
  INFO: { chip: 'bg-sky-50 text-sky-700 border-sky-200', dot: 'bg-sky-400' },
};

export const severityRank = (s) => {
  const i = SEVERITY_ORDER.indexOf(s);
  return i < 0 ? SEVERITY_ORDER.length : i;
};

/** The worst-severity finding among `ids`, or null. */
export function worstFinding(ids = [], findings = []) {
  return ids
    .map((id) => findings.find((f) => f.id === id))
    .filter(Boolean)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0] || null;
}
