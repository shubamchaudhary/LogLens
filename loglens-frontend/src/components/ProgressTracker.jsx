import { fmtBytes } from '../utils/format';

// UPLOAD is done by the time this shows; the rest follow the backend's statuses.
const STEPS = ['UPLOAD', 'CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING', 'DONE'];

/** Each pipeline stage's name, with the run's own numbers under it when known. */
function stages(stats) {
  const n = (x) => (x == null ? null : x.toLocaleString('en-US'));
  return {
    UPLOAD: { label: 'Upload', sub: stats ? fmtBytes(stats.bytes) : 'to storage' },
    CHUNKING: { label: 'Chunk', sub: stats ? `${stats.parts} chunks` : '~5 MB chunks' },
    PARSING: { label: 'Parse', sub: stats ? `${n(stats.lines)} lines` : 'every line' },
    ENRICHING: { label: 'Enrich', sub: 'AI on anomalies' },
    CORRELATING: { label: 'Correlate', sub: 'into incidents' },
    REPORTING: { label: 'Report', sub: 'root causes' },
    DONE: { label: 'Done', sub: 'report and Q&A' },
  };
}

/**
 * Live pipeline stepper driven by the SSE progress stream.
 * `progress` = { status, enriched, total }.
 */
export default function ProgressTracker({ progress, stats }) {
  const status = progress?.status || 'CREATED';
  const enriched = progress?.enriched ?? 0;
  const total = progress?.total ?? 0;
  const failed = status === 'FAILED';
  const S = stages(stats);

  const currentIdx = Math.max(1, STEPS.indexOf(status));
  const pct = total > 0 ? Math.min(100, Math.round((enriched / total) * 100)) : 0;

  return (
    <div className="card p-6">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Analysing the log</h3>
        {failed ? <span className="text-sm font-medium text-rose-600">Failed</span> : <span className="text-xs text-slate-400">live</span>}
      </div>

      <ol className="grid grid-cols-4 gap-y-4 sm:flex sm:w-full sm:items-start">
        {STEPS.map((step, i) => {
          const done = !failed && currentIdx > i;
          const active = !failed && currentIdx === i;
          return (
            <li key={step} className={`flex items-start ${i < STEPS.length - 1 ? 'sm:flex-1' : ''}`}>
              <div className="flex w-full flex-col items-center text-center sm:w-auto">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition ${
                    done
                      ? 'bg-accent text-on-accent'
                      : active
                        ? 'bg-accent-soft text-accent ring-2 ring-accent ring-offset-2 ring-offset-surface'
                        : failed && currentIdx === i
                          ? 'bg-rose-500/15 text-rose-600 ring-2 ring-rose-500'
                          : 'bg-sand text-slate-400'
                  }`}
                >
                  {done ? '✓' : active && step !== 'DONE' ? <Spinner /> : i + 1}
                </span>
                <span className={`mt-1.5 whitespace-nowrap text-[11px] font-semibold ${active ? 'text-accent' : done ? 'text-ink' : 'text-slate-400'}`}>
                  {S[step].label}
                </span>
                <span className="whitespace-nowrap text-[10px] text-slate-400">{S[step].sub}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="mx-2 mt-4 hidden h-0.5 flex-1 overflow-hidden rounded bg-line2 sm:block">
                  <div
                    className={`h-full bg-accent transition-all duration-700 ${done ? 'w-full' : 'w-0'}`}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {status === 'ENRICHING' && total > 0 && (
        <div className="mt-6">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>Anomalies enriched</span>
            <span className="font-semibold text-ink">
              {enriched} / {total}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-sand">
            <div
              className="h-2 rounded-full bg-accent transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

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
