import { useState } from 'react';
import { fmtNum } from '../utils/format';

// Bounded-memory evidence from bench/results: heap used over a whole ingest (the GC
// sawtooth) against the -Xmx cap, and the live set (heap left after a full GC), which
// is the number that shows memory does not grow with the file.

const mmss = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;

export default function HeapChart({ bench, height = 210 }) {
  const [sel, setSel] = useState(bench.sizes.length - 1);
  const [hover, setHover] = useState(null);
  const run = bench.sizes[sel];
  const top = run.xmxMb;
  const tMax = run.heap.at(-1)[0] || 1;
  const x = (t) => (t / tMax) * 1000;
  const y = (mb) => 200 - (mb / top) * 190;
  const line = run.heap.map(([t, mb], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(mb).toFixed(1)}`).join(' ');
  const area = `${line} L1000 200 L0 200 Z`;
  const pt = hover != null ? run.heap[hover] : null;

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * tMax;
    let best = 0;
    for (let i = 1; i < run.heap.length; i++) if (Math.abs(run.heap[i][0] - t) < Math.abs(run.heap[best][0] - t)) best = i;
    setHover(best);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Heap while ingesting {run.size}</h3>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs font-medium" role="tablist">
          {bench.sizes.map((s, i) => (
            <button
              key={s.size}
              role="tab"
              aria-selected={i === sel}
              onClick={() => {
                setSel(i);
                setHover(null);
              }}
              className={`rounded-md px-2.5 py-1 transition ${i === sel ? 'bg-ink text-paper' : 'text-muted hover:text-ink'}`}
            >
              {s.size}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <div className="relative flex w-8 shrink-0 flex-col justify-between pb-5 text-right text-[10px] text-dim" style={{ height: height + 20 }}>
          {[top, (top * 3) / 4, top / 2, top / 4, 0].map((v) => (
            <span key={v}>{Math.round(v)}</span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
              {[0.25, 0.5, 0.75].map((f) => (
                <line key={f} x1="0" x2="1000" y1={y(top * f)} y2={y(top * f)} className="stroke-line" vectorEffect="non-scaling-stroke" />
              ))}
              <rect x="0" width="1000" y={y(run.live.max)} height={y(run.live.median) - y(run.live.max)} className="fill-hot/20" />
              <path d={area} className="fill-accent/10" />
              <path d={line} fill="none" strokeWidth="1.5" className="stroke-accent" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              <line x1="0" x2="1000" y1={y(top)} y2={y(top)} strokeWidth="1.5" strokeDasharray="6 4" className="stroke-line2" vectorEffect="non-scaling-stroke" />
              <line x1="0" x2="1000" y1={y(run.live.max)} y2={y(run.live.max)} strokeWidth="1.5" className="stroke-hot" vectorEffect="non-scaling-stroke" />
              <line x1="0" x2="1000" y1={y(run.live.median)} y2={y(run.live.median)} strokeWidth="1.5" className="stroke-hot" vectorEffect="non-scaling-stroke" />
              {pt && <line x1={x(pt[0])} x2={x(pt[0])} y1="0" y2="200" className="stroke-line2" vectorEffect="non-scaling-stroke" />}
            </svg>
            <span className="absolute right-1 rounded bg-surface/80 px-1 text-[10px] font-medium text-muted" style={{ top: `${(y(top) / 200) * 100}%`, transform: 'translateY(-115%)' }}>
              -Xmx cap {top} MB
            </span>
            <span className="absolute left-1 rounded bg-surface/85 px-1 text-[10px] font-semibold text-hot" style={{ top: `${(y(run.live.max) / 200) * 100}%`, transform: 'translateY(4px)' }}>
              live set {run.live.median}–{run.live.max} MB
            </span>
            {pt && (
              <div
                className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-[11px] text-paper shadow-lg"
                style={{ left: `${Math.min(Math.max((pt[0] / tMax) * 100, 12), 88)}%` }}
              >
                {mmss(pt[0])} · <span className="font-semibold">{pt[1]} MB</span> heap used
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-dim">
            <span>0</span>
            <span>{mmss(tMax / 2)}</span>
            <span>{mmss(tMax)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-accent" /> heap used</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border-y border-hot bg-hot/20" /> live set</span>
        <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-line2" /> heap cap</span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2">
        <Fact k="Lines" v={fmtNum(run.lines)} />
        <Fact k="Live set" v={`${run.live.max} MB`} tone="text-hot" />
        <Fact k="Peak heap" v={`${Math.round(run.peakHeapMb)} MB`} />
      </dl>
    </div>
  );
}

function Fact({ k, v, tone = 'text-ink' }) {
  return (
    <div className="rounded-lg border border-line bg-paper/60 px-3 py-2">
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className={`text-base font-bold ${tone}`}>
        {v}
      </dd>
    </div>
  );
}

/**
 * Live set next to peak heap, by file size or by part threads. The point it makes:
 * the file grew 20× and the live set did not; the thread count is what moves it.
 */
export function LiveSetBars({ bench }) {
  const [by, setBy] = useState('size');
  const [hover, setHover] = useState(null);
  const rows =
    by === 'size'
      ? bench.sizes.map((s) => ({ label: s.size, live: s.live.max, peak: Math.round(s.peakHeapMb), note: `${s.mbPerS} MB/s` }))
      : bench.threads.map((t) => ({ label: `${t.threads} thr`, live: t.live.max, note: `${t.mbPerS} MB/s` }));
  const max = by === 'size' ? 256 : 200;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{by === 'size' ? 'Live set by file size' : 'Live set by threads'}</h3>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs font-medium">
          {[
            ['size', 'File size'],
            ['threads', 'Threads'],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setBy(k)}
              className={`rounded-md px-2.5 py-1 transition ${by === k ? 'bg-ink text-paper' : 'text-muted hover:text-ink'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 grid grid-cols-4 gap-3">
        {rows.map((r, i) => (
          <div key={r.label} className="flex flex-col items-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className="relative flex h-40 w-full items-end justify-center gap-1">
              {hover === i && (
                <div className="pointer-events-none absolute -top-2 z-10 whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-[11px] text-paper shadow-lg">
                  live {r.live} MB{r.peak ? ` · peak ${r.peak} MB` : ''} · {r.note}
                </div>
              )}
              {r.peak != null && (
                <div className="w-1/3 max-w-6 rounded-t-[4px] bg-line2" style={{ height: `${(r.peak / max) * 100}%` }} />
              )}
              <div className="w-1/3 max-w-6 rounded-t-[4px] bg-hot" style={{ height: `${(r.live / max) * 100}%` }} />
            </div>
            <span className="mt-1.5 text-xs font-semibold text-ink">{r.live} MB</span>
            <span className="text-[11px] text-muted">{r.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-hot" /> live set</span>
        {by === 'size' && (
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-line2" /> peak heap</span>
        )}
      </div>
    </div>
  );
}
