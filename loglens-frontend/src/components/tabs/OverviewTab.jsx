import Icon from '../Icon';
import TimelineChart from '../TimelineChart';
import { timeline, totals } from '../../utils/analysis';
import { fmtNum, fmtRange } from '../../utils/format';
import { SEVERITY_ORDER, SEVERITY_STYLES, worstFinding } from '../../utils/severity';

/**
 * One-screen summary of a finished session: headline numbers, errors over time
 * with the incidents marked, and (when the pipeline stats are known) how much the
 * anomaly gate saved on LLM calls.
 */
export default function OverviewTab({ results, stats, onOpenTab }) {
  const metrics = results?.metrics || [];
  const findings = results?.findings || [];
  const incidents = results?.incidents || [];
  const t = totals(metrics);
  const series = timeline(metrics);

  const kpis = [
    { label: 'Log lines', value: fmtNum(t.lines), icon: 'file' },
    { label: 'ERROR lines', value: fmtNum(t.errors), icon: 'alert', tone: 'text-rose-600' },
    { label: 'WARN lines', value: fmtNum(t.warns), icon: 'alert', tone: 'text-amber-600' },
    stats
      ? { label: 'Windows flagged', value: `${stats.flagged}/${stats.windows}`, icon: 'filter' }
      : { label: '1-min windows', value: fmtNum(t.windows), icon: 'grid' },
    stats
      ? { label: 'LLM calls', value: fmtNum(stats.llmCallsGated), sub: `vs ${stats.llmCallsUngated} ungated`, icon: 'sparkles' }
      : { label: 'Findings', value: fmtNum(findings.length), icon: 'list' },
    { label: 'Incidents', value: fmtNum(incidents.length), icon: 'layers', tone: 'text-violet-700' },
  ];

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
            {k.sub && <div className="text-[11px] text-slate-400">{k.sub}</div>}
          </div>
        ))}
      </div>

      {series.length > 0 && (
        <div className="card p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Errors and warnings over time</h3>
              <p className="text-xs text-slate-500">
                Counted by the deterministic parsers, never by the LLM. Click a marker to open the incident.
              </p>
            </div>
          </div>
          <TimelineChart series={series} incidents={incidents} onSelectIncident={() => onOpenTab('incidents')} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="card p-5 lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Incidents</h3>
            <button onClick={() => onOpenTab('incidents')} className="btn-ghost">
              Details <Icon name="arrowRight" className="h-3.5 w-3.5" />
            </button>
          </div>
          {incidents.length === 0 && <p className="text-sm text-slate-400">No incidents were correlated.</p>}
          <ol className="space-y-2">
            {incidents.map((inc, i) => {
              const worst = worstFinding(inc.findingIds, findings);
              const sev = SEVERITY_STYLES[worst?.severity] || SEVERITY_STYLES.INFO;
              return (
                <li key={inc.id}>
                  <button
                    onClick={() => onOpenTab('incidents')}
                    className="flex w-full items-start gap-3 rounded-xl p-2 text-left transition hover:bg-slate-50"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-pink-500 text-[11px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">
                        {worst?.title || inc.narrative?.split('. ')[0]}
                      </span>
                      <span className="block text-[11px] text-slate-400">
                        {fmtRange(inc.timeRangeStart, inc.timeRangeEnd)} · {inc.findingIds?.length || 0} finding
                        {inc.findingIds?.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    {worst && (
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sev.chip}`}>
                        {worst.severity}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="card p-5 lg:col-span-2">{stats ? <Gating stats={stats} /> : <Severity findings={findings} />}</div>
      </div>
    </div>
  );
}

function Gating({ stats }) {
  const saved = Math.round((1 - stats.llmCallsGated / stats.llmCallsUngated) * 1000) / 10;
  const rules = Object.entries(stats.anomalyRules || {}).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <h3 className="text-sm font-semibold text-slate-900">Anomaly gate: LLM calls</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Only windows flagged by deterministic rules are sent to the LLM; every window still gets embedded for Q&amp;A.
      </p>
      <div className="mt-4 space-y-3">
        <Bar label="Without the gate" value={stats.llmCallsUngated} max={stats.llmCallsUngated} cls="bg-slate-300" />
        <Bar
          label="With the gate"
          value={stats.llmCallsGated}
          max={stats.llmCallsUngated}
          cls="bg-gradient-to-r from-violet-600 to-pink-500"
        />
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
        <span className="font-semibold text-slate-800">{value} calls</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}

function Severity({ findings }) {
  return (
    <>
      <h3 className="text-sm font-semibold text-slate-900">Findings by severity</h3>
      <div className="mt-4 space-y-2">
        {SEVERITY_ORDER.map((s) => {
          const n = findings.filter((f) => f.severity === s).length;
          return (
            <div key={s} className="flex items-center gap-2 text-sm">
              <span className={`h-2.5 w-2.5 rounded-full ${SEVERITY_STYLES[s].dot}`} />
              <span className="flex-1 text-slate-600">{s}</span>
              <span className="font-semibold text-slate-800">{n}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
