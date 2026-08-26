// src/tmp-dirs.js — temp directories a test run can never remove itself.
//
// A harness that makes a database in os.tmpdir() has no moment at which it can
// delete it:
//
//   - not when the test finishes: `@@log(audit)` flushes through the jsonl
//     driver AFTER the awaited call returns, so tearing the directory down in
//     an afterAll() races it into SQLITE_READONLY_DBMOVED.
//   - not at exit: `process.on('exit')` DOES NOT FIRE under `bun test`. Probed
//     with a one-test file whose handler printed nothing and whose directory
//     survived.
//
// So a run reaps the PREVIOUS runs' directories on the way IN. That is the one
// moment the owning process is provably gone — it has exited, however it
// exited, including the SIGKILL no handler can see. The age floor is what
// keeps a CONCURRENT run of the same suite safe: nothing here runs for an
// hour, so anything older belongs to nobody.
//
// Reaching for this from a `mkdtempSync` of your own is a leak waiting to be
// rediscovered — call `tempDir()`, which cannot be used without reaping.
//
// This cannot live in @frontierjs/toolbelt: it is a filesystem sweep and that
// package does no I/O by ruling (FJS-D26). It lives here because litestone is
// the lowest package that may, and it is already the Testing realm's Data
// half. @frontierjs/mesa is the one place that may not import it (leaf rule) —
// its browser drive owns a profile lifecycle of its own and says so.

import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REAP_AFTER_MS = 60 * 60 * 1000

// One sweep per prefix per process. A suite calling tempDir() a thousand times
// would otherwise readdir a directory holding thousands of entries each time.
const swept = new Set()

/** Remove leftovers of previous runs. `prefixes` is a string or an array of
 *  them; a name must START with one, so `ls-onlog-` does not reach `ls-onlog-
 *  plain-`'s siblings unless you ask for the shorter prefix. */
export function reapTempDirs(prefixes, { olderThanMs = REAP_AFTER_MS, root = tmpdir(), force = false } = {}) {
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter(p => {
    if (!force && swept.has(p)) return false
    swept.add(p)
    return true
  })
  if (!list.length) return 0

  const cutoff = Date.now() - olderThanMs
  let entries
  try { entries = readdirSync(root) } catch { return 0 }

  let removed = 0
  for (const name of entries) {
    if (!list.some(p => name.startsWith(p))) continue
    const full = join(root, name)
    try {
      if (statSync(full).mtimeMs > cutoff) continue
      rmSync(full, { recursive: true, force: true })
      removed++
    } catch { /* a concurrent run got there first, or it is not ours to remove */ }
  }
  return removed
}

/** A fresh temp directory, with the previous runs' already swept. The prefix is
 *  what the sweep matches on, so it must identify the harness and nothing
 *  else — a bare `test-` would reap a stranger's directory. */
export function tempDir(prefix, opts) {
  if (!prefix || prefix.length < 4)
    throw new Error(`tempDir: refusing the prefix ${JSON.stringify(prefix)} — it must identify one harness`)
  reapTempDirs(prefix, opts)
  return mkdtempSync(join(opts?.root ?? tmpdir(), prefix))
}
