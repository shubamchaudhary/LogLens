import { useEffect, useState } from 'react';
import { fmtClock, fmtNum } from '../../utils/format';
import { SEVERITY_STYLES } from '../../utils/severity';
import { analysisAPI } from '../../services/api';
import Icon from '../Icon';
import LogViewer from '../LogViewer';

const ROLE = {
  warning: 'Warning before',
  change: 'Change before',
  first: 'First failure',
  sample: 'Full error',
  event: 'During',
  last: 'Last failure',
  fix: 'Recovery',
};
const LEVEL_DOT = { ERROR: 'bg-rose-500', WARN: 'bg-amber-400', INFO: 'bg-sky-400' };

const duration = (a, b) => {
  const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** A failure template made readable: placeholders become "…". */
const readable = (t) => t.replace(/<n>|<hex>|<ip>|<id>|<pod>/g, '…').replace(/q=\*/g, 'q=…');

/**
 * Incidents with everything needed to act on them: what happened, how often each
 * failure occurred, the most probable causes (each pointing at log lines), and the
 * exact lines themselves.
 */
export default function IncidentsTab({ sessionId, incidents, onOpenFile, focus }) {
  const [open, setOpen] = useState(() => new Set([focus || incidents?.[0]?.id]));

  useEffect(() => {
    if (focus) document.getElementById(`incident-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  if (!incidents || incidents.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm font-medium text-ink">No incidents</p>
        <p className="mt-1 text-sm text-slate-400">Nothing in this log stood out from its normal behaviour.</p>
      </div>
    );
  }

  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      {incidents.map((inc, i) => (
        <Incident
          key={inc.id}
          n={i + 1}
          inc={inc}
          sessionId={sessionId}
          open={open.has(inc.id)}
          onToggle={() => toggle(inc.id)}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function Incident({ n, inc, sessionId, open, onToggle, onOpenFile }) {
  const sev = SEVERITY_STYLES[inc.severity] || SEVERITY_STYLES.INFO;
  const [focusLine, setFocusLine] = useState(null);

  return (
    <article id={`incident-${inc.id}`} className="card overflow-hidden">
      <button onClick={onToggle} className="flex w-full items-start gap-4 p-5 text-left transition hover:bg-sand/60">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-on-accent ">
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${sev.chip}`}>
              {inc.severity}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted">
              <Icon name="clock" className="h-3.5 w-3.5" />
              {fmtClock(inc.start)} → {fmtClock(inc.end)} UTC · {duration(inc.start, inc.end)}
            </span>
          </span>
          <span className="mt-1.5 block text-[15px] font-semibold leading-snug text-ink">{inc.title}</span>
          {!open && inc.summary && <span className="mt-1 line-clamp-1 block text-sm text-muted">{inc.summary}</span>}
        </span>
        <Icon name="chevronDown" className={`mt-2 h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-line px-5 pb-5 pt-4 animate-fade-up">
          {inc.summary && <p className="text-sm leading-relaxed text-ink">{inc.summary}</p>}

          {inc.failingLines != null && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Failing log records" value={fmtNum(inc.failingLines)} />
              <Stat label="Peak minute" value={inc.peak ? `${fmtNum(inc.peak.lines)}/min` : '—'} sub={inc.peak && `at ${fmtClock(inc.peak.minute).slice(0, 5)}`} />
              <Stat label="Tenants affected" value={fmtNum(inc.tenants)} />
              <Stat label="Services" value={inc.services?.length ?? '—'} sub={inc.services?.slice(0, 2).join(', ')} />
            </div>
          )}

          {inc.causes?.length > 0 && (
            <section>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-accent">
                <Icon name="sparkles" className="h-3.5 w-3.5" /> Most probable cause{inc.causes.length > 1 ? 's' : ''}
              </h4>
              <ol className="space-y-2">
                {inc.causes.map((c, k) => (
                  <li key={k} className="rounded-xl border border-accent/25 bg-accent-soft p-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          c.likelihood === 'most likely' ? 'bg-accent text-on-accent' : 'bg-surface text-accent ring-1 ring-accent/30'
                        }`}
                      >
                        {c.likelihood}
                      </span>
                      <span className="text-sm font-semibold text-ink">{c.cause}</span>
                    </div>
                    {c.why && <p className="mt-1.5 text-sm text-ink">{c.why}</p>}
                    {c.lines?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {c.lines.map((l) => (
                          <button
                            key={l}
                            onClick={() => setFocusLine(l)}
                            className="rounded-md border border-accent/40 bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-accent hover:border-accent"
                          >
                            line {fmtNum(l)}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {inc.explainedBy && (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  Written by {inc.explainedBy} from the evidence below; counts and times come from the parsers.
                </p>
              )}
            </section>
          )}

          {inc.failures?.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">What failed, and how many times</h4>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="min-w-full text-sm">
                  <thead className="bg-sand text-[11px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Failure</th>
                      <th className="px-3 py-2 text-right font-semibold">Times</th>
                      <th className="whitespace-nowrap px-3 py-2 text-left font-semibold">First → last (UTC)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {inc.failures.map((f) => (
                      <tr key={f.id} className="align-top">
                        <td className="px-3 py-2">
                          <div className="flex items-start gap-2">
                            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_DOT[f.level] || 'bg-line2'}`} />
                            <div className="min-w-0">
                              <span className="text-[11px] font-semibold text-muted">{f.service}</span>
                              <p className="break-words font-mono text-[11.5px] text-ink">{readable(f.template)}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{fmtNum(f.count)}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">
                          {fmtClock(f.first)} → {fmtClock(f.last)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {inc.endpoints?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="text-[11px] font-medium text-muted">Users saw:</span>
                  {inc.endpoints.map((e) => (
                    <span key={e.endpoint} className="chip font-mono text-[10.5px]">
                      {e.endpoint} ×{fmtNum(e.count)}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}

          <Evidence inc={inc} sessionId={sessionId} focusLine={focusLine} onOpenFile={onOpenFile} />

          {inc.fix?.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Follow-ups</h4>
              <ul className="space-y-1.5">
                {inc.fix.map((f, k) => (
                  <li key={k} className="flex gap-2 text-sm text-ink">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    {f}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

function Evidence({ inc, sessionId, focusLine, onOpenFile }) {
  const [chunks, setChunks] = useState(null);
  const lazy = !inc.evidence?.length && inc.evidenceChunkIds?.length > 0;

  useEffect(() => {
    if (!lazy) return;
    analysisAPI
      .evidence(sessionId, inc.evidenceChunkIds)
      .then((r) => setChunks(r.data || []))
      .catch(() => setChunks([]));
  }, [lazy, sessionId, inc.evidenceChunkIds]);

  useEffect(() => {
    if (focusLine) document.getElementById(`ev-${inc.id}-${focusLine}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusLine, inc.id]);

  const rows = inc.evidence?.length
    ? inc.evidence
    : (chunks || []).map((c) => ({ line: c.lineStart, lineEnd: c.lineEnd, text: c.content, role: null }));
  if (!rows.length) return null;

  return (
    <section>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <Icon name="terminal" className="h-3.5 w-3.5" /> Log evidence (exact lines)
      </h4>
      <div className="space-y-2">
        {rows.map((e) => (
          <div
            key={e.line}
            id={`ev-${inc.id}-${e.line}`}
            className={`rounded-xl transition ${focusLine === e.line ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}`}
          >
            <LogViewer
              content={e.text}
              lineStart={e.line}
              maxHeight="max-h-60"
              title={`${e.role ? `${ROLE[e.role] || e.role} · ` : ''}line ${fmtNum(e.line)}`}
              action={
                onOpenFile && (
                  <button
                    onClick={() => onOpenFile(e.line, [e.line, e.lineEnd ?? e.line])}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                  >
                    <Icon name="eye" className="h-3.5 w-3.5" /> In file
                  </button>
                )
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-line bg-sand/60 px-3 py-2">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className="text-lg font-bold text-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}
