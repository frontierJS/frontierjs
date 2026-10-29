// src/errand.browser.js — `#errand` in a browser, the twin of `errand.js`.
// A page cannot run a command on the machine it is open on, so no runner
// comes in a browser, no board hangs behind the bar, and the desk asks nobody
// and snoozes and peeks at nothing.
export async function nextErrand() { return null }

export function markDelivered() {}

export async function barActivity() { return null }

export async function homeBoard() { return null }

export async function askDesk() { return null }

export async function deskReport() { return null }

export async function reportNames() { return [] }

export function readSnoozes() { return {} }

export function setSnooze() { return null }

export async function openLink() { return false }

export async function peekItem() { return null }
