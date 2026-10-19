import { useEffect, useRef, useState } from 'react';
import { analysisAPI } from '../services/api';
import { fmtClock, fmtNum } from '../utils/format';
import Markdown from './Markdown';
import Icon from './Icon';
import LogViewer from './LogViewer';

const CONFIDENCE = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-rose-50 text-rose-700 border-rose-200',
};
const readable = (t) => t.replace(/<n>|<hex>|<ip>|<id>|<pod>/g, '…');

/**
 * Questions about the log, answered from retrieved evidence: every point the
 * answer makes carries the log lines and failure counts that back it, and the
 * server drops any citation that wasn't in the retrieved context.
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
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Icon name="message" className="h-4 w-4 text-violet-600" /> Ask about this log
          </h3>
          <p className="text-xs text-slate-500">
            Hybrid search (pgvector + full-text) over 127k error and warning records, then an LLM answers with the line
            numbers that prove each point. It says so when the log doesn't contain the answer.
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
            <p className="mt-3 text-sm font-medium text-slate-700">Ask in plain English</p>
            <p className="mt-1 text-xs text-slate-400">Try a suggestion below, or ask your own.</p>
          </div>
        )}
        {turns.map((t, i) => (
          <Turn key={i} t={t} onOpenFile={onOpenFile} />
        ))}
        {pending && (
          <div className="space-y-2">
            <UserBubble text={pending} />
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
              Searching 5.4M lines, grading evidence, writing a cited answer…
            </div>
          </div>
        )}
      </div>

      {error && <p className="px-5 pb-2 text-xs text-rose-600">{error}</p>}

      <div className="border-t border-slate-100 p-4">
        {suggestions.length > 0 && (
          <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                disabled={!!pending}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  asked.has(s)
                    ? 'border-slate-200 bg-slate-50 text-slate-400'
                    : 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-400'
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
            placeholder="e.g. What failed first after the 10:38 deploy?"
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
  return (
    <div className="space-y-2">
      <UserBubble text={t.question} />
      {t.trace?.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {t.trace.map((s, i) => (
            <span
              key={i}
              className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] ${
                /weak|abstain|removed|failed|skipped/.test(s)
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-violet-100 bg-violet-50/60 text-violet-800'
              }`}
            >
              {s}
            </span>
          ))}
          {t.cached && <span className="text-[10.5px] text-slate-400">· cached</span>}
        </div>
      )}
      <div className={`rounded-2xl rounded-tl-sm border p-4 ${t.abstained ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {t.abstained ? (
            <span className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
              Not in the logs
            </span>
          ) : (
            t.confidence && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${CONFIDENCE[t.confidence]}`}>
                {t.confidence} confidence
              </span>
            )
          )}
          {t.ms != null && <span className="text-[10.5px] text-slate-400">{(t.ms / 1000).toFixed(1)} s</span>}
        </div>
        {t.markdown ? <Markdown>{t.answer}</Markdown> : <p className="text-sm leading-relaxed text-slate-800">{t.answer}</p>}

        {t.points?.length > 0 && (
          <ol className="mt-3 space-y-3 border-t border-slate-100 pt-3">
            {t.points.map((p, i) => (
              <li key={i} className="space-y-1.5">
                <p className="flex gap-2 text-sm text-slate-700">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[10px] font-bold text-violet-700">
                    {i + 1}
                  </span>
                  {p.text}
                </p>
                {p.types?.map((ty) => (
                  <div key={ty.ref} className="ml-6 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11.5px]">
                    <span className="font-semibold text-slate-900">{fmtNum(ty.count)}×</span>{' '}
                    <span className="text-slate-500">{ty.service}</span>{' '}
                    <span className="font-mono text-slate-700">{readable(ty.template).slice(0, 140)}</span>
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
    </div>
  );
}

function UserBubble({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-violet-600 to-pink-500 px-4 py-2 text-sm text-white shadow-sm">
        {text}
      </div>
    </div>
  );
}
