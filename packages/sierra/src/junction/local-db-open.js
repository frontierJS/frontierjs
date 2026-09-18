// local-db-open.js — the one line that makes a bundler emit the worker.
//
// Its own module, imported DYNAMICALLY and stubbed out by the build when an app
// did not ask for a database (`build/local-db-plugin.js`).
//
// That indirection is not style. `new Worker(new URL(…, import.meta.url))` is a
// STATIC signal: a bundler emits the worker chunk wherever it sees the pattern,
// whether or not the code around it ever runs — so written inline it put the
// whole litestone browser client into every app, and the service worker
// precaches every `.js` the build emits, which put it into every SHELL.
// Measured on `example` with the database turned OFF: 277 kB → 401 kB.
export function openWorker() {
  return new Worker(new URL('./local-db-worker.js', import.meta.url), { type: 'module' })
}
