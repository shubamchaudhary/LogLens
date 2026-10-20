import Icon from '../Icon';
import TimelineChart from '../TimelineChart';
import { fmtBytes, fmtClock, fmtNum } from '../../utils/format';
import { SEVERITY_STYLES } from '../../utils/severity';

/**
 * One-screen report: errors over time with the incidents marked, the incident list,
 * and how many LLM calls the anomaly gate saved.
 */
export default function OverviewTab({ data, onOpenIncident, onOpenFile }) {
  const { series = [], incidents = [], stats, file } = data || {};
  const sum = (k) => series.reduce((n, b) => n + (b[k] || 0), 0);

  return (
    <div className="space-y-4">
      {series.length > 0 && (
        <div className="card p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Errors and warnings per minute</h3>
              <p className="text-xs text-muted">Click a number to open that incident.</p>
            </div>
            {file && onOpenFile && (
              <button onClick={() => onOpenFile(1)} className="btn-ghost">
                <Icon name="eye" className="h-3.5 w-3.5" /> Browse the raw file
              </button>
            )}
          </div>
          <TimelineChart series={series} incidents={incidents} onSelectIncident={(inc) => onOpenIncident(inc.id)} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="card p-5 lg:col-span-3">
          <h3 className="mb-3 text-sm font-semibold text-ink">Incidents</h3>
          {incidents.length === 0 && <p className="text-sm text-slate-400">No incidents were found.</p>}
          <ol className="space-y-1">
            {incidents.map((inc, i) => {
              const sev = SEVERITY_STYLES[inc.severity] || SEVERITY_STYLES.INFO;
              return (
                <li key={inc.id}>
                  <button
                    onClick={() => onOpenIncident(inc.id)}
                    className="flex w-full items-start gap-3 rounded-xl p-2 text-left transition hover:bg-sand"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-on-accent">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{inc.title}</span>
                      <span className="block text-[11px] text-slate-400">
                        {fmtClock(inc.start)} → {fmtClock(inc.end)} UTC
                        {inc.failingLines != null && ` · ${fmtNum(inc.failingLines)} failing records`}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sev.chip}`}>
                      {inc.severity}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        {stats && (
          <div className="card p-5 lg:col-span-2">
            <Gating stats={stats} />
          </div>
        )}
      </div>

      <p className="pt-2 text-center text-xs text-slate-400">
        {fmtNum(stats?.lines ?? sum('lines'))} log lines analysed{file?.bytes ? ` · ${fmtBytes(file.bytes)}` : ''}
      </p>
    </div>
  );
}

function Gating({ stats }) {
  const saved = Math.round((1 - stats.llmCallsGated / stats.llmCallsUngated) * 1000) / 10;
  return (
    <>
      <h3 className="text-sm font-semibold text-ink">Anomaly gate: what reached the LLM</h3>
      <p className="mt-0.5 text-xs text-muted">
        Only the unusual minutes are sent to the LLM.
      </p>
      <div className="mt-4 space-y-3">
        <Bar label="Without the gate" value={stats.llmCallsUngated} max={stats.llmCallsUngated} cls="bg-line2" />
        <Bar label="With the gate" value={stats.llmCallsGated} max={stats.llmCallsUngated} cls="bg-accent" />
      </div>
      <p className="mt-3 text-2xl font-bold text-gradient">{saved}% fewer calls</p>
    </>
  );
}

function Bar({ label, value, max, cls }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-semibold text-ink">{fmtNum(value)} calls</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-sand">
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.max((value / max) * 100, 0.5)}%` }} />
      </div>
    </div>
  );
}
