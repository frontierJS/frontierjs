// src/workers.browser.js — `#workers` in a browser, the twin of `workers.js`.
// A page cannot read the directory of the machine it is open on, so the
// workshop is empty in a browser.
export const QUIET_MS = 10 * 60 * 1000

export function readWorkers() { return [] }

export function closeOut() { return false }
