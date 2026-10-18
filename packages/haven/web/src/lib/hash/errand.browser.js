// src/errand.browser.js — `#errand` in a browser, the twin of `errand.js`.
// A page cannot run a command on the machine it is open on, so no runner
// comes in a browser, no board hangs behind the bar, and the desk asks nobody.
export async function nextErrand() { return null }

export function markDelivered() {}

export async function barActivity() { return null }

export async function homeBoard() { return null }

export async function askDesk() { return null }

export async function deskReport() { return null }
