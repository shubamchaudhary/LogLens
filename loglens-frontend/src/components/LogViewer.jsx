import { useState } from 'react';

const LEVEL = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;

const ROW = {
  FATAL: 'bg-rose-500/15 text-rose-200',
  ERROR: 'bg-rose-500/10 text-rose-200',
  WARN: 'bg-amber-400/10 text-amber-100',
  WARNING: 'bg-amber-400/10 text-amber-100',
};

const BADGE = {
  FATAL: 'text-rose-400',
  ERROR: 'text-rose-400',
  WARN: 'text-amber-300',
  WARNING: 'text-amber-300',
  INFO: 'text-sky-400',
  DEBUG: 'text-slate-500',
  TRACE: 'text-slate-500',
};

/**
 * Raw log lines (a chunk's content) in a terminal-style viewer: line numbers,
 * ERROR/WARN rows highlighted, and a toggle to hide everything else.
 */
export default function LogViewer({ content, lineStart, title, maxHeight = 'max-h-72', action }) {
  const lines = (content || '').split('\n');
  const issues = lines.filter((l) => /\b(FATAL|ERROR|WARN(?:ING)?)\b/.test(l)).length;
  const [onlyIssues, setOnlyIssues] = useState(false);

  const rows = lines
    .map((text, i) => ({ text, no: lineStart != null ? lineStart + i : null, level: LEVEL.exec(text)?.[1] }))
    .filter((r) => !onlyIssues || ROW[r.level]);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-slate-400">
          {title || (lineStart != null ? `lines ${lineStart}–${lineStart + lines.length - 1}` : 'log lines')}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {issues > 0 && issues < lines.length && lines.length > 12 && (
            <button
              onClick={() => setOnlyIssues((v) => !v)}
              className="rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
            >
              {onlyIssues ? `Show all ${lines.length}` : `Only ERROR/WARN (${issues})`}
            </button>
          )}
          {action}
        </span>
      </div>
      <div className={`${maxHeight} overflow-auto py-1`}>
        <pre className="font-mono text-[11px] leading-5">
          {rows.map((r, i) => (
            <div key={i} className={`flex gap-3 px-3 ${ROW[r.level] || 'text-slate-300'}`}>
              {r.no != null && <span className="w-14 shrink-0 select-none text-right text-slate-600">{r.no}</span>}
              <span className="whitespace-pre-wrap break-all">
                <Highlighted text={r.text} level={r.level} />
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function Highlighted({ text, level }) {
  if (!level) return text;
  const i = text.indexOf(level);
  return (
    <>
      {text.slice(0, i)}
      <span className={`font-semibold ${BADGE[level]}`}>{level}</span>
      {text.slice(i + level.length)}
    </>
  );
}
