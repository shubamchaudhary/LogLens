// AI-written parts of the demo replay: finding explanations, incident narratives,
// the report and the Q&A answers. They follow the pipeline's output format
// (EnrichPrompts / rag-orchestrator prompts) but were written by hand, NOT produced
// by a model. Every number goes through a {{placeholder}} that build-fixture.mjs
// fills from the log file, so the prose can't drift from the data.
//
// Replace them with real model output by capturing a live run:
//   node scripts/demo/capture-fixture.mjs --help
//
// Placeholders (key = a finding key below):
//   {{n:key}} matching lines   {{range:key}} first–last time   {{start:key}} {{end:key}}
//   {{tenants:key}} {{tenantCount:key}} {{hosts:key}}   {{stat:name}}   {{metricsTable}}

export const findings = [
  {
    key: 'oauth',
    category: 'AUTH',
    severity: 'CRITICAL',
    title: 'OAuth token validation failing in auth-service (provider 401)',
    match: /OAuth token validation failed/,
    confidence: 0.93,
    explanation:
      "auth-service logged {{n:oauth}} 'OAuth token validation failed provider_status=401' errors between {{range:oauth}}, " +
      'for tenants {{tenants:oauth}} on {{hosts:oauth}}. The first one appears 4 s after token-service logged ' +
      "'Deployment completed version=2.8.1' at 09:30:00.",
  },
  {
    key: 'gateway503',
    category: 'DEPENDENCY',
    severity: 'ERROR',
    title: 'api-gateway returning 503: downstream auth-service unavailable',
    match: /503 Service Unavailable downstream=auth-service/,
    confidence: 0.9,
    explanation:
      "api-gateway returned {{n:gateway503}} '503 Service Unavailable' responses that name auth-service as the failing " +
      'downstream ({{range:gateway503}}). They interleave one-for-one with the auth-service validation failures, so ' +
      'clients saw the auth problem as gateway 503s.',
  },
  {
    key: 'sqltimeout',
    category: 'DATABASE',
    severity: 'ERROR',
    title: 'db-proxy SQL timeouts at 12,000 ms',
    match: /SQL timeout duration=12000ms/,
    confidence: 0.86,
    explanation:
      "db-proxy logged {{n:sqltimeout}} 'SQL timeout duration=12000ms' errors ({{range:sqltimeout}}) in the same minutes " +
      "as the auth failures. Normal 'SQL executed' lines elsewhere in the file report 12 ms. The logs don't say which " +
      'query timed out.',
  },
  {
    key: 'tokenretry',
    category: 'AUTH',
    severity: 'WARN',
    title: 'token-service retrying token refresh',
    match: /Retrying token refresh/,
    confidence: 0.88,
    explanation:
      "token-service logged {{n:tokenretry}} 'Retrying token refresh' warnings ({{range:tokenretry}}), starting 1 s after " +
      'its own 2.8.1 deployment. There are no retry warnings anywhere else in the file.',
  },
  {
    key: 'stripe',
    category: 'DEPENDENCY',
    severity: 'ERROR',
    title: 'Payment gateway timeouts to Stripe',
    match: /Payment gateway timeout provider=Stripe/,
    confidence: 0.9,
    explanation:
      "payment-service logged {{n:stripe}} 'Payment gateway timeout provider=Stripe' errors ({{range:stripe}}) for all " +
      '{{tenantCount:stripe}} tenants. There are no internal exceptions or database errors in that window, which fits a ' +
      "provider-side problem, but the logs alone can't confirm it.",
  },
  {
    key: 'redis',
    category: 'DEPENDENCY',
    severity: 'ERROR',
    title: 'Redis connection timeouts',
    match: /Redis connection timeout/,
    confidence: 0.89,
    explanation:
      "redis-cache logged {{n:redis}} 'Redis connection timeout' errors ({{range:redis}}) across {{tenantCount:redis}} " +
      'tenants, on {{hosts:redis}}. Only client-side timeouts are logged; there is nothing from the Redis server itself.',
  },
  {
    key: 'gc',
    category: 'PERFORMANCE',
    severity: 'WARN',
    title: 'search-service long GC pauses (2,500 ms)',
    match: /GC pause duration=2500ms/,
    confidence: 0.87,
    explanation:
      "search-service logged {{n:gc}} 'GC pause duration=2500ms' warnings ({{range:gc}}). Back-to-back pauses this long " +
      'mean the JVM was spending a large share of its time collecting garbage, a typical sign of a nearly full heap.',
  },
  {
    key: 'oom',
    category: 'PERFORMANCE',
    severity: 'CRITICAL',
    title: 'search-service OutOfMemoryError: Java heap space',
    match: /OutOfMemoryError Java heap space/,
    confidence: 0.95,
    explanation:
      "{{n:oom}} 'OutOfMemoryError Java heap space' errors from search-service ({{range:oom}}), starting the second after " +
      'the last GC-pause warning. Long GC pauses followed by OOM is consistent with the heap filling up over minutes, ' +
      'not a single oversized request.',
  },
  {
    key: 'forbidden',
    category: 'AUTH',
    severity: 'ERROR',
    title: '403 policy mismatch for tenant nike-us',
    match: /Permission denied policy mismatch/,
    confidence: 0.91,
    explanation:
      "auth-service rejected {{n:forbidden}} requests with 'Permission denied policy mismatch status=403' " +
      '({{range:forbidden}}). Every one is for tenant {{tenants:forbidden}}, spread across {{hosts:forbidden}}, so the ' +
      'problem is scoped to that tenant rather than one pod.',
  },
];

export const incidents = [
  {
    key: 'auth-cascade',
    findings: ['oauth', 'gateway503', 'sqltimeout', 'tokenretry'],
    narrative:
      "One second after token-service logged 'Deployment completed version=2.8.1' at 09:30:00 it began retrying token " +
      'refreshes. From {{start:tokenretry}} to {{end:tokenretry}} four errors repeat in a fixed cycle: the token-service ' +
      'retry, a db-proxy SQL timeout, an api-gateway 503 (downstream=auth-service) and an auth-service OAuth validation ' +
      'failure (provider_status=401). The cycle stops at {{end:tokenretry}}; no rollback or restart is logged.',
    rootCause:
      'The token-service 2.8.1 deployment is the most likely trigger: it is the only change logged before the ' +
      'failures, and they start 1–4 s after it. The SQL timeouts follow the same cycle, so they look like a symptom ' +
      "rather than the cause. Confirm by diffing 2.8.1's token-validation config against the previous release.",
  },
  {
    key: 'stripe',
    findings: ['stripe'],
    narrative:
      'payment-service could not reach Stripe from {{start:stripe}} to {{end:stripe}}: {{n:stripe}} gateway timeouts ' +
      'spread evenly across all {{tenantCount:stripe}} tenants.',
    rootCause:
      "Provider-side latency or an outage at Stripe, since every failure is a timeout to the provider and no internal " +
      "errors are logged. Check Stripe's status history for this window.",
  },
  {
    key: 'redis',
    findings: ['redis'],
    narrative:
      'redis-cache timed out on {{n:redis}} connections between {{start:redis}} and {{end:redis}}, across all pods.',
    rootCause:
      'A Redis availability or network problem. The logs only show client-side timeouts, so check Redis server metrics ' +
      '(memory, evictions, failover events) for this window.',
  },
  {
    key: 'search-oom',
    findings: ['gc', 'oom'],
    narrative:
      'search-service went through about two minutes of 2.5 s GC pauses ({{n:gc}} warnings from {{start:gc}}) and then ' +
      'failed with {{n:oom}} OutOfMemoryError: Java heap space errors until {{end:oom}}.',
    rootCause:
      'Heap exhaustion in search-service, from a leak or an oversized query or result set. Enable ' +
      '-XX:+HeapDumpOnOutOfMemoryError and compare heap usage before {{start:gc}}.',
  },
  {
    key: 'nike-403',
    findings: ['forbidden'],
    narrative:
      'For two minutes ({{range:forbidden}}) auth-service rejected every logged request from tenant {{tenants:forbidden}} ' +
      'with a 403 policy mismatch, on all four pods.',
    rootCause:
      "A tenant-level authorization policy for nike-us that no longer matches what auth-service expects, such as a " +
      "policy edit or a role-mapping change. The logs don't show the change itself; check the policy store's audit " +
      'log for nike-us around {{start:forbidden}}.',
  },
];

export const report = `# Incident report: owner_sample_10k.log

## Summary
{{stat:lines}} log lines from 09:00 to 11:46 UTC on 15 Jul 2026. The deterministic parsers counted {{stat:errorLines}} ERROR and {{stat:warnLines}} WARN lines; the anomaly gate flagged {{stat:flagged}} of {{stat:windows}} one-minute windows, which correlate into **5 incidents**. The most severe is an auth failure cascade that began seconds after the token-service 2.8.1 deployment; the second is an OutOfMemoryError crash in search-service.

## Key Metrics
{{metricsTable}}

## Incidents

### 1. Auth cascade after the token-service 2.8.1 deploy ({{range:oauth}})
The deploy at 09:30:00 was followed within seconds by token refresh retries ({{n:tokenretry}}), OAuth validation failures in auth-service ({{n:oauth}}, provider_status=401), api-gateway 503s naming auth-service as downstream ({{n:gateway503}}) and db-proxy SQL timeouts at 12,000 ms ({{n:sqltimeout}}). All four repeat in one fixed cycle until {{end:tokenretry}}.

### 2. Stripe payment gateway timeouts ({{range:stripe}})
{{n:stripe}} payment timeouts with provider=Stripe across all {{tenantCount:stripe}} tenants, with no internal errors alongside them.

### 3. Redis connection timeouts ({{range:redis}})
{{n:redis}} client-side connection timeouts from redis-cache, spread across {{hosts:redis}}.

### 4. search-service GC storm and OutOfMemoryError ({{start:gc}}–{{end:oom}} UTC)
{{n:gc}} GC pauses of 2,500 ms, then {{n:oom}} OutOfMemoryError: Java heap space errors starting at {{start:oom}}.

### 5. 403 policy mismatch for tenant nike-us ({{range:forbidden}})
{{n:forbidden}} requests rejected with status=403, all for nike-us, spread over {{hosts:forbidden}}.

## Recommendations
- Diff token-service 2.8.1 against the previous release (token-validation config first) and gate future deploys on the auth-service 401 rate.
- Put a circuit breaker and a timeout budget on the Stripe client so checkout fails fast instead of piling up timeouts.
- search-service: enable heap dumps on OOM and alert when GC pauses exceed 1 s; this crash gave two minutes of warning.
- Alert on the per-tenant 403 rate, so a tenant-scoped policy break pages someone even when other tenants look healthy.
- Pull Redis server-side metrics for {{range:redis}}; the application logs only show the client side.
`;

// Suggested questions in the Ask tab. `cite` lists the windows (HH:MM, UTC) whose
// chunks the answer cites; `trace` is the path through the corrective-RAG graph.
export const qa = [
  {
    question: 'What caused the 503 errors around 09:30?',
    keywords: ['503', 'gateway', 'unavailable', '09:3'],
    cite: ['09:30', '09:31'],
    trace: ['retrieve · hybrid (pgvector + full-text, RRF) → 12 chunks', 'grade → 5 relevant', 'generate · 2 citations'],
    answer:
      'The 503s came from **api-gateway**, and each one names **auth-service** as the failing downstream ' +
      '({{n:gateway503}} errors, {{range:gateway503}}). auth-service was failing OAuth validation with ' +
      '`provider_status=401` ({{n:oauth}} errors) in the same cycle. The cycle starts right after token-service logged ' +
      '`Deployment completed version=2.8.1` at 09:30:00, so that deploy is the most likely trigger.',
  },
  {
    question: 'Which tenants were hit by the 403 errors?',
    keywords: ['403', 'tenant', 'forbidden', 'permission', 'nike'],
    cite: ['11:13', '11:14'],
    trace: ['retrieve · hybrid (pgvector + full-text, RRF) → 12 chunks', 'grade → 3 relevant', 'generate · 2 citations'],
    answer:
      'Only **{{tenants:forbidden}}**. All {{n:forbidden}} `Permission denied policy mismatch status=403` errors ' +
      '({{range:forbidden}}) are for that tenant, spread across {{hosts:forbidden}}. The log has no lines from other ' +
      "tenants during those two minutes, so it can't tell whether they were affected too.",
  },
  {
    question: 'What happened before search-service ran out of memory?',
    keywords: ['memory', 'oom', 'outofmemory', 'heap', 'gc', 'search'],
    cite: ['10:48', '10:50'],
    trace: ['retrieve · hybrid (pgvector + full-text, RRF) → 12 chunks', 'grade → 3 relevant', 'generate · 2 citations'],
    answer:
      'From {{start:gc}} search-service logged {{n:gc}} `GC pause duration=2500ms` warnings: long, back-to-back ' +
      'pauses. The first `OutOfMemoryError Java heap space` comes at {{start:oom}}, one second after the last GC ' +
      'warning ({{end:gc}}), and {{n:oom}} OOM errors follow until {{end:oom}}. GC thrashing followed by OOM points to ' +
      'the heap filling up over about two minutes, not to a single bad request.',
  },
  {
    question: 'Was Stripe at fault for the payment failures?',
    keywords: ['stripe', 'payment', 'checkout', 'fault'],
    cite: ['09:58', '09:59'],
    trace: [
      'retrieve · hybrid (pgvector + full-text, RRF) → 12 chunks',
      'grade → 1 relevant (too few)',
      "rewrite → 'payment gateway timeout provider=Stripe 09:58'",
      're-retrieve → 12 chunks',
      'grade → 4 relevant',
      'generate · 2 citations',
    ],
    answer:
      "The logs can't prove it either way. All {{n:stripe}} errors are `Payment gateway timeout provider=Stripe` from " +
      'payment-service ({{range:stripe}}), across all {{tenantCount:stripe}} tenants, with no internal exceptions or ' +
      "database errors in that window. That fits a provider-side problem, but confirming it needs Stripe's status " +
      'history for that time.',
  },
  {
    question: 'What was the CPU usage on pod-2?',
    keywords: ['cpu', 'utilization', 'utilisation', 'load'],
    cite: [],
    trace: [
      'retrieve · hybrid (pgvector + full-text, RRF) → 12 chunks',
      'grade → 0 relevant',
      "rewrite → 'pod-2 cpu utilization percent'",
      're-retrieve → 12 chunks',
      'grade → 0 relevant',
      'abstain · no grounded answer',
    ],
    answer:
      "I can't answer that from these logs. None of the retrieved chunks contain CPU data. The file has request, auth, " +
      'GC and error lines, but no CPU or host utilisation metrics.',
  },
];
