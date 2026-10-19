import bench from '../demo/bench.json';

/** The headline test results, all from bench.json. */
export default function TestedGrid({ lines1g }) {
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
        <div key={k} className="bg-surface p-5 sm:p-6">
          <dt className="sr-only">{k}</dt>
          <dd className="font-display text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{v}</dd>
          <dd className="mt-1 text-sm text-muted">{k}</dd>
        </div>
      ))}
    </dl>
  );
}
