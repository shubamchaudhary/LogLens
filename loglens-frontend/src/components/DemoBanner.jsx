import { useEffect, useState } from 'react';
import { loadFixture } from '../demo/demoApi';
import { REPO_URL } from '../config';
import Icon from './Icon';

/** Tells demo visitors what they're looking at, and what in it is real. */
export default function DemoBanner() {
  const [open, setOpen] = useState(false);
  const [prov, setProv] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadFixture().then((f) => !cancelled && setProv(f.provenance));
    return () => {
      cancelled = true;
    };
  }, []);

  const recorded = prov?.kind === 'recorded';

  return (
    <div className="border-b border-violet-200 bg-gradient-to-r from-violet-50 via-fuchsia-50 to-pink-50 text-xs text-violet-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6">
        <span className="flex items-center gap-1.5 font-semibold">
          <Icon name="play" className="h-3 w-3" /> Demo replay
        </span>
        <span className="text-violet-800/80">
          Runs in your browser. The live backend (Kafka, Postgres, LLM keys) is paused to keep hosting free.
        </span>
        <span className="ml-auto flex items-center gap-3">
          <button onClick={() => setOpen((v) => !v)} className="font-semibold underline-offset-2 hover:underline">
            {open ? 'Hide details' : "What's real here?"}
          </button>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-semibold hover:underline">
            <Icon name="github" className="h-3.5 w-3.5" /> Source
          </a>
        </span>
      </div>
      {open && (
        <ul className="grid gap-2 border-t border-violet-200/70 px-4 py-3 sm:grid-cols-3 sm:px-6">
          <Item ok title="Numbers are real">
            Metrics, anomaly flags and LLM-call counts are the output of the production Java parsers and anomaly rules,
            run on this exact file.
          </Item>
          <Item ok title="Log lines are real">
            Every evidence chunk and citation shows the actual lines from the sample file.
          </Item>
          <Item ok={recorded} title={recorded ? 'AI text is recorded' : 'AI text is a sample'}>
            {recorded
              ? `${prov.narratives}.`
              : 'Findings, incidents, report and answers are written in the pipeline’s output format; every number in them is computed from the file.'}{' '}
            Pipeline timing is staged (~20 s).
          </Item>
        </ul>
      )}
    </div>
  );
}

function Item({ ok, title, children }) {
  return (
    <li className="flex gap-2">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
          ok ? 'bg-emerald-500 text-white' : 'bg-amber-400 text-white'
        }`}
      >
        <Icon name={ok ? 'check' : 'info'} className="h-3 w-3" strokeWidth={3} />
      </span>
      <span>
        <span className="font-semibold">{title}.</span> <span className="text-violet-900/80">{children}</span>
      </span>
    </li>
  );
}
