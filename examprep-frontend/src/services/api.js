import axios from 'axios';

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

export const authAPI = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
};

export const sessionAPI = {
  list: () => api.get('/sessions'),
  get: (id) => api.get(`/sessions/${id}`),
  create: (title) => api.post('/sessions', title ? { title } : {}),
  rename: (id, title) => api.patch(`/sessions/${id}`, { title }),
  remove: (id) => api.delete(`/sessions/${id}`),
};

export const documentAPI = {
  list: (sessionId) => api.get(`/sessions/${sessionId}/documents`),
  upload: (sessionId, file, onUploadProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post(`/sessions/${sessionId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
      onUploadProgress,
    });
  },
};

export const analysisAPI = {
  metrics: (sessionId, params) => api.get(`/sessions/${sessionId}/metrics`, { params }),
  findings: (sessionId, params) => api.get(`/sessions/${sessionId}/findings`, { params }),
  incidents: (sessionId) => api.get(`/sessions/${sessionId}/incidents`),
  report: (sessionId) => api.get(`/sessions/${sessionId}/report`),
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

export function streamProgress(sessionId, { onUpdate, onDone, onError } = {}) {
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
