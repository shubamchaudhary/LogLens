import { Link } from 'react-router-dom';
import bench from '../demo/bench.json';
import { Logo } from './Icon';

// Frame of the sign-in and sign-up pages: what the product does on the left (wide
// screens), the form on the right. Same paper style as the landing page.

export default function AuthShell({ title, subtitle, children }) {
  const big = bench.sizes.at(-1);
  const liveHi = Math.max(...bench.sizes.map((s) => s.live.max));
  const f1 = bench.gate.synthetic.find((d) => d.dataset.includes('medium')).f1;
  const faults = bench.chaos.rows.filter((r) => r.scenario !== 'baseline').length;
  const facts = [
    [big.size, `archive tested, live heap ≤ ${liveHi} MB`],
    [f1.toFixed(2), 'F1 on labelled incidents'],
    [`${faults} / ${faults}`, 'crash and replay runs with identical counts'],
  ];

  return (
    <div className="grid min-h-screen bg-paper lg:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line p-10 lg:flex">
        <Link to="/" aria-label="DeepLogLens home">
          <Logo />
        </Link>
        <div>
          <p className="kicker">Log intelligence · GB scale</p>
          <h2 className="mt-4 font-display text-4xl font-extrabold leading-tight tracking-tight text-slate-900">
            Deep-analyse millions of log lines, with the root cause of every failure.
          </h2>
          <ul className="mt-10 space-y-4">
            {facts.map(([v, k]) => (
              <li key={k} className="flex items-baseline gap-4">
                <span className="w-24 shrink-0 font-display text-2xl font-extrabold text-gradient">{v}</span>
                <span className="text-sm text-slate-600">{k}</span>
              </li>
            ))}
          </ul>
        </div>
        <Link to="/benchmarks" className="text-sm font-medium text-violet-700 hover:underline">
          How it was measured →
        </Link>
      </aside>

      <main className="flex items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-10 inline-block lg:hidden" aria-label="DeepLogLens home">
            <Logo />
          </Link>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-2 text-slate-600">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          <p className="mt-10 text-sm">
            <Link to="/" className="text-slate-500 hover:text-violet-700">
              ← Back to DeepLogLens
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
