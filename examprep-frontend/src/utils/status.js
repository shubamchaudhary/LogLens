// Analysis lifecycle status helpers + presentation styles (shared, non-component
// module so components stay fast-refresh friendly).

export const STATUS_STYLES = {
  CREATED: { label: 'Created', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
  CHUNKING: { label: 'Chunking', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  PARSING: { label: 'Parsing', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  ENRICHING: { label: 'Enriching', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  CORRELATING: { label: 'Correlating', cls: 'bg-purple-50 text-purple-700 border-purple-200' },
  REPORTING: { label: 'Reporting', cls: 'bg-purple-50 text-purple-700 border-purple-200' },
  DONE: { label: 'Done', cls: 'bg-green-50 text-green-700 border-green-200' },
  FAILED: { label: 'Failed', cls: 'bg-red-50 text-red-700 border-red-200' },
};

const IN_PROGRESS = new Set(['CHUNKING', 'PARSING', 'ENRICHING', 'CORRELATING', 'REPORTING']);

export function isTerminal(status) {
  return status === 'DONE' || status === 'FAILED';
}

export function isProcessing(status) {
  return IN_PROGRESS.has(status);
}
