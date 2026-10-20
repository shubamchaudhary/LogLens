// Finding severity order + styles, shared by the findings, incidents and overview views.

export const SEVERITY_ORDER = ['CRITICAL', 'ERROR', 'WARN', 'INFO'];

export const SEVERITY_STYLES = {
  CRITICAL: { chip: 'bg-rose-500/10 text-rose-600 border-rose-500/30', dot: 'bg-rose-500' },
  ERROR: { chip: 'bg-orange-500/10 text-orange-600 border-orange-500/30', dot: 'bg-orange-500' },
  WARN: { chip: 'bg-amber-500/10 text-amber-600 border-amber-500/30', dot: 'bg-amber-400' },
  INFO: { chip: 'bg-sky-500/10 text-sky-600 border-sky-500/30', dot: 'bg-sky-400' },
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
