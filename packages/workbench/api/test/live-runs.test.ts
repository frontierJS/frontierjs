/**
 * live-runs.test.ts -- the live record read on Workbench's side, and the
 * Charter page's runs refused before they spawn (charter-to-live.md 2.3).
 * Nothing here spawns live.ts: every start is refused first, because one that
 * got as far as the child would deploy to a box. The checkout is a temp dir.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { writeBasecamp } from '@frontierjs/cli/core/basecamps.js'

import { readLiveRecord, stateOf, STAGES, type LiveRecord } from '../src/domain/charter/live-record.ts'
import { addCharter, keptApps, listCases, removeKept, startRun, stateOfRuns } from '../src/domain/charter/live-runs.ts'

const root = mkdtempSync(join(tmpdir(), 'wb-live-'))
const dir  = join(root, 'charter')
const home = join(root, 'home')
const opts = { dir, wb: join(root, 'workbench'), home, running: () => [] }

const stages = Object.fromEntries(STAGES.map(s => [s, { outcome: 'passed', ms: 1000, detail: s }]))
const record = (over: Record<string, unknown> = {}) => ({
  live: 1, case: '01-saas-signup', charter: 'corpus/live/01-saas-signup.json', date: '2026-11-07', keep: false,
  startedAt: '2026-11-07T10:00:00.000Z', stages, ...over,
})
const read = (o: object) => readLiveRecord(JSON.stringify(o), 'runs/x.json')

beforeAll(() => {
  mkdirSync(join(dir, 'builder'), { recursive: true })
  mkdirSync(join(dir, 'corpus/live'), { recursive: true })
  mkdirSync(join(dir, 'runs'), { recursive: true })
  writeFileSync(join(dir, 'builder/live.ts'), '')
  writeFileSync(join(dir, 'package.json'), '{"name":"charter"}')
  for (const c of ['01-saas-signup', '02-saas-admin']) writeFileSync(join(dir, `corpus/live/${c}.json`), '{}')
  writeFileSync(join(dir, 'runs/2026-11-07-live-01-saas-signup.json'), JSON.stringify(record({ finishedAt: 'x', outcome: 'passed' })))
  writeFileSync(join(dir, 'runs/2026-11-07-live-02-saas-admin.json'), JSON.stringify(record({
    case: '02-saas-admin', keep: true, finishedAt: 'x', outcome: 'failed', deploy: { basecamp: 'box', appName: '02-saas-admin-1107-1200', appId: 'a1', hostname: 'h.example.com' },
  })))
  writeFileSync(join(dir, 'runs/2026-11-07-live-03-saas-invite.json'), JSON.stringify(record({ case: '03-saas-invite', live: 2 })))
  writeBasecamp('box', { url: 'https://box.example.com', host: 'box', apiKey: 'admin', runs: true }, { home })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('readLiveRecord', () => {
  test('reads the six stages in order', () => {
    const r = read(record()) as LiveRecord
    expect(Object.keys(r.stages)).toEqual([...STAGES])
  })

  // FJS-D2025: a stage or version Workbench does not know is refused by name.
  test('refuses an unknown version, stage or outcome by name', () => {
    expect(read(record({ live: 2 }))).toEqual({ refused: expect.stringContaining('version 2') })
    expect(read(record({ stages: { ...stages, ship: { outcome: 'passed', ms: 0, detail: '' } } }))).toEqual({ refused: expect.stringContaining("'ship'") })
    const { use: _, ...five } = stages
    expect(read(record({ stages: five }))).toEqual({ refused: expect.stringContaining("missing stage 'use'") })
    expect(read(record({ stages: { ...stages, deploy: { outcome: 'pending', ms: 0, detail: '' } } }))).toEqual({ refused: expect.stringContaining('"pending"') })
  })
})

describe('stateOf', () => {
  test('a record with no finishedAt is running only while its pid is', () => {
    const r = read(record({ pid: 4242 })) as LiveRecord
    expect(stateOf(r, () => true)).toBe('running')
    expect(stateOf(r, () => false)).toBe('stopped')
    expect(stateOf(read(record()) as LiveRecord, () => true)).toBe('stopped')
    expect(stateOf(read(record({ finishedAt: 'x', outcome: 'failed' })) as LiveRecord)).toBe('failed')
  })
})

describe('the checkout', () => {
  test('lists the corpus cases, then a picked charter', () => {
    expect(addCharter({ name: 'my-app.json', text: '{"name":"x"}' }, opts)).toMatchObject({ case: 'my-app', source: 'picked' })
    expect(listCases(opts).map(c => c.case)).toEqual(['01-saas-signup', '02-saas-admin', 'my-app'])
  })

  test('refuses a picked charter that would share a corpus case record, or is not JSON', () => {
    expect(addCharter({ name: '01-saas-signup.json', text: '{}' }, opts)).toEqual({ refused: expect.stringContaining('corpus case') })
    expect(addCharter({ name: 'bad.json', text: '{' }, opts)).toEqual({ refused: expect.stringContaining('not JSON') })
  })

  test('a kept App is listed; a refused record is named, not dropped', async () => {
    expect(keptApps(opts)).toEqual([expect.objectContaining({ appName: '02-saas-admin-1107-1200', record: 'runs/2026-11-07-live-02-saas-admin.json' })])
    const s = await stateOfRuns(opts)
    expect(s.refused).toEqual([{ file: 'runs/2026-11-07-live-03-saas-invite.json', refused: expect.stringContaining('version 2') }])
  })
})

describe('starting', () => {
  test('refuses an unknown case, an unapproved run, and a box with no run key', async () => {
    expect(await startRun({ cases: ['99-nope'], approved: true }, opts)).toEqual({ refused: expect.stringContaining("'99-nope'") })
    expect(await startRun({ cases: ['01-saas-signup'] }, opts)).toEqual({ refused: expect.stringContaining('not approved') })
    expect(await startRun({ cases: ['01-saas-signup'], approved: true }, opts)).toEqual({ refused: expect.stringContaining('run key') })
  })

  test('refuses while another live.ts runs on this machine', async () => {
    expect(await startRun({ cases: ['01-saas-signup'], approved: true }, { ...opts, running: () => [777] })).toEqual({ refused: expect.stringContaining('pid 777') })
  })

  test('removes only a record that kept an App', async () => {
    expect(await removeKept({ record: 'runs/2026-11-07-live-01-saas-signup.json', approved: true }, opts)).toEqual({ refused: expect.stringContaining('keeps no App') })
    expect(await removeKept({ record: 'runs/2026-11-07-live-02-saas-admin.json' }, opts)).toEqual({ refused: expect.stringContaining('not approved') })
  })
})
