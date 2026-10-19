// Facts and download links for the showcase log, served by /api/log?info=1 (fetched once).
let infoPromise;

export function logFileInfo() {
  infoPromise ??= fetch('/api/log?info=1')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return infoPromise;
}
