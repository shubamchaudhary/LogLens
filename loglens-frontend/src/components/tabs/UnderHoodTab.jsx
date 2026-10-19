import { useState } from 'react';
import Icon from '../Icon';
import HeapChart, { LiveSetBars } from '../HeapChart';
import { ArchitectureDiagram, StepRail } from '../Architecture';
import { pipelineSteps } from '../../utils/pipeline';
import bench from '../../demo/bench.json';
import { fmtBytes, fmtNum } from '../../utils/format';

/**
 * How this session went through the system: the funnel from file to incidents with
 * this run's numbers, the architecture step by step, and the bounded-memory benchmark.
 */
export default function UnderHoodTab({ data }) {
  const { stats, incidents = [], file } = data || {};
  const steps = pipelineSteps(stats && { ...stats, incidents: incidents.length });
  const [step, setStep] = useState(0);

  const funnel = stats
    ? [
        { v: fmtBytes(file?.bytes ?? stats.bytes), k: 'log file', sub: `${fmtNum(stats.lines)} lines` },
        { v: fmtNum(stats.parts), k: 'byte-range parts', sub: '~5 MB each' },
        { v: fmtNum(stats.chunks), k: '60 s windows', sub: `${fmtNum(stats.metricRows)} metric rows` },
        { v: fmtNum(stats.flaggedChunks), k: 'windows flagged', sub: `${stats.flaggedMinutes} of ${stats.minutes} minutes` },
        { v: fmtNum(stats.llmCallsGated), k: 'LLM calls', sub: `instead of ${fmtNum(stats.llmCallsUngated)}` },
        { v: fmtNum(incidents.length), k: 'incidents', sub: 'with root causes' },
      ]
    : null;

  return (
    <div className="space-y-4">
      {funnel && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-slate-900">From file to incidents</h3>
          <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {funnel.map((f, i) => (
              <li key={f.k} className="relative rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
                <div className={`text-lg font-bold tracking-tight ${i === 4 ? 'text-gradient' : i === 5 ? 'text-violet-700' : 'text-slate-900'}`}>{f.v}</div>
                <div className="text-xs font-medium text-slate-700">{f.k}</div>
                <div className="text-[11px] text-slate-400">{f.sub}</div>
                {i < funnel.length - 1 && (
                  <Icon name="arrowRight" className="absolute -right-2.5 top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 rounded-full bg-white text-slate-300 xl:block" />
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="card p-5">
        <h3 className="text-sm font-semibold text-slate-900">How it works</h3>
        <div className="mt-4 hidden rounded-xl border border-slate-100 bg-slate-50/50 p-4 md:block">
          <ArchitectureDiagram step={steps[step]} />
        </div>
        <div className="mt-3">
          <StepRail steps={steps} active={step} onSelect={setStep} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="card p-5">
          <HeapChart bench={bench} />
        </div>
        <div className="card p-5">
          <LiveSetBars bench={bench} />
        </div>
      </div>
    </div>
  );
}
