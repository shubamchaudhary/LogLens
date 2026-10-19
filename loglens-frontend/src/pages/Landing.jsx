import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/auth';
import { REPO_URL } from '../config';
import { loadFixture } from '../demo/demoApi';
import TimelineChart from '../components/TimelineChart';
import Icon, { Logo } from '../components/Icon';

// Every number here is measured; the caption says where (evals/ and bench/ in the repo).
const STATS = [
  { value: '2 GB', label: 'log ingested in a 256 MB heap', note: 'live set ≤ 92 MB from 100 MB to 2 GB files', icon: 'cpu' },
  { value: '0.90', label: 'F1 on anomaly detection', note: '12/12 labelled incidents caught', icon: 'shield' },
  { value: '78%', label: 'fewer LLM calls', note: 'only anomalous minutes reach the model', icon: 'zap' },
  { value: '45 ms', label: 'p95 hybrid retrieval', note: 'pgvector + full-text, RRF-fused', icon: 'search' },
];

const STEPS = [
  { icon: 'upload', title: 'Upload', body: 'Presigned PUT straight to blob storage. The API returns in milliseconds; the app server never touches the bytes.' },
  { icon: 'layers', title: 'Split on Kafka', body: 'One streaming pass cuts window-aligned byte ranges. Parallel consumers do ranged GETs, so memory stays flat.' },
  { icon: 'grid', title: 'Parse exactly', body: 'Eight regex parsers compute every count, rate and p95 per minute. The LLM never counts anything.' },
  { icon: 'filter', title: 'Gate anomalies', body: 'Robust statistical rules (modified z-score, rare signatures) pick the few minutes worth an LLM call.' },
  { icon: 'graph', title: 'Correlate', body: 'A LangGraph agent clusters findings into incidents, and an LLM judge rejects claims the evidence doesn’t support.' },
  { icon: 'message', title: 'Ask', body: 'Corrective RAG over the session’s own chunks: retrieve, grade, rewrite, answer with line-level citations.' },
];

const HIGHLIGHTS = [
  { icon: 'key', title: 'Rate limits as Kafka partitions', body: 'One partition per API key, one consumer per partition: each worker self-paces to its quota with zero coordination, and a proactive token budget makes 429s a non-event.' },
  { icon: 'repeat', title: 'Exactly-once effects', body: 'A marker row in the same transaction as each part’s data makes every redelivery a no-op. Crash, rebalance and full replay tests leave identical counts.' },
  { icon: 'cpu', title: 'Memory-bounded ingest', body: 'Virtual parts (the Hadoop input-split idea) plus S3 ranged GETs: the same heap for a 1 MB file and a 2 GB one.' },
  { icon: 'database', title: 'Per-session vector tables', body: 'Each session gets its own right-sized HNSW index, avoiding the recall collapse of filtered ANN on one shared table.' },
  { icon: 'shield', title: 'Grounded by construction', body: 'Numbers come from SQL, explanations cite chunks, and the judge loop blocks unsupported claims. Answers abstain when logs are silent.' },
  { icon: 'chart', title: 'Measured, not claimed', body: 'Eval harness for anomaly F1, retrieval recall@k and answer faithfulness, plus chaos and throughput benchmarks, all in the repo.' },
];

const STACK = [
  ['Backend', 'Java 17 · Spring Boot · Spring Kafka · JdbcTemplate'],
  ['AI', 'Python · FastAPI · LangGraph · Groq · Gemini embeddings'],
  ['Data', 'PostgreSQL 16 · pgvector (HNSW) · full-text search'],
  ['Infra', 'Kafka (Redpanda) · S3 / MinIO · Docker · React + Vite'],
];

export default function Landing() {
  const { user, guestLogin } = useAuth();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadFixture().then((f) => {
      if (!cancelled) setPreview(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const launch = async () => {
    if (!user) await guestLogin();
    navigate('/app');
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-white">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-8 text-sm text-slate-600 md:flex">
            <a href="#how" className="hover:text-violet-700">How it works</a>
            <a href="#engineering" className="hover:text-violet-700">Engineering</a>
            <a href="#stack" className="hover:text-violet-700">Stack</a>
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
        <div className="pointer-events-none absolute -left-32 -top-24 h-96 w-96 rounded-full bg-fuchsia-200/50 blur-3xl" />
        <div className="pointer-events-none absolute -right-32 top-40 h-96 w-96 rounded-full bg-sky-200/50 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-16 text-center sm:px-6 sm:pt-24">
          <span className="chip border-violet-200 bg-violet-50 text-violet-700">
            <Icon name="sparkles" className="h-3.5 w-3.5" /> Spring Boot · Kafka · LangGraph · pgvector
          </span>
          <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-extrabold tracking-tight text-slate-900 sm:text-6xl">
            Turn GB-scale logs into <span className="text-gradient">cited incident reports</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
            Upload a log file. Deterministic parsers compute exact metrics, an LLM explains only the anomalous minutes,
            a LangGraph agent correlates them into incidents, and you can ask questions answered with citations to the
            exact log lines.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button onClick={launch} className="btn-primary w-full px-7 py-3 text-base sm:w-auto">
              <Icon name="play" className="h-4 w-4" /> Analyze a 1 GB log
            </button>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn-secondary w-full px-7 py-3 text-base sm:w-auto">
              <Icon name="github" className="h-4 w-4" /> View source
            </a>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            No sign-up. A full day of production logs from 10 services: 1 GB, 5.4 million lines, six real-world outages.
          </p>

          {/* Stats */}
          <div className="mx-auto mt-14 grid max-w-5xl grid-cols-2 gap-6 lg:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="flex flex-col items-center">
                <span className="icon-tile">
                  <Icon name={s.icon} className="h-5 w-5" />
                </span>
                <span className="mt-3 text-3xl font-extrabold text-gradient sm:text-4xl">{s.value}</span>
                <span className="mt-1 text-sm font-medium text-slate-700">{s.label}</span>
                <span className="text-xs text-slate-400">{s.note}</span>
              </div>
            ))}
          </div>
          <p className="mt-6 text-[11px] text-slate-400">
            Measured by the eval harness and benchmarks in the repo (<code>evals/</code>, <code>bench/</code>).
          </p>
        </div>
      </section>

      {/* Product preview */}
      <section className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-2xl shadow-violet-500/10">
          <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="ml-3 truncate font-mono text-[11px] text-slate-400">
              DeepLogLens · {preview?.file.name || 'deeploglens-1gb.log'} · overview
            </span>
          </div>
          <div className="p-4 sm:p-6">
            {preview ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Mini label="Log lines" value={preview.stats.lines.toLocaleString('en-US')} />
                  <Mini label="ERROR lines" value={preview.stats.errorLines.toLocaleString('en-US')} tone="text-rose-600" />
                  <Mini label="Minutes sent to the LLM" value={`${preview.stats.flaggedMinutes}/${preview.stats.minutes}`} />
                  <Mini label="Incidents" value={preview.incidents.length} tone="text-violet-700" />
                </div>
                <div className="card p-4">
                  <TimelineChart series={preview.timeline} incidents={preview.incidents} onSelectIncident={launch} height={150} />
                </div>
              </>
            ) : (
              <div className="h-72 animate-pulse rounded-2xl bg-slate-100" />
            )}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-16 bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionTitle kicker="How it works" title="Heavy work off the request path" sub="Kafka moves facts, blob storage moves bytes, Postgres holds the truth." />
          <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="card relative p-6">
                <span className="absolute right-5 top-5 text-4xl font-extrabold text-slate-100">{i + 1}</span>
                <span className="icon-tile">
                  <Icon name={s.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Engineering */}
      <section id="engineering" className="scroll-mt-16 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionTitle kicker="Engineering" title={<>The parts that were <span className="text-gradient">hard to get right</span></>} />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {HIGHLIGHTS.map((h) => (
              <div key={h.title} className="card p-6 transition hover:-translate-y-0.5 hover:shadow-md">
                <span className="icon-tile">
                  <Icon name={h.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-semibold text-slate-900">{h.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{h.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Stack */}
      <section id="stack" className="scroll-mt-16 bg-slate-50 py-20">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <SectionTitle kicker="Stack" title="Built with" />
          <dl className="mt-10 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {STACK.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-1 px-6 py-4 sm:flex-row sm:gap-6">
                <dt className="w-24 shrink-0 text-sm font-semibold text-violet-700">{k}</dt>
                <dd className="text-sm text-slate-700">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-3xl bg-gradient-to-br from-violet-600 via-fuchsia-600 to-pink-500 p-10 text-center text-white shadow-2xl shadow-violet-500/30 sm:p-14">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Find the six outages in 1 GB of logs</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">
            Expired certificates, a bad deploy, a Redis failover, a Kafka rebalance loop, an OOM crash loop and
            database deadlocks. Watch the pipeline find them, then ask it why.
          </p>
          <button onClick={launch} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3 font-semibold text-violet-700 shadow-lg transition hover:bg-violet-50">
            <Icon name="play" className="h-4 w-4" /> Analyze the log
          </button>
        </div>
      </section>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:px-6">
          <Logo />
          <span>Open-source portfolio project · runs on free tiers at $0</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium hover:text-violet-700">
            <Icon name="github" className="h-4 w-4" /> GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

function SectionTitle({ kicker, title, sub }) {
  return (
    <div className="text-center">
      <span className="chip">{kicker}</span>
      <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
      {sub && <p className="mx-auto mt-3 max-w-2xl text-slate-600">{sub}</p>}
    </div>
  );
}

function Mini({ label, value, tone = 'text-slate-900' }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}
