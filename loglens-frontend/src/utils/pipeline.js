// The seven steps a log file takes through LogLens, with this session's numbers
// where it has them. Each step names the diagram boxes and arrows it uses.

import { fmtNum } from './format';

export function pipelineSteps(stats) {
  const n = (v, fallback) => (v != null ? fmtNum(v) : fallback);
  return [
    {
      key: 'upload',
      title: 'Upload',
      body: 'Your browser sends the file straight to blob storage with a short-lived upload link. The API checks that the file arrived and starts the analysis.',
      metric: stats ? `${(stats.bytes / 2 ** 30).toFixed(1)} GB uploaded directly to storage` : 'uploaded directly to storage',
      nodes: ['browser', 'blob', 'api'],
      edges: ['browser-blob', 'browser-api'],
    },
    {
      key: 'split',
      title: 'Split',
      body: 'A splitter reads the file once and cuts it into pieces of about 5 MB, always at a minute boundary. It puts a small pointer to each piece on Kafka.',
      metric: stats ? `${n(stats.parts)} pieces` : '~5 MB pieces',
      nodes: ['api', 'kafka', 'workers', 'blob'],
      edges: ['api-kafka', 'kafka-workers', 'workers-blob'],
    },
    {
      key: 'parse',
      title: 'Parse',
      body: 'Workers take the pieces in parallel and read just their slice of the file. Eight parsers count errors, 5xx responses, latency and SQL failures for every minute, and each piece is saved in one database transaction.',
      metric: stats ? `${n(stats.chunks)} windows, ${n(stats.metricRows)} metric rows` : 'exact counts per minute',
      nodes: ['workers', 'blob', 'pg', 'kafka'],
      edges: ['kafka-workers', 'workers-blob', 'workers-pg'],
    },
    {
      key: 'gate',
      title: 'Detect',
      body: 'Each minute is compared with the rest of the same log, using median-based baselines, rare error patterns, and hard rules such as out-of-memory or deadlocks. The minutes that stand out are flagged.',
      metric: stats ? `${stats.flaggedMinutes} of ${stats.minutes} minutes flagged` : 'unusual minutes flagged',
      nodes: ['workers', 'pg'],
      edges: ['workers-pg'],
    },
    {
      key: 'explain',
      title: 'Explain',
      body: 'The flagged minutes go to the LLM, which explains what went wrong in each one. Every API key has its own Kafka partition and worker, so each key runs at its full rate limit.',
      metric: stats ? `${n(stats.llmCallsGated)} LLM calls, out of ${n(stats.llmCallsUngated)} possible` : 'flagged minutes only',
      nodes: ['workers', 'llm', 'kafka'],
      edges: ['kafka-workers', 'workers-llm'],
    },
    {
      key: 'correlate',
      title: 'Root cause',
      body: 'A LangGraph pipeline groups related findings into incidents and ranks their likely causes. A judge checks each explanation against the log lines it cites.',
      metric: stats?.incidents != null ? `${stats.incidents} incidents with ranked causes` : 'incidents with ranked causes',
      nodes: ['api', 'python', 'pg'],
      edges: ['api-python', 'python-pg'],
    },
    {
      key: 'ask',
      title: 'Ask',
      body: 'A LangGraph decision graph reads the conversation so far from Redis, works out whether your message is a follow-up, and picks how to answer: hybrid search over the failure records in Postgres, the log profile, or general knowledge. Answers about the log cite the exact lines.',
      metric: 'answers cite exact log lines',
      nodes: ['browser', 'api', 'python', 'pg', 'redis'],
      edges: ['browser-api', 'api-python', 'python-pg', 'python-redis'],
    },
  ];
}
