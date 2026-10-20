import { useEffect, useRef } from 'react';

const STAGE = {
  upload: 'text-sky-300',
  split: 'text-sky-300',
  parse: 'text-cyan-300',
  detect: 'text-amber-300',
  'fan-out': 'text-amber-300',
  explain: 'text-accent',
  embed: 'text-accent',
  correlate: 'text-hot',
  verify: 'text-hot',
  report: 'text-hot',
  done: 'text-emerald-300',
};

/** Terminal-style feed of what the pipeline is doing, one line per step. */
export default function PipelineConsole({ lines, running }) {
  const box = useRef(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-lg shadow-accent/10">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        <span className="ml-2 font-mono text-[11px] text-slate-400">pipeline · kafka → parsers → anomaly gate → llm → langgraph</span>
      </div>
      <div ref={box} className="h-64 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-6">
        {lines.map((l, i) => (
          <div key={i} className="flex gap-3 animate-fade-up">
            <span className="w-14 shrink-0 text-right text-body">+{(l.t / 1000).toFixed(1)}s</span>
            <span className={`w-16 shrink-0 ${STAGE[l.stage] || 'text-slate-400'}`}>{l.stage}</span>
            <span className="min-w-0 break-words text-slate-200">{l.text}</span>
          </div>
        ))}
        {running && (
          <div className="flex gap-3">
            <span className="w-14 shrink-0" />
            <span className="inline-block h-4 w-2 animate-pulse bg-accent" />
          </div>
        )}
      </div>
    </div>
  );
}
