import { useEffect } from 'react';
import bench from '../demo/bench.json';
import BarChart from '../components/BarChart';
import HeapChart, { LiveSetBars } from '../components/HeapChart';
import GateExplainer from '../components/GateExplainer';
import { Heading, Section, SiteHeader } from '../components/Site';
import Icon from '../components/Icon';
import { fmtBytes, fmtNum } from '../utils/format';

// The repo's bench/BENCHMARKS.md and eval reports as charts and tables. All values
// come from src/demo/bench.json, generated from bench/results and evals/results.

const NAV = [
  ['#ingest', 'Ingest'],
  ['#faults', 'Faults'],
  ['#quality', 'Quality'],
  ['#vectors', 'Vectors'],
];

// What was broken on purpose, and how the system carried on (counts from bench.json).
const FAULT = {
  crash_after_part_commit: {
    title: 'Killed while reading the file',
    text: (r) =>
      `The process was killed (kill -9) three times, each time right after it saved a piece. On restart it carried on from the next unsaved piece: the ${fmtNum(r.skips)} pieces already saved were recognised and skipped.`,
  },
  crash_after_enrich_commit: {
    title: 'Killed while the AI was explaining',
    text: () =>
      'Killed three times right after an AI explanation was saved. On restart it continued with the minutes still waiting; nothing was explained or counted twice.',
  },
  replay_ingest: {
    title: 'Whole ingest history replayed',
    text: (r) => `Kafka was rewound to its very first message. All ${fmtNum(r.skips)} already-processed pieces were recognised, so the results stayed the same.`,
  },
  replay_enrich: {
    title: 'Whole AI queue replayed',
    text: (r) => `The AI queue was rewound to the start and drained. ${fmtNum(r.skips)} finished explanations were recognised and not sent to the model again.`,
  },
  rebalance: {
    title: 'One of two servers stopped mid-run',
    text: () => 'Its share of the work moved to the other server, which continued from where the first one stopped.',
  },
};


const CASE = {
  'malformed_lines.log': 'Malformed lines',
  'non_utf8.log': 'Invalid UTF-8',
  'nul_bytes.log': 'NUL bytes',
  'empty.log': 'Empty file',
  'archive.log.gz': 'gzip archive',
  'huge_single_line.log': 'One 100 MB line',
  'busy_minute.log': '120,000 lines in one minute',
  poison_message: 'A message that is not JSON',
};

const LAYOUT = {
  shared_hnsw: 'Shared table, planner’s choice',
  shared_hnsw_forced: 'Shared HNSW, then filter',
  shared_iterative: 'Shared, iterative scan',
  shared_btree_exact: 'Shared, exact search',
  partial_hnsw: 'Partial index per session',
  partitioned: 'Partition per session',
  per_session_table: 'Own table per session',
};

const LAYOUT_SHORT = {
  shared_hnsw: 'Shared',
  shared_hnsw_forced: 'Shared + filter',
  shared_iterative: 'Iterative',
  shared_btree_exact: 'Exact',
  partial_hnsw: 'Partial index',
  partitioned: 'Partition',
  per_session_table: 'Own table',
};

const RETRIEVER = { vector_only: 'Vector', fts_only: 'Full text', hybrid_rrf: 'Hybrid (RRF)' };

export default function Benchmarks() {
  useEffect(() => {
    document.title = 'Benchmarks · DeepLogLens';
    return () => {
      document.title = 'DeepLogLens · Log intelligence';
    };
  }, []);

  const base = bench.chaos.rows.find((r) => r.scenario === 'baseline');
  const matches = (r) => r.chunks === base.chunks && r.lineSum === base.lineSum && r.metricSum === base.metricSum && r.occurrences === base.occurrences;
  const layouts = Object.keys(LAYOUT);
  const sessions = [...new Set(bench.vector.rows.map((r) => r.session))];
  const cell = (session, layout) => bench.vector.rows.find((r) => r.session === session && r.layout === layout);
  const small = sessions.at(-1);
  const g = bench.gate;
  const medium = g.synthetic.find((d) => d.dataset.includes('medium'));
  const incidents = g.synthetic.reduce((n, d) => n + d.incidents, 0);
  const found = g.synthetic.reduce((n, d) => n + Math.round(d.incidentRecall * d.incidents), 0);
  const held = g.heldout.map((d) => d.f1);
  const minCut = Math.min(...g.volume.map((v) => v.callReduction));
  const hybrid = bench.retrieval.rows.find((r) => r.retriever.startsWith('hybrid'));
  const own = bench.vector.rows.filter((r) => r.layout === 'per_session_table');

  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <SiteHeader links={NAV} back />

      <section className="mx-auto max-w-6xl px-4 pb-14 pt-16 sm:px-6 sm:pt-20">
        <p className="kicker">Benchmarks</p>
        <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">Measured numbers</h1>
        <div className="mt-6 flex flex-wrap gap-2">
          {[bench.setup.hardware, bench.setup.jvm, bench.setup.stack, `run ${bench.date}`].map((t) => (
            <span key={t} className="rounded-md border border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-body">
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* Ingest */}
      <Section id="ingest">
        <Heading kicker="01 · Ingest" title="Throughput at 100 MB to 2 GB" />
        <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_1.6fr]">
          <Panel title="MB/s by file size" sub={`-Xmx${bench.sizes[0].xmxMb}m · ${bench.sizes[0].threads} part threads`}>
            <BarChart data={bench.sizes.map((s) => ({ label: s.size, v: s.mbPerS }))} series={[{ key: 'v', name: 'MB/s' }]} max={3} format={(v) => v.toFixed(2)} />
          </Panel>
          <Table
            head={['File', 'Lines', 'Time', 'MB/s', 'Live set', 'Peak heap', 'RSS']}
            rows={bench.sizes.map((s) => [s.size, fmtNum(s.lines), `${Math.round(s.ingestS)} s`, s.mbPerS.toFixed(2), `${s.live.max} MB`, `${Math.round(s.peakHeapMb)} MB`, `${s.peakRssMb} MB`])}
            strong={4}
          />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div className="panel p-5 sm:p-6">
            <HeapChart bench={bench} />
          </div>
          <div className="panel p-5 sm:p-6">
            <LiveSetBars bench={bench} />
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.6fr]">
          <Panel title="MB/s by part threads" sub="same 1 GB file · 4 vCPUs · flat after 4">
            <BarChart data={bench.threads.map((t) => ({ label: `${t.threads}`, v: t.mbPerS }))} series={[{ key: 'v', name: 'MB/s' }]} max={3} format={(v) => v.toFixed(2)} />
          </Panel>
          <Table
            head={['Threads', 'Time', 'MB/s', 'Speed-up', 'Live set', 'Peak heap', 'RSS']}
            rows={bench.threads.map((t) => [t.threads, `${Math.round(t.ingestS)} s`, t.mbPerS.toFixed(2), `${t.speedup.toFixed(2)}×`, `${t.live.max} MB`, `${Math.round(t.peakHeapMb)} MB`, `${t.peakRssMb} MB`])}
            strong={3}
          />
        </div>
      </Section>

      {/* Faults */}
      <Section id="faults">
        <Heading kicker="02 · Faults" title="It resumes after a crash, it does not start over" />
        <p className="mt-4 max-w-3xl text-base leading-relaxed text-body">
          The same {fmtBytes(bench.chaos.bytes)} log was ingested once cleanly, then again while we broke things on purpose.
          Every run below ended with the same result as the clean one:{' '}
          <b className="text-ink">
            {fmtNum(base.chunks)} windows, {fmtNum(base.lineSum)} lines, {fmtNum(base.occurrences)} findings
          </b>
          .
        </p>
        <ul className="mt-10 grid gap-x-12 gap-y-9 md:grid-cols-2">
          {bench.chaos.rows
            .filter((r) => r.scenario !== 'baseline')
            .map((r) => (
              <li key={r.scenario} className="flex gap-4">
                <span className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${matches(r) ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                <div>
                  <h3 className="font-semibold text-ink">{FAULT[r.scenario]?.title || r.scenario}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-body">{FAULT[r.scenario]?.text(r)}</p>
                </div>
              </li>
            ))}
        </ul>

        <h3 className="mt-16 font-display text-xl font-extrabold text-ink">Unusual input</h3>
        <ul className="mt-6 grid gap-x-12 gap-y-4 sm:grid-cols-2">
          {bench.robustness.map((r) => (
            <li key={r.case} className="flex items-baseline gap-3 border-b border-line pb-3">
              <Icon name="check" className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-emerald-500" />
              <span className="font-medium text-ink">{CASE[r.case] || r.case}</span>
              <span className="ml-auto text-right text-sm text-muted">
                {outcome(r)}
                {r.seconds != null && <span className="font-mono text-xs"> · {r.seconds} s</span>}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {/* Quality */}
      <Section id="quality">
        <Heading kicker="03 · Quality" title="Anomaly detection and Q&A retrieval" lead="On labelled logs where every incident line is known." />
        <BigNumbers
          items={[
            [medium.f1.toFixed(2), 'F1 score, incident detection'],
            [`${found} / ${incidents}`, 'injected incidents found'],
            [`${Math.min(...held).toFixed(2)}–${Math.max(...held).toFixed(2)}`, 'F1 on unseen logs'],
            [`≥ ${Math.floor(minCut * 100)}%`, 'fewer LLM calls at every traffic level'],
            [hybrid.r30.toFixed(2), `Q&A recall@30, ${bench.retrieval.questions} questions`],
            [`${Math.round(hybrid.p95)} ms`, 'p95 search latency'],
          ]}
        />
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <Panel title="F1 per dataset" sub="labelled corpora, then held-out seeds the rules never saw">
            <BarChart
              data={[...g.synthetic.map((d) => ({ label: d.dataset.replace('eval_', '').replace('noise', ' noise'), v: d.f1 })), ...g.heldout.map((d) => ({ label: `seed ${d.dataset.match(/\d+/)[0]}`, v: d.f1 }))]}
              series={[{ key: 'v', name: 'F1' }]}
              max={1}
              format={(v) => v.toFixed(2)}
            />
          </Panel>
          <Panel title="LLM calls saved by traffic level" sub="same generator, only lines per second changes">
            <BarChart data={g.volume.map((v) => ({ label: `${v.linesPerS}/s`, v: v.callReduction * 100 }))} series={[{ key: 'v', name: 'saved', cls: 'bg-hot' }]} max={100} format={(v) => `${Math.round(v)}%`} />
          </Panel>
        </div>
        <div className="mt-4">
          <Table
            head={['Dataset', 'Lines', 'Precision', 'Recall', 'F1', 'False alarms / h', 'Incidents found', 'Calls saved']}
            rows={g.synthetic.map((d) => [
              d.dataset.replace('eval_', ''),
              fmtNum(d.lines),
              d.precision.toFixed(2),
              d.recall.toFixed(2),
              d.f1.toFixed(3),
              d.falseAlarmsPerHour,
              `${Math.round(d.incidentRecall * d.incidents)} / ${d.incidents}`,
              `${Math.round(d.callReduction * 1000) / 10}%`,
            ])}
            strong={4}
          />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.25fr]">
          <Panel title="The count-spike rule" sub="median + MAD, on ten minutes you can edit">
            <GateExplainer />
          </Panel>
          <div className="space-y-4">
            <Panel title={`Retrieval recall on ${bench.retrieval.questions} golden questions`} sub="top 5 / 10 / 30 chunks · the grader reads 30">
              <BarChart
                data={bench.retrieval.rows.map((r) => ({ label: RETRIEVER[r.retriever] || r.retriever, r5: r.r5, r10: r.r10, r30: r.r30 }))}
                series={[
                  { key: 'r5', name: 'recall@5' },
                  { key: 'r10', name: 'recall@10' },
                  { key: 'r30', name: 'recall@30' },
                ]}
                max={1}
                format={(v) => v.toFixed(2)}
                highlight={2}
                height={140}
              />
            </Panel>
            <Table
              head={['Retriever', 'R@5', 'R@10', 'R@30', 'MRR', 'p50', 'p95']}
              rows={bench.retrieval.rows.map((r) => [RETRIEVER[r.retriever] || r.retriever, r.r5.toFixed(2), r.r10.toFixed(2), r.r30.toFixed(2), r.mrr.toFixed(2), `${Math.round(r.p50)} ms`, `${Math.round(r.p95)} ms`])}
              strong={3}
            />
          </div>
        </div>
      </Section>

      {/* Vectors */}
      <Section id="vectors">
        <Heading kicker="04 · Vectors" title="One table per session keeps small tenants at 100% recall" lead={`${fmtNum(bench.vector.vectors)} vectors across three tenants; the smallest holds 0.83% of the rows.`} />
        <BigNumbers
          items={[
            [Math.min(...own.map((r) => r.recall)).toFixed(2), 'recall@10 for every tenant'],
            [`${Math.min(...own.map((r) => r.p50))} ms`, 'median query, smallest tenant'],
            [`${Math.max(...own.map((r) => r.p50))} ms`, 'median query, largest tenant'],
          ]}
        />
        <div className="mt-8 grid gap-4 lg:grid-cols-[0.9fr_1.6fr]">
          <Panel title="Recall@10 for the small tenant" sub={`session ${small}, by table layout`}>
            <BarChart
              data={layouts.map((l) => ({ label: LAYOUT_SHORT[l], v: cell(small, l)?.recall ?? 0 }))}
              series={[{ key: 'v', name: 'recall@10' }]}
              max={1}
              format={(v) => v.toFixed(2)}
              highlight={layouts.length - 1}
            />
          </Panel>
          <Table
            head={['Layout', ...sessions.map((s) => `${s} recall · p50`)]}
            rows={layouts.map((l) => [
              <span key="l" className={l === 'per_session_table' ? 'font-semibold text-accent' : 'text-ink'}>
                {LAYOUT[l]}
              </span>,
              ...sessions.map((s) => {
                const c = cell(s, l);
                return c ? `${c.recall.toFixed(2)} · ${c.p50} ms` : '–';
              }),
            ])}
          />
        </div>
      </Section>

    </div>
  );
}

/** Measured figures set as type: a big number over a short label, no boxes. */
function BigNumbers({ items }) {
  return (
    <div className="mt-10 grid grid-cols-2 gap-x-10 gap-y-8 border-y border-line py-8 md:grid-cols-3">
      {items.map(([v, k]) => (
        <div key={k}>
          <p className="font-display text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{v}</p>
          <p className="mt-1 text-sm text-muted">{k}</p>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, sub, children }) {
  return (
    <div className="panel p-5 sm:p-6">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {sub && <p className="mb-5 text-xs text-muted">{sub}</p>}
      {children}
    </div>
  );
}

function Table({ head, rows, strong }) {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-paper/60">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((c, j) => (
                <td key={j} className={`whitespace-nowrap px-4 py-2.5 font-mono text-[13px] ${j === strong ? 'font-semibold text-ink' : j === 0 ? 'font-sans text-ink' : 'text-body'}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function outcome(r) {
  if (r.status === 'FAILED') return 'Rejected with a clear message';
  if (r.status === 'DLQ') return 'Set aside; the next upload runs';
  return r.lines != null ? `Parsed, ${fmtNum(r.lines)} line${r.lines === 1 ? '' : 's'}` : 'Parsed';
}
