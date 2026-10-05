// ci-log.js — the CI run log: written by scripts/ci.mjs, read by `fli gui`.
//
// The count fixtures are real runner output, captured from bun test 1.4 and
// vitest 2.1 with FORCE_COLOR=0 — vitest colors its summary anyway, which is
// why one fixture keeps the escapes. A parser tested against output somebody
// typed passes against the format they imagined.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseCounts, openRunLog, readRuns, foldRun, latestByItem, lastFullRun,
  ciState, ciArgv, startCiRun, stopCiRun, RUNS_DIR,
} from '../core/ci-log.js'

const BUN_PASS = `bun test v1.4.2 (744846f84)

 12 pass
 0 fail
 32 expect() calls
Ran 12 tests across 1 file. [9.00ms]
`

const BUN_FAIL = `bun test v1.4.2 (744846f84)
a.test.js:
error: expect(received).toBe(expected)
Expected: 2
Received: 1
(fail) grp > breaks [0.16ms]
 1 pass
 1 skip
 1 fail
 2 expect() calls
Ran 3 tests across 1 file. [50.00ms]
`

const VITEST_PASS = ` \x1b[32m✓\x1b[39m email-kit.test.js \x1b[2m(\x1b[22m\x1b[2m102 tests\x1b[22m\x1b[2m)\x1b[22m

\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m
\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m102 passed\x1b[39m\x1b[22m\x1b[90m (102)\x1b[39m
\x1b[2m   Start at \x1b[22m 11:15:53
`

const VITEST_FAIL = ` ❯ zz-tmp-fail.test.js (3 tests | 1 failed | 1 skipped) 8ms
   × grp > breaks 6ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  zz-tmp-fail.test.js > grp > breaks
AssertionError: expected 1 to be 2 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 1 skipped (3)
`

describe('parseCounts', () => {
  test('bun test', () => {
    expect(parseCounts('bun test test/', BUN_PASS)).toEqual({ pass: 12, fail: 0, skip: 0, partial: false, failed: [] })
  })

  test('bun test, failing — the test that failed is named', () => {
    expect(parseCounts('bun test', BUN_FAIL)).toEqual({ pass: 1, fail: 1, skip: 1, partial: false, failed: ['grp > breaks'] })
  })

  test('vitest, with the colors it prints whatever FORCE_COLOR says', () => {
    expect(parseCounts('vitest run', VITEST_PASS)).toEqual({ pass: 102, fail: 0, skip: 0, partial: false, failed: [] })
  })

  test('vitest, failing', () => {
    expect(parseCounts('vitest run', VITEST_FAIL)).toEqual({ pass: 1, fail: 1, skip: 1, partial: false, failed: ['zz-tmp-fail.test.js > grp > breaks'] })
  })

  test('two bun invocations in one script are summed', () => {
    const c = parseCounts('bun test a.test.js && bun test b.test.js', BUN_PASS + BUN_FAIL)
    expect([c.pass, c.fail, c.skip, c.partial]).toEqual([13, 1, 1, false])
  })

  test('a script that also runs something unreadable is partial, not complete', () => {
    // mesa's shape: a spec check, vitest, then two CDP drives.
    const c = parseCounts('node test/spec-check.mjs && vitest run && node test/browser/runtime/run.mjs', VITEST_PASS)
    expect(c.pass).toBe(102)
    expect(c.partial).toBe(true)
  })

  test('a runner that died before its summary leaves the count partial', () => {
    expect(parseCounts('bun test a && bun test b', BUN_PASS).partial).toBe(true)
  })

  test('nothing readable is null — never 0, which has to mean "ran nothing"', () => {
    expect(parseCounts('node test/phase0.test.js', 'phase 0 ok\n')).toBeNull()
    // `bun test/run.js` runs a file; it is not bun's runner.
    expect(parseCounts('bun test/run.js', ' 3 pass\n')).toBeNull()
  })

  test('a runner that ran zero tests reads as zero', () => {
    const c = parseCounts('bun test', 'bun test v1.4.2\n\n 0 pass\n 0 fail\nRan 0 tests across 1 file. [3.00ms]\n')
    expect([c.pass, c.fail, c.partial]).toEqual([0, 0, false])
  })
})

// ─── the log ──────────────────────────────────────────────────────────────────

let root
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ci-log-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const alive = () => false

function clock(start = 1_000_000) {
  let t = start
  const now = () => t
  now.tick = ms => { t += ms }
  return now
}

function writeRun(meta, steps, { now = clock(), end = true } = {}) {
  const log = openRunLog(root, meta, { now })
  for (const [e, f, ms = 0] of steps) { now.tick(ms); log.emit(e, f) }
  if (end) log.emit('end', { ok: true, ms: 1 })
  return log
}

describe('openRunLog → readRuns', () => {
  test('a run folds into phases, steps, notes and a verdict', () => {
    const now = clock()
    const log = openRunLog(root, { commit: 'abc', dirty: false, argv: [], scope: 'full', phases: ['hygiene', 'tests'] }, { now })
    log.emit('phase', { name: 'hygiene' })
    log.emit('step', { phase: 'hygiene', status: 'ok', label: 'clean' })
    log.emit('phase-end', { name: 'hygiene', ms: 40, ok: true })
    log.emit('phase', { name: 'tests' })
    log.emit('begin', { phase: 'tests', key: 'packages/a' })
    log.emit('step', { phase: 'tests', status: 'fail', label: 'packages/a test exited 1', key: 'packages/a', ms: 900, counts: { pass: 3, fail: 1, skip: 0, partial: false, failed: ['x'] } })
    log.emit('note', { text: 'a note' })
    log.emit('phase-end', { name: 'tests', ms: 950, ok: false })
    log.emit('end', { ok: false, ms: 1000 })

    const [run] = readRuns(root, { alive })
    expect(run.status).toBe('failed')
    expect(run.commit).toBe('abc')
    expect(run.phases.map(p => [p.name, p.ok, p.ms])).toEqual([['hygiene', true, 40], ['tests', false, 950]])
    expect(run.phases[1].steps[0]).toMatchObject({ key: 'packages/a', status: 'fail', ms: 900 })
    expect(run.notes).toEqual(['a note'])
    expect(run.current).toBeNull()
  })

  test('a run whose pid is gone with no end was killed, and is not running forever', () => {
    writeRun({ scope: 'full', phases: ['tests'] }, [['phase', { name: 'tests' }]], { end: false })
    expect(readRuns(root, { alive: () => false })[0].status).toBe('aborted')
    expect(readRuns(root, { alive: () => true })[0].status).toBe('running')
  })

  test('a begin with no answering step is what is running now', () => {
    writeRun({ scope: 'full', phases: ['tests'] }, [
      ['phase', { name: 'tests' }],
      ['begin', { phase: 'tests', key: 'packages/a' }],
      ['step', { phase: 'tests', status: 'ok', label: 'packages/a', key: 'packages/a' }],
      ['begin', { phase: 'tests', key: 'packages/b' }],
    ], { end: false })
    const [run] = readRuns(root, { alive: () => true })
    expect(run.current).toMatchObject({ phase: 'tests', key: 'packages/b' })
  })

  test('half a line at the end of a log being written is skipped, not fatal', () => {
    const log = writeRun({ scope: 'full', phases: [] }, [], { end: false })
    writeFileSync(log.file, readFileSync(log.file, 'utf8') + '{"e":"pha')
    expect(readRuns(root, { alive })[0].status).toBe('aborted')
  })

  test('a log that cannot be written warns and never throws', () => {
    writeFileSync(join(root, '.cache'), 'a file where a directory goes')
    const log = openRunLog(root, { scope: 'full', phases: [] })
    expect(() => log.emit('end', { ok: true, ms: 1 })).not.toThrow()
  })

  test('old logs are pruned, newest kept', () => {
    const now = clock()
    for (let i = 0; i < 45; i++) { now.tick(1000); openRunLog(root, { scope: 'full', phases: [] }, { now }).emit('end', { ok: true, ms: 1 }) }
    const files = readdirSync(join(root, RUNS_DIR))
    expect(files.length).toBe(40)
  })

  test('foldRun refuses events that do not open with a run', () => {
    expect(foldRun([{ e: 'phase', name: 'x' }])).toBeNull()
  })
})

describe('latestByItem', () => {
  test('a narrowed rerun answers its own suite and leaves the others where the full run put them', () => {
    const now = clock()
    writeRun({ scope: 'full', argv: [], phases: ['tests'] }, [
      ['phase', { name: 'tests' }],
      ['step', { phase: 'tests', status: 'fail', label: 'a failed', key: 'packages/a', ms: 100 }],
      ['step', { phase: 'tests', status: 'ok', label: 'packages/b', key: 'packages/b', ms: 200 }],
      ['phase-end', { name: 'tests', ms: 300, ok: false }],
    ], { now })
    now.tick(60_000)
    writeRun({ scope: 'partial', argv: ['--phase', 'tests', '--only', 'packages/a'], only: 'packages/a', phases: ['tests'] }, [
      ['phase', { name: 'tests' }],
      ['step', { phase: 'tests', status: 'ok', label: 'packages/a', key: 'packages/a', ms: 120 }],
      ['phase-end', { name: 'tests', ms: 121, ok: true }],
    ], { now })

    const runs = readRuns(root, { alive })
    const by = Object.fromEntries(latestByItem(runs).map(i => [`${i.phase}:${i.key}`, i]))
    expect(by['tests:packages/a'].status).toBe('ok')
    expect(by['tests:packages/a'].scope).toBe('partial')
    expect(by['tests:packages/b'].scope).toBe('full')
    expect(by['tests:tests'].narrowed).toBe(true)
    expect(lastFullRun(runs).scope).toBe('full')
  })

  test('the usual time is a median of passing runs, so one failure or one slow run does not move it', () => {
    const now = clock()
    for (const ms of [100, 110, 5000, 105]) {
      now.tick(1000)
      writeRun({ scope: 'full', phases: ['tests'] }, [
        ['phase', { name: 'tests' }],
        ['step', { phase: 'tests', status: 'ok', label: 'a', key: 'a', ms }],
        ['phase-end', { name: 'tests', ms, ok: true }],
      ], { now })
    }
    const a = latestByItem(readRuns(root, { alive })).find(i => i.key === 'a')
    expect(a.usualMs).toBe(108)
  })

  test('a keyless failure travels on its phase with its detail, output and fix — it has no row of its own', () => {
    writeRun({ scope: 'fast', phases: ['snapshots'] }, [
      ['phase', { name: 'snapshots' }],
      ['step', { phase: 'snapshots', status: 'fail', label: 'a.snapshot.md no longer matches its source',
                 detail: 'Run it and read the diff.', output: '- old\n+ new', fix: { kind: 'snapshot', file: 'a.snapshot.md' } }],
      ['step', { phase: 'snapshots', status: 'fail', label: 'packages/a exited 1', key: 'packages/a' }],
      ['step', { phase: 'snapshots', status: 'ok', label: '3 current' }],
      ['phase-end', { name: 'snapshots', ms: 10, ok: false }],
    ])
    const phase = latestByItem(readRuns(root, { alive })).find(i => i.kind === 'phase')
    expect(phase.failures).toEqual([{
      label: 'a.snapshot.md no longer matches its source', detail: 'Run it and read the diff.',
      output: '- old\n+ new', fix: { kind: 'snapshot', file: 'a.snapshot.md' },
    }])
  })
})

describe('ciState', () => {
  test('no scripts/ci.mjs is an app, and the panel has nothing to show', () => {
    expect(ciState(root)).toEqual({ available: false })
  })

  test('the phase list comes from the newest full run', () => {
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'ci.mjs'), '')
    writeRun({ scope: 'full', argv: [], phases: ['hygiene', 'tests'] }, [])
    const s = ciState(root, { alive })
    expect(s.available).toBe(true)
    expect(s.phases).toEqual(['hygiene', 'tests'])
    expect(s.lastFull.status).toBe('passed')
  })
})

// ─── starting and stopping ────────────────────────────────────────────────────

describe('ciArgv', () => {
  test('flags are built from names, never passed through', () => {
    expect(ciArgv({ tier: 'fast' }).argv).toEqual(['--fast'])
    expect(ciArgv({ phases: ['tests'], only: 'packages/cli' }).argv).toEqual(['--phase', 'tests', '--only', 'packages/cli'])
    expect(ciArgv({}).argv).toEqual([])
  })

  test('anything that is not a name is refused', () => {
    expect(ciArgv({ phases: ['tests --update'] }).error).toBeTruthy()
    expect(ciArgv({ only: '../../etc' }).error).toBeTruthy()
    expect(ciArgv({ only: 'a b' }).error).toBeTruthy()
    expect(ciArgv({ tier: 'slow' }).error).toBeTruthy()
  })
})

describe('startCiRun / stopCiRun', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'ci.mjs'), '')
  })

  const fakeSpawn = (exitCode = null) => {
    const calls = []
    const fn = (cmd, argv, opts) => {
      calls.push({ cmd, argv, opts })
      return { pid: 4242, unref() {}, once(ev, cb) { if (ev === 'exit' && exitCode != null) cb(exitCode) } }
    }
    fn.calls = calls
    return fn
  }

  test('starts ci.mjs with the flags, in its own process group', async () => {
    const spawnFn = fakeSpawn()
    const out = await startCiRun(root, { phases: ['tests'], only: 'packages/cli' }, { spawnFn, alive, settleMs: 5 })
    expect(out).toMatchObject({ ok: true, pid: 4242, argv: ['--phase', 'tests', '--only', 'packages/cli'] })
    expect(spawnFn.calls[0].argv).toEqual([join(root, 'scripts', 'ci.mjs'), '--phase', 'tests', '--only', 'packages/cli'])
    expect(spawnFn.calls[0].opts).toMatchObject({ cwd: root, detached: true })
  })

  test('one at a time — a run already going is refused, whoever started it', async () => {
    writeRun({ scope: 'full', phases: [] }, [], { end: false })
    const out = await startCiRun(root, {}, { spawnFn: fakeSpawn(), alive: () => true, settleMs: 5 })
    expect(out).toMatchObject({ ok: false, status: 409 })
  })

  test('ci.mjs refusing its flags comes back as the error, not as a started run', async () => {
    const out = await startCiRun(root, {}, { spawnFn: fakeSpawn(2), alive, settleMs: 50 })
    expect(out).toMatchObject({ ok: false, status: 400 })
  })

  test('bad flags never reach a spawn', async () => {
    const spawnFn = fakeSpawn()
    const out = await startCiRun(root, { only: '../x' }, { spawnFn, alive, settleMs: 5 })
    expect(out.status).toBe(400)
    expect(spawnFn.calls).toEqual([])
  })

  test('stop signals the group, and falls back to the pid for a run a terminal started', () => {
    writeRun({ scope: 'full', phases: [] }, [], { end: false })
    const sent = []
    const group = stopCiRun(root, { alive: () => true, kill: (pid, sig) => sent.push([pid, sig]) })
    expect(group).toMatchObject({ ok: true, group: true })
    expect(sent[0][0]).toBe(-process.pid)

    const single = stopCiRun(root, { alive: () => true, kill: (pid) => { if (pid < 0) throw new Error('ESRCH') } })
    expect(single).toMatchObject({ ok: true, group: false })
  })

  test('nothing running is a 404', () => {
    expect(stopCiRun(root, { alive })).toMatchObject({ ok: false, status: 404 })
  })
})
