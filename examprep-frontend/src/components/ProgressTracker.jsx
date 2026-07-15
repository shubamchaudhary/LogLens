const STEPS = ['CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING', 'DONE'];
const STEP_LABELS = {
  CHUNKING: 'Chunk',
  PARSING: 'Parse',
  ENRICHING: 'Enrich',
  CORRELATING: 'Correlate',
  REPORTING: 'Report',
  DONE: 'Done',
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
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-semibold text-gray-800">Analysis progress</h3>
        {failed && <span className="text-sm font-medium text-red-600">Failed</span>}
      </div>

      {/* Stepper */}
      <ol className="flex items-center w-full mb-6">
        {STEPS.map((step, i) => {
          const done = !failed && currentIdx > i;
          const active = !failed && currentIdx === i;
          return (
            <li
              key={step}
              className={`flex items-center ${i < STEPS.length - 1 ? 'w-full' : ''}`}
            >
              <div className="flex flex-col items-center">
                <span
                  className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold shrink-0 ${
                    done
                      ? 'bg-indigo-600 text-white'
                      : active
                        ? 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-500'
                        : failed && currentIdx === i
                          ? 'bg-red-100 text-red-700 ring-2 ring-red-500'
                          : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span
                  className={`mt-1.5 text-[11px] whitespace-nowrap ${
                    active ? 'text-indigo-700 font-medium' : 'text-gray-400'
                  }`}
                >
                  {STEP_LABELS[step]}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-2 -mt-5 ${done ? 'bg-indigo-600' : 'bg-gray-200'}`}
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Enrichment window progress */}
      {status === 'ENRICHING' && total > 0 && (
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Enriching windows</span>
            <span>
              {enriched} / {total}
            </span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-400">
            LLM enrichment is rate-limited per API key — this can pause between windows while the
            retry lane drains. That's expected, not a hang.
          </p>
        </div>
      )}

      {status !== 'ENRICHING' && !failed && status !== 'DONE' && (
        <p className="text-sm text-gray-500">Working… this updates live.</p>
      )}
    </div>
  );
}
