// Demo-mode flags, kept in localStorage so a reload stays in the demo and a
// finished replay stays finished. Storage can be unavailable (private mode,
// blocked site data), so every access is guarded and falls back to defaults.

const MODE_KEY = 'loglens.demo';
const STATE_KEY = 'loglens.demo.state';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* demo still works, it just won't survive a reload */
  }
}

export function isDemo() {
  return read(MODE_KEY) === 'true';
}

export function enterDemo() {
  write(MODE_KEY, 'true');
}

export function exitDemo() {
  write(MODE_KEY, null);
  write(STATE_KEY, null);
}

/** Where the demo session is: 'CREATED' (not run yet), 'RUNNING' or 'DONE'. */
export function demoState() {
  const s = read(STATE_KEY);
  return s === 'RUNNING' || s === 'DONE' ? s : 'CREATED';
}

export function setDemoState(state) {
  write(STATE_KEY, state);
}
