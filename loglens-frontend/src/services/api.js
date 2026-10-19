import axios from 'axios';
import { isDemo } from '../demo/demoMode';
import * as demo from '../demo/demoApi';
import { timeline } from '../utils/analysis';
import { askView, incidentView } from '../utils/views';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  withCredentials: false,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    console.log(`[API Request] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  },
  (error) => {
    console.error('[API Request Error]', error);
    return Promise.reject(error);
  }
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      console.error('[API Error Response]', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: error.config?.url,
        baseURL: error.config?.baseURL,
      });
    } else if (error.request) {
      console.error('[API Network Error]', {
        message: error.message,
        url: error.config?.url,
        baseURL: error.config?.baseURL,
        code: error.code,
      });
    } else {
      console.error('[API Request Setup Error]', error.message);
    }
    return Promise.reject(error);
  }
);

/**
 * Route each call to the in-browser demo backend while demo mode is on, else to
 * the real API. Decided per call, because demo mode starts and ends at runtime.
 */
function demoAware(real, fake) {
  return Object.fromEntries(
    Object.keys(real).map((name) => [name, (...args) => (isDemo() ? fake : real)[name](...args)])
  );
}

export const authAPI = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
  guest: () => api.post('/auth/guest'),
};

export const sessionAPI = demoAware({
  list: () => api.get('/sessions'),
  get: (id) => api.get(`/sessions/${id}`),
  create: (title) => api.post('/sessions', title ? { title } : {}),
  rename: (id, title) => api.patch(`/sessions/${id}`, { title }),
  remove: (id) => api.delete(`/sessions/${id}`),
}, demo.sessionAPI);

const realDocumentAPI = {
  list: (sessionId) => api.get(`/sessions/${sessionId}/documents`),

  // Legacy stream-through upload (kept as a fallback). Prefer uploadDirect.
  upload: (sessionId, file, onUploadProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post(`/sessions/${sessionId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
      onUploadProgress,
    });
  },

  presign: (sessionId, file) =>
    api.post(`/sessions/${sessionId}/documents/presign`, {
      fileName: file.name,
      fileSizeBytes: file.size,
      contentType: file.type || 'application/octet-stream',
    }),

  confirm: (sessionId, documentId, file) =>
    api.post(`/sessions/${sessionId}/documents/${documentId}/confirm`, {
      fileName: file.name,
    }),

  /**
   * Presigned direct-to-blob upload: ask the backend for a presigned PUT URL,
   * upload the bytes straight to storage (the app server never sees them), then
   * confirm so the backend records the row and kicks off the pipeline.
   */
  uploadDirect: async (sessionId, file, onUploadProgress) => {
    const { data: presign } = await realDocumentAPI.presign(sessionId, file);
    if (presign.duplicate) {
      // Identical file already processed — nothing to upload.
      return { data: presign.document, duplicate: true };
    }
    // Raw PUT to blob storage: NOT the api instance (no Authorization header,
    // no JSON content-type, no api baseURL — this URL is already fully signed).
    await axios.put(presign.uploadUrl, file, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 0, // large files; let the browser manage it
      onUploadProgress,
    });
    return realDocumentAPI.confirm(sessionId, presign.documentId, file);
  },
};

export const documentAPI = demoAware(realDocumentAPI, demo.documentAPI);

// Raw backend endpoints (signed-in sessions).
const backend = {
  metrics: (sessionId, params) => api.get(`/sessions/${sessionId}/metrics`, { params }),
  findings: (sessionId, params) => api.get(`/sessions/${sessionId}/findings`, { params }),
  incidents: (sessionId) => api.get(`/sessions/${sessionId}/incidents`),
  evidence: (sessionId, chunkIds) =>
    api.get(`/sessions/${sessionId}/evidence`, {
      params: { chunkIds },
      paramsSerializer: { indexes: null },
    }),
  drilldown: (sessionId, question) =>
    api.post(`/sessions/${sessionId}/drilldown`, { question }, { timeout: 130000 }),
  drilldownHistory: (sessionId) => api.get(`/sessions/${sessionId}/drilldown`),
  drilldownClear: (sessionId) => api.delete(`/sessions/${sessionId}/drilldown`),
};

// What the result tabs consume; the guest session serves the same shapes from demoApi.js.
export const analysisAPI = demoAware({
  overview: async (sessionId) => {
    const [fin, inc, met] = await Promise.all([
      backend.findings(sessionId),
      backend.incidents(sessionId),
      backend.metrics(sessionId),
    ]);
    const findings = fin.data || [];
    return {
      status: 200,
      data: {
        series: timeline(met.data || []),
        incidents: (inc.data || []).map((x) => incidentView(x, findings)),
        stats: null,
        file: null,
        suggestions: ['What caused the errors?', 'When did the first error happen?', 'Which service failed most?'],
      },
    };
  },
  ask: async (sessionId, question) => {
    const { data } = await backend.drilldown(sessionId, question);
    const ids = data.citations || [];
    const rows = ids.length ? (await backend.evidence(sessionId, ids).catch(() => ({ data: [] }))).data : [];
    return { status: 200, data: askView(question, data.answer, rows) };
  },
  askHistory: async (sessionId) => {
    const { data } = await backend.drilldownHistory(sessionId);
    return { status: 200, data: (data || []).map((m) => askView(m.question, m.answer, [])) };
  },
  askClear: (sessionId) => backend.drilldownClear(sessionId),
  evidence: backend.evidence,
}, demo.analysisAPI);

export function streamProgress(sessionId, handlers = {}) {
  if (isDemo()) return demo.streamProgress(sessionId, handlers);
  const { onUpdate, onDone, onError } = handlers;
  const token = localStorage.getItem('token');
  const controller = new AbortController();
  const url = `${API_BASE_URL}/sessions/${sessionId}/progress`;

  (async () => {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        onError?.(new Error(`progress stream failed (${resp.status})`));
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const payload = parseSseData(frame);
          if (payload) onUpdate?.(payload);
        }
      }
      onDone?.();
    } catch (e) {
      if (e.name !== 'AbortError') onError?.(e);
    }
  })();

  return () => controller.abort();
}

function parseSseData(frame) {
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
}

export default api;
