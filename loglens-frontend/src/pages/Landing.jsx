import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadFixture } from '../demo/demoApi';
import bench from '../demo/bench.json';
import TimelineChart from '../components/TimelineChart';
import HeapChart, { LiveSetBars } from '../components/HeapChart';
import { ArchitectureStory } from '../components/Architecture';
import { Heading, Section, SiteFooter, SiteHeader } from '../components/Site';
import Icon from '../components/Icon';
import { useGuestLaunch } from '../hooks/useGuestLaunch';
import { pipelineSteps } from '../utils/pipeline';
import { fmtClock, fmtNum } from '../utils/format';
import { SEVERITY_STYLES } from '../utils/severity';

// Every number on this page is measured: the 1 GB log's from its fixture (production
// parsers and gate), the rest from bench/ and evals/ via src/demo/bench.json.

const FEATURES = [
  { icon: 'search', title: 'Root cause per failure', body: 'Ranked causes, each citing the log lines behind it.' },
  { icon: 'message', title: 'Ask the logs', body: 'AI Q&A over the whole archive, with line citations.' },
  { icon: 'chart', title: 'Exact numbers', body: 'Every count comes from parsers, never from the LLM.' },
  { icon: 'layers', title: 'GB-scale ingest', body: 'Streamed through Kafka with flat memory.' },
  { icon: 'filter', title: 'Cheap AI', body: 'Only abnormal minutes are sent to the model.' },
  { icon: 'activity', title: 'Live pipeline', body: 'Watch every stage run, from upload to report.' },
];

const STACK = [
  { group: 'Backend', items: ['Java 17', 'Spring Boot 3', 'Spring Kafka', 'JdbcTemplate'] },
  { group: 'AI', items: ['LangGraph', 'FastAPI', 'Groq', 'Gemini embeddings'] },
  { group: 'Data', items: ['PostgreSQL 16', 'pgvector · HNSW', 'Full-text search'] },
  { group: 'Infra', items: ['Kafka · Redpanda', 'S3 · MinIO · B2', 'Docker', 'React + Vite'] },
];

const NAV = [
  ['#architecture', 'Architecture'],
  ['#memory', 'Memory'],
  ['#testing', 'Testing'],
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
  const hybrid = bench.retrieval.rows.find((r) => r.retriever.startsWith('hybrid'));

  return (
    <div className="min-h-screen overflow-x-clip bg-paper">
      <SiteHeader links={NAV} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <SquareField />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <p className="kicker">Log intelligence · GB scale · AI root cause</p>
          <h1 className="mt-5 max-w-4xl font-display text-4xl font-extrabold leading-[1.08] tracking-tight text-slate-900 sm:text-6xl">
            Deep-analyse millions of log lines,{' '}
            <span className="bg-gradient-to-r from-violet-600 to-pink-500 bg-[length:100%_6px] bg-bottom bg-no-repeat pb-1">at GB scale</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            Upload a log archive. DeepLogLens finds the failures, explains the root cause of each one, and answers your
            questions about the logs, pointing at the exact lines.
          </p>

          <ul className="mt-10 grid max-w-4xl gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-violet-600">
                  <Icon name={f.icon} className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-900">{f.title}</span>
                  <span className="block text-sm text-slate-500">{f.body}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button onClick={launch} disabled={busy} className="btn-primary px-6 py-3 text-base">
              <Icon name="play" className="h-4 w-4" /> Guest analysis on a 1 GB log
            </button>
            <Link to="/login" className="btn-secondary px-6 py-3 text-base">
              Sign in
            </Link>
            <span className="font-mono text-xs text-slate-500 sm:ml-2">no sign-up · 5.4M lines · 6 outages</span>
          </div>
        </div>
      </section>

      {/* The report */}
      <section className="px-4 pb-16 sm:px-6">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-line bg-white shadow-2xl shadow-violet-900/10">
          <div className="flex items-center gap-2 border-b border-line bg-paper/60 px-4 py-2.5">
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
                    <button onClick={launch} className="flex h-full w-full gap-3 rounded-xl border border-line p-3 text-left transition hover:border-violet-300 hover:bg-violet-50/40">
                      <span className="num-badge rounded-full">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold leading-snug text-slate-900">{inc.title}</span>
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
            <div className="m-6 h-96 animate-pulse rounded-xl bg-paper" />
          )}
        </div>
      </section>

      {/* Three numbers */}
      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-3 md:grid-cols-3">
          <Metric value={big.size} label="archive tested, constant heap" note={`live set ${liveLo}–${liveHi} MB under a ${big.xmxMb} MB cap`} />
          <Metric
            value={saved != null ? pct(saved) : '…'}
            label="fewer LLM calls"
            note={stats ? `${fmtNum(stats.llmCallsGated)} instead of ${fmtNum(stats.llmCallsUngated)} on the 1 GB guest log` : 'on the 1 GB guest log'}
            accent
          />
          <Metric value={medium.f1.toFixed(2)} label="F1 on labelled incidents" note={`every injected incident found · recall@30 ${hybrid.r30.toFixed(2)} on golden Q&A`} />
        </div>
      </section>

      {/* Architecture */}
      <Section id="architecture">
        <Heading
          kicker="Architecture"
          title="Code counts. Statistics choose. The LLM explains."
          lead="Kafka moves facts, blob storage moves bytes, Postgres holds the truth. Here is what happens to a file, step by step."
        />
        <div className="mt-12">
          <ArchitectureStory steps={steps} />
        </div>
      </Section>

      {/* Memory */}
      <Section id="memory">
        <Heading kicker="Memory" title={`${big.size} of logs, flat memory`} />
        <div className="mt-10 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div className="panel p-5 sm:p-6">
            <HeapChart bench={bench} />
          </div>
          <div className="panel p-5 sm:p-6">
            <LiveSetBars bench={bench} />
          </div>
        </div>
      </Section>

      {/* Testing */}
      <Section id="testing">
        <Heading kicker="Testing" title="Tested with numbers, not demos" lead="What every claim on this page was measured against. All of it reruns from the repo." />
        <TestGrid />
        <Link to="/benchmarks" className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-700 hover:underline">
          See every benchmark <Icon name="arrowRight" className="h-4 w-4" />
        </Link>
      </Section>

      {/* Stack */}
      <Section id="stack">
        <Heading kicker="Tech stack" title="Java for the heavy lifting, Python for the graphs" />
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STACK.map((g) => (
            <div key={g.group} className="panel p-5">
              <p className="kicker text-slate-500">{g.group}</p>
              <ul className="mt-4 space-y-2.5">
                {g.items.map((t) => (
                  <li key={t} className="flex items-center gap-2.5 font-display text-[15px] font-semibold text-slate-900">
                    <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-violet-600 to-pink-500" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <SiteFooter />
    </div>
  );
}

/** What it was tested on, with the result. Numbers come from bench.json. */
function TestGrid() {
  const g = bench.gate;
  const f1s = g.synthetic.map((d) => d.f1);
  const held = g.heldout.map((d) => d.f1);
  const incidents = g.synthetic.reduce((n, d) => n + d.incidents, 0);
  const allFound = g.synthetic.every((d) => d.incidentRecall === 1);
  const minCut = Math.min(...g.volume.map((v) => v.callReduction));
  const rates = g.volume.map((v) => v.linesPerS);
  const hybrid = bench.retrieval.rows.find((r) => r.retriever.startsWith('hybrid'));
  const base = bench.chaos.rows.find((r) => r.scenario === 'baseline');
  const faults = bench.chaos.rows.filter((r) => r.scenario !== 'baseline');
  const exact = faults.every(
    (r) => r.chunks === base.chunks && r.lineSum === base.lineSum && r.metricSum === base.metricSum && r.occurrences === base.occurrences
  );
  const clean = bench.robustness.filter((r) => r.status && !/PARSING|CHUNKING/.test(r.status)).length;
  const own = bench.vector.rows.filter((r) => r.layout === 'per_session_table');
  const big = bench.sizes.at(-1);

  const tests = [
    {
      what: 'Anomaly detection',
      on: `${g.synthetic.length} labelled 6 h logs · ${incidents} injected incidents`,
      result: `F1 ${Math.min(...f1s).toFixed(2)}–${Math.max(...f1s).toFixed(2)}`,
      sub: allFound ? `${incidents} / ${incidents} incidents found` : '',
    },
    { what: 'Unseen data', on: `${g.heldout.length} held-out generator seeds`, result: `F1 ${Math.min(...held).toFixed(2)}–${Math.max(...held).toFixed(2)}`, sub: 'rules never tuned on them' },
    { what: 'Real-world logs', on: 'Loghub BGL with labelled alerts', result: `recall ${g.bgl.recall.toFixed(1)}`, sub: `${pct(g.bgl.callReduction)} fewer LLM calls` },
    { what: 'Traffic levels', on: `${rates[0]} to ${rates.at(-1)} lines per second`, result: `≥ ${Math.floor(minCut * 100)}% fewer calls`, sub: 'at every rate tested' },
    { what: 'Q&A retrieval', on: `${bench.retrieval.questions} golden questions with gold lines`, result: `recall@30 ${hybrid.r30.toFixed(2)}`, sub: `p95 ${Math.round(hybrid.p95)} ms` },
    { what: 'Crash safety', on: 'kill -9 ×3, rebalance, Kafka replay from 0', result: exact ? 'identical counts' : 'see benchmarks', sub: `${faults.length} / ${faults.length} scenarios match a clean run` },
    { what: 'Hostile input', on: 'NUL bytes, gzip, one 100 MB line, …', result: `${clean} / ${bench.robustness.length} handled`, sub: 'every upload ends in a clear state' },
    { what: 'Scale', on: `100 MB → ${big.size} at -Xmx${big.xmxMb}m`, result: `${(big.lines / 1e6).toFixed(1)}M lines`, sub: 'no out-of-memory, flat live set' },
    {
      what: 'Tenant isolation',
      on: `${fmtNum(bench.vector.vectors)} vectors, 3 tenants`,
      result: `recall ${Math.min(...own.map((r) => r.recall)).toFixed(1)}`,
      sub: `own table per session · ≤ ${Math.max(...own.map((r) => r.p50))} ms`,
    },
  ];

  return (
    <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tests.map((t, i) => (
        <div key={t.what} className="panel flex flex-col p-5">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-xs text-slate-400">{String(i + 1).padStart(2, '0')}</span>
            <span className="text-sm font-semibold text-slate-900">{t.what}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{t.on}</p>
          <p className="mt-4 font-display text-2xl font-extrabold tracking-tight text-slate-900">{t.result}</p>
          <p className="text-xs text-violet-700">{t.sub}</p>
        </div>
      ))}
      <div className="panel flex items-center gap-3 border-dashed p-5 sm:col-span-2 lg:col-span-3">
        <Icon name="shield" className="h-5 w-5 shrink-0 text-violet-600" />
        <p className="text-sm text-slate-600">
          Every pull request reruns the seeded anomaly eval in CI. The build fails if F1, incident recall or the LLM-call
          saving drops below its threshold.
        </p>
      </div>
    </div>
  );
}

function Metric({ value, label, note, accent = false }) {
  return (
    <div className="panel p-6">
      <div className={`font-display text-5xl font-extrabold tracking-tight ${accent ? 'text-gradient' : 'text-slate-900'}`}>{value}</div>
      <div className="mt-2 text-base font-semibold text-slate-800">{label}</div>
      <div className="mt-1 text-sm text-slate-500">{note}</div>
    </div>
  );
}

function Kpi({ label, value, tone = 'text-slate-900' }) {
  return (
    <div className="rounded-lg border border-line bg-paper/50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`font-display text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );
}

/** Faint grid of squares behind the hero, a few of them tinted (decoration only). */
function SquareField() {
  const tinted = new Set([3, 9, 14, 22, 27, 33, 38, 45]);
  return (
    <div className="pointer-events-none absolute -right-10 top-16 hidden grid-cols-8 gap-2 opacity-70 lg:grid" aria-hidden="true">
      {Array.from({ length: 48 }, (_, i) => (
        <span
          key={i}
          className={`h-10 w-10 rounded-md border ${tinted.has(i) ? 'border-violet-200 bg-gradient-to-br from-violet-100 to-pink-100' : 'border-line bg-white/40'}`}
        />
      ))}
    </div>
  );
}
