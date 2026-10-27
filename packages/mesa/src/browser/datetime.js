/*
 * datetime.js — when something happened, in the viewer's words: `dt`, `at`, `ago`.
 *
 * `@frontierjs/toolbelt/datetime` reads no clock and keeps no zone (`FJS-D26`),
 * because one server renders for viewers in many zones. A screen is one viewer,
 * so the binding is made here, once, and a screen imports the words
 * (`FJS-D1543`). A screen that formats a date itself gets whatever order the
 * browser's locale writes: one column reads 9/14/2026 for one person and
 * 14/09/2026 for the next, and 3/4 is either month.
 *
 * ─── Every host ──────────────────────────────────────────────────────────
 *
 * No host rule: Intl and `Date.now` exist in a tab, on a terminal and under
 * bun, so nothing here throws on a terminal (`FJS-D1097` Q6 is for a wrapper
 * whose browser API is absent). The zone is read once, where this module
 * loads: the viewer's in a tab, the process's on a terminal, and the SERVER's
 * under a server render — a prerendered date is the build machine's until
 * hydration rewrites it.
 *
 * A date that belongs to a place — the day an invoice is for, the hour a store
 * opens — is that place's: toolbelt's `format(instant, pattern, { timeZone })`
 * with the zone from its config. An app with words of its own writes them
 * over `dt`.
 */
import { createDatetime } from '@frontierjs/toolbelt/datetime'

// An arrow, not `Date.now` itself: a test that swaps the clock is read.
// A pure IIFE: `@frontierjs/mesa/browser` is one entry, so every app that
// imports any wrapper from it otherwise ships this and toolbelt's datetime
// (+3.6 kB brotli on sierra's floor SPA), and a bundler keeps the Intl
// argument of a pure call because reading it could throw.
export const dt = /* @__PURE__ */ (() => createDatetime({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  now:      () => Date.now(),
}))()

/** 'Sep 14, 2026, 4:05 PM' — or `none`, for a row with no time. */
export function at(instant, none = '—') {
  return instant ? dt.format(instant, 'MMM D, YYYY, h:mm aa') : none
}

/** '5 minutes ago', 'now' under a minute — or `none`, for a row with no time. */
export function ago(instant, none = 'never') {
  return instant ? dt.relativeToNow(instant) : none
}
