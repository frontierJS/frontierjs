// ============================================================
// tmp-run — a package's test script, with a /tmp of its own
//
//   "test": "node ../../scripts/tmp-run.mjs 'bun test test/'"
//
// Suites write under $TMPDIR and many never remove what they write:
// a few hundred bare mkdtemp calls, a litestone template per schema,
// Chrome's own temp files, a child process SIGKILLed with a tool
// call. A week of runs filled a 457GB disk (FJS-2762). So the whole
// script runs with $TMPDIR set to one directory, fjs-run-<pid>, and
// everything any of it writes lands where one owner can remove it.
//
// The run removes it on the way out. A run that never reaches its
// way out — SIGKILL — is taken by the NEXT run on the way in: a
// directory whose pid is dead belongs to nobody. A live pid, not an
// age floor, is what keeps a concurrent run safe, because nothing
// about a directory says whether its run has ended. Anything still
// running that names the dead run's directory is an orphan of that
// run and is killed first, or Chrome writes its profile back.
//
// The command is ONE argument and goes through sh, so a script that
// chains with && stays one run with one directory.
// ============================================================

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, constants } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'fjs-run-'

// What follows the script (`bun run test -t 'a name'`) arrives split, so it
// is quoted back before sh reads it.
const quote = (a) => `'${a.replaceAll(`'`, `'\\''`)}'`
const [script, ...extra] = process.argv.slice(2)
const command = [script, ...extra.map(quote)].join(' ')
if (!script) {
  console.error(`tmp-run: name the command to run, as one quoted argument`)
  process.exit(2)
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code === 'EPERM' }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// ─── reap the runs that died ─────────────────────────────────

const base = tmpdir()
const dead = []
for (const name of readdirSync(base)) {
  if (!name.startsWith(PREFIX)) continue
  const pid = Number(name.slice(PREFIX.length))
  if (pid && !alive(pid)) dead.push(join(base, name))
}
if (dead.length) {
  // The trailing slash stops fjs-run-12 from matching fjs-run-123.
  for (const dir of dead) spawnSync('pkill', ['-KILL', '-f', `${dir}/`])
  sleepSync(300)
  for (const dir of dead) try { rmSync(dir, { recursive: true, force: true }) } catch { /* read-only, or a concurrent run took it */ }
}

// ─── run ─────────────────────────────────────────────────────

const dir = join(base, `${PREFIX}${process.pid}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir)

// ─── one run per package ─────────────────────────────────────
//
// Two runs in one package share its ports and its fixture files, and
// each fails in ways that belong to neither — three sessions once ran
// `bun run test` together. So the second run refuses. The claim is the
// marker in this run's own directory, which dies with its pid like
// everything else here, so no lock is ever left behind. The marker is
// written BEFORE the scan: two runs starting together both see each
// other, and the earlier (started, pid) is the one that goes ahead.

const MARKER = '.run'
const cwd = process.cwd()
const started = Date.now()
writeFileSync(join(dir, MARKER), JSON.stringify({ cwd, command, started }))

const before = (a, b) => a.started < b.started || (a.started === b.started && a.pid < b.pid)
const me = { pid: process.pid, started }
for (const name of readdirSync(base)) {
  if (!name.startsWith(PREFIX)) continue
  const pid = Number(name.slice(PREFIX.length))
  if (!pid || pid === process.pid || !alive(pid)) continue
  let other
  try { other = { pid, ...JSON.parse(readFileSync(join(base, name, MARKER), 'utf8')) } }
  catch { continue /* still writing its marker */ }
  if (other.cwd !== cwd || !before(other, me)) continue
  const secs = Math.round((started - other.started) / 1000)
  console.error(`tmp-run: ${cwd} already has a test run going`)
  console.error(`  pid ${pid}, started ${secs}s ago: ${other.command}`)
  console.error(`  rerun when it exits, or kill ${pid}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(75)
}

const child = spawn(command, { shell: true, stdio: 'inherit', env: { ...process.env, TMPDIR: dir } })

// A Ctrl-C reaches the whole process group, the child included; this
// process has to outlive it to clean up after it.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))

child.on('exit', (code, signal) => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* the next run reaps it */ }
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0))
})
