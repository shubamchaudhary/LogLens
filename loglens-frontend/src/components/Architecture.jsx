// The system on one diagram, plus the seven steps a log file takes through it.
// Picking a step lights up the boxes and arrows it uses (steps: utils/pipeline.js).

const W = 160;
const H = 64;
const NODES = {
  browser: { x: 20, y: 170, title: 'Browser', sub: 'React on Vercel' },
  blob: { x: 220, y: 40, title: 'Blob store', sub: 'S3 API · bytes only' },
  api: { x: 220, y: 170, title: 'Spring Boot API', sub: 'REST + SSE progress' },
  kafka: { x: 420, y: 170, title: 'Kafka', sub: '6 topics · pointers only' },
  python: { x: 420, y: 300, title: 'Python · LangGraph', sub: 'report + Q&A graphs' },
  workers: { x: 620, y: 170, title: 'Workers', sub: 'split · parse · gate' },
  llm: { x: 820, y: 40, title: 'LLM providers', sub: 'Groq chat · Gemini embed' },
  pg: { x: 820, y: 170, title: 'Postgres + pgvector', sub: 'the single truth' },
};

// [id, svg path, label, label x, label y]
const EDGES = [
  ['browser-blob', 'M180 186 L220 90', 'presigned PUT', 120, 128],
  ['browser-api', 'M180 210 L220 210', '', 0, 0],
  ['api-kafka', 'M380 202 L420 202', '', 0, 0],
  ['kafka-workers', 'M580 202 L620 202', '', 0, 0],
  ['workers-blob', 'M700 170 L700 72 L380 72', 'ranged GET', 540, 64],
  ['workers-llm', 'M780 182 L820 96', 'flagged only', 742, 134],
  ['workers-pg', 'M780 214 L820 214', '', 0, 0],
  ['api-python', 'M300 234 L300 332 L420 332', 'analyze · ask', 362, 324],
  ['python-pg', 'M580 332 L900 332 L900 234', 'hybrid SQL', 740, 324],
];

export function ArchitectureDiagram({ step }) {
  const nodes = new Set(step?.nodes || []);
  const edges = new Set(step?.edges || []);
  const lit = (set, id) => !step || set.has(id);
  return (
    <svg viewBox="0 0 1000 380" className="h-auto w-full" role="img" aria-label="LogLens architecture">
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-slate-400" />
        </marker>
        <marker id="arch-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-violet-600" />
        </marker>
      </defs>
      {EDGES.map(([id, d, label, lx, ly]) => {
        const on = step && edges.has(id);
        return (
          <g key={id} className="transition-opacity duration-300" opacity={lit(edges, id) ? 1 : 0.4}>
            <path
              d={d}
              fill="none"
              strokeWidth={on ? 2.5 : 1.5}
              className={on ? 'arch-flow stroke-violet-600' : 'stroke-slate-400'}
              markerEnd={`url(#${on ? 'arch-arrow-on' : 'arch-arrow'})`}
            />
            {label && (
              <text x={lx} y={ly} textAnchor="middle" className={`text-[12.5px] font-medium ${on ? 'fill-violet-700' : 'fill-slate-500'}`}>
                {label}
              </text>
            )}
          </g>
        );
      })}
      {Object.entries(NODES).map(([id, nd]) => {
        const on = step && nodes.has(id);
        return (
          <g key={id} className="transition-opacity duration-300" opacity={lit(nodes, id) ? 1 : 0.5}>
            <rect
              x={nd.x}
              y={nd.y}
              width={W}
              height={H}
              rx="14"
              strokeWidth={on ? 2 : 1}
              className={on ? 'fill-violet-50 stroke-violet-500' : 'fill-white stroke-slate-300'}
            />
            <text x={nd.x + W / 2} y={nd.y + 28} textAnchor="middle" className="fill-slate-900 text-[15px] font-semibold">
              {nd.title}
            </text>
            <text x={nd.x + W / 2} y={nd.y + 47} textAnchor="middle" className="fill-slate-500 text-[12px]">
              {nd.sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The steps as a rail of buttons with the picked step explained underneath. */
export function StepRail({ steps, active, onSelect }) {
  const s = steps[active];
  return (
    <div>
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {steps.map((st, i) => {
          const on = active === i;
          return (
            <li key={st.key}>
              <button
                onClick={() => onSelect(i)}
                className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition ${
                  on ? 'border-violet-300 bg-violet-50 text-slate-900 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-violet-200'
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${
                    on ? 'bg-gradient-to-br from-violet-600 to-pink-500 text-white' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {i + 1}
                </span>
                {st.title}
              </button>
            </li>
          );
        })}
      </ol>
      <div key={s.key} className="mt-3 animate-fade-up rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h4 className="font-semibold text-slate-900">
            {active + 1}. {s.title}
          </h4>
          <span className="font-mono text-xs text-violet-700">{s.metric}</span>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{s.body}</p>
      </div>
    </div>
  );
}
