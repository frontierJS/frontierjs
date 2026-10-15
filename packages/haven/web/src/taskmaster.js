// src/taskmaster.js — `#taskmaster` in the terminal: what the workshop's
// taskmaster knows and does (`components/Taskmaster.mesa`). A browser takes
// `taskmaster.browser.js`.
//
// He reads `fli next --json` and offers the package of its top row that the
// fix loop can take, and on a yes starts `scripts/fix-loop.mjs --pkg <it>`
// detached, so the loop outlives the room. Both are THIS checkout's: an
// installed Haven (`~/.fli/haven/<version>/`) has no `scripts/fix-loop.mjs`,
// so there is no taskmaster on a machine that only walks in, and a command
// that edits a tree and spends money starts only from a tree that has it and
// only after a typed `/yes`.
//
// One loop at a time, across terminals: `~/.fli/haven/taskmaster.json` holds
// the pid of the loop he started, and a pid that is gone is no loop. Two loops
// in one tree both pick its top row (`scripts/fix-loop.mjs`).
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCK_FILE = join(homedir(), '.fli', 'haven', 'taskmaster.json')
export const LOG_FILE = join(homedir(), '.fli', 'haven', 'fix-loop.log')

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LOOP = join('scripts', 'fix-loop.mjs')
const FLI = join('packages', 'cli', 'bin', 'fli.js')

/**
 * The workspace root this Haven sits in, or null when it is not a checkout with
 * the fix loop. `HAVEN_TASKMASTER_ROOT` names another root, which is how a drive
 * gives him a ranking and a loop that cost nothing.
 */
export function checkout({ from = HERE, env = process.env.HAVEN_TASKMASTER_ROOT } = {}) {
  const root = env || join(from, '..', '..', '..', '..')
  return existsSync(join(root, LOOP)) && existsSync(join(root, FLI)) ? root : null
}

/**
 * What to offer, best first: a package per row `fli next` ranks that the loop
 * can take (`byHand` rows it skips), each with the top such row naming it.
 * @returns {Promise<{ pkg: string, id: string, severity: string, title: string }[]>}
 */
export function proposals({ root, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, FLI), 'next', '--json', '--limit', '100'], { cwd: root, signal, timeout: 60_000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return reject(err)
      try {
        const rows = JSON.parse(out).ready.filter((r) => !r.byHand)
        const pkgs = [...new Set(rows.map((r) => r.pkg[0]))]
        resolve(pkgs.map((pkg) => {
          const r = rows.find((row) => row.pkg.includes(pkg))
          return { pkg, id: r.id, severity: r.severity, title: r.title }
        }))
      } catch (e) {
        reject(new Error(`fli next printed no ranking: ${e.message}`))
      }
    })
  })
}

/** The loop he started that is still alive, `{ pkg, pid, at }`; a pid that is gone or an unreadable file is none. */
export function running({ file = LOCK_FILE } = {}) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'))
    process.kill(lock.pid, 0)
    return lock
  } catch {
    return null
  }
}

/** Start the fix loop on `pkg`, detached, its output appended to `LOG_FILE`; throws naming the loop already running. */
export function startLoop(pkg, { root, file = LOCK_FILE, log = LOG_FILE, now = Date.now() } = {}) {
  // A leading dash would be read as one of the loop's flags.
  if (!/^\w[\w-]*$/.test(pkg)) throw new Error(`not a package name: ${pkg}`)
  const live = running({ file })
  if (live) throw new Error(`fix-loop is already on ${live.pkg}`)
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
  const out = openSync(log, 'a')
  const child = spawn(process.execPath, [join(root, LOOP), '--pkg', pkg], { cwd: root, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  const lock = { pkg, pid: child.pid, at: new Date(now).toISOString() }
  writeFileSync(file, JSON.stringify(lock) + '\n')
  return lock
}
