import { useState } from 'react';
import { fmtRange, fmtNum } from '../../utils/format';

const SEVERITY = {
  CRITICAL: 'bg-red-100 text-red-800 border-red-200',
  ERROR: 'bg-orange-100 text-orange-800 border-orange-200',
  WARN: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  INFO: 'bg-blue-100 text-blue-800 border-blue-200',
};

const SEVERITY_ORDER = ['CRITICAL', 'ERROR', 'WARN', 'INFO'];

export default function FindingsTab({ findings }) {
  const [severity, setSeverity] = useState('');

  if (!findings || findings.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
        <p className="text-sm font-medium text-gray-700">No findings</p>
        <p className="mt-1 text-sm text-gray-400">
          The enrichment pass didn't flag anything for this session.
        </p>
      </div>
    );
  }

  const present = SEVERITY_ORDER.filter((s) => findings.some((f) => f.severity === s));
  const shown = severity ? findings.filter((f) => f.severity === severity) : findings;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setSeverity('')}
          className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
            severity === '' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200'
          }`}
        >
          All ({findings.length})
        </button>
        {present.map((s) => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
              severity === s ? 'ring-2 ring-offset-1 ring-gray-400' : ''
            } ${SEVERITY[s]}`}
          >
            {s} ({findings.filter((f) => f.severity === s).length})
          </button>
        ))}
      </div>

      {shown.map((f) => (
        <div key={f.id} className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                    SEVERITY[f.severity] || SEVERITY.INFO
                  }`}
                >
                  {f.severity}
                </span>
                {f.category && (
                  <span className="text-[11px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                    {f.category}
                  </span>
                )}
                {f.occurrenceCount > 1 && (
                  <span className="text-[11px] text-gray-500">×{f.occurrenceCount}</span>
                )}
              </div>
              <h4 className="mt-1.5 text-sm font-semibold text-gray-900">{f.title}</h4>
            </div>
            {f.confidence != null && (
              <span className="text-[11px] text-gray-400 whitespace-nowrap">
                conf {fmtNum(f.confidence)}
              </span>
            )}
          </div>
          {f.explanation && (
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{f.explanation}</p>
          )}
          <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
            <span>{fmtRange(f.timeRangeStart, f.timeRangeEnd)}</span>
            {f.evidenceChunkIds?.length > 0 && (
              <span>
                {f.evidenceChunkIds.length} evidence chunk
                {f.evidenceChunkIds.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
