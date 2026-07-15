import { useState } from 'react';
import { fmtTime, fmtNum } from '../../utils/format';

export default function MetricsTab({ metrics }) {
  const [category, setCategory] = useState('');

  if (!metrics || metrics.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
        <p className="text-sm font-medium text-gray-700">No metrics</p>
        <p className="mt-1 text-sm text-gray-400">
          The deterministic parsers didn't roll up any metric buckets for this session.
        </p>
      </div>
    );
  }

  const categories = [...new Set(metrics.map((m) => m.category).filter(Boolean))].sort();
  const rows = category ? metrics.filter((m) => m.category === category) : metrics;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800">Metric buckets ({metrics.length})</h3>
        {categories.length > 1 && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="text-xs border border-gray-200 rounded-md px-2 py-1 text-gray-600"
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
      <div className="overflow-x-auto max-h-[60vh]">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide sticky top-0">
            <tr>
              <th className="text-left font-medium px-4 py-2">Time bucket</th>
              <th className="text-left font-medium px-4 py-2">Category</th>
              <th className="text-left font-medium px-4 py-2">Metric</th>
              <th className="text-right font-medium px-4 py-2">Count</th>
              <th className="text-right font-medium px-4 py-2">Avg ms</th>
              <th className="text-right font-medium px-4 py-2">p95 ms</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((m, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmtTime(m.timeBucket)}</td>
                <td className="px-4 py-2 text-gray-700">{m.category || '—'}</td>
                <td className="px-4 py-2 text-gray-700 font-medium">{m.metric}</td>
                <td className="px-4 py-2 text-right text-gray-700">{fmtNum(m.count)}</td>
                <td className="px-4 py-2 text-right text-gray-500">{fmtNum(m.avgMs)}</td>
                <td className="px-4 py-2 text-right text-gray-500">{fmtNum(m.p95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
