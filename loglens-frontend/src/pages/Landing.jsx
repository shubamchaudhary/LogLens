import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadFixture } from '../demo/demoApi';
import bench from '../demo/bench.json';
import TimelineChart from '../components/TimelineChart';
import HeapChart from '../components/HeapChart';
import { ArchitectureSteps, ArchitectureStory } from '../components/Architecture';
import { Heading, Section, SiteFooter, SiteHeader } from '../components/Site';
import Icon from '../components/Icon';
import { useGuestLaunch } from '../hooks/useGuestLaunch';
import { pipelineSteps } from '../utils/pipeline';
import { fmtClock, fmtNum } from '../utils/format';

// Every number on this page is measured: the 1 GB log's from its fixture (production
// parsers and gate), the rest from bench/ and evals/ via src/demo/bench.json.

const NAV = [
  ['#scale', 'Scale'],
  ['#how', 'How it works'],
  ['/benchmarks', 'Benchmarks'],
];

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

// Outlined severity chips that read on both themes.
const SEVERITY_CHIP = {
  CRITICAL: 'border-rose-500/40 text-rose-500',
  ERROR: 'border-orange-500/40 text-orange-500',
  WARN: 'border-amber-500/40 text-amber-500',
  INFO: 'border-sky-500/40 text-sky-500',
};

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
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <SiteHeader links={NAV} />

      {/* Hero */}
      <section>
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <p className="kicker">Log intelligence · GB-scale archives · AI-enabled Q&amp;A · Deep log analysis</p>
          <h1 className="mt-6 font-display text-4xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-5xl lg:text-[2.9rem]">
            Log intelligence for{' '}
            <span className="whitespace-nowrap underline decoration-accent decoration-[5px] underline-offset-[10px]">GB-scale archives</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-body">
            Upload a log archive. DeepLogLens reads every line, finds the failures, explains the root cause of each one,
            and answers your questions about the logs with the exact lines as evidence.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <button onClick={launch} disabled={busy} className="btn-primary px-6 py-3 text-base">
              <Icon name="play" className="h-4 w-4" /> Guest analysis on a 1 GB log
            </button>
            <Link to="/login" className="inline-flex items-center justify-center rounded-xl border border-line bg-surface px-6 py-3 text-base font-semibold text-ink transition hover:border-accent/40 hover:text-accent">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* The report */}
      <section className="px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-line bg-surface shadow-xl shadow-[#b45900]/5">
          <div className="flex items-center gap-2 border-b border-line bg-sand px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="ml-3 truncate font-mono text-[11px] text-muted">deeploglens-1gb.log · report</span>
          </div>
          {fixture ? (
            <div className="p-4 sm:p-6">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Kpi label="Log lines" value={fmtNum(stats.lines)} />
                <Kpi label="ERROR lines" value={fmtNum(stats.errorLines)} tone="text-rose-600" />
                <Kpi label="WARN lines" value={fmtNum(stats.warnLines)} tone="text-amber-600" />
                <Kpi label="Minutes flagged" value={`${stats.flaggedMinutes}/${stats.minutes}`} />
                <Kpi label="LLM calls" value={fmtNum(stats.llmCallsGated)} tone="text-accent" />
                <Kpi label="Incidents" value={fixture.incidents.length} tone="text-accent" />
              </div>
              <div className="mt-4 rounded-xl border border-line p-3 sm:p-4">
                <TimelineChart series={fixture.timeline} incidents={fixture.incidents} onSelectIncident={launch} height={200} />
              </div>
              <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {fixture.incidents.map((inc, i) => (
                  <li key={inc.id}>
                    <button onClick={launch} className="flex h-full w-full gap-3 rounded-xl border border-line p-3 text-left transition hover:border-accent/40 hover:bg-paper">
                      <span className="num-badge rounded-full">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold leading-snug text-ink">{inc.title}</span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                          <span className="font-mono">
                            {fmtClock(inc.start).slice(0, 5)}–{fmtClock(inc.end).slice(0, 5)}
                          </span>
                          <span className={`rounded border px-1.5 text-[10px] font-semibold ${SEVERITY_CHIP[inc.severity] || ''}`}>{inc.severity}</span>
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

      {/* Scale */}
      <Section id="scale">
        <Heading kicker="Scale" title={`${big.size} of logs, flat memory`} />
        <div className="panel mt-10 p-5 sm:p-8">
          <HeapChart bench={bench} height={320} />
        </div>
        <div className="mt-14 grid gap-12 md:grid-cols-3">
          <Fact value={big.size}>
            The largest archive tested. Memory stayed flat at <b className="text-ink">{liveLo}–{liveHi} MB</b> from the first line to the last.
          </Fact>
          <Fact value={saved != null ? pct(saved) : '…'} accent>
            fewer LLM calls on the 1 GB log
            {stats && (
              <>
                : <b className="text-ink">{fmtNum(stats.llmCallsGated)}</b> instead of {fmtNum(stats.llmCallsUngated)}
              </>
            )}
            . Only the unusual minutes are sent to the model.
          </Fact>
          <Fact value={medium.f1.toFixed(2)}>
            F1 score for finding incidents, on logs where every incident is known in advance. <b className="text-ink">1.00</b> would be perfect.
          </Fact>
        </div>
      </Section>

      {/* How it works */}
      <Section id="how" className="pb-24" full>
        <Heading kicker="How it works" title="From one log file to a cited report" />
        <div className="mt-4 hidden lg:block">
          <ArchitectureStory steps={steps} />
        </div>
        <div className="mt-12 lg:hidden">
          <ArchitectureSteps steps={steps} />
        </div>
      </Section>

      <SiteFooter />
    </div>
  );
}

/** A measured fact written out: a big figure with one sentence under it. */
function Fact({ value, accent = false, children }) {
  return (
    <div>
      <span className="block h-1 w-10 rounded-full bg-accent" />
      <p className={`mt-5 font-display text-5xl font-extrabold tracking-tight ${accent ? 'text-gradient' : 'text-ink'}`}>{value}</p>
      <p className="mt-3 text-base leading-relaxed text-body">{children}</p>
    </div>
  );
}

function Kpi({ label, value, tone = 'text-ink' }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`font-display text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );
}
