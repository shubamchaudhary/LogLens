import { useSyncExternalStore } from 'react';

// Light/dark theme for the whole site (landing, benchmarks, sign-in and the app).
// Dark by default, like macbatch; the visitor's choice is remembered in this browser.
// index.html paints the stored theme before React loads, so pages never flash white.

const KEY = 'deeploglens-theme';
const listeners = new Set();

function stored() {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let theme = stored();
document.documentElement.dataset.theme = theme;

function setTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // private window or blocked storage: the choice lasts for this visit only
  }
  listeners.forEach((l) => l());
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** [theme, toggle] for the theme switch. */
export function useTheme() {
  const current = useSyncExternalStore(subscribe, () => theme);
  return [current, () => setTheme(current === 'dark' ? 'light' : 'dark')];
}
