// src/lib/study/study.js — `#study` in the terminal: the shell's show-and-hide
// of its side pane, which holds the study where `fli haven` passed one
// (`IDEAS/study.md` 1.4), and a session handed to the study to open
// (study.md 3.3). Null where the shell was started with no side.
export { sideToggle } from '@frontierjs/mesa/runtime/terminal'
import { checkout } from '../hash/ledger.js'
import { readStudy } from './kept.js'

/** Where the study's sessions run and `study.json` keeps its tabs: the checkout this Haven sits in, else the process's own directory. */
export const studyCwd = () => checkout() ?? process.cwd()

/**
 * Each session a study tab runs or reads along, to its number in the bar
 * (from 1), so a workshop figure names its tab (study.md 3.2). Read off
 * `study.json` and not the mounted study, since kept tabs exist before the
 * study first shows.
 */
export function studyTabs() {
  const kept = readStudy(studyCwd())
  const out = new Map()
  kept?.tabs.forEach((t, i) => { const s = t.sessionId ?? t.reads; if (s) out.set(s, i + 1) })
  return out
}

// What each tab's session is doing as the pane draws it, by session id, so
// the workshop's figure says it alike (study.md 3.2): the hook's file lags a
// turn's start and never names a thought from a write. Written by the
// mounted study, read by `Workers.mesa` in the same process.
const live = new Map()

/** The study's own read of session `id`: `{ status, tool, since }`, or null for a session it does not run. */
export const studyLive = (id) => live.get(id) ?? null

/** Set what session `id` is doing, null when the study no longer runs it. */
export function setLive(id, now) {
  if (now) live.set(id, now)
  else live.delete(id)
}

// The study mounts the first time it shows, so a session handed in before
// then waits here for it.
const waiting = []
let hear = null

/** Hand the study a `#workers` session to show, as a tab of its own or read along. */
export function openSession(worker) {
  if (hear) hear(worker)
  else waiting.push(worker)
}

/** The study's ear: every session handed in, those waiting first. Returns its removal. */
export function onOpen(fn) {
  hear = fn
  for (const w of waiting.splice(0)) fn(w)
  return () => { if (hear === fn) hear = null }
}
