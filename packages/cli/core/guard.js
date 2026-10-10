// ─── guard.js — one writer at a time, across processes ───────────────────────
//
// A read-modify-write of a shared file loses the first writer's change when a
// second process reads before the first one writes: two `fli dev` both read
// slot 1 as free, two `fli file` both mint the next id. The guard is a file
// created with `wx`, which only one process can win, holding the winner's pid.
//
// Zero dependencies, plain ESM, node or bun.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { execSync }                                                          from 'node:child_process'
import { dirname }                                                           from 'node:path'

/** Take `guard`, waiting up to `timeoutMs`; answers the path to unlink. */
export function acquireGuard(guard, timeoutMs = 5000) {
  const start = Date.now()
  mkdirSync(dirname(guard), { recursive: true })
  while (true) {
    try {
      const fd = openSync(guard, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return guard
    } catch {
      // A holder that died mid-claim leaves the guard behind.
      try {
        const heldBy = parseInt(readFileSync(guard, 'utf8'), 10)
        if (heldBy && !isProcessAlive(heldBy)) { unlinkSync(guard); continue }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`Could not acquire ${guard} within ${timeoutMs}ms`)
      try { execSync('sleep 0.05', { stdio: 'pipe' }) } catch {}
    }
  }
}

/** Run `fn` holding `guard`, and give it back however `fn` ends. */
export function withGuard(guard, fn, timeoutMs) {
  acquireGuard(guard, timeoutMs)
  try { return fn() } finally { try { unlinkSync(guard) } catch {} }
}

function isProcessAlive(pid) {
  try   { process.kill(pid, 0); return true }
  catch { return false }
}
