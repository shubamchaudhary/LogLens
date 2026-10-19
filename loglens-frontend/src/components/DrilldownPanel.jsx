import { useEffect, useRef, useState } from 'react';
import { analysisAPI } from '../services/api';
import { isDemo } from '../demo/demoMode';
import { loadFixture } from '../demo/demoApi';
import Markdown from './Markdown';
import Icon from './Icon';
import LogViewer from './LogViewer';

const LIVE_SUGGESTIONS = ['What caused the errors?', 'When did the first error happen?', 'Which service failed most?'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Free-form Q&A over the session's own log chunks (orchestrator Graph 2).
 * Answers are grounded and cite chunk ids; we resolve those ids to the actual
 * log lines via the evidence endpoint and show them under each answer.
 *
 * History is persisted server-side (drilldown_messages), scoped to the session
 * and gated by session ownership — so it survives logout, reload and device
 * changes. We load it on mount and append newly-asked turns as they complete.
 * In the demo, recorded answers are revealed step by step (graph path, then text).
 */
export default function DrilldownPanel({ sessionId }) {
  const demo = isDemo();
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(null);
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState(demo ? [] : LIVE_SUGGESTIONS);
  const mounted = useRef(true);
  const scroller = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!demo) return;
    loadFixture().then((f) => mounted.current && setSuggestions(f.qa.map((q) => q.question)));
  }, [demo]);

  // Load persisted history for this session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await analysisAPI.drilldownHistory(sessionId);
        if (cancelled) return;
        const loaded = (data || []).map((m) => ({
          id: m.id,
          q: m.question,
          answer: m.answer,
          citations: m.citations || [],
          trace: m.trace,
          unanswered: m.unanswered,
          suggestion: m.suggestion,
          evidence: [],
        }));
        setTurns(loaded);
        // Resolve citations for restored turns so their log lines show again.
        const withCites = loaded.filter((t) => t.citations.length);
        for (const t of withCites) {
          const res = await analysisAPI.evidence(sessionId, t.citations).catch(() => null);
          if (cancelled || !res) continue;
          setTurns((prev) => prev.map((x) => (x === t || x.id === t.id ? { ...x, evidence: res.data || [] } : x)));
        }
      } catch {
        /* history is best-effort — an empty panel is acceptable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [turns.length, pending]);

  const clear = async () => {
    try {
      await analysisAPI.drilldownClear(sessionId);
    } catch {
      /* ignore — clearing is best-effort */
    }
    setTurns([]);
  };

  const ask = async (raw) => {
    const q = raw.trim();
    if (!q || pending) return;
    setError('');
    setQuestion('');
    setPending({ q, steps: [], text: '' });
    try {
      const { data } = await analysisAPI.drilldown(sessionId, q);
      let evidence = [];
      if (data.citations?.length) {
        try {
          const res = await analysisAPI.evidence(sessionId, data.citations);
          evidence = res.data || [];
        } catch {
          /* evidence is a nice-to-have; ignore lookup failures */
        }
      }
      if (demo && data.trace) {
        for (let i = 0; i < data.trace.length && mounted.current; i++) {
          await sleep(420);
          setPending((p) => p && { ...p, steps: data.trace.slice(0, i + 1) });
        }
        const words = data.answer.split(' ');
        for (let i = 0; i < words.length && mounted.current; i += 3) {
          await sleep(35);
          setPending((p) => p && { ...p, text: words.slice(0, i + 3).join(' ') });
        }
      }
      if (!mounted.current) return;
      setTurns((prev) => [
        ...prev,
        {
          q,
          answer: data.answer,
          citations: data.citations || [],
          trace: data.trace,
          unanswered: data.unanswered,
          suggestion: data.suggestion,
          evidence,
        },
      ]);
    } catch (err) {
      const status = err.response?.status;
      let msg = 'Drill-down failed. Please try again.';
      if (status === 429) {
        msg = 'The AI provider is rate-limited right now (daily quota). Please try again in a few minutes.';
      } else if (status === 502 || status === 503) {
        msg = 'The orchestrator is unavailable — is the Python service running on :8000?';
      }
      setError(msg);
      setQuestion(q);
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  const asked = new Set(turns.map((t) => t.q));

  return (
    <div className="card flex h-[72vh] min-h-[480px] flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Icon name="message" className="h-4 w-4 text-violet-600" /> Ask about these logs
          </h3>
          <p className="text-xs text-slate-500">
            Corrective RAG: hybrid retrieval (pgvector + full-text) → grade → rewrite if weak → answer with citations.
            It abstains when the logs don't say.
          </p>
        </div>
        {turns.length > 0 && (
          <button onClick={clear} className="btn-ghost shrink-0 hover:text-rose-600">
            Clear
          </button>
        )}
      </div>

      <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto p-5">
        {turns.length === 0 && !pending && (
          <div className="mx-auto mt-6 max-w-md text-center">
            <span className="icon-tile mx-auto h-12 w-12">
              <Icon name="sparkles" className="h-6 w-6" />
            </span>
            <p className="mt-3 text-sm font-medium text-slate-700">Ask a question in plain English</p>
            <p className="mt-1 text-xs text-slate-400">
              Pick one below. The last one shows what happens when the logs can't answer.
            </p>
          </div>
        )}

        {turns.map((t, i) => (
          <Turn key={t.id || i} turn={t} onAsk={ask} />
        ))}

        {pending && (
          <div className="space-y-2">
            <UserBubble text={pending.q} />
            <Trace steps={pending.steps} running />
            {pending.text ? (
              <AnswerBubble>
                <Markdown>{pending.text}</Markdown>
              </AnswerBubble>
            ) : (
              pending.steps.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" /> Retrieving and grading chunks…
                </div>
              )
            )}
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
            placeholder="Ask a question about these logs…"
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

function Turn({ turn: t, onAsk }) {
  return (
    <div className="space-y-2">
      <UserBubble text={t.q} />
      {t.trace && <Trace steps={t.trace} />}
      <AnswerBubble muted={t.unanswered}>
        {t.answer ? <Markdown>{t.answer}</Markdown> : 'No answer produced.'}
        {t.unanswered && t.suggestion && (
          <button onClick={() => onAsk(t.suggestion)} className="btn-secondary mt-2 px-3 py-1.5 text-xs">
            Ask “{t.suggestion}”
          </button>
        )}
      </AnswerBubble>
      {t.evidence?.length > 0 && (
        <details className="ml-1 group">
          <summary className="flex cursor-pointer select-none items-center gap-1 text-xs font-semibold text-violet-600">
            <Icon name="terminal" className="h-3.5 w-3.5" />
            {t.evidence.length} cited chunk{t.evidence.length === 1 ? '' : 's'} (the exact log lines used)
          </summary>
          <div className="mt-2 space-y-2">
            {t.evidence.map((ev) => (
              <LogViewer key={ev.chunkId} content={ev.content} lineStart={ev.lineStart} maxHeight="max-h-56" />
            ))}
          </div>
        </details>
      )}
      {t.evidence?.length === 0 && t.citations?.length > 0 && (
        <p className="ml-1 text-[11px] text-slate-400">
          {t.citations.length} citation{t.citations.length === 1 ? '' : 's'}
        </p>
      )}
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

function AnswerBubble({ children, muted }) {
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[92%] overflow-x-auto rounded-2xl rounded-bl-sm border px-4 py-2 text-sm ${
          muted ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function Trace({ steps, running }) {
  if (!steps?.length && !running) return null;
  return (
    <div className="ml-1 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">graph</span>
      {steps.map((s, i) => (
        <span
          key={i}
          className={`animate-fade-up rounded-md border px-2 py-0.5 font-mono text-[10.5px] ${
            /abstain|too few|0 relevant/.test(s)
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-violet-100 bg-violet-50/60 text-violet-800'
          }`}
        >
          {s}
        </span>
      ))}
      {running && <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />}
    </div>
  );
}
