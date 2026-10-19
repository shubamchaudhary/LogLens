const STEPS = ['CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING', 'DONE'];
const STEP_LABELS = {
  CHUNKING: 'Split',
  PARSING: 'Parse',
  ENRICHING: 'Enrich',
  CORRELATING: 'Correlate',
  REPORTING: 'Report',
  DONE: 'Done',
};
const STEP_HINTS = {
  CHUNKING: 'Streaming splitter cuts the file into window-aligned parts on Kafka.',
  PARSING: 'Deterministic parsers compute exact metrics per 1-minute window; the anomaly gate picks windows for the LLM.',
  ENRICHING: 'Flagged windows get LLM explanations; every window is embedded for Q&A.',
  CORRELATING: 'LangGraph clusters findings into incidents and ground-checks every claim.',
  REPORTING: 'Writing the incident report.',
};

/**
 * Live pipeline stepper driven by the SSE progress stream.
 * `progress` = { status, enriched, total }.
 */
export default function ProgressTracker({ progress }) {
  const status = progress?.status || 'CREATED';
  const enriched = progress?.enriched ?? 0;
  const total = progress?.total ?? 0;
  const failed = status === 'FAILED';

  const currentIdx = STEPS.indexOf(status);
  const pct = total > 0 ? Math.min(100, Math.round((enriched / total) * 100)) : 0;

  return (
    <div className="card p-6">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Analysis pipeline</h3>
        {failed ? (
          <span className="text-sm font-medium text-rose-600">Failed</span>
        ) : (
          <span className="text-xs text-slate-400">updates live</span>
        )}
      </div>

      <ol className="mb-6 flex w-full items-center">
        {STEPS.map((step, i) => {
          const done = !failed && currentIdx > i;
          const active = !failed && currentIdx === i;
          return (
            <li key={step} className={`flex items-center ${i < STEPS.length - 1 ? 'w-full' : ''}`}>
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition ${
                    done
                      ? 'bg-gradient-to-br from-violet-600 to-pink-500 text-white'
                      : active
                        ? 'bg-violet-50 text-violet-700 ring-2 ring-violet-500 ring-offset-2'
                        : failed && currentIdx === i
                          ? 'bg-rose-100 text-rose-700 ring-2 ring-rose-500'
                          : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {done ? '✓' : active && step !== 'DONE' ? <Spinner /> : i + 1}
                </span>
                <span
                  className={`mt-1.5 whitespace-nowrap text-[11px] ${active ? 'font-semibold text-violet-700' : 'text-slate-400'}`}
                >
                  {STEP_LABELS[step]}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="-mt-5 mx-1.5 h-0.5 flex-1 overflow-hidden rounded bg-slate-200 sm:mx-2">
                  <div
                    className={`h-full bg-gradient-to-r from-violet-600 to-pink-500 transition-all duration-700 ${done ? 'w-full' : 'w-0'}`}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {status === 'ENRICHING' && total > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>Enrichment work items (LLM + embeddings)</span>
            <span className="font-semibold text-slate-700">
              {enriched} / {total}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-violet-600 to-pink-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {STEP_HINTS[status] && <p className="text-sm text-slate-500">{STEP_HINTS[status]}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
