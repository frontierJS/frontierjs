// src/taskmaster.browser.js — `#taskmaster` in a browser, the twin of
// `taskmaster.js`. A page runs no command and starts no loop on the machine it
// is open on, so the workshop has a desk and nobody at it.
export function checkout() { return null }

export async function proposals() { return [] }

export function running() { return null }

export function startLoop() { throw new Error('a page starts nothing on a machine') }
