// src/errand.browser.js — `#errand` in a browser, the twin of `errand.js`.
// A page cannot run a command on the machine it is open on, so no runner
// comes in a browser.
export async function nextErrand() { return null }

export function markDelivered() {}
