// Analysis lifecycle status helpers + presentation styles (shared, non-component
// module so components stay fast-refresh friendly).

export const STATUS_STYLES = {
  CREATED: { label: 'Not analysed', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  CHUNKING: { label: 'Chunking', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  PARSING: { label: 'Parsing', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  ENRICHING: { label: 'Enriching', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  CORRELATING: { label: 'Correlating', cls: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
  REPORTING: { label: 'Reporting', cls: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
  DONE: { label: 'Done', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  FAILED: { label: 'Failed', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const IN_PROGRESS = new Set(['CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING']);

export function isTerminal(status) {
  return status === 'DONE' || status === 'FAILED';
}

export function isProcessing(status) {
  return IN_PROGRESS.has(status);
}
