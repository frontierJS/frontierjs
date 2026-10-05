// ─── ci-log.js ────────────────────────────────────────────────────────────────
// The CI run log: what `scripts/ci.mjs` did, as it did it, one JSON event per
// line in `.cache/ci-runs/<id>.jsonl`. The writer is ci.mjs and the reader is
// `fli gui`, and both go through this module, so the event shape has one owner
// and the page cannot read a field the runner stopped writing.
//
// Appended DURING the run rather than written at the end, because the question
// it answers is "what is it doing right now": ci.mjs is serial and every spawn
// in it is synchronous, so a run with no log is a terminal that says nothing for
// fifteen minutes. A `begin` written before a spawn is enough to show which
// suite is running and for how long, without making the runner async.
//
// Events, each with `at` (epoch ms):
//   run        { id, pid, commit, dirty, argv, scope, only, phases }
//   phase      { name }
//   begin      { phase, key }                  something long started
//   step       { phase, key?, status, label, ms?, counts? }   ok | warn | fail
//   phase-end  { name, ms, ok }
//   note       { text }
//   end        { ok, ms }
//
// A run with no `end` whose pid is gone was killed, and reads as `aborted`
// rather than as running forever.
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join }  from 'node:path'
import { spawn } from 'node:child_process'

export const RUNS_DIR = join('.cache', 'ci-runs')

// Enough history for a median that a single slow run cannot move, and few
// enough that reading them all on a page poll stays cheap.
const KEEP = 40

// ─── writing ──────────────────────────────────────────────────────────────────

/** Open a run log under `root` and write its `run` event. A log that cannot be
 *  written is a warning and never a verdict: CI's answer does not depend on it. */
export function openRunLog(root, meta, { now = Date.now } = {}) {
  const dir = join(root, RUNS_DIR)
  const at  = now()
  const id  = `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  const file = join(dir, `${id}.jsonl`)
  let broken = false

  const emit = (e, fields = {}) => {
    if (broken) return
    try { appendFileSync(file, JSON.stringify({ e, at: now(), ...fields }) + '\n') }
    catch (err) {
      broken = true
      console.error(`[ci] run log not written (${err.message}) — the run itself is unaffected`)
    }
  }

  try { mkdirSync(dir, { recursive: true }); prune(dir) } catch {}
  emit('run', { id, pid: process.pid, ...meta })
  return { id, file, emit }
}

function prune(dir) {
  const files = runFiles(dir)
  for (const f of files.slice(0, Math.max(0, files.length - (KEEP - 1))))
    rmSync(join(dir, f), { force: true })
}

// ─── counting ─────────────────────────────────────────────────────────────────
//
// A suite's script chains runners — mesa is a spec check, vitest and two CDP
// drives — and only bun test and vitest print a summary this can read. So a
// count is honest about what it covers: `partial` when part of the script ran
// something unreadable, and null when nothing matched at all. Never 0 for
// "could not tell", because 0 is the answer that has to read as red: a vitest
// package importing `bun:test` once ran zero tests and passed.

// `bun test/run.js` runs a file and is not bun's runner, hence the space.
const RUNNER = /^(?:npx |bunx )?(?:bun test(?:\s|$)|vitest(?:\s|$))/

// vitest colors its summary whatever FORCE_COLOR says.
const ANSI = /\x1b\[[0-9;]*m/g

export function parseCounts(script, text) {
  const segments   = String(script ?? '').split(/&&|;|\|\|/).map(s => s.trim()).filter(Boolean)
  const readable   = segments.filter(s => RUNNER.test(s)).length
  const plain      = String(text ?? '').replace(ANSI, '')
  const counts     = { pass: 0, fail: 0, skip: 0, partial: false, failed: [] }
  let   summaries  = 0

  // bun: one ` N pass` / ` N fail` block per invocation, ended by `Ran N tests`.
  const ran = plain.match(/^Ran \d+ tests? across/gm)?.length ?? 0
  if (ran) {
    summaries += ran
    counts.pass += sum(plain, /^\s*(\d+) pass\s*$/gm)
    counts.fail += sum(plain, /^\s*(\d+) fail\s*$/gm)
    counts.skip += sum(plain, /^\s*(\d+) (?:skip|todo)\s*$/gm)
  }

  // vitest: `Tests  2 failed | 100 passed (102)`.
  for (const m of plain.matchAll(/^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/gm)) {
    summaries++
    for (const part of m[1].split('|')) {
      const [, n, word] = part.trim().match(/^(\d+)\s+(\w+)/) ?? []
      if (!n) continue
      if (word === 'passed') counts.pass += Number(n)
      else if (word === 'failed') counts.fail += Number(n)
      else counts.skip += Number(n)
    }
  }

  if (!summaries) return null

  counts.partial = segments.length > readable || summaries < readable
  const names = new Set()
  for (const m of plain.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/gm)) names.add(m[1])
  for (const m of plain.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)) names.add(m[1])
  counts.failed = [...names].slice(0, 30)
  return counts
}

function sum(text, re) {
  let n = 0
  for (const m of text.matchAll(re)) n += Number(m[1])
  return n
}

// ─── reading ──────────────────────────────────────────────────────────────────

function runFiles(dir) {
  try { return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() }
  catch { return [] }
}

/** Every logged run under `root`, newest first, each folded from its events. */
export function readRuns(root, { alive = pidAlive } = {}) {
  const dir = join(root, RUNS_DIR)
  return runFiles(dir).reverse().map(f => {
    let text = ''
    try { text = readFileSync(join(dir, f), 'utf8') } catch {}
    return foldRun(parseLines(text), { alive })
  }).filter(Boolean)
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    // A run being written can end on half a line.
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

/** One run's events into the shape the page reads. */
export function foldRun(events, { alive = pidAlive } = {}) {
  const head = events[0]
  if (head?.e !== 'run') return null

  const run = {
    id: head.id, pid: head.pid, at: head.at, commit: head.commit ?? null, dirty: head.dirty ?? null,
    argv: head.argv ?? [], scope: head.scope ?? 'partial', only: head.only ?? null,
    planned: head.phases ?? [], phases: [], notes: [],
    status: 'running', ms: null, current: null, lastAt: head.at,
  }
  let phase = null

  for (const ev of events.slice(1)) {
    run.lastAt = ev.at
    if (ev.e === 'phase') {
      phase = { name: ev.name, at: ev.at, ms: null, ok: null, steps: [] }
      run.phases.push(phase)
      run.current = null
    } else if (ev.e === 'begin') {
      run.current = { phase: ev.phase, key: ev.key, at: ev.at }
    } else if (ev.e === 'step') {
      phase?.steps.push({
        key: ev.key ?? null, status: ev.status, label: ev.label, ms: ev.ms ?? null, counts: ev.counts ?? null, at: ev.at,
        detail: ev.detail ?? null, output: ev.output ?? null, fix: ev.fix ?? null,
      })
      if (run.current && ev.key === run.current.key) run.current = null
    } else if (ev.e === 'phase-end') {
      if (phase?.name === ev.name) { phase.ms = ev.ms; phase.ok = ev.ok }
      run.current = null
    } else if (ev.e === 'note') {
      run.notes.push(ev.text)
    } else if (ev.e === 'end') {
      run.status = ev.ok ? 'passed' : 'failed'
      run.ms = ev.ms
      run.current = null
    }
  }

  if (run.status === 'running' && !alive(run.pid)) run.status = 'aborted'
  return run
}

export function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return err.code === 'EPERM' }
}

/** The run in progress, if any — whoever started it. */
export function activeRun(runs) {
  return runs.find(r => r.status === 'running') ?? null
}

// ─── the latest answer per item ───────────────────────────────────────────────
//
// A `--only packages/cli` rerun answers one suite, and overwriting the whole
// picture with it is how "CI passes" came to mean three partial runs stitched
// together. So each phase and each keyed step keeps its OWN latest result, with
// the run it came from, and a full run is reported separately.

/** `runs` newest first, as `readRuns` returns them. */
export function latestByItem(runs) {
  const items = new Map()
  const history = new Map()

  const record = (id, entry) => {
    if (!items.has(id)) items.set(id, entry)
    if (entry.ms != null && entry.status !== 'fail') {
      const h = history.get(id) ?? []
      if (h.length < 5) h.push(entry.ms)
      history.set(id, h)
    }
  }

  for (const run of runs) {
    if (run.status === 'running') continue
    const from = { runId: run.id, at: run.at, commit: run.commit, dirty: run.dirty, scope: run.scope }
    for (const p of run.phases) {
      if (p.ms == null) continue
      const narrowed = !!run.only && (p.name === 'tests' || p.name === 'typecheck')
      record(`phase:${p.name}`, { kind: 'phase', phase: p.name, key: p.name, status: p.ok ? 'ok' : 'fail', ms: p.ms, narrowed, failures: phaseFailures(p), ...from })
      for (const s of p.steps) {
        if (!s.key) continue
        record(`${p.name}:${s.key}`, { kind: 'step', phase: p.name, key: s.key, status: s.status, ms: s.ms, counts: s.counts, label: s.label, ...from })
      }
    }
  }

  for (const [id, entry] of items) entry.usualMs = median(history.get(id) ?? [])
  return [...items.values()]
}

// A keyed step has a row of its own; a keyless one — a hygiene finding, a stale
// snapshot — exists nowhere else, so the phase carries it or the page cannot
// say why the phase is red.
export function phaseFailures(phase) {
  return phase.steps
    .filter(s => s.status === 'fail' && !s.key)
    .map(({ label, detail, output, fix }) => ({ label, detail, output, fix }))
}

/** The newest finished run that ran every phase its tier has. */
export function lastFullRun(runs) {
  return runs.find(r => r.scope === 'full' && (r.status === 'passed' || r.status === 'failed')) ?? null
}

// ─── what the page reads ──────────────────────────────────────────────────────

export function ciScript(root) {
  return join(root, 'scripts', 'ci.mjs')
}

/** Everything `fli gui`'s CI panel shows, in one read. `runId` picks the run
 *  to show in full; the default is the newest. */
export function ciState(root, { runId = null, alive = pidAlive } = {}) {
  if (!existsSync(ciScript(root))) return { available: false }

  const runs     = readRuns(root, { alive })
  const active   = activeRun(runs)
  const selected = (runId && runs.find(r => r.id === runId)) || runs[0] || null
  const latest   = latestByItem(runs)

  // A phase's usual time beside the one running is what turns "still going"
  // into "slower than it ever is".
  const usual = Object.fromEntries(latest.filter(i => i.kind === 'phase').map(i => [i.key, i.usualMs]))
  // Two `--phase` runs share a scope and nothing else, so the same flags it is.
  const argv = (active ?? selected)?.argv.join(' ')
  const sameScope = runs.filter(r => r.status === 'passed' && r.argv.join(' ') === argv).slice(0, 5).map(r => r.ms)

  return {
    available: true,
    now:       Date.now(),
    active:    active ? summarize(active) : null,
    selected,
    usualRunMs: median(sameScope),
    usual,
    latest,
    lastFull:  summarize(lastFullRun(runs)),
    runs:      runs.slice(0, 20).map(summarize),
    phases:    knownPhases(runs),
  }
}

function summarize(run) {
  if (!run) return null
  const steps = run.phases.flatMap(p => p.steps)
  return {
    id: run.id, at: run.at, lastAt: run.lastAt, status: run.status, ms: run.ms, scope: run.scope,
    argv: run.argv, only: run.only, commit: run.commit, dirty: run.dirty,
    planned: run.planned, done: run.phases.filter(p => p.ms != null).length,
    current: run.current, phase: run.phases.at(-1)?.name ?? null, phaseAt: run.phases.at(-1)?.at ?? null,
    failures: steps.filter(s => s.status === 'fail').map(s => s.label),
  }
}

// The phase list comes from the runs rather than from ci.mjs, whose table sits
// in a script that runs CI on import. The newest full run planned every phase.
function knownPhases(runs) {
  const full = runs.find(r => r.scope === 'full')
  if (full) return full.planned
  const seen = []
  for (const r of [...runs].reverse()) for (const p of r.planned) if (!seen.includes(p)) seen.push(p)
  return seen
}

// ─── starting and stopping one ────────────────────────────────────────────────
//
// The page starts `node scripts/ci.mjs` with flags and nothing else, so a run
// from the page and one from a terminal are the same run and write the same log.
// One at a time, whoever started the first: several phases bind ports, and two
// runs at once fail each other.

const PHASE_NAME = /^[a-z]+$/
const MEMBER     = /^[A-Za-z0-9@._/-]+$/

export function ciArgv({ tier = null, phases = [], only = null } = {}) {
  const argv = []
  if (tier === 'fast') argv.push('--fast')
  else if (tier != null && tier !== 'full') return { error: `no tier called ${tier}` }
  for (const p of phases) {
    if (!PHASE_NAME.test(String(p))) return { error: `not a phase name: ${p}` }
    argv.push('--phase', p)
  }
  if (only != null) {
    if (!MEMBER.test(String(only)) || String(only).includes('..')) return { error: `not a workspace member: ${only}` }
    argv.push('--only', only)
  }
  return { argv }
}

/** Resolves once the run has either written its log or exited early — an
 *  early exit is ci.mjs refusing the flags, and the page should say so. */
export async function startCiRun(root, opts = {}, { spawnFn = spawn, alive = pidAlive, settleMs = 1500 } = {}) {
  if (!existsSync(ciScript(root))) return { ok: false, status: 404, error: 'no scripts/ci.mjs here — `bun run check` is an app\'s CI' }

  const active = activeRun(readRuns(root, { alive }))
  if (active) return { ok: false, status: 409, error: `a run is already going (pid ${active.pid}, started ${new Date(active.at).toLocaleTimeString()})` }

  const { argv, error } = ciArgv(opts)
  if (error) return { ok: false, status: 400, error }

  const dir = join(root, RUNS_DIR)
  mkdirSync(dir, { recursive: true })
  const outFile = join(dir, 'launch.out')
  const out = openSync(outFile, 'w')

  // Its own process group, so stopping it takes the suite it is in the middle
  // of with it — ci.mjs is blocked inside spawnSync and cannot forward a signal.
  const child = spawnFn(process.execPath.endsWith('node') ? process.execPath : 'node', [ciScript(root), ...argv], {
    cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env },
  })
  closeSync(out)
  child.unref?.()

  const early = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), settleMs)
    child.once?.('exit', code => { clearTimeout(timer); resolve(code) })
  })
  if (early != null && early !== 0) {
    let text = ''
    try { text = readFileSync(outFile, 'utf8').trim().split('\n').slice(-5).join('\n') } catch {}
    return { ok: false, status: 400, error: text || `ci.mjs exited ${early}` }
  }
  return { ok: true, pid: child.pid, argv }
}

export function stopCiRun(root, { alive = pidAlive, kill = process.kill.bind(process) } = {}) {
  const active = activeRun(readRuns(root, { alive }))
  if (!active) return { ok: false, status: 404, error: 'no run is going' }
  // A run the page started leads its own group; one from a terminal does not,
  // and then only ci.mjs itself is stopped and its current suite finishes alone.
  try { kill(-active.pid, 'SIGTERM'); return { ok: true, pid: active.pid, group: true } }
  catch {}
  try { kill(active.pid, 'SIGTERM'); return { ok: true, pid: active.pid, group: false } }
  catch (err) { return { ok: false, status: 500, error: err.message } }
}

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}
