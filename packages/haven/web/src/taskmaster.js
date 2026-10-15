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
// One loop at a time, across terminals and the agents (`agents/agents.js`,
// whose task is a plan this module starts): `~/.fli/haven/taskmaster.json`
// holds the pid of the loop started, and a pid that is gone is no loop. Two
// loops in one tree both pick its top row (`scripts/fix-loop.mjs`).
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

/** The rows `fli next` ranks that the loop can take, best first — `byHand` rows it skips. */
export function readyRows({ root, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(root, FLI), 'next', '--json', '--limit', '100'], { cwd: root, signal, timeout: 60_000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(out).ready.filter((r) => !r.byHand)) }
      catch (e) { reject(new Error(`fli next printed no ranking: ${e.message}`)) }
    })
  })
}

/**
 * What to offer, best first: a package per row `fli next` ranks that the loop
 * can take, each with the top such row naming it.
 * @returns {Promise<{ pkg: string, id: string, severity: string, title: string }[]>}
 */
export async function proposals({ root, signal } = {}) {
  const rows = await readyRows({ root, signal })
  return [...new Set(rows.map((r) => r.pkg[0]))].map((pkg) => {
    const r = rows.find((row) => row.pkg.includes(pkg))
    return { pkg, id: r.id, severity: r.severity, title: r.title }
  })
}

/** The loop he started that is still alive, `{ on, pid, at, from, ...plan }`; a pid that is gone or an unreadable file is none. */
export function running({ file = LOCK_FILE } = {}) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'))
    process.kill(lock.pid, 0)
    return lock
  } catch {
    return null
  }
}

/** The most rows a plan may name; the loop's own default is four, a mod's task is one or a few. */
export const MAX_ROWS = 3

/** What a plan is on, in a line: `litestone`, `FJS-2790`, `sierra S3,S4`. */
export const planName = (p) => [p.ids?.join(', '), p.pkg, p.sev].filter(Boolean).join(' ')

/**
 * The loop's flags for a plan `{ ids?, pkg?, sev?, rows? }`, each part checked,
 * or a throw naming the first that is not. A value with a leading dash would be
 * read as one of the loop's flags, and a plan may come from a model.
 */
export function loopArgv({ ids, pkg, sev, rows } = {}) {
  const argv = []
  if (ids != null) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ROWS || !ids.every((id) => typeof id === 'string' && /^FJS-\d+$/.test(id))) throw new Error(`not issue ids: ${ids}`)
    argv.push('--ids', ids.join(','))
  }
  if (pkg != null) {
    if (typeof pkg !== 'string' || !/^\w[\w-]*$/.test(pkg)) throw new Error(`not a package name: ${pkg}`)
    argv.push('--pkg', pkg)
  }
  if (!argv.length) throw new Error('a loop needs a package or an issue')
  if (sev != null) {
    if (typeof sev !== 'string' || !/^S[1-4](,S[1-4])*$/.test(sev)) throw new Error(`not a severity: ${sev}`)
    argv.push('--sev', sev)
  }
  if (rows != null) {
    if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) throw new Error(`not a row count: ${rows}`)
    argv.push('--rows', String(rows))
  }
  return argv
}

/**
 * Start the fix loop on a plan, detached, its output appended to `LOG_FILE`;
 * throws naming the loop already running. `from` in the lock is where this
 * loop's output starts in the log, which `loopReport` reads from.
 */
export function startLoop(plan, { root, file = LOCK_FILE, log = LOG_FILE, now = Date.now() } = {}) {
  const argv = loopArgv(plan)
  const live = running({ file })
  if (live) throw new Error(`fix-loop is already on ${live.on}`)
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
  let from = 0
  try { from = statSync(log).size } catch {}
  const out = openSync(log, 'a')
  // The child holds its own copy of the fd; ours would leak one per loop started.
  let child
  try { child = spawn(process.execPath, [join(root, LOOP), ...argv], { cwd: root, detached: true, stdio: ['ignore', out, out] }) }
  finally { closeSync(out) }
  child.unref()
  const lock = { on: planName(plan), ...plan, pid: child.pid, at: new Date(now).toISOString(), from }
  writeFileSync(file, JSON.stringify(lock) + '\n')
  return lock
}

/**
 * File a row with `fli file` in this checkout and answer its id. The title and
 * area may come from a mod's words through a model: a leading dash is cut, so
 * no value reads as a flag, and `fli file`'s own check refuses the rest.
 */
export function fileRow({ root, sev, area, title, detail }) {
  const arg = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/^[-\s]+/, '').trim().slice(0, 300)
  return new Promise((resolve, reject) => {
    const argv = [join(root, FLI), 'file', '--sev', arg(sev), '--area', arg(area), '--title', arg(title), '--detail', arg(detail)]
    execFile(process.execPath, argv, { cwd: root, timeout: 60_000 }, (err, out) => {
      const id = /✓ (FJS-\d+) filed/.exec(String(out))?.[1]
      if (id) return resolve(id)
      reject(new Error(String(out).match(/✗ (.*)/)?.[1] ?? err?.message ?? 'fli file wrote nothing'))
    })
  })
}

/** What one loop printed to the log since `from`; a missing log is nothing. */
export function loopOutput({ log = LOG_FILE, from = 0 } = {}) {
  try { return readFileSync(log).subarray(from).toString('utf8') } catch { return '' }
}

/**
 * A loop's output read back: each row it took (`{ id, severity, pkg, title,
 * outcome }`, the last attempt's outcome), its summary line, and whether it
 * found nothing ready. Reads `scripts/fix-loop.mjs`'s own lines, so a change
 * to their shape there reads as a loop that took nothing.
 */
export function loopReport(text) {
  const rows = []
  let summary = null, nothing = false
  for (const line of String(text).split('\n')) {
    const row = /^\[fix-loop(?::\d+)?\] \d+\/\d+ (FJS-\d+) \(([^,]+), ([^)]+)\) — (.*)$/.exec(line)
    if (row) { rows.push({ id: row[1], severity: row[2], pkg: row[3].split(' · '), title: row[4], outcome: null }); continue }
    const tried = /^\[fix-loop(?::\d+)?\]\s+[\w.-]+\/\w+: (\w+) · \$/.exec(line)
    if (tried && rows.length) { rows.at(-1).outcome = tried[1]; continue }
    const end = /^\[fix-loop\] (\d+ closed · .*?)(?: · log .*)?$/.exec(line)
    if (end) { summary = end[1]; continue }
    if (/^\[fix-loop(?::\d+)?\] nothing ready/.test(line)) nothing = true
  }
  return { rows, summary, nothing }
}
