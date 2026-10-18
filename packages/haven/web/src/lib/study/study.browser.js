// src/lib/study/study.browser.js — `#study` in a browser, the twin of
// `study.js`. A page has no side pane and runs no session on its machine, so
// `/work` is no command there.
export function sideToggle() { return null }
export function openSession() {}
export function onOpen() { return () => {} }
export function studyCwd() { return null }
export function studyTabs() { return new Map() }
