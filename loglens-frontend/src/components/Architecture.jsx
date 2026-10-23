import { useEffect, useRef, useState } from 'react';

// The system on one diagram, plus the seven steps a log file takes through it.
// Picking a step lights up the boxes and arrows it uses (steps: utils/pipeline.js).

// Application server: the API and the workers run in the same app.
const GROUP = { x: 270, y: 140, w: 520, h: 180, title: 'Application server' };
const NODES = {
  client: { x: 30, y: 200, w: 150, title: 'Client', sub: '' },
  blob: { x: 30, y: 30, w: 150, title: 'Blob Store', sub: 'holds the log file' },
  api: { x: 315, y: 190, w: 180, title: 'API', sub: 'handles requests' },
  workers: { x: 575, y: 190, w: 180, title: 'Workers', sub: 'split · parse · detect' },
  kafka: { x: 445, y: 400, w: 170, title: 'Kafka', sub: 'job queue' },
  langgraph: { x: 700, y: 400, w: 150, title: 'LangGraph', sub: 'root cause + Q&A' },
  llm: { x: 890, y: 30, w: 150, title: 'LLM', sub: 'Groq · Gemini' },
  pg: { x: 890, y: 200, w: 150, title: 'Postgres', sub: 'data + vectors' },
  redis: { x: 890, y: 400, w: 150, title: 'Redis', sub: 'chat history' },
};
const H = 80;

// [id, svg path, label, label x, label y, label anchor]
const EDGES = [
  ['client-blob', 'M105 200 L105 110', 'upload', 117, 160, 'start'],
  ['client-api', 'M180 240 L315 240', '', 0, 0],
  ['api-kafka', 'M390 290 L390 440 L445 440', 'queue the job', 398, 372, 'start'],
  ['kafka-workers', 'M615 440 L665 440 L665 290', 'hand out pieces', 675, 372, 'start'],
  ['workers-blob', 'M665 190 L665 70 L180 70', 'read file slices', 420, 60, 'middle'],
  ['workers-llm', 'M755 205 L830 205 L830 70 L890 70', 'flagged minutes', 822, 125, 'end'],
  ['workers-pg', 'M755 255 L890 255', 'save results', 800, 247, 'middle'],
  ['api-langgraph', 'M335 290 L335 510 L775 510 L775 480', 'analyze · ask', 555, 503, 'middle'],
  ['langgraph-pg', 'M850 420 L870 420 L870 300 L965 300 L965 280', 'hybrid SQL', 880, 360, 'start'],
  ['langgraph-redis', 'M850 440 L890 440', '', 0, 0],
];

export function ArchitectureDiagram({ step }) {
  const nodes = new Set(step?.nodes || []);
  const edges = new Set(step?.edges || []);
  const lit = (set, id) => !step || set.has(id);
  const groupOn = step && (nodes.has('api') || nodes.has('workers'));
  return (
    <svg viewBox="0 0 1060 540" className="h-auto max-h-[calc(100vh-11rem)] w-full" role="img" aria-label="LogLens architecture">
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-dim" />
        </marker>
        <marker id="arch-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="fill-accent" />
        </marker>
      </defs>
      <g className="transition-opacity duration-300" opacity={!step || groupOn ? 1 : 0.5}>
        <rect
          x={GROUP.x}
          y={GROUP.y}
          width={GROUP.w}
          height={GROUP.h}
          rx="18"
          strokeDasharray="6 5"
          strokeWidth="1.5"
          className={groupOn ? 'fill-none stroke-accent' : 'fill-none stroke-line2'}
        />
        <text x={GROUP.x + GROUP.w / 2} y={GROUP.y + 28} textAnchor="middle" className={`text-[15px] font-semibold ${groupOn ? 'fill-accent' : 'fill-muted'}`}>
          {GROUP.title}
        </text>
      </g>
      {EDGES.map(([id, d, label, lx, ly, anchor]) => {
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
              <text x={lx} y={ly} textAnchor={anchor} className={`text-[15px] font-medium ${on ? 'fill-accent' : 'fill-muted'}`}>
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
              width={nd.w}
              height={H}
              rx="14"
              strokeWidth={on ? 2 : 1}
              className={on ? 'fill-accent-soft stroke-accent' : 'fill-surface stroke-line2'}
            />
            <text x={nd.x + nd.w / 2} y={nd.y + (nd.sub ? 34 : 47)} textAnchor="middle" className="fill-ink text-[21px] font-semibold">
              {nd.title}
            </text>
            {nd.sub && (
              <text x={nd.x + nd.w / 2} y={nd.y + 58} textAnchor="middle" className="fill-muted text-[14px]">
                {nd.sub}
              </text>
            )}
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
    <div className="grid grid-cols-[minmax(0,1fr)_16rem] gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="sticky top-16 flex h-[calc(100vh-4rem)] flex-col justify-center">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="font-mono text-xs text-muted">
            <span className="font-semibold text-accent">{String(active + 1).padStart(2, '0')}</span> / {String(steps.length).padStart(2, '0')}
          </span>
          <span className="font-display text-sm font-bold text-ink">{steps[active].title}</span>
        </div>
        <div className="panel p-3 xl:p-4">
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
