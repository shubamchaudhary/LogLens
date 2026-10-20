import { useEffect, useRef, useState } from 'react';

// The system on one diagram, plus the seven steps a log file takes through it.
// Picking a step lights up the boxes and arrows it uses (steps: utils/pipeline.js).

const W = 160;
const H = 64;
const NODES = {
  browser: { x: 20, y: 210, title: 'Browser', sub: 'React' },
  blob: { x: 220, y: 40, title: 'Blob store', sub: 'bytes only' },
  api: { x: 220, y: 210, title: 'Spring Boot', sub: 'REST + SSE' },
  kafka: { x: 420, y: 210, title: 'Kafka', sub: 'pointers only' },
  python: { x: 420, y: 380, title: 'LangGraph', sub: 'Python graphs' },
  workers: { x: 620, y: 210, title: 'Workers', sub: 'split · parse · gate' },
  llm: { x: 820, y: 40, title: 'LLMs', sub: 'Groq · Gemini' },
  pg: { x: 820, y: 210, title: 'Postgres', sub: '+ pgvector' },
};

// [id, svg path, label, label x, label y]
const EDGES = [
  ['browser-blob', 'M180 226 L220 104', 'presigned PUT', 112, 160],
  ['browser-api', 'M180 250 L220 250', '', 0, 0],
  ['api-kafka', 'M380 242 L420 242', '', 0, 0],
  ['kafka-workers', 'M580 242 L620 242', '', 0, 0],
  ['workers-blob', 'M700 210 L700 72 L380 72', 'ranged GET', 540, 64],
  ['workers-llm', 'M780 222 L820 96', 'flagged only', 852, 160],
  ['workers-pg', 'M780 254 L820 254', '', 0, 0],
  ['api-python', 'M300 274 L300 412 L420 412', 'analyze · ask', 362, 402],
  ['python-pg', 'M580 412 L900 412 L900 274', 'hybrid SQL', 740, 402],
];

export function ArchitectureDiagram({ step }) {
  const nodes = new Set(step?.nodes || []);
  const edges = new Set(step?.edges || []);
  const lit = (set, id) => !step || set.has(id);
  return (
    <svg viewBox="0 0 1000 470" className="h-auto w-full" role="img" aria-label="LogLens architecture">
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-dim" />
        </marker>
        <marker id="arch-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-accent" />
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
              className={on ? 'arch-flow stroke-accent' : 'stroke-line2'}
              markerEnd={`url(#${on ? 'arch-arrow-on' : 'arch-arrow'})`}
            />
            {label && (
              <text x={lx} y={ly} textAnchor="middle" className={`text-[15px] font-medium ${on ? 'fill-accent' : 'fill-muted'}`}>
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
              className={on ? 'fill-accent-soft stroke-accent' : 'fill-surface stroke-line2'}
            />
            <text x={nd.x + W / 2} y={nd.y + 30} textAnchor="middle" className="fill-ink text-[20px] font-semibold">
              {nd.title}
            </text>
            <text x={nd.x + W / 2} y={nd.y + 51} textAnchor="middle" className="fill-muted text-[14px]">
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
                  on ? 'border-accent/40 bg-accent-soft text-ink shadow-sm' : 'border-line bg-surface text-body hover:border-accent/40'
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${
                    on ? 'bg-accent text-on-accent' : 'bg-sand text-muted'
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
      <div key={s.key} className="mt-3 animate-fade-up rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h4 className="font-semibold text-ink">
            {active + 1}. {s.title}
          </h4>
          <span className="font-mono text-xs text-accent">{s.metric}</span>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-body">{s.body}</p>
      </div>
    </div>
  );
}

/** Each step as a full-width diagram with its explanation underneath, one after another. */
export function ArchitectureSteps({ steps }) {
  return (
    <ol className="space-y-16 sm:space-y-20">
      {steps.map((s, i) => (
        <li key={s.key}>
          <figure>
            <div className="panel p-3 sm:p-6">
              <ArchitectureDiagram step={s} />
            </div>
            <figcaption className="mx-auto mt-6 grid max-w-4xl gap-x-8 gap-y-3 sm:grid-cols-[auto_1fr]">
              <span className="font-display text-4xl font-extrabold leading-none text-gradient sm:text-5xl">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3 className="font-display text-2xl font-extrabold tracking-tight text-ink">{s.title}</h3>
                <p className="mt-2 text-[17px] leading-relaxed text-body">{s.body}</p>
                <p className="mt-3 inline-block rounded-md bg-sand px-2.5 py-1 font-mono text-xs font-medium text-accent">{s.metric}</p>
              </div>
            </figcaption>
          </figure>
        </li>
      ))}
    </ol>
  );
}

/**
 * Wide screens: one big diagram pinned on the left while the steps scroll past on the
 * right. The step in the middle of the screen lights up its part of the diagram.
 */
export function ArchitectureStory({ steps }) {
  const [active, setActive] = useState(0);
  const items = useRef([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(Number(e.target.dataset.step))),
      { rootMargin: '-50% 0px -50% 0px' }
    );
    items.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [steps.length]);

  const jump = (i) => items.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_15rem] gap-10 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="sticky top-16 flex h-[calc(100vh-4rem)] flex-col justify-center">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="font-mono text-xs text-muted">
            <span className="font-semibold text-accent">{String(active + 1).padStart(2, '0')}</span> / {String(steps.length).padStart(2, '0')}
          </span>
          <span className="font-display text-sm font-bold text-ink">{steps[active].title}</span>
        </div>
        <div className="panel p-4 xl:p-6">
          <ArchitectureDiagram step={steps[active]} />
        </div>
        <div className="mt-4 flex gap-1.5">
          {steps.map((s, i) => (
            <button
              key={s.key}
              onClick={() => jump(i)}
              aria-label={`Step ${i + 1}: ${s.title}`}
              className={`h-1.5 flex-1 rounded-full transition-colors ${i <= active ? 'bg-accent' : 'bg-line hover:bg-line2'}`}
            />
          ))}
        </div>
      </div>

      <ol className="py-[18vh]">
        {steps.map((s, i) => {
          const on = active === i;
          return (
            <li
              key={s.key}
              ref={(el) => (items.current[i] = el)}
              data-step={i}
              className={`flex min-h-[50vh] flex-col justify-center border-l-2 pl-5 transition-all duration-500 ${
                on ? 'border-accent opacity-100' : 'border-line opacity-35'
              }`}
            >
              <span className="font-mono text-[11px] font-semibold text-accent">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="mt-1 font-display text-base font-extrabold tracking-tight text-ink">{s.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-body">{s.body}</p>
              <span className="mt-2.5 self-start font-mono text-[11px] text-accent">{s.metric}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
