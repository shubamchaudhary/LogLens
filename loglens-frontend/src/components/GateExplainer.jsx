import { useState } from 'react';

// Ten minutes of ERROR counts with one adjustable spike, judged two ways: the mean
// and standard deviation (which the spike inflates, so it hides itself) and the
// gate's median + MAD rule (count ≥ 3 and above median + 3.5 × max(1.4826 × MAD, 1)).

const BASE = [2, 3, 2, 4, 3, 2, 3, null, 2, 3];
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export default function GateExplainer() {
  const [spike, setSpike] = useState(40);
  const xs = BASE.map((v) => (v == null ? spike : v));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const med = median(xs);
  const mad = median(xs.map((v) => Math.abs(v - med)));
  const robustCut = med + 3.5 * Math.max(1.4826 * mad, 1);
  const meanCut = mean + 3 * sd;
  const robustHit = spike >= 3 && spike > robustCut;
  const meanHit = spike > meanCut;
  const top = Math.max(spike, meanCut, robustCut, 10) * 1.12;
  const pct = (v) => `${(v / top) * 100}%`;

  return (
    <div>
      <div className="relative h-44 border-b border-line">
        <Cut at={pct(meanCut)} label="mean + 3σ" value={meanCut} cls="border-line2 text-muted" />
        <Cut at={pct(robustCut)} label="median + MAD" value={robustCut} cls="border-pink-600 text-hot" />
        <div className="absolute inset-y-0 left-0 right-[6.5rem] flex items-end gap-1.5 px-1">
          {xs.map((v, i) => {
            const isSpike = BASE[i] == null;
            const flagged = isSpike && robustHit;
            return (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end">
                {isSpike && <span className="mb-0.5 text-[10px] font-semibold text-ink">{v}</span>}
                <div
                  className={`w-full max-w-7 rounded-t-[4px] ${flagged ? 'bg-pink-600' : isSpike ? 'bg-violet-400' : 'bg-line2'}`}
                  style={{ height: pct(Math.max(v, 0.3)) }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="mr-[6.5rem] mt-1 flex justify-between px-1 text-[10px] text-dim">
        <span>minute 1</span>
        <span>ERROR lines per minute</span>
        <span>minute 10</span>
      </div>

      <label className="mt-4 block text-xs font-medium text-body">
        Minute 8 has <span className="font-mono font-semibold text-ink">{spike}</span> errors
        <input
          type="range"
          min="0"
          max="300"
          value={spike}
          onChange={(e) => setSpike(Number(e.target.value))}
          className="mt-2 w-full accent-violet-600"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Verdict hit={meanHit} title="Mean + 3σ" note={`mean ${mean.toFixed(1)}, σ ${sd.toFixed(1)}`} />
        <Verdict hit={robustHit} title="Median + MAD (the gate)" note={`median ${med}, MAD ${mad}`} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Drag it up. The spike drags the mean and σ up with it, so with ten minutes a single spike can never clear
        mean + 3σ. The median and MAD barely move until half the minutes are abnormal.
      </p>
    </div>
  );
}

function Cut({ at, label, value, cls }) {
  return (
    <div className={`absolute inset-x-0 border-t border-dashed ${cls}`} style={{ bottom: at }}>
      <span className="absolute right-0 top-0 w-[6.25rem] -translate-y-1/2 bg-surface pl-1.5 text-[10px] font-medium leading-tight">
        {label} <span className="font-mono">{value.toFixed(1)}</span>
      </span>
    </div>
  );
}

function Verdict({ hit, title, note }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${hit ? 'border-hot/30 bg-hot/10' : 'border-line bg-sand'}`}>
      <div className="font-semibold text-ink">{title}</div>
      <div className={hit ? 'font-semibold text-hot' : 'text-muted'}>{hit ? '✓ flags minute 8' : '✗ misses it'}</div>
      <div className="mt-0.5 font-mono text-[10px] text-dim">{note}</div>
    </div>
  );
}
