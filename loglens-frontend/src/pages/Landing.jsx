import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadFixture } from '../demo/demoApi';
import bench from '../demo/bench.json';
import TimelineChart from '../components/TimelineChart';
import HeapChart, { LiveSetBars } from '../components/HeapChart';
import { ArchitectureSteps } from '../components/Architecture';
import { Heading, Section, SiteHeader } from '../components/Site';
import Icon from '../components/Icon';
import { useGuestLaunch } from '../hooks/useGuestLaunch';
import { pipelineSteps } from '../utils/pipeline';
import { fmtClock, fmtNum } from '../utils/format';
import { SEVERITY_STYLES } from '../utils/severity';

// Every number on this page is measured: the 1 GB log's from its fixture (production
// parsers and gate), the rest from bench/ and evals/ via src/demo/bench.json.

const NAV = [
  ['#how', 'How it works'],
  ['#scale', 'Scale'],
  ['#tested', 'Tested'],
  ['/benchmarks', 'Benchmarks'],
];

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

export default function Landing() {
  const { launch, busy } = useGuestLaunch();
  const [fixture, setFixture] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadFixture().then((f) => !cancelled && setFixture(f));
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = fixture?.stats;
  const saved = stats ? 1 - stats.llmCallsGated / stats.llmCallsUngated : null;
  const steps = pipelineSteps(stats && { ...stats, incidents: fixture.incidents.length });
  const big = bench.sizes.at(-1);
  const liveLo = Math.min(...bench.sizes.map((s) => s.live.median));
  const liveHi = Math.max(...bench.sizes.map((s) => s.live.max));
  const medium = bench.gate.synthetic.find((d) => d.dataset.includes('medium'));

  return (
    <div className="min-h-screen overflow-x-clip bg-paper">
      <SiteHeader links={NAV} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <SquareField />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <p className="kicker">Log intelligence · GB-scale archives · AI-enabled Q&amp;A · Deep log analysis</p>
          <h1 className="mt-6 font-display text-4xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-5xl lg:text-[2.9rem]">
            Log intelligence for{' '}
            <span className="whitespace-nowrap bg-gradient-to-r from-violet-600 to-pink-500 bg-[length:100%_6px] bg-bottom bg-no-repeat pb-1">GB-scale archives</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            Upload a log archive. DeepLogLens reads every line, finds the failures, explains the root cause of each one,
            and answers your questions about the logs with the exact lines as evidence.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <button onClick={launch} disabled={busy} className="btn-primary px-6 py-3 text-base">
              <Icon name="play" className="h-4 w-4" /> Guest analysis on a 1 GB log
            </button>
            <Link to="/login" className="inline-flex items-center justify-center rounded-xl border border-line bg-white px-6 py-3 text-base font-semibold text-slate-700 transition hover:border-violet-300 hover:text-violet-700">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* The report */}
      <section className="px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-line bg-white shadow-xl shadow-[#b45900]/5">
          <div className="flex items-center gap-2 border-b border-line bg-sand px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="ml-3 truncate font-mono text-[11px] text-slate-500">deeploglens-1gb.log · report</span>
          </div>
          {fixture ? (
            <div className="p-4 sm:p-6">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Kpi label="Log lines" value={fmtNum(stats.lines)} />
                <Kpi label="ERROR lines" value={fmtNum(stats.errorLines)} tone="text-rose-600" />
                <Kpi label="WARN lines" value={fmtNum(stats.warnLines)} tone="text-amber-600" />
                <Kpi label="Minutes flagged" value={`${stats.flaggedMinutes}/${stats.minutes}`} />
                <Kpi label="LLM calls" value={fmtNum(stats.llmCallsGated)} tone="text-violet-700" />
                <Kpi label="Incidents" value={fixture.incidents.length} tone="text-violet-700" />
              </div>
              <div className="mt-4 rounded-xl border border-line p-3 sm:p-4">
                <TimelineChart series={fixture.timeline} incidents={fixture.incidents} onSelectIncident={launch} height={200} />
              </div>
              <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {fixture.incidents.map((inc, i) => (
                  <li key={inc.id}>
                    <button onClick={launch} className="flex h-full w-full gap-3 rounded-xl border border-line p-3 text-left transition hover:border-violet-300 hover:bg-paper">
                      <span className="num-badge rounded-full">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold leading-snug text-ink">{inc.title}</span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="font-mono">
                            {fmtClock(inc.start).slice(0, 5)}–{fmtClock(inc.end).slice(0, 5)}
                          </span>
                          <span className={`rounded border px-1.5 text-[10px] font-semibold ${SEVERITY_STYLES[inc.severity]?.chip || ''}`}>{inc.severity}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="m-6 h-96 animate-pulse rounded-xl bg-sand" />
          )}
        </div>
      </section>

      {/* Three numbers */}
      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-3 md:grid-cols-3">
          <Metric value={big.size} label="largest archive tested" note={`memory stays flat at ${liveLo}–${liveHi} MB`} />
          <Metric
            value={saved != null ? pct(saved) : '…'}
            label="fewer LLM calls"
            note={stats ? `${fmtNum(stats.llmCallsGated)} instead of ${fmtNum(stats.llmCallsUngated)} on the 1 GB log` : 'on the 1 GB log'}
            accent
          />
          <Metric value={medium.f1.toFixed(2)} label="F1 score, incident detection" note="accuracy on logs with known incidents (1.0 is perfect)" />
        </div>
      </section>

      {/* How it works */}
      <Section id="how">
        <Heading kicker="How it works" title="From one log file to a cited report" />
        <div className="mt-12">
          <ArchitectureSteps steps={steps} />
        </div>
      </Section>

      {/* Scale */}
      <Section id="scale">
        <Heading kicker="Scale" title={`${big.size} of logs, flat memory`} />
        <div className="mt-10 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div className="panel p-5 sm:p-6">
            <HeapChart bench={bench} />
          </div>
          <div className="panel p-5 sm:p-6">
            <LiveSetBars bench={bench} />
          </div>
        </div>
      </Section>

      {/* Tested */}
      <Section id="tested" className="pb-24">
        <Heading kicker="Tested" title="Tested at scale" />
        <Tested lines1g={stats?.lines} />
        <Link to="/benchmarks" className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-700 hover:underline">
          All benchmarks <Icon name="arrowRight" className="h-4 w-4" />
        </Link>
      </Section>
    </div>
  );
}

/** The headline test results, all from bench.json. */
function Tested({ lines1g }) {
  const big = bench.sizes.at(-1);
  const g = bench.gate;
  const incidents = g.synthetic.reduce((n, d) => n + d.incidents, 0);
  const found = g.synthetic.reduce((n, d) => n + Math.round(d.incidentRecall * d.incidents), 0);
  const faults = bench.chaos.rows.filter((r) => r.scenario !== 'baseline').length;
  const hybrid = bench.retrieval.rows.find((r) => r.retriever.startsWith('hybrid'));
  const items = [
    [big.size, `archive ingested, ${(big.lines / 1e6).toFixed(1)}M lines`],
    ['1 GB', `archive analysed end to end${lines1g ? `, ${(lines1g / 1e6).toFixed(1)}M lines` : ''}`],
    [`${found} / ${incidents}`, 'injected incidents detected'],
    [`${faults} / ${faults}`, 'crash and replay runs identical to a clean run'],
    [`${bench.robustness.length} / ${bench.robustness.length}`, 'malformed inputs handled cleanly'],
    [hybrid.r30.toFixed(2), `Q&A retrieval recall on ${bench.retrieval.questions} questions`],
  ];
  return (
    <dl className="mt-10 grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-line gap-px lg:grid-cols-3">
      {items.map(([v, k]) => (
        <div key={k} className="bg-white p-5 sm:p-6">
          <dt className="sr-only">{k}</dt>
          <dd className="font-display text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{v}</dd>
          <dd className="mt-1 text-sm text-slate-500">{k}</dd>
        </div>
      ))}
    </dl>
  );
}

function Metric({ value, label, note, accent = false }) {
  return (
    <div className="panel p-6">
      <div className={`font-display text-5xl font-extrabold tracking-tight ${accent ? 'text-gradient' : 'text-ink'}`}>{value}</div>
      <div className="mt-2 text-base font-semibold text-slate-800">{label}</div>
      <div className="mt-1 text-sm text-slate-500">{note}</div>
    </div>
  );
}

function Kpi({ label, value, tone = 'text-ink' }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`font-display text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );
}

/** Faint grid of squares behind the hero, a few of them tinted (decoration only). */
function SquareField() {
  const tinted = new Set([3, 9, 14, 22, 27, 33, 38, 45]);
  return (
    <div className="pointer-events-none absolute -right-10 top-60 hidden grid-cols-8 gap-2 lg:grid" aria-hidden="true">
      {Array.from({ length: 48 }, (_, i) => (
        <span key={i} className={`h-10 w-10 rounded-md border border-line ${tinted.has(i) ? 'bg-[#f5ede1]' : 'bg-white/50'}`} />
      ))}
    </div>
  );
}
