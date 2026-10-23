import { useEffect, useRef } from 'react';

// Each pipeline stage logs as the component that does the work, like the server's own log.
const SOURCE = {
  upload: ['UploadController', 'text-sky-300'],
  split: ['LogSplitter', 'text-sky-300'],
  parse: ['ChunkParser', 'text-cyan-300'],
  detect: ['AnomalyGate', 'text-amber-300'],
  'fan-out': ['EnrichDispatcher', 'text-amber-300'],
  explain: ['LlmEnricher', 'text-accent'],
  embed: ['Embedder', 'text-accent'],
  correlate: ['IncidentGraph', 'text-hot'],
  verify: ['EvidenceJudge', 'text-hot'],
  report: ['ReportWriter', 'text-hot'],
  done: ['Pipeline', 'text-emerald-300'],
};

const clock = (ms) => {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** Terminal that streams what the app is doing right now, formatted like a server log. */
export default function PipelineConsole({ lines, running }) {
  const box = useRef(null);
  const origin = useRef(0);
  if (!origin.current) origin.current = Date.now();
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-lg shadow-accent/10">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        <span className="ml-2 font-mono text-[11px] text-slate-400">deeploglens-server · live application log</span>
        {running && <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
      </div>
      <div ref={box} className="h-[32rem] overflow-y-auto px-4 py-3 font-mono text-[12px] leading-6">
        {lines.map((l, i) => {
          const [name, color] = SOURCE[l.stage] || [l.stage, 'text-slate-400'];
          const warn = l.level === 'WARN';
          return (
            <div key={i} className="flex animate-fade-up gap-3">
              <span className="shrink-0 text-slate-500">{clock(origin.current + l.t)}</span>
              <span className={`w-10 shrink-0 font-semibold ${warn ? 'text-amber-300' : 'text-emerald-400'}`}>{l.level || 'INFO'}</span>
              <span className={`w-40 shrink-0 ${color}`}>{name}</span>
              <span className="min-w-0 break-words text-slate-200">{l.text}</span>
            </div>
          );
        })}
        {running && (
          <div className="flex gap-3">
            <span className="inline-block h-4 w-2 animate-pulse bg-accent" />
          </div>
        )}
      </div>
    </div>
  );
}
