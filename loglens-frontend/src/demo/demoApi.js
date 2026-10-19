// In-browser stand-in for the backend, used when demo mode is on. Each method
// mirrors its counterpart in services/api.js and resolves to an axios-like
// { data, status }, so components can't tell the difference. The fixture is
// loaded lazily, so it only costs bandwidth for visitors who open the demo.

import { demoState, setDemoState } from './demoMode';
import { buildReplay } from './replay';

let fixturePromise;
export function loadFixture() {
  fixturePromise ??= import('./fixture.json').then((m) => m.default);
  return fixturePromise;
}

const ok = (data, status = 200) => ({ data, status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => sleep(80 + Math.random() * 120);
const readOnly = () =>
  Promise.reject(Object.assign(new Error('The demo session is read-only'), { response: { status: 403 } }));

// Replay coordination: the progress stream waits for the upload to "start" the run,
// and the UI can ask a running replay to jump to the end.
const startListeners = new Set();
let activeSkip = null;

// Drill-down turns asked during this visit (the real backend persists them).
const history = [];

export function skipReplay() {
  activeSkip?.();
}

/** Back to a fresh, un-run demo session. */
export function resetDemo() {
  activeSkip = null;
  history.length = 0;
  setDemoState('CREATED');
}

function sessionView(f) {
  const state = demoState();
  if (state === 'DONE') return f.session;
  return {
    ...f.session,
    analysisStatus: state === 'RUNNING' ? 'CHUNKING' : 'CREATED',
    enrichedWindows: 0,
    totalWindows: 0,
  };
}

export const sessionAPI = {
  list: async () => {
    const f = await loadFixture();
    await latency();
    return ok([sessionView(f)]);
  },
  get: async () => ok(sessionView(await loadFixture())),
  create: readOnly,
  rename: readOnly,
  remove: readOnly,
};

export const documentAPI = {
  list: async () => {
    const f = await loadFixture();
    return ok(demoState() === 'CREATED' ? [] : [{ id: f.documentId, fileName: f.file.name, fileSizeBytes: f.file.bytes }]);
  },
  upload: readOnly,
  presign: readOnly,
  confirm: readOnly,
  /** Pretend presign → PUT → confirm; the "file" is always the bundled sample. */
  uploadDirect: async (sessionId, file, onUploadProgress) => {
    const f = await loadFixture();
    const total = f.file.bytes;
    for (let i = 1; i <= 12; i++) {
      await sleep(90);
      onUploadProgress?.({ loaded: Math.round((total * i) / 12), total });
    }
    setDemoState('RUNNING');
    startListeners.forEach((fn) => fn());
    return ok({ id: f.documentId, fileName: f.file.name }, 202);
  },
};

const normalise = (q) => q.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();

function answerFor(f, question) {
  const q = normalise(question);
  const exact = f.qa.find((x) => normalise(x.question) === q);
  if (exact) return { answer: exact.answer, citations: exact.citations, trace: exact.trace };

  const scored = f.qa
    .map((x) => ({ x, score: x.keywords.filter((k) => q.includes(k)).length }))
    .sort((a, b) => b.score - a.score);
  const closest = scored[0]?.score > 0 ? scored[0].x.question : null;
  return {
    answer:
      'This demo only has answers for the suggested questions, because free-form questions need the live ' +
      'retrieval + LLM backend, which is paused to keep hosting free. ' +
      (closest ? `The closest suggested question is: **${closest}**` : 'Try one of the suggested questions above.'),
    citations: [],
    unanswered: true,
    suggestion: closest,
  };
}

export const analysisAPI = {
  metrics: async (sessionId, params = {}) => {
    const f = await loadFixture();
    await latency();
    return ok(
      f.metrics.filter(
        (m) => (!params.category || m.category === params.category) && (!params.metric || m.metric === params.metric)
      )
    );
  },
  findings: async (sessionId, params = {}) => {
    const f = await loadFixture();
    await latency();
    return ok(
      f.findings.filter(
        (x) => (!params.category || x.category === params.category) && (!params.severity || x.severity === params.severity)
      )
    );
  },
  incidents: async () => {
    const f = await loadFixture();
    await latency();
    return ok(f.incidents);
  },
  report: async () => {
    const f = await loadFixture();
    await latency();
    return ok(f.report);
  },
  evidence: async (sessionId, chunkIds = []) => {
    const f = await loadFixture();
    await latency();
    const rows = chunkIds.map((id) => f.chunks[id]).filter(Boolean);
    rows.sort((a, b) => a.timeBucket.localeCompare(b.timeBucket) || a.lineStart - b.lineStart);
    return ok(rows);
  },
  drilldown: async (sessionId, question) => {
    const f = await loadFixture();
    const result = answerFor(f, question);
    history.push({ id: `demo-${history.length + 1}`, question, ...result, createdAt: new Date().toISOString() });
    return ok(result);
  },
  drilldownHistory: async () => ok(history.map((h) => ({ ...h }))),
  drilldownClear: async () => {
    history.length = 0;
    return ok(null, 204);
  },
};

/** The demo's SSE: replays the pipeline once the sample upload starts it. */
export function streamProgress(sessionId, { onUpdate, onDone, onLog } = {}) {
  const timers = [];
  let cancelled = false;
  let remaining = [];

  const apply = (step) => {
    if (step.log) onLog?.(step.log);
    if (step.progress) {
      if (step.progress.status === 'DONE') setDemoState('DONE');
      onUpdate?.(step.progress);
      if (step.progress.status === 'DONE') onDone?.();
    }
  };

  const run = async () => {
    const f = await loadFixture();
    if (cancelled) return;
    remaining = buildReplay(f);
    for (const step of remaining) {
      timers.push(
        setTimeout(() => {
          remaining = remaining.filter((s) => s !== step);
          apply(step);
        }, step.at)
      );
    }
    activeSkip = () => {
      timers.forEach(clearTimeout);
      const rest = remaining;
      remaining = [];
      rest.forEach(apply);
    };
  };

  const state = demoState();
  if (state === 'DONE') {
    loadFixture().then((f) => {
      if (cancelled) return;
      onUpdate?.({ status: 'DONE', enriched: f.stats.workItems, total: f.stats.workItems });
      onDone?.();
    });
  } else if (state === 'RUNNING') {
    run(); // a reload mid-replay starts it over
  } else {
    onUpdate?.({ status: 'CREATED', enriched: 0, total: 0 });
    startListeners.add(run);
  }

  return () => {
    cancelled = true;
    startListeners.delete(run);
    timers.forEach(clearTimeout);
    activeSkip = null;
  };
}
