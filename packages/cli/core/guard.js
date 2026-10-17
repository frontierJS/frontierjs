// ─── guard.js — one writer at a time, across processes ───────────────────────
//
// A read-modify-write of a shared file loses the first writer's change when a
// second process reads before the first one writes: two `fli dev` both read
// slot 1 as free, two `fli file` both mint the next id. The guard is a file
// created with `wx`, which only one process can win, holding the winner's pid.
//
// Zero dependencies, plain ESM, node or bun.

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { execSync }                                                          from 'node:child_process'
import { createHash }                                                        from 'node:crypto'
import { homedir }                                                           from 'node:os'
import { dirname, join }                                                     from 'node:path'

/** Take `guard` once: `{ ok: true }`, or `{ ok: false, by }` naming the process holding it. */
export function tryGuard(guard) {
  mkdirSync(dirname(guard), { recursive: true })
  for (;;) {
    try {
      const fd = openSync(guard, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return { ok: true }
    } catch {
      // A holder that died mid-claim leaves the guard behind.
      let by = null
      try { by = parseInt(readFileSync(guard, 'utf8'), 10) || null } catch {}
      if (by && !isProcessAlive(by)) {
        try { unlinkSync(guard); continue } catch {}
      }
      return { ok: false, by }
    }
  }
}

/** Take `guard`, waiting up to `timeoutMs`; answers the path to unlink. */
export function acquireGuard(guard, timeoutMs = 5000) {
  const start = Date.now()
  while (true) {
    if (tryGuard(guard).ok) return guard
    if (Date.now() - start > timeoutMs) throw new Error(`Could not acquire ${guard} within ${timeoutMs}ms`)
    try { execSync('sleep 0.05', { stdio: 'pipe' }) } catch {}
  }
}

/** Run `fn` holding `guard`, and give it back however `fn` ends. */
export function withGuard(guard, fn, timeoutMs) {
  acquireGuard(guard, timeoutMs)
  try { return fn() } finally { try { unlinkSync(guard) } catch {} }
}

/**
 * What one checkout holds while a drive runs — `hold('ports')` answers
 * `{ ok: true, release }` or `{ ok: false, by }`. Keyed on the checkout, since
 * a linked worktree has a port block and a database of its own and so shares
 * nothing with the main tree; two runs in ONE tree share both.
 */
export function treeHold(root, dir = join(homedir(), '.fli', 'holds')) {
  let real = root
  try { real = realpathSync(root) } catch {}
  const key = createHash('sha1').update(real).digest('hex').slice(0, 12)
  return resource => {
    const guard = join(dir, `${key}-${resource}.guard`)
    const got   = tryGuard(guard)
    return got.ok ? { ok: true, release: () => { try { unlinkSync(guard) } catch {} } } : got
  }
}

function isProcessAlive(pid) {
  try   { process.kill(pid, 0); return true }
  catch { return false }
}
