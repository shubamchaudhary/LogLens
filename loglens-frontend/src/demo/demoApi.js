// Guest mode backend. Sessions, upload and pipeline progress run in the browser
// from fixture.json (the precomputed analysis of the 1 GB showcase log); questions
// go to the serverless /api/ask function, which queries the log's database live.
// Each method resolves to an axios-like { data, status } like services/api.js.

import { demoState, setDemoState } from './demoMode';
import { buildReplay } from './replay';

let fixturePromise;
export function loadFixture() {
  fixturePromise ??= import('./fixture.json').then((m) => m.default);
  return fixturePromise;
}

const ok = (data, status = 200) => ({ data, status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readOnly = () =>
  Promise.reject(Object.assign(new Error('Read-only session'), { response: { status: 403 } }));

const startListeners = new Set();
let activeSkip = null;
const history = []; // Ask turns of this visit

export function skipReplay() {
  activeSkip?.();
}

/** Back to a fresh, un-run session. */
export function resetDemo() {
  activeSkip = null;
  history.length = 0;
  setDemoState('CREATED');
}

function sessionView(f) {
  const state = demoState();
  if (state === 'DONE') return f.session;
  return { ...f.session, analysisStatus: state === 'RUNNING' ? 'CHUNKING' : 'CREATED', enrichedWindows: 0, totalWindows: 0 };
}

export const sessionAPI = {
  list: async () => ok([sessionView(await loadFixture())]),
  get: async () => ok(sessionView(await loadFixture())),
  create: readOnly,
  rename: readOnly,
  remove: readOnly,
};

export const documentAPI = {
  list: async () => {
    const f = await loadFixture();
    return ok(demoState() === 'CREATED' ? [] : [{ fileName: f.file.name, fileSizeBytes: f.file.bytes }]);
  },
  upload: readOnly,
  presign: readOnly,
  confirm: readOnly,
  /** presign → PUT → confirm for the bundled 1 GB file. */
  uploadDirect: async (sessionId, file, onUploadProgress) => {
    const f = await loadFixture();
    for (let i = 1; i <= 16; i++) {
      await sleep(110);
      onUploadProgress?.({ loaded: Math.round((f.file.bytes * i) / 16), total: f.file.bytes });
    }
    setDemoState('RUNNING');
    startListeners.forEach((fn) => fn());
    return ok({ fileName: f.file.name }, 202);
  },
};

async function postAsk(question) {
  const resp = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || 'ask failed'), { response: { status: resp.status, data } });
  return data;
}

export const analysisAPI = {
  /** Everything the result tabs need, in one call. */
  overview: async () => {
    const f = await loadFixture();
    return ok({ series: f.timeline, incidents: f.incidents, stats: f.stats, file: f.file, suggestions: f.suggestions });
  },
  ask: async (sessionId, question) => {
    const data = await postAsk(question);
    history.push({ ...data, question });
    return ok(data);
  },
  askHistory: async () => ok(history.map((h) => ({ ...h }))),
  askClear: async () => {
    history.length = 0;
    return ok(null, 204);
  },
  evidence: async () => ok([]), // incidents carry their evidence lines already
};

/** The guest session's SSE: replays the pipeline once the upload starts it. */
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
      rest.filter((s) => s.progress || s.final).forEach(apply);
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
    run(); // a reload mid-run starts it over
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
