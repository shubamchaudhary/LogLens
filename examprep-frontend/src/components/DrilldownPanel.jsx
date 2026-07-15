import { useEffect, useState } from 'react';
import { analysisAPI } from '../services/api';

/**
 * Free-form Q&A over the session's own log chunks (orchestrator Graph 2).
 * Answers are grounded and cite chunk ids; we resolve those ids to the actual
 * log lines via the evidence endpoint and show them under each answer.
 *
 * History is persisted server-side (drilldown_messages), scoped to the session
 * and gated by session ownership — so it survives logout, reload and device
 * changes. We load it on mount and append newly-asked turns as they complete.
 */
export default function DrilldownPanel({ sessionId }) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState('');

  // Load persisted history for this session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await analysisAPI.drilldownHistory(sessionId);
        if (cancelled) return;
        setTurns(
          (data || []).map((m) => ({
            id: m.id,
            q: m.question,
            answer: m.answer,
            citations: m.citations || [],
            evidence: [],
          }))
        );
      } catch {
        /* history is best-effort — an empty panel is acceptable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const clear = async () => {
    try {
      await analysisAPI.drilldownClear(sessionId);
    } catch {
      /* ignore — clearing is best-effort */
    }
    setTurns([]);
  };

  const ask = async (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setError('');
    setLoading(true);
    setQuestion('');
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
      setTurns((prev) => [...prev, { q, answer: data.answer, citations: data.citations || [], evidence }]);
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
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 flex flex-col h-[70vh]">
      <div className="px-5 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Ask about these logs</h3>
          <p className="text-xs text-gray-400">
            Grounded answers with citations, drawn only from this session's chunks.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            onClick={clear}
            className="text-xs text-gray-400 hover:text-red-500 shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {turns.length === 0 && !loading && (
          <div className="text-center text-sm text-gray-400 mt-10">
            Try “What caused the errors?” or a keyword like “deadlock”.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="flex justify-end">
              <div className="bg-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-2 text-sm max-w-[80%]">
                {t.q}
              </div>
            </div>
            <div className="flex justify-start">
              <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-bl-sm px-4 py-2 text-sm max-w-[85%] whitespace-pre-wrap">
                {t.answer || 'No answer produced.'}
              </div>
            </div>
            {t.evidence?.length > 0 && (
              <details className="ml-2">
                <summary className="text-xs text-indigo-600 cursor-pointer select-none">
                  {t.evidence.length} cited log line{t.evidence.length === 1 ? '' : 's'}
                </summary>
                <div className="mt-2 space-y-1">
                  {t.evidence.map((ev) => (
                    <pre
                      key={ev.chunkId}
                      className="text-[11px] bg-gray-900 text-gray-100 rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-words"
                    >
                      {ev.content}
                    </pre>
                  ))}
                </div>
              </details>
            )}
            {t.evidence?.length === 0 && t.citations?.length > 0 && (
              <p className="ml-2 text-[11px] text-gray-400">
                {t.citations.length} citation{t.citations.length === 1 ? '' : 's'}
              </p>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-500 rounded-2xl rounded-bl-sm px-4 py-2 text-sm">
              Thinking…
            </div>
          </div>
        )}
      </div>

      {error && <p className="px-5 pb-2 text-xs text-red-600">{error}</p>}

      <form onSubmit={ask} className="p-4 border-t border-gray-100 flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about these logs…"
          disabled={loading}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
