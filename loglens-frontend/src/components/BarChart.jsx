import { useState } from 'react';

const SERIES_CLS = ['bg-violet-600', 'bg-pink-500', 'bg-slate-400'];
const SERIES_DOT = ['bg-violet-600', 'bg-pink-500', 'bg-slate-400'];

/**
 * Vertical bars, one group per category. `series` lists the measures (one or more,
 * same unit, one axis); `highlight` marks a category (e.g. the layout LogLens uses).
 */
export default function BarChart({ data, series, max, format = (v) => v, height = 170, highlight }) {
  const [hover, setHover] = useState(null);
  const top = max ?? Math.max(...data.flatMap((d) => series.map((s) => d[s.key] ?? 0))) * 1.1;
  return (
    <div>
      <div className="flex items-end gap-2 border-b border-line sm:gap-3" style={{ height }}>
        {data.map((d, i) => (
          <div
            key={d.label}
            className="relative flex h-full min-w-0 flex-1 items-end justify-center gap-1"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            {hover === i && (
              <div className="pointer-events-none absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[11px] text-white shadow-lg">
                {series.map((s) => `${series.length > 1 ? `${s.name} ` : ''}${format(d[s.key])}`).join(' · ')}
              </div>
            )}
            {series.map((s, j) => (
              <div key={s.key} className="flex h-full max-w-9 flex-1 flex-col items-center justify-end">
                {series.length === 1 && <span className="mb-1 font-mono text-[10px] font-semibold text-slate-700">{format(d[s.key])}</span>}
                <div
                  className={`w-full rounded-t-[4px] transition-opacity ${s.cls || SERIES_CLS[j]} ${highlight != null && highlight !== i ? 'opacity-35' : ''}`}
                  style={{ height: `${Math.max(((d[s.key] ?? 0) / top) * 100, 0.8)}%` }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2 sm:gap-3">
        {data.map((d, i) => (
          <span key={d.label} className={`min-w-0 flex-1 text-center text-[11px] leading-tight ${highlight === i ? 'font-semibold text-violet-700' : 'text-slate-500'}`}>
            {d.label}
          </span>
        ))}
      </div>
      {series.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          {series.map((s, j) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-sm ${s.cls || SERIES_DOT[j]}`} /> {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
