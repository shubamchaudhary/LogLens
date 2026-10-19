import { fmtBytes } from '../utils/format';

const STEPS = ['CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING', 'DONE'];

/** What each pipeline stage does, in plain words (sub-labels use the run's own numbers when known). */
function stages(stats) {
  const n = (x) => (x == null ? null : x.toLocaleString('en-US'));
  return {
    CHUNKING: {
      label: 'Split',
      sub: stats ? `${fmtBytes(stats.bytes)} → ${stats.parts} parts` : 'into parts on Kafka',
      hint: 'One streaming pass cuts the file into ~5 MB parts on 1-minute boundaries and queues them on Kafka, so memory stays flat at any file size.',
    },
    PARSING: {
      label: 'Parse & detect',
      sub: stats ? `${n(stats.lines)} lines` : 'exact metrics',
      hint: 'Parallel consumers read their part with an HTTP Range request; 8 regex parsers count every request, error, GC pause and SQL call per minute, and robust statistics flag the unusual minutes.',
    },
    ENRICHING: {
      label: 'Explain',
      sub: stats ? `${n(stats.flaggedChunks)} flagged chunks` : 'LLM on anomalies',
      hint: 'Only the flagged chunks go to the LLM, which returns findings as JSON. Every chunk also gets a vector embedding for search. One Kafka partition per API key keeps each worker inside its rate limit.',
    },
    CORRELATING: {
      label: 'Correlate',
      sub: 'findings → incidents',
      hint: 'A LangGraph agent groups findings across services into incidents, and an LLM judge drops any claim its cited lines do not support.',
    },
    REPORTING: {
      label: 'Report',
      sub: 'causes & follow-ups',
      hint: 'Ranking incidents by impact and writing probable causes with the lines that show them.',
    },
    DONE: { label: 'Ready', sub: 'ask questions' },
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

  const currentIdx = STEPS.indexOf(status);
  const pct = total > 0 ? Math.min(100, Math.round((enriched / total) * 100)) : 0;

  return (
    <div className="card p-6">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Analysis pipeline</h3>
        {failed ? <span className="text-sm font-medium text-rose-600">Failed</span> : <span className="text-xs text-slate-400">live</span>}
      </div>

      <ol className="mb-6 grid grid-cols-3 gap-y-4 sm:flex sm:w-full sm:items-start">
        {STEPS.map((step, i) => {
          const done = !failed && currentIdx > i;
          const active = !failed && currentIdx === i;
          return (
            <li key={step} className={`flex items-start ${i < STEPS.length - 1 ? 'sm:flex-1' : ''}`}>
              <div className="flex w-full flex-col items-center text-center sm:w-auto">
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
                <span className={`mt-1.5 whitespace-nowrap text-[11px] font-semibold ${active ? 'text-violet-700' : done ? 'text-slate-700' : 'text-slate-400'}`}>
                  {S[step].label}
                </span>
                <span className="whitespace-nowrap text-[10px] text-slate-400">{S[step].sub}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className="mx-2 mt-4 hidden h-0.5 flex-1 overflow-hidden rounded bg-slate-200 sm:block">
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
            <span>Work items (LLM explanations + embedding batches)</span>
            <span className="font-semibold text-slate-700">
              {enriched} / {total}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-violet-600 to-pink-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {S[status]?.hint && <p className="text-sm text-slate-500">{S[status].hint}</p>}
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
