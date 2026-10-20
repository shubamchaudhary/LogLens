// Analysis lifecycle status helpers + presentation styles (shared, non-component
// module so components stay fast-refresh friendly).

export const STATUS_STYLES = {
  CREATED: { label: 'Not analysed', cls: 'bg-sand text-body border-line' },
  CHUNKING: { label: 'Chunking', cls: 'bg-sky-500/10 text-sky-600 border-sky-500/30' },
  PARSING: { label: 'Parsing', cls: 'bg-sky-500/10 text-sky-600 border-sky-500/30' },
  ENRICHING: { label: 'Enriching', cls: 'bg-accent-soft text-accent border-accent/30' },
  CORRELATING: { label: 'Correlating', cls: 'bg-accent-soft text-accent border-accent/30' },
  REPORTING: { label: 'Reporting', cls: 'bg-accent-soft text-accent border-accent/30' },
  DONE: { label: 'Done', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
  FAILED: { label: 'Failed', cls: 'bg-rose-500/10 text-rose-600 border-rose-500/30' },
};

const IN_PROGRESS = new Set(['CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING']);

export function isTerminal(status) {
  return status === 'DONE' || status === 'FAILED';
}

export function isProcessing(status) {
  return IN_PROGRESS.has(status);
}
