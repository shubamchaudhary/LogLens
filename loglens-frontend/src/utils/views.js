// Adapters from the backend's API rows to the view models the result tabs render
// (the guest session's fixture already has these shapes).

import { severityRank } from './severity';

const LEVEL = { CRITICAL: 'ERROR', ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO' };

/** Backend incident + its findings → the Incidents tab's view model. */
export function incidentView(inc, findings) {
  const own = (inc.findingIds || []).map((id) => findings.find((f) => f.id === id)).filter(Boolean);
  own.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const worst = own[0];
  return {
    id: inc.id,
    start: inc.timeRangeStart,
    end: inc.timeRangeEnd,
    severity: worst?.severity || 'INFO',
    title: worst?.title || inc.narrative?.split('. ')[0] || 'Incident',
    summary: inc.narrative,
    impact: null,
    causes: inc.rootCauseHypothesis
      ? [{ cause: inc.rootCauseHypothesis, likelihood: 'most likely', why: '', lines: [] }]
      : [],
    fix: [],
    failures: own.map((f) => ({
      id: f.id,
      level: LEVEL[f.severity] || 'INFO',
      service: f.category,
      template: f.title,
      sample: f.explanation || f.title,
      count: f.occurrenceCount,
      first: f.timeRangeStart,
      last: f.timeRangeEnd,
    })),
    evidence: [],
    evidenceChunkIds: [...new Set(own.flatMap((f) => f.evidenceChunkIds || []))].slice(0, 6),
  };
}

/** Backend drill-down answer + cited chunks → the Ask tab's view model. */
export function askView(question, answer, chunks) {
  return {
    question,
    answer,
    markdown: true,
    abstained: false,
    confidence: null,
    trace: [],
    points: chunks.length
      ? [{ text: 'Cited log chunks', types: [], lines: chunks.map((c) => ({ no: c.lineStart, text: c.content })) }]
      : [],
  };
}
