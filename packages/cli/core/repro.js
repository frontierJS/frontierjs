// ─── repro.js — the measurement an env: timing row carries ───────────────────
//
// The reader and runner behind `fli register:repro`. An `env: timing` row is a
// GUESSED cause until something runs the test it names on a quiet machine, and
// half of them read *fails under the full suite, passes alone* — which is order
// and load at once. Three cells of N runs separate them:
//
//   alone      the file by itself, nothing beside it
//   in suite   the package's own `bun run test`, the file's result read out of
//              that run (`FJS-D1146`) — a pass alone and a fail here is a file
//              leaking state into another, which is test code
//   loaded     the file by itself beside N copies of junction's own
//              `bun run typecheck`, each restarted until the cell ends
//              (`FJS-D1148`) — hermetic, no port, db or tmp of its own
//
// ── Where a file's result is read ────────────────────────────────────────────
//
// bun prints a file's header only when that file printed something, so a clean
// file and a file that never ran look the same on stdout. Every run therefore
// asks bun for its junit report and reads the file's `<testsuite>` there. A run
// whose report does not name the file refuses the measurement: an unseen file
// is not a pass. That is also what a package script that runs `bun test` twice
// produces for a file in its first group, since the flags reach the last one.
//
// ── What it refuses ─────────────────────────────────────────────────────────
//
// A row naming no collected test, or more than one, or a drive or a spec (a
// `verify-*.mjs` holds a port and a db, which is a different measurement). A
// package whose `test` script is not `bun test`. A load whose typecheck exits
// nonzero — a load that died is no load, and its cell would read as quiet.
//
// ── The verdict ─────────────────────────────────────────────────────────────
//
// A failure alone, or a pass alone and a failure in the suite, is code: the
// loaded cell cannot change that, so it is not run, and the row loses
// `env: timing` (`repro: 9/9 alone · 3/9 in suite`). Clean in both and failing
// loaded is the environment, and the row keeps the tag with all three counts.
// Clean in all three did not reproduce; the counts are written and the tag
// stays, since nine quiet passes do not prove the guess wrong. The segment is
// written through `amendIssue`, the one writer of an open row.
//
// Zero dependencies, plain ESM — same rule as its neighbors.

import { spawn }                                         from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism, loadavg, tmpdir }        from 'node:os'
import { dirname, join, relative, resolve }              from 'node:path'

import { readRegisters } from './registers.js'

// One junction typecheck holds about 1.8 cores; N fills the machine, because a
// timeout under load is starvation and nothing starves at half load.
export const TYPECHECK_CORES = 1.8
export const DEFAULT_RUNS    = 9

export function defaultLoad(cores = availableParallelism()) {
  return Math.max(1, Math.ceil(cores / TYPECHECK_CORES))
}

const COLLECTED = /\.test\.[cm]?[jt]sx?$/
const DRIVEN    = /(^|\/)verify[^/]*\.mjs$|\.spec\.[cm]?[jt]sx?$/

// ─── the row → the test ──────────────────────────────────────────────────────

/**
 * What a row's measurement would run: `{ ok, id, test, pkgDir, junctionDir }`
 * with paths absolute, or `{ ok: false, reason }`.
 */
/** The one collected test a row links, or why it links none — the half of
 *  `reproTarget` that reads the row alone, which `env-smell` asks of every
 *  `env: timing` row so a drive row is not told to run a command that refuses. */
export function linkedTest(record, root) {
  const base   = dirname(join(root, record.file))
  const linked = (record.files ?? []).map(f => resolve(base, f))
  const driven = linked.filter(f => DRIVEN.test(f))
  const tests  = linked.filter(f => COLLECTED.test(f))
  if (driven.length && !tests.length) {
    return { reason: `names a drive or a spec (${driven.map(f => relative(root, f)).join(', ')}), which holds a port or a browser — repro measures a collected test file` }
  }
  if (!tests.length)    return { reason: 'links no *.test.* file in its Detail — link the test the row is about' }
  if (tests.length > 1) return { reason: `links ${tests.length} test files (${tests.map(f => relative(root, f)).join(', ')}) — a measurement is of one` }
  return { test: tests[0] }
}

export function reproTarget({ root, id }) {
  const doc = readRegisters(root)
  if (!doc.prefix) return refuse('package.json declares no usable registers.prefix, so no row can be read')

  const want   = String(id ?? '').trim().toUpperCase()
  const record = doc.issues.find(r => r.id.toUpperCase() === want || (r.aliases ?? []).some(a => a.toUpperCase() === want))
  if (!record)       return refuse(`no issue row has the id ${want || '(none)'}`)
  if (record.closed) return refuse(`${record.id} is closed (${record.file}:${record.line})`)

  const { test, reason } = linkedTest(record, root)
  if (reason) return refuse(`${record.id} ${reason} (${record.file}:${record.line})`)

  if (!existsSync(test)) return refuse(`${relative(root, test)} is not on disk — the row links a file that moved`)

  const pkgDir = packageOf(test, root)
  if (!pkgDir) return refuse(`no package.json above ${relative(root, test)} declares a test script`)
  const script = readJson(join(pkgDir, 'package.json'))?.scripts?.test ?? ''
  if (!/\bbun test\b/.test(script)) {
    return refuse(`${relative(root, pkgDir) || '.'}'s test script is not bun test (${script.slice(0, 60)}), so its per-file result cannot be read`)
  }

  const junctionDir = join(root, 'packages', 'junction')
  if (!readJson(join(junctionDir, 'package.json'))?.scripts?.typecheck) {
    return refuse('packages/junction has no typecheck script, and its typecheck is the load (FJS-D1148)')
  }

  return { ok: true, id: record.id, title: record.title, test, file: relative(root, test), pkgDir, junctionDir }
}

function packageOf(file, root) {
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    if (readJson(join(dir, 'package.json'))?.scripts?.test) return dir
    if (dir === root) break
  }
  return null
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// ─── the junit report ────────────────────────────────────────────────────────

/**
 * One file's result out of bun's junit report: `{ tests, failed, failures }`,
 * or `null` when the report does not name the file. `failures` is each failing
 * case's name and the first line of its message. A `describe` is a nested
 * `<testsuite>`, so cases are matched by their own `file` and the counts come
 * from the file's outermost suite, the first that names it.
 */
export function fileResult(xml, file, cwd) {
  const text  = String(xml ?? '')
  const ours  = (attrs) => { const f = attr(attrs, 'file'); return !!f && resolve(cwd, f) === file }
  const suite = [...text.matchAll(/<testsuite\b([^>]*?)\/?>/g)].find(m => ours(m[1]))
  if (!suite) return null

  const failures = []
  let cases = 0
  for (const c of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!ours(c[1])) continue
    cases++
    const f = /<(failure|error)\b([^>]*)/.exec(c[2] ?? '')
    if (f) failures.push({ name: attr(c[1], 'name'), message: (attr(f[2], 'message') || attr(f[2], 'type')).split('\n')[0] })
  }
  const counted = Number(attr(suite[1], 'failures') || 0) + Number(attr(suite[1], 'errors') || 0)
  return { tests: Math.max(Number(attr(suite[1], 'tests') || 0), cases), failed: Math.max(counted, failures.length), failures }
}

function attr(attrs = '', name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? unescapeXml(m[1]) : ''
}

function unescapeXml(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

// ─── the runs ────────────────────────────────────────────────────────────────

/**
 * Run the three cells. `onRun({ cell, run, pass, failures })` hears each run as
 * it ends, since a suite cell can take most of an hour. Answers
 * `{ ok, target, cells: [{ cell, label, pass, runs, loadAtStart, failures }] }`
 * or `{ ok: false, reason, cells }` with the cells measured before the refusal.
 */
export async function runRepro({ root, id, runs = DEFAULT_RUNS, load = defaultLoad(), onRun = () => {}, onCell = () => {} }) {
  const target = reproTarget({ root, id })
  if (!target.ok) return target

  const rel   = relative(target.pkgDir, target.test)
  const alone = ['bun', ['test', `./${rel}`]]
  const suite = ['bun', ['run', 'test']]
  const cells = []

  const plan = [
    { cell: 'alone',  label: 'alone',                 argv: alone },
    { cell: 'suite',  label: 'in suite',              argv: suite },
    { cell: 'loaded', label: `under ${load} typechecks`, argv: alone, load },
  ]

  for (const step of plan) {
    if (step.load && cells.some(c => c.pass < c.runs)) break
    const loader = step.load ? startLoad(target.junctionDir, step.load) : null
    try {
      const out = { cell: step.cell, label: step.label, pass: 0, runs: 0, loadAtStart: step.load ? null : loadavg()[0], failures: [] }
      onCell(out)
      for (let run = 1; run <= runs; run++) {
        const res = await runOnce(step.argv, target)
        const died = loader?.died()
        if (died) return { ok: false, reason: died, target, cells }
        if (!res.seen) {
          return { ok: false, reason: `run ${run} of the ${step.label} cell never reported ${rel} (${res.why}) — an unseen file is not a pass`, target, cells }
        }
        out.runs++
        if (res.pass) out.pass++
        else out.failures.push({ run, failures: res.failures })
        onRun({ cell: step.cell, label: step.label, run, pass: res.pass, failures: res.failures })
      }
      cells.push(out)
    } finally {
      loader?.stop()
    }
  }

  return { ok: true, target, cells }
}

/**
 * What the counts say: `{ code, reproduced, segment }`. `code` is a
 * failure alone or in the suite; `segment` is the row's `repro:` text, one
 * ` · ` part per cell measured.
 */
export function reproVerdict(cells) {
  const failed     = (name) => cells.some(c => c.cell === name && c.pass < c.runs)
  const code       = failed('alone') || failed('suite')
  const reproduced = code || failed('loaded')
  const segment    = `repro: ${cells.map(c => `${c.pass}/${c.runs} ${c.label}`).join(' · ')}`
  return { code, reproduced, segment }
}

async function runOnce([cmd, args], target) {
  const scratch = mkdtempSync(join(tmpdir(), 'fjs-repro-'))
  const report  = join(scratch, 'junit.xml')
  try {
    const code = await exec(cmd, [...args, '--reporter=junit', `--reporter-outfile=${report}`], {
      cwd: target.pkgDir,
      env: { ...process.env, TMPDIR: scratch },
    })
    if (!existsSync(report)) return { seen: false, why: `exit ${code}, no junit report written` }
    const r = fileResult(readFileSync(report, 'utf8'), target.test, target.pkgDir)
    if (!r)          return { seen: false, why: 'the report names other files and not this one' }
    if (!r.tests)    return { seen: false, why: 'the report holds the file with no tests in it' }
    return { seen: true, pass: r.failed === 0, failures: r.failures }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// A child is its own process group and is killed as one: `bun run` is a
// launcher, and signaling its pid leaves the tsc or the test process running.
function exec(cmd, args, opts) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'ignore', detached: true })
    const kill  = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    process.once('exit', kill)
    child.on('error', () => done(-1))
    child.on('exit', (code, signal) => { process.off('exit', kill); done(code ?? signal) })
  })
}

/**
 * N copies of junction's typecheck, each restarted as it ends. `died()` is the
 * refusal once any exits nonzero; `stop()` kills every group.
 */
function startLoad(dir, count) {
  const live = new Set()
  let died = null, stopping = false

  const one = () => {
    if (stopping || died) return
    const child = spawn('bun', ['run', 'typecheck'], { cwd: dir, stdio: 'ignore', detached: true })
    live.add(child)
    child.on('exit', (code, signal) => {
      live.delete(child)
      if (stopping) return
      if (code !== 0) { died ??= `junction's typecheck exited ${code ?? signal} under the load — a load that died is no load; run bun run typecheck in packages/junction`; return }
      one()
    })
  }

  const stop = () => {
    stopping = true
    for (const c of live) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
    live.clear()
  }
  process.once('exit', stop)
  for (let i = 0; i < count; i++) one()

  return { died: () => died, stop: () => { process.off('exit', stop); stop() } }
}

function refuse(reason) { return { ok: false, reason } }
