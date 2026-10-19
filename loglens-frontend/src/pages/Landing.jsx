import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/auth';
import { REPO_URL } from '../config';
import { loadFixture } from '../demo/demoApi';
import bench from '../demo/bench.json';
import TimelineChart from '../components/TimelineChart';
import HeapChart, { LiveSetBars } from '../components/HeapChart';
import GateExplainer from '../components/GateExplainer';
import { ArchitectureDiagram, StepRail } from '../components/Architecture';
import { pipelineSteps } from '../utils/pipeline';
import Icon, { Logo } from '../components/Icon';
import { fmtNum } from '../utils/format';

// Every number on this page is measured. The 1 GB log's numbers come from its
// fixture (the production parsers and gate); the rest from bench/ and evals/.

const PROBLEMS = [
  { title: 'Volume', body: 'A 1 GB log is 5.4 million lines. No context window holds it.' },
  { title: 'Counting', body: 'Ask “how many 503s?” and an LLM estimates from what it sees. It does not count.' },
  { title: 'Trust', body: 'An answer without line numbers is an answer nobody can check.' },
  { title: 'Cost', body: 'You pay for every minute of logs to learn about the few minutes that matter.' },
];

const GATE_AB = [
  { k: 'F1 on labelled minutes', before: '0.576', after: '0.901' },
  { k: 'False alarms per hour', before: '14.8', after: '1.5' },
  { k: 'LLM calls saved at 50 lines/s', before: '0.3%', after: '74.3%' },
  { k: 'Injected incidents caught', before: '12 / 12', after: '12 / 12' },
];

const PROOF = [
  { value: '3 × kill -9', label: 'identical counts', body: 'The JVM killed right after a DB commit, before the offset commit. Before the marker-row fix, enrichment counts drifted +5.8%.' },
  { value: '8 / 8', label: 'bad inputs end cleanly', body: 'A NUL byte, a gzip file, one 100 MB line, 120k lines in a minute. Before: 3 sessions hung and one consumer died.' },
  { value: '100% vs 7%', label: 'vector recall', body: 'A small tenant on a shared HNSW index got 7% recall@10. Its own table per session: 100%, in 0.24 ms.' },
  { value: '0.39 → 0.76', label: 'recall@10', body: 'An eval showed “hybrid” search had been vector-only: the full-text leg silently matched nothing.' },
];

const STACK = [
  ['Backend', 'Java 17 · Spring Boot 3 · Spring Kafka · JdbcTemplate'],
  ['AI', 'Python · FastAPI · LangGraph · Groq · Gemini embeddings'],
  ['Data', 'PostgreSQL 16 · pgvector (HNSW) · full-text search'],
  ['Infra', 'Kafka (Redpanda) · S3 / MinIO / B2 · Docker · React + Vite on Vercel'],
];

export default function Landing() {
  const { user, guestLogin } = useAuth();
  const navigate = useNavigate();
  const [fixture, setFixture] = useState(null);
  const [step, setStep] = useState(0);
  const [autoplay, setAutoplay] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadFixture().then((f) => !cancelled && setFixture(f));
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = fixture?.stats;
  const steps = pipelineSteps(stats && { ...stats, incidents: fixture.incidents.length });
  const saved = stats ? (Math.round((1 - stats.llmCallsGated / stats.llmCallsUngated) * 1000) / 10).toFixed(1) : null;

  // Walk through the steps on its own until the visitor picks one.
  useEffect(() => {
    if (!autoplay) return undefined;
    const t = setInterval(() => setStep((s) => (s + 1) % steps.length), 4500);
    return () => clearInterval(t);
  }, [autoplay, steps.length]);
  const pick = (i) => {
    setAutoplay(false);
    setStep(i);
  };

  const launch = async () => {
    if (!user) await guestLogin();
    navigate('/app');
  };

  const big = bench.sizes.at(-1);
  const liveMin = Math.min(...bench.sizes.map((s) => s.live.median));
  const liveMax = Math.max(...bench.sizes.map((s) => s.live.max));

  return (
    <div className="min-h-screen overflow-x-hidden bg-white">
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-7 text-sm text-slate-600 md:flex">
            <a href="#how" className="hover:text-violet-700">How it works</a>
            <a href="#gate" className="hover:text-violet-700">The gate</a>
            <a href="#memory" className="hover:text-violet-700">Memory</a>
            <a href="#proof" className="hover:text-violet-700">Proof</a>
          </nav>
          <div className="flex items-center gap-2">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn-ghost hidden sm:inline-flex" title="Source on GitHub">
              <Icon name="github" className="h-4 w-4" /> GitHub
            </a>
            {!user && (
              <Link to="/login" className="btn-ghost hidden sm:inline-flex">
                Sign in
              </Link>
            )}
            <button onClick={launch} className="btn-primary px-4 py-2">
              {user ? 'Open app' : 'Try it'} <Icon name="arrowRight" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="pointer-events-none absolute -left-40 -top-24 h-96 w-96 rounded-full bg-fuchsia-200/40 blur-3xl" />
        <div className="pointer-events-none absolute -right-40 top-48 h-96 w-96 rounded-full bg-sky-200/40 blur-3xl" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pb-14 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <Kicker>Log analysis · Spring Boot · Kafka · LangGraph · pgvector</Kicker>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight text-slate-900 sm:text-[3.4rem]">
              Find the outage in <span className="text-gradient">1 GB of logs</span>, with the lines that prove it
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
              Code parses every line into exact per-minute counts. Statistics pick the few abnormal minutes. Only those
              reach an LLM, which explains them. You get incidents with causes and citations, and a chat that answers
              from the logs.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <button onClick={launch} className="btn-primary px-6 py-3 text-base">
                <Icon name="play" className="h-4 w-4" /> Open the 1 GB demo
              </button>
              <a href="#how" className="btn-secondary px-6 py-3 text-base">
                See how it works
              </a>
            </div>
            <Callout className="mt-6 max-w-xl">
              <b>No sign-up.</b> The demo replays a real run of the production parsers on a 1 GB, 5.4M-line log with six
              outages. The Ask tab is live: it searches that log in Postgres and cites its lines.
            </Callout>
          </div>

          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-2xl shadow-violet-500/10">
            <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
              <span className="ml-3 truncate font-mono text-[11px] text-slate-400">deeploglens-1gb.log · overview</span>
            </div>
            <div className="p-4">
              {fixture ? (
                <>
                  <div className="mb-3 grid grid-cols-3 gap-2">
                    <Mini label="Log lines" value={fmtNum(stats.lines)} />
                    <Mini label="Minutes to the LLM" value={`${stats.flaggedMinutes}/${stats.minutes}`} />
                    <Mini label="Incidents" value={fixture.incidents.length} tone="text-violet-700" />
                  </div>
                  <div className="card p-3">
                    <TimelineChart series={fixture.timeline} incidents={fixture.incidents} onSelectIncident={launch} height={140} />
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {fixture.incidents.slice(0, 3).map((inc, i) => (
                      <li key={inc.id} className="flex items-center gap-2 truncate text-xs text-slate-600">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[10px] font-bold text-white">
                          {i + 1}
                        </span>
                        <span className="truncate">{inc.title}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="h-72 animate-pulse rounded-2xl bg-slate-100" />
              )}
            </div>
          </div>
        </div>

        {/* Measured numbers */}
        <div className="relative mx-auto grid max-w-6xl grid-cols-2 gap-3 px-4 pb-16 sm:px-6 lg:grid-cols-4">
          <Stat value={big.size} label={`ingested in a ${big.xmxMb} MB heap`} note={`live set ${liveMin}–${liveMax} MB at every file size`} />
          <Stat
            value={saved ? `${saved}%` : '…'}
            label="fewer LLM calls"
            note={stats ? `${fmtNum(stats.llmCallsGated)} vs ${fmtNum(stats.llmCallsUngated)} on this 1 GB log` : 'on this 1 GB log'}
            accent
          />
          <Stat value="0.90" label="F1, anomaly gate" note="0.58 with fixed thresholds" />
          <Stat value="0.76" label="recall@10, hybrid search" note="0.39 before an eval caught a bug" />
        </div>
      </section>

      {/* Problem */}
      <Section id="problem" tone="bg-slate-50">
        <Kicker>The problem</Kicker>
        <H2>Pasting logs into a chatbot fails four ways</H2>
        <Lead>
          It is 3 AM and checkout returns 503. You need three answers: what broke, since when, and how many users were
          hit. A chatbot gives you none of them reliably.
        </Lead>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PROBLEMS.map((p, i) => (
            <div key={p.title} className="card p-5">
              <span className="font-mono text-xs text-slate-400">0{i + 1}</span>
              <h3 className="mt-2 font-semibold text-slate-900">{p.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{p.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* How it works */}
      <Section id="how">
        <Kicker>How it works</Kicker>
        <H2>Code counts. Statistics choose. The LLM explains.</H2>
        <Lead>
          One rule explains most of the design: Kafka moves facts, blob storage moves bytes, Postgres holds the truth.
          Pick a step to see the path it takes{autoplay ? ' (it walks through them on its own until you do)' : ''}.
        </Lead>
        <div className="mt-10 card hidden p-4 sm:p-6 md:block">
          <ArchitectureDiagram step={steps[step]} />
        </div>
        <div className="mt-4">
          <StepRail steps={steps} active={step} onSelect={pick} />
        </div>
        <Callout className="mt-8">
          <b>Failure is assumed, not exceptional.</b> Kafka offsets are committed only after the database commit, and
          every unit of work writes a marker row in the same transaction as its data, so a redelivered message changes
          nothing. Replaying the enrichment topic from offset 0 used to redo 8,820 LLM calls; now every item is skipped by
          its marker.
        </Callout>
      </Section>

      {/* Gate */}
      <Section id="gate" tone="bg-slate-50">
        <Kicker>The anomaly gate</Kicker>
        <H2>Only abnormal minutes reach the LLM</H2>
        <Lead>
          Each minute is compared with the rest of its own session, not with a fixed threshold. That is what makes the
          LLM bill follow the incidents instead of the file size.
        </Lead>
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-slate-900">On this 1 GB log</h3>
            {stats ? (
              <>
                <p className="mt-3 text-5xl font-extrabold tracking-tight text-gradient">{saved}%</p>
                <p className="text-sm text-slate-600">fewer LLM calls than sending every window</p>
                <div className="mt-6 space-y-3">
                  <CallBar label="Every window" value={stats.llmCallsUngated} max={stats.llmCallsUngated} cls="bg-slate-300" />
                  <CallBar label="Flagged windows only" value={stats.llmCallsGated} max={stats.llmCallsUngated} cls="bg-gradient-to-r from-violet-600 to-pink-500" />
                </div>
                <p className="mt-4 text-xs text-slate-500">
                  {stats.flaggedMinutes} of {stats.minutes} minutes flagged ({fmtNum(stats.flaggedChunks)} of {fmtNum(stats.chunks)} windows). A window
                  larger than 5,000 characters takes several calls, which is why the counts are this high.
                </p>
              </>
            ) : (
              <div className="mt-4 h-40 animate-pulse rounded-xl bg-slate-100" />
            )}
            <Callout className="mt-5">
              The saving depends on how much of the log is abnormal: <b>87.5%</b> on the 10k-line sample log, <b>{saved ?? '…'}%</b>{' '}
              on this one, about <b>74%</b> on an incident-dense benchmark.
            </Callout>
          </div>
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-slate-900">Why the median, not the mean</h3>
            <p className="mb-5 mt-0.5 text-xs text-slate-500">The gate’s count-spike rule, on ten minutes you can edit.</p>
            <GateExplainer />
          </div>
        </div>
        <div className="mt-6 card overflow-hidden">
          <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 border-b border-slate-100 bg-slate-50 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <span>Same build, flag switched</span>
            <span>Fixed thresholds</span>
            <span>Session statistics</span>
          </div>
          {GATE_AB.map((r) => (
            <div key={r.k} className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 border-b border-slate-100 px-5 py-2.5 text-sm last:border-0">
              <span className="text-slate-600">{r.k}</span>
              <span className="font-mono text-slate-500">{r.before}</span>
              <span className="font-mono font-semibold text-slate-900">{r.after}</span>
            </div>
          ))}
          <p className="bg-slate-50 px-5 py-3 text-xs leading-relaxed text-slate-500">
            Fixed thresholds (“flag any ERROR line”) saved 77% at 1 line/s and 0% at 20 lines/s, because every busy minute
            contains a harmless ERROR. Nothing in the code showed it; measuring on labelled logs did.
          </p>
        </div>
      </Section>

      {/* Memory */}
      <Section id="memory">
        <Kicker>Bounded memory</Kicker>
        <H2>
          A {big.size} file in a {big.xmxMb} MB heap
        </H2>
        <Lead>
          The splitter reads the file once and hands out byte ranges; each worker holds only its ~5 MB part. So memory
          follows the number of threads, not the size of the file. These are the real runs from <code className="text-[0.9em]">bench/</code>.
        </Lead>
        <div className="mt-10 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <div className="card p-5 sm:p-6">
            <HeapChart bench={bench} />
          </div>
          <div className="card p-5 sm:p-6">
            <LiveSetBars bench={bench} />
          </div>
        </div>
        <Callout className="mt-6">
          <b>The first measurement misled me.</b> Peak heap went from 186 MB to 228 MB as the file grew, which looked like
          a leak. It was the top of the GC sawtooth, which follows when the collector decides to run. The live set, the
          heap left after a full GC, stayed between {liveMin} and {liveMax} MB from 100 MB to 2 GB.
        </Callout>
      </Section>

      {/* Proof */}
      <Section id="proof" tone="bg-slate-50">
        <Kicker>Measured, not claimed</Kicker>
        <H2>Every number is reproducible</H2>
        <Lead>
          The benchmarks and evals ship in the repo, including the runs that went badly. Each of these found a real bug
          first, and is a before/after number now.
        </Lead>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PROOF.map((p) => (
            <div key={p.label} className="card p-5">
              <div className="text-2xl font-extrabold tracking-tight text-slate-900">{p.value}</div>
              <div className="text-sm font-medium text-violet-700">{p.label}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <div className="card p-5">
            <h3 className="font-semibold text-slate-900">Read the raw results</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Throughput, GC logs, chaos and robustness runs, and the vector-isolation experiment, with the scripts that
              produced them.
            </p>
            <a href={`${REPO_URL}/blob/main/bench/BENCHMARKS.md`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-violet-700 hover:underline">
              Benchmarks <Icon name="arrowRight" className="h-3.5 w-3.5" />
            </a>
          </div>
          <div className="card p-5">
            <h3 className="font-semibold text-slate-900">Where it falls short</h3>
            <ul className="mt-1.5 space-y-1.5 text-sm leading-relaxed text-slate-600">
              <li>• The gate misses slow drifts, and a session that is abnormal from start to finish, because the median moves with it.</li>
              <li>• In the full app, citations point to 60-second windows with their line range, not to single lines.</li>
              <li>• This guest demo replays a precomputed run. Uploading your own file needs an account and the backend.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* Stack */}
      <Section id="stack">
        <Kicker>Stack</Kicker>
        <H2>Built with</H2>
        <dl className="mt-8 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {STACK.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:gap-6">
              <dt className="w-24 shrink-0 text-sm font-semibold text-violet-700">{k}</dt>
              <dd className="text-sm text-slate-700">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-3xl bg-gradient-to-br from-violet-600 via-fuchsia-600 to-pink-500 p-10 text-center text-white shadow-2xl shadow-violet-500/30 sm:p-14">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Find the six outages yourself</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">
            An expired certificate, a bad deploy, a Redis failover, a Kafka rebalance loop, an OOM crash loop and database
            deadlocks. Watch the pipeline find them, then ask it why.
          </p>
          <button onClick={launch} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3 font-semibold text-violet-700 shadow-lg transition hover:bg-violet-50">
            <Icon name="play" className="h-4 w-4" /> Open the 1 GB demo
          </button>
        </div>
      </section>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:px-6">
          <Logo />
          <span>Open-source portfolio project · runs on free tiers</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium hover:text-violet-700">
            <Icon name="github" className="h-4 w-4" /> GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

function Section({ id, tone = '', children }) {
  return (
    <section id={id} className={`scroll-mt-16 py-20 ${tone}`}>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">{children}</div>
    </section>
  );
}

function Kicker({ children }) {
  return <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-violet-700">{children}</p>;
}

function H2({ children }) {
  return <h2 className="mt-3 max-w-3xl text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">{children}</h2>;
}

function Lead({ children }) {
  return <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600">{children}</p>;
}

function Callout({ children, className = '' }) {
  return (
    <div className={`rounded-xl border border-slate-200 border-l-4 border-l-violet-500 bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ${className}`}>
      {children}
    </div>
  );
}

function Stat({ value, label, note, accent = false }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className={`text-2xl font-extrabold tracking-tight sm:text-3xl ${accent ? 'text-gradient' : 'text-slate-900'}`}>{value}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-700">{label}</div>
      <div className="mt-1 text-xs text-slate-400">{note}</div>
    </div>
  );
}

function Mini({ label, value, tone = 'text-slate-900' }) {
  return (
    <div className="card p-2.5">
      <div className="text-[10px] font-medium text-slate-500">{label}</div>
      <div className={`text-base font-bold ${tone}`}>{value}</div>
    </div>
  );
}

function CallBar({ label, value, max, cls }) {
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
