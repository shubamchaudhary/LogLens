import { useEffect, useRef, useState } from 'react';
import { analysisAPI } from '../services/api';
import { fmtClock, fmtNum } from '../utils/format';
import Markdown from './Markdown';
import Icon from './Icon';
import LogViewer from './LogViewer';

const CONFIDENCE = {
  high: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  medium: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  low: 'bg-rose-500/10 text-rose-600 border-rose-500/30',
};
const readable = (t) => t.replace(/<n>|<hex>|<ip>|<id>|<pod>/g, '…');

// Where an answer came from (logs answers show their confidence instead).
const SOURCE = {
  system: 'From the log profile',
  general: 'General knowledge · not from this log',
  web: 'From the web · not from this log',
};

/**
 * DeepLogLens AI. Questions about failures are answered from retrieved evidence (every
 * point carries the log lines and counts that back it); questions about the system come
 * from the log profile; small talk, general knowledge and web answers are labelled as such.
 */
export default function AskPanel({ sessionId, suggestions = [], onOpenFile }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState([]);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const scroller = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    analysisAPI
      .askHistory(sessionId)
      .then((r) => mounted.current && setTurns(r.data || []))
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [turns.length, pending]);

  const ask = async (raw) => {
    const q = raw.trim();
    if (!q || pending) return;
    setError('');
    setQuestion('');
    setPending(q);
    try {
      const { data } = await analysisAPI.ask(sessionId, q);
      if (mounted.current) setTurns((prev) => [...prev, { ...data, question: q }]);
    } catch (err) {
      const status = err.response?.status;
      setError(
        err.response?.data?.error ||
          (status === 429 ? 'Too many questions right now, try again in a minute.' : 'Could not answer right now. Please try again.')
      );
      setQuestion(q);
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const asked = new Set(turns.map((t) => t.question));

  return (
    <div className="card flex h-[74vh] min-h-[520px] flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon name="message" className="h-4 w-4 text-accent" /> DeepLogLens AI
          </h3>
          <p className="text-xs text-muted">
            Ask about failures and their causes, services, tenants or dependencies, in any language. Answers about the log
            point to the exact lines.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            onClick={() => analysisAPI.askClear(sessionId).finally(() => setTurns([]))}
            className="btn-ghost shrink-0 hover:text-rose-600"
          >
            Clear
          </button>
        )}
      </div>

      <div ref={scroller} className="flex-1 space-y-6 overflow-y-auto p-5">
        {turns.length === 0 && !pending && (
          <div className="mx-auto mt-6 max-w-md text-center">
            <span className="icon-tile mx-auto h-12 w-12">
              <Icon name="sparkles" className="h-6 w-6" />
            </span>
            <p className="mt-3 text-sm font-medium text-ink">Hi, I'm DeepLogLens AI</p>
            <p className="mt-1 text-xs text-muted">I've read all 5.4 million lines of this log. Say hello, pick a suggestion, or ask your own question.</p>
          </div>
        )}
        {turns.map((t, i) => (
          <Turn key={i} t={t} onOpenFile={onOpenFile} />
        ))}
        {pending && (
          <div className="space-y-2">
            <UserBubble text={pending} />
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              Searching 5.4M lines, grading evidence, writing a cited answer…
            </div>
          </div>
        )}
      </div>

      {error && <p className="px-5 pb-2 text-xs text-rose-600">{error}</p>}

      <div className="border-t border-line p-4">
        {suggestions.length > 0 && (
          <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                disabled={!!pending}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  asked.has(s)
                    ? 'border-line bg-sand text-slate-400'
                    : 'border-accent/40 bg-accent-soft text-accent hover:border-accent'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
          className="flex gap-2"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about failures, services, tenants…"
            maxLength={300}
            disabled={!!pending}
            className="input"
          />
          <button type="submit" disabled={!!pending || !question.trim()} className="btn-primary px-4">
            <Icon name="send" className="h-4 w-4" />
            <span className="hidden sm:inline">Ask</span>
          </button>
        </form>
      </div>
    </div>
  );
}

function Turn({ t, onOpenFile }) {
  const assistant = t.mode === 'assistant';
  return (
    <div className="space-y-2">
      <UserBubble text={t.question} />
      <div
        className={`rounded-2xl rounded-tl-sm border p-4 ${
          t.abstained ? 'border-amber-500/30 bg-amber-500/10' : assistant ? 'border-transparent bg-sand' : 'border-line bg-surface'
        }`}
      >
        {!assistant && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            {t.abstained ? (
              <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600">
                Not in the logs
              </span>
            ) : SOURCE[t.mode] && t.mode !== 'system' ? (
              <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">{SOURCE[t.mode]}</span>
            ) : (
              <>
                {t.mode === 'system' && (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">{SOURCE.system}</span>
                )}
                {t.confidence && (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${CONFIDENCE[t.confidence]}`}>
                    {t.confidence} confidence
                  </span>
                )}
              </>
            )}
            {t.ms != null && <span className="text-[10.5px] text-muted">{(t.ms / 1000).toFixed(1)} s</span>}
          </div>
        )}
        {t.markdown ? <Markdown>{t.answer}</Markdown> : <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{t.answer}</p>}

        {t.background && (
          <p className="mt-3 rounded-lg bg-sand px-3 py-2 text-[13px] leading-relaxed text-body">
            <span className="font-semibold text-ink">Background · </span>
            {t.background}
          </p>
        )}

        {t.sources?.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-line pt-3">
            {t.sources.map((src) => (
              <li key={src.url} className="truncate text-[12.5px]">
                <a href={src.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {src.title || src.url}
                </a>
              </li>
            ))}
          </ul>
        )}

        {t.points?.length > 0 && (
          <ol className="mt-3 space-y-3 border-t border-line pt-3">
            {t.points.map((p, i) => (
              <li key={i} className="space-y-1.5">
                <p className="flex gap-2 text-sm text-ink">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold text-accent">
                    {i + 1}
                  </span>
                  {p.text}
                </p>
                {p.types?.map((ty) => (
                  <div key={ty.ref} className="ml-6 rounded-lg border border-line bg-sand px-2.5 py-1.5 text-[11.5px]">
                    <span className="font-semibold text-ink">{fmtNum(ty.count)}×</span>{' '}
                    <span className="text-muted">{ty.service}</span>{' '}
                    <span className="font-mono text-ink">{readable(ty.template).slice(0, 140)}</span>
                    <span className="text-slate-400">
                      {' '}
                      · {fmtClock(ty.firstTs)} → {fmtClock(ty.lastTs)}
                    </span>
                  </div>
                ))}
                {p.lines?.map((l) => (
                  <div key={l.no} className="ml-6">
                    <LogViewer
                      content={l.text}
                      lineStart={l.no}
                      maxHeight="max-h-40"
                      title={`line ${fmtNum(l.no)}`}
                      action={
                        onOpenFile && (
                          <button
                            onClick={() => onOpenFile(l.no, [l.no, l.end ?? l.no])}
                            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                          >
                            <Icon name="eye" className="h-3.5 w-3.5" /> In file
                          </button>
                        )
                      }
                    />
                  </div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </div>
      {t.trace?.length > 0 && (
        <details className="group text-[11px] text-muted">
          <summary className="cursor-pointer select-none list-none hover:text-ink">
            How this was answered{t.cached ? ' · cached' : ''} <span className="group-open:hidden">▸</span>
            <span className="hidden group-open:inline">▾</span>
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3 font-mono text-[10.5px]">
            {t.trace.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function UserBubble({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm text-on-accent shadow-sm">
        {text}
      </div>
    </div>
  );
}
