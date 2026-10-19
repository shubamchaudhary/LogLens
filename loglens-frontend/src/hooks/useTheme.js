import { useEffect, useSyncExternalStore } from 'react';

// Light/dark theme of the public pages (landing, benchmarks, sign-in). Dark by default,
// like macbatch; the visitor's choice is remembered in this browser. The app itself
// stays light: the theme is applied to <html> only while a public page is mounted.

const KEY = 'deeploglens-theme';
const listeners = new Set();
let mounted = 0;

function stored() {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let theme = stored();

function apply() {
  if (mounted > 0) document.documentElement.dataset.theme = theme;
}

function setTheme(next) {
  theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // private window or blocked storage: the choice lasts for this visit only
  }
  apply();
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

/** Call once in each public page: applies the theme while the page is open. */
export function usePublicTheme() {
  useEffect(() => {
    mounted += 1;
    apply();
    return () => {
      mounted -= 1;
      if (mounted === 0) delete document.documentElement.dataset.theme;
    };
  }, []);
}
