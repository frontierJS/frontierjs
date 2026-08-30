// ─── app-import.js — importing the app's own modules at build time ───────────
//
// A static build imports code the app wrote, from two doors: the Litestone
// client `config.db` names, and a route's `.meta.js` companion. Both used to
// `catch { return null }`, and that is `FJS-551`: the one truthful error a
// build ever gets is thrown away, and what is left is a downstream TDZ.
//
// ── Why the truth is only available once ─────────────────────────────────────
//
// An app's db module ends in a top-level `await` — `export const db = await
// openShop(…)` is the shape — and a module whose TLA throws reports its real
// error exactly ONCE. Every import after that resolves to a partially
// initialised namespace rather than re-throwing, so the next reader gets
// `Cannot access 'X' before initialization` naming whichever binding it
// happened to touch, and the cause is gone from the process for good.
//
// Measured, three imports of one broken module in one Bun process:
//
//     1 THREW: schema.lite has errors: …the real one
//     2 THREW: Cannot access 'other' before initialization.
//     3 THREW: Cannot access 'other' before initialization.
//
// A build imports the app's db from several places, so what it usually holds is
// the second kind — four messages of that shape once hid a schema parse error
// naming a file and a line, and cost two people the same wrong diagnosis on the
// same day.
//
// ── So this module keeps the first one ───────────────────────────────────────
//
// One owner for *import a module the app wrote*, and it remembers. The first
// failure that is not itself a TDZ is recorded for the whole build; every later
// TDZ is reported WITH it, so the build's output carries the cause even though
// the runtime has thrown it away. A module that failed once is not imported
// again — re-importing it can only produce the half-built namespace, which is
// how the lie gets made in the first place.
//
// What it deliberately does not do is decide what a failure MEANS. A companion
// that threw is fatal and a db module that is merely absent is not; that is the
// caller's question, and the two callers answer it differently.

import { existsSync }    from 'fs'
import { pathToFileURL } from 'url'

// Per build. `beginBuildImports()` clears it, so a watch rebuild after a fix is
// not held to the previous run's failure.
let failures = new Map()   // absolute path → Error
let firstReal = null       // { path, error } — the earliest non-TDZ failure

const isTDZ = err => /before initialization/.test(String(err?.message ?? ''))

/** Start a build. Forget what failed in the previous one. */
export function beginBuildImports() {
  failures  = new Map()
  firstReal = null
}

/**
 * The first module that failed in this build for a reason of its own, if any.
 * `{ path, error }` — what every later TDZ is really about.
 */
export function firstRealFailure() {
  return firstReal
}

/**
 * Import a module the app wrote, by absolute path.
 *
 * Answers `{ ok: true, module }`, `{ ok: false, reason: 'missing' }` or
 * `{ ok: false, reason: 'threw', error }` — never null, because *not there* and
 * *broken* are the two answers whose conflation is the bug this file is about.
 *
 * Cache-busted so a watch rebuild re-reads a file that changed; the failure map
 * above is what stops a re-read from manufacturing a TDZ.
 */
export async function importAppModule(absPath) {
  if (!absPath || !existsSync(absPath)) return { ok: false, reason: 'missing' }

  const known = failures.get(absPath)
  if (known) return { ok: false, reason: 'threw', error: known, repeated: true }

  try {
    const module = await import(pathToFileURL(absPath).href + `?t=${Date.now()}`)

    // A half-built namespace does not throw on IMPORT — it throws when somebody
    // reads a binding that never got a value, which is why the lie surfaces in
    // the caller rather than here. So every binding is touched once, and a
    // module that cannot answer for its own exports is a module that threw.
    // Without this the TDZ lands wherever the caller happened to reach for
    // `.db` or `.load`, outside any explanation this file can give it.
    for (const key of Object.keys(module)) void module[key]

    return { ok: true, module }
  } catch (error) {
    failures.set(absPath, error)
    if (!firstReal && !isTDZ(error)) firstReal = { path: absPath, error }
    return { ok: false, reason: 'threw', error }
  }
}
