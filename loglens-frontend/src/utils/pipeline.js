// The seven steps a log file takes through LogLens, with this session's numbers
// where it has them. Each step names the diagram boxes and arrows it uses.

import { fmtNum } from './format';

export function pipelineSteps(stats) {
  const n = (v, fallback) => (v != null ? fmtNum(v) : fallback);
  return [
    {
      key: 'upload',
      title: 'Upload',
      lead: 'The file goes straight to storage. The server never holds it.',
      body: 'The browser gets a presigned URL and PUTs the file directly to blob storage. The API only confirms the object exists, so a GB-sized upload never ties up the backend or its memory.',
      tags: ['Presigned URL', 'S3 API', 'Spring Boot'],
      metric: stats ? `${(stats.bytes / 2 ** 30).toFixed(1)} GB · 0 bytes through the API` : '0 bytes through the API',
      nodes: ['browser', 'blob', 'api'],
      edges: ['browser-blob', 'browser-api'],
    },
    {
      key: 'split',
      title: 'Split',
      lead: 'One pass over the file, cut into byte ranges on minute boundaries.',
      body: 'A splitter streams the file once and emits ranges that never cut a stack trace in half. Kafka carries only small pointers to those ranges, never the log itself.',
      tags: ['Kafka', 'Byte ranges', 'Streaming read'],
      metric: stats ? `${n(stats.parts)} parts of ~5 MB` : '~5 MB parts',
      nodes: ['api', 'kafka', 'workers', 'blob'],
      edges: ['api-kafka', 'kafka-workers', 'workers-blob'],
    },
    {
      key: 'parse',
      title: 'Parse',
      lead: 'Code counts every line. The LLM never does.',
      body: 'Workers read their range in parallel with ranged GETs. Eight parsers turn each 60-second window into exact counts: errors, 5xx, latency p95, SQL failures. Each part commits in one transaction with a marker row, so a crash or redelivery never double-counts.',
      tags: ['8 regex parsers', 'Exactly-once effects', 'Bounded memory'],
      metric: stats ? `${n(stats.chunks)} windows · ${n(stats.metricRows)} metric rows` : 'exact per-minute counts',
      nodes: ['workers', 'blob', 'pg', 'kafka'],
      edges: ['kafka-workers', 'workers-blob', 'workers-pg'],
    },
    {
      key: 'gate',
      title: 'Gate',
      lead: 'Statistics pick the few minutes worth an LLM call.',
      body: 'Each minute is compared with its own session: median and MAD baselines per metric, rare error templates, and hard rules like OOM, deadlock or an exhausted connection pool. A busy service with harmless errors all day stays quiet.',
      tags: ['Median + MAD', 'Rare signatures', 'Hard rules'],
      metric: stats ? `${stats.flaggedMinutes} of ${stats.minutes} minutes flagged` : 'a few minutes flagged',
      nodes: ['workers', 'pg'],
      edges: ['workers-pg'],
    },
    {
      key: 'explain',
      title: 'Explain',
      lead: 'Only abnormal minutes reach the LLM, at full speed and inside rate limits.',
      body: 'Flagged windows go to the model for an explanation. One Kafka partition per API key gives each key a single worker that paces itself, with no shared lock; a 429 moves the item to a retry topic instead of dropping it.',
      tags: ['Groq', 'Partition per API key', 'Retry topic'],
      metric: stats ? `${n(stats.llmCallsGated)} LLM calls, not ${n(stats.llmCallsUngated)}` : 'abnormal minutes only',
      nodes: ['workers', 'llm', 'kafka'],
      edges: ['kafka-workers', 'workers-llm'],
    },
    {
      key: 'correlate',
      title: 'Root cause',
      lead: 'Findings become incidents, each with ranked causes and evidence.',
      body: 'A LangGraph pipeline groups related findings across services into incidents. A judge checks every story against the log lines it cites and sends it back if they do not support it.',
      tags: ['LangGraph', 'LLM judge', 'Cited evidence'],
      metric: stats?.incidents != null ? `${stats.incidents} incidents with causes` : 'judged incidents',
      nodes: ['api', 'python', 'pg'],
      edges: ['api-python', 'python-pg'],
    },
    {
      key: 'ask',
      title: 'Ask',
      lead: 'Ask anything about the logs. Every answer points at the lines.',
      body: 'Questions run hybrid search, pgvector plus Postgres full text fused with RRF, inside a corrective loop that grades the evidence and rewrites the query when it is weak. Code drops any citation the model makes that was not retrieved.',
      tags: ['pgvector', 'Full-text + RRF', 'Corrective RAG'],
      metric: 'answers cite exact log lines',
      nodes: ['browser', 'api', 'python', 'pg'],
      edges: ['browser-api', 'api-python', 'python-pg'],
    },
  ];
}
