// feeders.test.js — the feed loop's pure half: which CI steps are red, the one
// title each files under, and what a run does about each under its cap.
//
// What can be WRONG: a known failure CI already names filed as new, the same
// red filed twice because its title carried a count, an environment failure
// filed as a defect, a persistent red growing its row on every run, and a
// row filed past the day's cap.

import { describe, test, expect } from 'bun:test'

import { STRANGER_STEPS, ciTitle, strangerTitle, areaOf, failuresOf, strangerFailure, squash, detailOf, amendedToday, plan } from '../../../scripts/feeders.mjs'

const run = {
  id: 'r1', status: 'failed', commit: 'abc1234',
  phases: [
    { name: 'tests', ok: false, steps: [
      { key: 'packages/cli', status: 'ok', label: 'packages/cli' },
      { key: 'packages/mesa', status: 'warn', label: 'packages/mesa (known failure)' },
      { key: 'packages/junction', status: 'fail', label: 'packages/junction test exited 1', output: 'x.test.ts:\n  ✗ a thing\n   expected 1 got 2' },
    ] },
    { name: 'snapshots', ok: false, steps: [{ key: null, status: 'fail', label: 'surface.snapshot.md no longer matches its source', detail: 'cd . && bunx fli ws:surface' }] },
    { name: 'hygiene', ok: true, steps: [{ key: null, status: 'ok', label: 'clean' }] },
  ],
}

describe('titles and areas', () => {
  test('a title is the phase and the key, or the label when there is no key, and never a count or a code', () => {
    expect(ciTitle('tests', { key: 'packages/junction', label: 'packages/junction test exited 1' })).toBe('CI red: tests · packages/junction')
    expect(ciTitle('snapshots', { key: null, label: 'surface.snapshot.md no longer matches its source' })).toBe('CI red: snapshots · surface.snapshot.md no longer matches its source')
    expect(ciTitle('structure', { key: null, label: 'packages/basecamp — 1 rule(s) above check-baseline.json' })).toBe('CI red: structure · packages/basecamp — rules above check-baseline.json')
    expect(ciTitle('registers', { key: null, label: '5 register finding(s)' })).toBe('CI red: registers · register findings')
    expect(ciTitle('tests', { key: null, label: 'example test exited 1 in 42.1s' })).toBe('CI red: tests · example test')
    expect(strangerTitle('install')).toBe("A stranger's build from npm stalls at install")
    expect(STRANGER_STEPS).toEqual(['new', 'check', 'build'])
  })

  test('the area is the package the key or label names, example for the kitchen sink, repo otherwise', () => {
    expect(areaOf('packages/junction')).toBe('junction')
    expect(areaOf('perf:packages/litestone')).toBe('litestone')
    expect(areaOf('example test exited 1')).toBe('example')
    expect(areaOf('biome lint exited 1')).toBe('repo')
  })
})

describe('failuresOf', () => {
  test('every fail step is a failing unit; ok and warn steps are not', () => {
    const got = failuresOf(run)
    expect(got.map(f => [f.phase, f.title, f.area])).toEqual([
      ['tests', 'CI red: tests · packages/junction', 'junction'],
      ['snapshots', 'CI red: snapshots · surface.snapshot.md no longer matches its source', 'repo'],
    ])
    expect(got[0].output).toContain('expected 1 got 2')
    expect(failuresOf(null)).toEqual([])
  })
})

describe('the row', () => {
  test('squash flattens output and cuts it with an ellipsis', () => {
    expect(squash('\u001b[31m✗\u001b[0m  a\n\n  b   c')).toBe('✗ a b c')
    expect(squash('abcdefghij', 5)).toBe('abcd…')
  })

  test('the detail says who filed it, off what, and the failure in its own words', () => {
    const f = failuresOf(run)[0]
    const d = detailOf('ci', f, { run: 'r1', commit: 'abc1234', cites: 'FJS-9' })
    expect(d).toContain('Filed by the ci feeder off run r1 at abc1234')
    expect(d).toContain('packages/junction test exited 1')
    expect(d).toContain('output: x.test.ts: ✗ a thing expected 1 got 2')
    expect(d).toContain('came back after `FJS-9`')
    expect(d).not.toContain('\n')
    const s = strangerFailure({ step: 'install', cmd: 'bun install', code: 1, output: 'No version matching 0.16.8', version: '0.1.11', app: 'demo' })
    expect(s).toMatchObject({ title: "A stranger's build from npm stalls at install", area: 'cli' })
    expect(detailOf('stranger', s)).toContain('`bun install` exited 1 in `demo`, a fresh `fli new --full --source npm` from @frontierjs/cli@0.1.11')
  })
})

describe('plan', () => {
  const today = new Date('2026-11-03T04:10:00')
  const at    = h => new Date(today.getTime() - h * 36e5).toISOString()
  const f     = (title, extra = {}) => ({ title, area: 'repo', label: title, ...extra })
  const rows  = {
    'CI red: tests · packages/junction': [{ id: 'FJS-1', closed: false }],
    'CI red: tests · packages/mesa':     [{ id: 'FJS-2', closed: false }],
    'CI red: lint · biome':              [{ id: 'FJS-3', closed: true }],
  }
  const titled = t => rows[t] ?? []
  const smells = t => /timed out/.test(t)

  test('an open row is amended, once a day; a closed one is cited by a new row; a smell is env; the cap holds the rest', () => {
    const log = [{ at: at(2), feeder: 'ci', outcome: 'red', filed: ['FJS-9'], amended: ['FJS-2'] }]
    const got = plan({
      failures: [f('CI red: tests · packages/junction'), f('CI red: tests · packages/mesa'), f('CI red: lint · biome'), f('CI red: tests · packages/x timed out'), f('CI red: a'), f('CI red: b'), f('CI red: a')],
      titled, log, cap: 3, filedToday: 1, smells, today,
    })
    expect(got.amend.map(r => r.id)).toEqual(['FJS-1'])
    expect(got.skip.map(r => r.id)).toEqual(['FJS-2'])
    expect(got.env.map(r => r.title)).toEqual(['CI red: tests · packages/x timed out'])
    expect(got.file.map(r => [r.title, r.cites])).toEqual([['CI red: lint · biome', 'FJS-3'], ['CI red: a', null]])
    expect(got.held.map(r => r.title)).toEqual(['CI red: b'])
  })

  test('no cap files nothing, and a cap already spent holds everything new while open rows are still amended', () => {
    expect(plan({ failures: [f('CI red: a')], titled, today }).held).toHaveLength(1)
    const got = plan({ failures: [f('CI red: a'), f('CI red: tests · packages/junction')], titled, cap: 3, filedToday: 3, today })
    expect(got.held.map(r => r.title)).toEqual(['CI red: a'])
    expect(got.amend.map(r => r.id)).toEqual(['FJS-1'])
  })

  test('amendedToday reads the day\'s lines only', () => {
    expect(amendedToday([{ at: at(1), amended: ['FJS-2'] }], 'FJS-2', today)).toBe(true)
    expect(amendedToday([{ at: at(30), amended: ['FJS-2'] }], 'FJS-2', today)).toBe(false)
    expect(amendedToday([{ at: at(1), filed: ['FJS-2'] }], 'FJS-2', today)).toBe(false)
  })
})
