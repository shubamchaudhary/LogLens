import Icon from '../Icon';
import TimelineChart from '../TimelineChart';
import { fmtBytes, fmtClock, fmtNum } from '../../utils/format';
import { SEVERITY_STYLES } from '../../utils/severity';

/**
 * One-screen summary: headline numbers, errors over time with flagged minutes and
 * incidents marked, the incident list, and how much the anomaly gate saved.
 */
export default function OverviewTab({ data, onOpenIncident, onOpenFile }) {
  const { series = [], incidents = [], stats, file } = data || {};
  const sum = (k) => series.reduce((n, b) => n + (b[k] || 0), 0);

  const kpis = [
    { label: 'Log lines', value: fmtNum(stats?.lines ?? sum('lines')), sub: file && fmtBytes(file.bytes), icon: 'file' },
    { label: 'ERROR lines', value: fmtNum(stats?.errorLines ?? sum('errors')), icon: 'alert', tone: 'text-rose-600' },
    { label: 'WARN lines', value: fmtNum(stats?.warnLines ?? sum('warns')), icon: 'alert', tone: 'text-amber-600' },
    stats
      ? { label: 'Minutes flagged', value: `${stats.flaggedMinutes}/${stats.minutes}`, sub: 'by the anomaly gate', icon: 'filter' }
      : { label: 'Minutes', value: fmtNum(series.length), icon: 'grid' },
    stats
      ? { label: 'LLM calls', value: fmtNum(stats.llmCallsGated), sub: `vs ${fmtNum(stats.llmCallsUngated)} without the gate`, icon: 'sparkles' }
      : null,
    { label: 'Incidents', value: fmtNum(incidents.length), icon: 'layers', tone: 'text-violet-700' },
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="card p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
              <Icon name={k.icon} className="h-3.5 w-3.5" />
              {k.label}
            </div>
            <div className={`mt-1.5 text-2xl font-bold tracking-tight ${k.tone || 'text-slate-900'}`}>{k.value}</div>
            {k.sub && <div className="truncate text-[11px] text-slate-400">{k.sub}</div>}
          </div>
        ))}
      </div>

      {series.length > 0 && (
        <div className="card p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Errors and warnings per minute</h3>
              <p className="text-xs text-slate-500">Counted by deterministic parsers, never by the LLM. Click a number to open that incident.</p>
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
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Incidents</h3>
          {incidents.length === 0 && <p className="text-sm text-slate-400">No incidents were found.</p>}
          <ol className="space-y-1">
            {incidents.map((inc, i) => {
              const sev = SEVERITY_STYLES[inc.severity] || SEVERITY_STYLES.INFO;
              return (
                <li key={inc.id}>
                  <button
                    onClick={() => onOpenIncident(inc.id)}
                    className="flex w-full items-start gap-3 rounded-xl p-2 text-left transition hover:bg-slate-50"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-pink-500 text-[11px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-800">{inc.title}</span>
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
    </div>
  );
}

function Gating({ stats }) {
  const saved = Math.round((1 - stats.llmCallsGated / stats.llmCallsUngated) * 1000) / 10;
  const rules = Object.entries(stats.anomalyRules || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <>
      <h3 className="text-sm font-semibold text-slate-900">Anomaly gate: what reached the LLM</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Only chunks flagged by statistical rules are sent to the LLM. Every chunk is still embedded for search.
      </p>
      <div className="mt-4 space-y-3">
        <Bar label="Without the gate" value={stats.llmCallsUngated} max={stats.llmCallsUngated} cls="bg-slate-300" />
        <Bar label="With the gate" value={stats.llmCallsGated} max={stats.llmCallsUngated} cls="bg-gradient-to-r from-violet-600 to-pink-500" />
      </div>
      <p className="mt-3 text-2xl font-bold text-gradient">{saved}% fewer calls</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {rules.map(([rule, n]) => (
          <span key={rule} className="chip font-mono text-[10px]">
            {rule} ×{n}
          </span>
        ))}
      </div>
    </>
  );
}

function Bar({ label, value, max, cls }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold text-slate-800">{fmtNum(value)} calls</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.max((value / max) * 100, 0.5)}%` }} />
      </div>
    </div>
  );
}
