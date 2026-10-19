// The seven steps a log file takes through LogLens, with this session's numbers
// where it has them. Each step names the diagram boxes and arrows it uses.

import { fmtNum } from './format';

export function pipelineSteps(stats) {
  const n = (v, fallback) => (v != null ? fmtNum(v) : fallback);
  return [
    {
      key: 'upload',
      title: 'Upload',
      body: 'The browser PUTs the file straight to blob storage with a presigned URL. The API only confirms the object exists, so GB of bytes never pass through the JVM.',
      metric: stats ? `${(stats.bytes / 2 ** 30).toFixed(1)} GB, 0 bytes through the API` : 'GB files, 0 bytes through the API',
      nodes: ['browser', 'blob', 'api'],
      edges: ['browser-blob', 'browser-api'],
    },
    {
      key: 'split',
      title: 'Split',
      body: 'A splitter reads the file once and cuts byte ranges on minute boundaries. Kafka carries only small pointers to those ranges, never the log itself.',
      metric: stats ? `${n(stats.parts)} parts of ~5 MB` : '~5 MB parts',
      nodes: ['api', 'kafka', 'workers', 'blob'],
      edges: ['api-kafka', 'kafka-workers', 'workers-blob'],
    },
    {
      key: 'parse',
      title: 'Parse',
      body: 'Part workers read their range in parallel. Eight regex parsers turn every 60-second window into exact counts. Each part is one DB transaction with a marker row, so a redelivered message changes nothing.',
      metric: stats ? `${n(stats.chunks)} windows, ${n(stats.metricRows)} metric rows` : 'exact counts, no LLM',
      nodes: ['workers', 'blob', 'pg', 'kafka'],
      edges: ['kafka-workers', 'workers-blob', 'workers-pg'],
    },
    {
      key: 'gate',
      title: 'Gate',
      body: 'Once all parts are in, each window is compared with its own session: median and MAD per metric, rare error templates, and hard rules (OOM, deadlock, pool exhausted).',
      metric: stats ? `${stats.flaggedMinutes} of ${stats.minutes} minutes flagged` : 'few minutes flagged',
      nodes: ['workers', 'pg'],
      edges: ['workers-pg'],
    },
    {
      key: 'explain',
      title: 'Explain',
      body: 'Only flagged windows go to the LLM. One Kafka partition per API key means each key has one worker that paces itself, with no shared lock; a 429 moves the item to a retry topic.',
      metric: stats ? `${n(stats.llmCallsGated)} LLM calls, not ${n(stats.llmCallsUngated)}` : 'only abnormal minutes',
      nodes: ['workers', 'llm', 'kafka'],
      edges: ['kafka-workers', 'workers-llm'],
    },
    {
      key: 'correlate',
      title: 'Correlate',
      body: 'A LangGraph pipeline groups findings into incidents, and a judge rejects any story its cited lines do not support (at most three attempts).',
      metric: stats?.incidents != null ? `${stats.incidents} incidents` : 'judged incidents',
      nodes: ['api', 'python', 'pg'],
      edges: ['api-python', 'python-pg'],
    },
    {
      key: 'ask',
      title: 'Ask',
      body: 'Questions run hybrid search (pgvector + full text, fused with RRF) in a corrective loop. Code drops any citation that was not in the retrieved context.',
      metric: 'answers cite exact log lines',
      nodes: ['browser', 'api', 'python', 'pg'],
      edges: ['browser-api', 'api-python', 'python-pg'],
    },
  ];
}
