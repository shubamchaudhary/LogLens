import { useState } from 'react';
import { fmtClock, fmtNum } from '../../utils/format';

export default function MetricsTab({ metrics }) {
  const [category, setCategory] = useState('');

  if (!metrics || metrics.length === 0) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm font-medium text-slate-700">No metrics</p>
        <p className="mt-1 text-sm text-slate-400">
          The deterministic parsers didn't roll up any metric buckets for this session.
        </p>
      </div>
    );
  }

  const categories = [...new Set(metrics.map((m) => m.category).filter(Boolean))].sort();
  const rows = category ? metrics.filter((m) => m.category === category) : metrics;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Metric buckets ({fmtNum(rows.length)})</h3>
          <p className="text-xs text-slate-500">Exact counts from regex parsers, one row per minute × metric.</p>
        </div>
        {categories.length > 1 && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 focus:border-violet-400 focus:outline-none"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="max-h-[60vh] overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-semibold">Minute (UTC)</th>
              <th className="px-4 py-2 text-left font-semibold">Category</th>
              <th className="px-4 py-2 text-left font-semibold">Metric</th>
              <th className="px-4 py-2 text-right font-semibold">Count</th>
              <th className="px-4 py-2 text-right font-semibold">Avg ms</th>
              <th className="px-4 py-2 text-right font-semibold">p95 ms</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((m, i) => (
              <tr key={i} className="hover:bg-violet-50/40">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
                  {fmtClock(m.timeBucket).slice(0, 5)}
                </td>
                <td className="px-4 py-2">
                  <span className="chip font-mono text-[10px]">{m.category || '—'}</span>
                </td>
                <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-slate-700" title={m.metric}>
                  {m.metric}
                </td>
                <td className="px-4 py-2 text-right font-semibold text-slate-800">{fmtNum(m.count)}</td>
                <td className="px-4 py-2 text-right text-slate-500">{fmtNum(m.avgMs)}</td>
                <td className="px-4 py-2 text-right text-slate-500">{fmtNum(m.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
