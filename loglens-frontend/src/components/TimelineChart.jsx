import { useState } from 'react';
import { fmtClock } from '../utils/format';

const minuteOf = (iso) => Math.floor(new Date(iso).getTime() / 60000);

/**
 * ERROR + WARN lines per minute (stacked bars) with the correlated incidents
 * shaded behind them. Bars are SVG stretched to the container; labels are HTML
 * on top so text never distorts.
 */
export default function TimelineChart({ series, incidents = [], onSelectIncident, height = 190 }) {
  const [hover, setHover] = useState(null);
  const n = series.length;
  if (n === 0) return null;

  const first = minuteOf(series[0].bucket);
  const span = minuteOf(series[n - 1].bucket) - first + 1;
  const pos = (iso) => (minuteOf(iso) - first) / span; // 0..1 along the x axis
  const max = Math.max(1, ...series.map((s) => s.errors + s.warns));
  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  const bands = incidents
    .filter((inc) => inc.start)
    .map((inc, i) => {
      const x0 = pos(inc.start);
      const x1 = pos(inc.end || inc.start) + 1 / span;
      return { inc, i, x0, w: Math.max(x1 - x0, 1 / span) };
    });

  const tickEvery = span > 360 ? 60 : 30;
  const ticks = series.filter((s) => new Date(s.bucket).getUTCMinutes() % tickEvery === 0);
  const flagged = series.filter((s) => s.flagged);
  const hovered = hover != null ? series[hover] : null;

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const minute = first + Math.floor(((e.clientX - r.left) / r.width) * span);
    const idx = series.findIndex((s) => minuteOf(s.bucket) === minute);
    setHover(idx >= 0 ? idx : null);
  };

  return (
    <div>
      <div className="relative" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
          {bands.map(({ i, x0, w }) => (
            <rect key={i} x={x0 * 1000} y="0" width={w * 1000} height="100" className="fill-violet-500/10" />
          ))}
          {series.map((s, i) => {
            const x = pos(s.bucket) * 1000;
            const bw = Math.max(1000 / span - 1, 1.5);
            const he = (s.errors / max) * 92;
            const hw = (s.warns / max) * 92;
            return (
              <g key={s.bucket} opacity={hover == null || hover === i ? 1 : 0.55}>
                {s.warns > 0 && <rect x={x} y={100 - he - hw} width={bw} height={hw} className="fill-amber-400" />}
                {s.errors > 0 && <rect x={x} y={100 - he} width={bw} height={he} className="fill-rose-500" />}
                {s.errors + s.warns === 0 && <rect x={x} y={99} width={bw} height={1} className="fill-slate-300" />}
              </g>
            );
          })}
          {flagged.map((s) => (
            <rect key={`f${s.bucket}`} x={pos(s.bucket) * 1000} y="98.5" width={Math.max(1000 / span, 1.5)} height="1.5" className="fill-violet-600" />
          ))}
        </svg>

        {bands.map(({ inc, i, x0, w }) => (
          <button
            key={inc.id}
            onClick={() => onSelectIncident?.(inc, i)}
            title={`Incident ${i + 1}`}
            className="absolute top-1 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-pink-500 text-[10px] font-bold text-white shadow ring-2 ring-white hover:scale-110"
            style={{ left: pct(x0 + w / 2) }}
          >
            {i + 1}
          </button>
        ))}

        {hovered && (
          <div
            className="pointer-events-none absolute top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] text-white shadow-lg"
            style={{ left: pct(Math.min(Math.max(pos(hovered.bucket) + 0.5 / span, 0.08), 0.92)) }}
          >
            <div className="font-semibold">{fmtClock(hovered.bucket).slice(0, 5)} UTC</div>
            <div className="text-rose-300">{hovered.errors} ERROR</div>
            <div className="text-amber-200">{hovered.warns} WARN</div>
            <div className="text-slate-400">{hovered.lines.toLocaleString('en-US')} lines</div>
            {hovered.flagged && <div className="text-violet-300">flagged by the anomaly gate</div>}
          </div>
        )}
      </div>

      <div className="relative mt-1.5 h-4 border-t border-slate-200 text-[10px] text-slate-400">
        {ticks.map((t) => (
          <span key={t.bucket} className="absolute top-1 -translate-x-1/2" style={{ left: pct(pos(t.bucket)) }}>
            {fmtClock(t.bucket).slice(0, 5)}
          </span>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
        <Legend cls="bg-rose-500" label="ERROR lines / min" />
        <Legend cls="bg-amber-400" label="WARN lines / min" />
        {flagged.length > 0 && <Legend cls="bg-violet-600" label="Minute flagged by the anomaly gate" />}
        {bands.length > 0 && <Legend cls="bg-violet-500/20" label="Incident" />}
        <span className="ml-auto">peak {max} / min · UTC</span>
      </div>
    </div>
  );
}

function Legend({ cls, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}
