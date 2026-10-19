import { fmtRange } from '../../utils/format';
import { SEVERITY_STYLES, worstFinding } from '../../utils/severity';
import Icon from '../Icon';

/**
 * Correlated incidents. Each groups one or more findings under a narrative and a
 * root-cause hypothesis; we resolve finding ids to titles when the findings list
 * is available.
 */
export default function IncidentsTab({ incidents, findings = [] }) {
  if (!incidents || incidents.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm font-medium text-slate-700">No incidents</p>
        <p className="mt-1 text-sm text-slate-400">Correlation didn't group the findings into any incidents.</p>
      </div>
    );
  }

  return (
    <ol className="relative space-y-4 before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-px before:bg-violet-200">
      {incidents.map((inc, idx) => {
        const worst = worstFinding(inc.findingIds, findings);
        return (
          <li key={inc.id} className="relative flex gap-4">
            <span className="z-10 mt-4 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-pink-500 text-xs font-bold text-white shadow-md shadow-violet-500/30">
              {idx + 1}
            </span>
            <div className="card min-w-0 flex-1 p-5 animate-fade-up">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="text-[15px] font-semibold text-slate-900">
                  {worst?.title || `Incident ${idx + 1}`}
                </h4>
                <span className="flex items-center gap-1 text-[11px] text-slate-400">
                  <Icon name="clock" className="h-3.5 w-3.5" />
                  {fmtRange(inc.timeRangeStart, inc.timeRangeEnd)}
                </span>
              </div>

              {inc.narrative && <p className="mt-2 text-sm leading-relaxed text-slate-700">{inc.narrative}</p>}

              {inc.rootCauseHypothesis && (
                <div className="mt-3 rounded-xl border border-violet-100 bg-gradient-to-br from-violet-50 to-pink-50 p-3.5">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-violet-700">
                    <Icon name="sparkles" className="h-3.5 w-3.5" /> Root-cause hypothesis
                  </p>
                  <p className="mt-1 text-sm text-slate-800">{inc.rootCauseHypothesis}</p>
                </div>
              )}

              {inc.findingIds?.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                    {inc.findingIds.length} correlated finding{inc.findingIds.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-1">
                    {inc.findingIds.map((fid) => {
                      const f = findings.find((x) => x.id === fid);
                      const sev = SEVERITY_STYLES[f?.severity] || SEVERITY_STYLES.INFO;
                      return (
                        <li key={fid} className="flex items-center gap-2 text-xs text-slate-600">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
                          <span className="truncate">{f?.title || fid}</span>
                          {f?.occurrenceCount > 1 && (
                            <span className="shrink-0 text-slate-400">×{f.occurrenceCount}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
