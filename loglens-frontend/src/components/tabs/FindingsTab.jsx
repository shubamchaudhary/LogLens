import { useState } from 'react';
import { fmtRange } from '../../utils/format';
import { analysisAPI } from '../../services/api';
import { SEVERITY_ORDER, SEVERITY_STYLES } from '../../utils/severity';
import Icon from '../Icon';
import LogViewer from '../LogViewer';

export default function FindingsTab({ sessionId, findings }) {
  const [severity, setSeverity] = useState('');

  if (!findings || findings.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm font-medium text-slate-700">No findings</p>
        <p className="mt-1 text-sm text-slate-400">The enrichment pass didn't flag anything for this session.</p>
      </div>
    );
  }

  const present = SEVERITY_ORDER.filter((s) => findings.some((f) => f.severity === s));
  const shown = severity ? findings.filter((f) => f.severity === severity) : findings;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setSeverity('')}
          className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
            severity === '' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600'
          }`}
        >
          All ({findings.length})
        </button>
        {present.map((s) => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${SEVERITY_STYLES[s].chip} ${
              severity === s ? 'ring-2 ring-violet-300 ring-offset-1' : ''
            }`}
          >
            {s} ({findings.filter((f) => f.severity === s).length})
          </button>
        ))}
        <span className="ml-auto hidden text-xs text-slate-400 sm:block">
          Explanations by the LLM · counts and times by the parsers
        </span>
      </div>

      {shown.map((f) => (
        <FindingCard key={f.id} sessionId={sessionId} finding={f} />
      ))}
    </div>
  );
}

function FindingCard({ sessionId, finding: f }) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const count = f.evidenceChunkIds?.length || 0;
  const sev = SEVERITY_STYLES[f.severity] || SEVERITY_STYLES.INFO;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && evidence == null && count > 0) {
      setLoading(true);
      setError('');
      try {
        const res = await analysisAPI.evidence(sessionId, f.evidenceChunkIds);
        setEvidence(res.data || []);
      } catch {
        setError('Could not load evidence.');
        setEvidence([]);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="card p-5 animate-fade-up">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${sev.chip}`}>
          {f.severity}
        </span>
        {f.category && <span className="chip font-mono text-[10px]">{f.category}</span>}
        {f.occurrenceCount > 1 && <span className="text-[11px] font-medium text-slate-500">×{f.occurrenceCount} lines</span>}
        {f.confidence != null && (
          <span className="ml-auto text-[11px] text-slate-400">confidence {Number(f.confidence).toFixed(2)}</span>
        )}
      </div>
      <h4 className="mt-2 text-[15px] font-semibold text-slate-900">{f.title}</h4>
      {f.explanation && <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.explanation}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <Icon name="clock" className="h-3.5 w-3.5" />
          {fmtRange(f.timeRangeStart, f.timeRangeEnd)}
        </span>
        {count > 0 && (
          <button onClick={toggle} className="flex items-center gap-1 font-semibold text-violet-600 hover:text-violet-700">
            <Icon name="terminal" className="h-3.5 w-3.5" />
            {open ? 'Hide evidence' : `View evidence (${count} chunk${count === 1 ? '' : 's'})`}
          </button>
        )}
      </div>

      {open && count > 0 && (
        <div className="mt-3 space-y-2">
          {loading && <p className="text-[11px] text-slate-400">Loading evidence…</p>}
          {error && <p className="text-[11px] text-rose-500">{error}</p>}
          {evidence?.map((ev) => (
            <LogViewer key={ev.chunkId} content={ev.content} lineStart={ev.lineStart} />
          ))}
          {evidence?.length === 0 && !loading && <p className="text-[11px] text-slate-400">No evidence lines found.</p>}
        </div>
      )}
    </div>
  );
}
