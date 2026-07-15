import { fmtRange } from '../../utils/format';

/**
 * Correlated incidents. Each groups one or more findings under a narrative and a
 * root-cause hypothesis; we resolve finding ids to titles when the findings list
 * is available.
 */
export default function IncidentsTab({ incidents, findings = [] }) {
  if (!incidents || incidents.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
        <p className="text-sm font-medium text-gray-700">No incidents</p>
        <p className="mt-1 text-sm text-gray-400">
          Correlation didn't group the findings into any incidents.
        </p>
      </div>
    );
  }

  const titleOf = (id) => findings.find((f) => f.id === id)?.title;

  return (
    <div className="space-y-3">
      {incidents.map((inc, idx) => (
        <div key={inc.id} className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-900">Incident {idx + 1}</h4>
            <span className="text-[11px] text-gray-400">{fmtRange(inc.timeRangeStart, inc.timeRangeEnd)}</span>
          </div>

          {inc.narrative && (
            <p className="mt-2 text-sm text-gray-700 leading-relaxed">{inc.narrative}</p>
          )}

          {inc.rootCauseHypothesis && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-100 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                Root-cause hypothesis
              </p>
              <p className="mt-1 text-sm text-amber-900">{inc.rootCauseHypothesis}</p>
            </div>
          )}

          {inc.findingIds?.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-medium text-gray-500 mb-1">
                {inc.findingIds.length} correlated finding{inc.findingIds.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-1">
                {inc.findingIds.map((fid) => (
                  <li key={fid} className="text-xs text-gray-600 truncate">
                    • {titleOf(fid) || fid}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
