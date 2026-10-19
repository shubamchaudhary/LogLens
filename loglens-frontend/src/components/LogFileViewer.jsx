import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { fmtBytes } from '../utils/format';
import { logFileInfo } from '../utils/logFile';

const PAGE = 200;
const LEVEL = /\b(ERROR|WARN|INFO|DEBUG)\b/;
const ROW = { ERROR: 'bg-rose-500/10 text-rose-200', WARN: 'bg-amber-400/10 text-amber-100' };
const TAG = { ERROR: 'text-rose-400', WARN: 'text-amber-300', INFO: 'text-sky-400', DEBUG: 'text-slate-500' };

/**
 * Pages through the 1 GB log by line number. Each page is one HTTP Range read
 * on the server (/api/log), so nothing close to the whole file is transferred.
 */
export default function LogFileViewer({ file, line: initialLine = 1, highlight, jumps = [], onClose }) {
  const [start, setStart] = useState(Math.max(1, initialLine - 20));
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');
  const [goto, setGoto] = useState('');
  const [info, setInfo] = useState(null);
  const total = file?.lines || page?.total || 0;

  useEffect(() => {
    logFileInfo().then(setInfo);
  }, []);

  const load = useCallback(async (from) => {
    setError('');
    try {
      const r = await fetch(`/api/log?line=${from}&count=${PAGE}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'preview failed');
      setPage(data);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load(start);
  }, [start, load]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (n) => setStart(Math.min(Math.max(1, n), Math.max(1, total - PAGE + 1)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-2 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div
        className="flex h-full max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
          <span className="icon-tile h-9 w-9">
            <Icon name="file" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm font-semibold text-slate-900">{file?.name}</p>
            <p className="text-xs text-slate-500">
              {fmtBytes(file?.bytes)} · {total.toLocaleString('en-US')} lines · showing{' '}
              {start.toLocaleString('en-US')}–{Math.min(total, start + PAGE - 1).toLocaleString('en-US')}
            </p>
          </div>
          {info?.gzipUrl && (
            <a href={info.gzipUrl} className="btn-secondary px-3 py-1.5 text-xs">
              <Icon name="download" className="h-3.5 w-3.5" /> .gz
            </a>
          )}
          {info?.downloadUrl && (
            <a href={info.downloadUrl} className="btn-secondary px-3 py-1.5 text-xs">
              <Icon name="download" className="h-3.5 w-3.5" /> Download {fmtBytes(file?.bytes)}
            </a>
          )}
          <button onClick={onClose} className="btn-ghost" aria-label="Close">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
          <button onClick={() => go(start - PAGE)} className="btn-ghost" disabled={start <= 1}>
            ← Prev
          </button>
          <button onClick={() => go(start + PAGE)} className="btn-ghost">
            Next →
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(goto.replace(/[^0-9]/g, ''));
              if (n) go(n - 20);
            }}
            className="flex items-center gap-1"
          >
            <input
              value={goto}
              onChange={(e) => setGoto(e.target.value)}
              placeholder="line #"
              className="w-28 rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs focus:border-violet-400 focus:outline-none"
            />
            <button className="btn-ghost">Go</button>
          </form>
          <input
            type="range"
            min={1}
            max={Math.max(1, total)}
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
            className="mx-2 min-w-[120px] flex-1 accent-violet-600"
            aria-label="Position in file"
          />
          {jumps.map((j) => (
            <button key={j.line} onClick={() => go(j.line - 20)} className="chip hover:border-violet-300">
              {j.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto bg-slate-950 py-2">
          {error && <p className="px-4 py-6 text-sm text-rose-300">Preview unavailable: {error}</p>}
          {!error && !page && <p className="px-4 py-6 text-sm text-slate-400">Loading…</p>}
          {page && (
            <pre className="font-mono text-[11px] leading-5">
              {page.lines.map((text, i) => {
                const no = page.line + i;
                const level = LEVEL.exec(text.slice(0, 32))?.[1];
                const hit = highlight && no >= highlight[0] && no <= highlight[1];
                return (
                  <div
                    key={no}
                    className={`flex gap-3 px-3 ${hit ? 'bg-violet-500/30 text-white' : ROW[level] || 'text-slate-300'}`}
                  >
                    <span className="w-16 shrink-0 select-none text-right text-slate-600">{no}</span>
                    <span className="whitespace-pre-wrap break-all">
                      {level ? (
                        <>
                          {text.slice(0, text.indexOf(level))}
                          <span className={`font-semibold ${TAG[level]}`}>{level}</span>
                          {text.slice(text.indexOf(level) + level.length)}
                        </>
                      ) : (
                        text
                      )}
                    </span>
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
