/**
 * restore-drill.test.ts -- the restore drill's grading over stand-in deps, and
 * its refusals before anything starts. Nothing here reaches a box: `runDrill`
 * takes the outside world as an argument, and every start uses a stand-in
 * runner. The real thing is proved by a rehearsal on the designated Basecamp.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { writeBasecamp } from '@frontierjs/cli/core/basecamps.js'

import { blankStages, diffInventory, readDrill, runDrill, startDrill, stateOfDrill, type Deps, type Drill } from '../src/domain/charter/restore-drill.ts'

const root = mkdtempSync(join(tmpdir(), 'wb-drill-'))
const home = join(root, 'home')
const APP  = '11111111-2222-3333-4444-555555555555'
const opts = { wb: join(root, 'wb'), home, running: () => [], gate: async () => [], kept: () => [], spawnRunner: () => {} }

beforeAll(() => { writeBasecamp('box', { url: 'https://box.example.com', host: 'box', apiKey: 'sekret-admin', scopedKey: 'sekret-run', runs: true }, { home }) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const drill = (over: Partial<Drill> = {}): Drill => ({
  drill: 1, id: 'x', mode: 'real', basecamp: 'box', startedAt: '2026-11-10T00:00:00.000Z', finishedAt: null, outcome: null,
  pid: 1, current: null, sample: null, log: 'l', reinstallLog: null, stages: blankStages(), ...over,
})

/** A hub with one App and one Domain; `calls` is everything the drill did. */
function world(over: Partial<Deps> = {}) {
  const calls: string[] = []
  let clock = 1_000_000
  const rows: Record<string, any[]> = {
    '/apps':       [{ id: 'a1', name: 'ela', kind: 'container' }],
    '/domains':    [{ id: 'd1', hostname: 'ela.example.com', appId: 'a1' }],
    '/servers':    [{ id: 's1', name: 'box', get lastHeartbeatAt() { return new Date(clock + 1000).toISOString() } }],
    '/projects':   [{ id: 'p1', name: 'p' }],
    '/workspaces': [{ id: 'w1', name: 'w' }],
  }
  const deps: Deps = {
    save:  () => {},
    gate:  () => [],
    read:  async p => { calls.push(`read ${p}`); return [] },
    list:  async p => rows[p],
    call:  async (p, m) => { calls.push(`call ${p} ${m}`); return { running: true } },
    keys:  async () => [{ name: 'box', status: 200 }],
    probe: async () => ({ ok: true, status: 200, why: null }),
    box:   async (_s, what) => { calls.push(`box ${what}`); return '' },
    reinstall: plan => { calls.push(`reinstall plan=${plan}`); return { log: 'r', exit: { code: 0, signal: null } } },
    sleep: async ms => { clock += ms },
    now:   () => clock,
    ...over,
  }
  return { deps, calls, rows }
}

const outcomes = (d: Drill) => Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, v.outcome]))

describe('diffInventory', () => {
  test('names what is missing, new and renamed', () => {
    const before = { apps: [{ id: '1', label: 'a' }, { id: '2', label: 'b' }] }
    const after  = { apps: [{ id: '1', label: 'z' }, { id: '3', label: 'c' }] }
    expect(diffInventory(before, after)).toEqual(['apps: a is now z', 'apps: b is missing', 'apps: c is new'])
    expect(diffInventory(before, before)).toEqual([])
  })
})

describe('a rehearsal', () => {
  test('plans the reinstall and touches nothing', async () => {
    const { deps, calls } = world()
    const d = await runDrill(drill({ mode: 'rehearse' }), deps)
    expect(calls).toContain('reinstall plan=true')
    expect(calls.some(c => c.startsWith('box ') || c.includes(' take') || c.includes('restoreVolume'))).toBe(false)
    expect(outcomes(d)).toMatchObject({ preflight: 'passed', before: 'passed', reinstall: 'passed', hub: 'skipped', apps: 'skipped', data: 'skipped' })
    expect(d.outcome).toBe('passed')
  })

  test('reports a commit that cannot deploy and still reads the rest', async () => {
    const { deps, calls } = world({ gate: () => ['not pushed'] })
    const d = await runDrill(drill({ mode: 'rehearse' }), deps)
    expect(d.stages.preflight.detail).toContain('not pushed')
    expect(calls).toContain('reinstall plan=true')
    expect(d.outcome).toBe('failed')
  })
})

describe('a real run', () => {
  test('stops before the retire on a commit that cannot deploy', async () => {
    const { deps, calls } = world({ gate: () => ['not pushed'] })
    const d = await runDrill(drill(), deps)
    expect(calls.some(c => c.startsWith('reinstall'))).toBe(false)
    expect(d.stages.reinstall.outcome).toBe('not reached')
  })

  test('stops before the retire when a hostname is already down', async () => {
    const { deps, calls } = world({ probe: async () => ({ ok: false, status: 502, why: null }) })
    const d = await runDrill(drill(), deps)
    expect(calls.some(c => c.startsWith('reinstall'))).toBe(false)
    expect(d.stages.before.detail).toContain('ela.example.com')
  })

  test('passes when everything comes back, and skips the data check with no sample', async () => {
    const { deps, calls } = world()
    const d = await runDrill(drill(), deps)
    expect(calls).toContain('reinstall plan=false')
    expect(outcomes(d)).toMatchObject({ hub: 'passed', apps: 'passed', data: 'skipped' })
    expect(d.outcome).toBe('passed')
  })

  test('fails the hub on a missing row or a key no longer accepted', async () => {
    const w = world({ keys: async () => [{ name: 'box (run key)', status: 401 }] })
    const reinstall = w.deps.reinstall
    w.deps.reinstall = plan => { w.rows['/projects'] = []; return reinstall(plan) }
    const d = await runDrill(drill(), w.deps)
    expect(d.stages.hub.outcome).toBe('failed')
    expect(d.stages.hub.detail).toContain('projects: p is missing')
    expect(d.stages.hub.detail).toContain('box (run key)')
    expect(d.stages.data.outcome).toBe('not reached')
  })

  // A 403 is an authenticated key its scope stops, so only a 401 says the key was lost.
  test('a scoped key answering 403 is still accepted', async () => {
    const { deps } = world({ keys: async () => [{ name: 'box (run key)', status: 403 }] })
    expect((await runDrill(drill(), deps)).stages.hub.outcome).toBe('passed')
  })

  test('an outage during the reinstall fails Apps keep serving; one missed check does not', async () => {
    const during = (misses: number) => {
      let n = 0
      let ticks = 0
      const run = { log: 'r', exit: null as { code: number, signal: null } | null }
      const w = world({
        probe: async () => (++n > 1 && n <= 1 + misses ? { ok: false, status: 502, why: null } : { ok: true, status: 200, why: null }),
        reinstall: () => run,
      })
      const sleep = w.deps.sleep
      w.deps.sleep = async ms => { if (++ticks === 4) run.exit = { code: 0, signal: null }; await sleep(ms) }
      return runDrill(drill(), w.deps)
    }
    expect((await during(2)).stages.apps.detail).toContain('went down during the reinstall')
    expect((await during(1)).stages.apps.outcome).toBe('passed')
  })

  test('a failed reinstall never reaches the App data', async () => {
    const { deps, calls } = world({ reinstall: () => ({ log: 'r', exit: { code: 1, signal: null } }) })
    const d = await runDrill(drill({ sample: { record: 'r', appName: 'kept', appId: APP, hostname: null } }), deps)
    expect(d.stages.reinstall.outcome).toBe('failed')
    expect(d.stages.data.outcome).toBe('not reached')
    expect(calls.some(c => c.startsWith('box '))).toBe(false)
  })

  // The stage stops and overwrites its App, so an id the record does not name must not be touched.
  test('refuses a sample whose App is not the one its record left standing', async () => {
    const { deps, calls } = world({ read: async () => ({ name: 'ela', slug: 'ela', volumePath: '/db' }) })
    const d = await runDrill(drill({ sample: { record: 'r', appName: 'kept', appId: APP, hostname: null } }), deps)
    expect(d.stages.data.outcome).toBe('failed')
    expect(d.stages.data.detail).toContain('is not kept')
    expect(calls.some(c => c.startsWith('box '))).toBe(false)
  })

  test('refuses a sample id that is not one before it reads the hub', async () => {
    const { deps, calls } = world()
    const d = await runDrill(drill({ sample: { record: 'r', appName: 'kept', appId: 'a; rm -rf /', hostname: null } }), deps)
    expect(d.stages.data.outcome).toBe('failed')
    expect(calls.some(c => c.startsWith('box '))).toBe(false)
  })
})

describe('stateOfDrill and readDrill', () => {
  test('a record with no end is running only while its process is', () => {
    expect(stateOfDrill(drill(), () => true)).toBe('running')
    expect(stateOfDrill(drill(), () => false)).toBe('stopped')
    expect(stateOfDrill(drill({ outcome: 'failed' }), () => true)).toBe('failed')
  })
  test('with no pid yet it is starting, then stopped', () => {
    const at = Date.parse('2026-11-10T00:00:00.000Z')
    expect(stateOfDrill(drill({ pid: null }), () => true, at + 1000)).toBe('starting')
    expect(stateOfDrill(drill({ pid: null }), () => true, at + 60_000)).toBe('stopped')
  })
  test('refuses an unknown version or a missing stage by name', () => {
    expect(readDrill(JSON.stringify(drill({ drill: 2 as 1 })), 'x.json')).toEqual({ refused: expect.stringContaining('version 2') })
    const { data: _, ...five } = blankStages()
    expect(readDrill(JSON.stringify(drill({ stages: five as Drill['stages'] })), 'x.json')).toEqual({ refused: expect.stringContaining("'data'") })
  })
})

describe('startDrill', () => {
  test('refuses an unknown mode and a run nobody approved', async () => {
    expect(await startDrill({ mode: 'soon', approved: true }, opts)).toEqual({ refused: expect.stringContaining("'soon'") })
    expect(await startDrill({ mode: 'real' }, opts)).toEqual({ refused: expect.stringContaining('not approved') })
  })
  test('refuses beside other work on the box', async () => {
    expect(await startDrill({ mode: 'rehearse', approved: true }, { ...opts, running: () => [42] })).toEqual({ refused: expect.stringContaining('42') })
  })
  test('refuses a real run on a commit that cannot deploy, and allows a rehearsal of it', async () => {
    const gate = async () => ['not pushed']
    expect(await startDrill({ mode: 'real', approved: true }, { ...opts, gate })).toEqual({ refused: expect.stringContaining('not pushed') })
    expect(await startDrill({ mode: 'rehearse', approved: true }, { ...opts, gate })).toMatchObject({ mode: 'rehearse' })
  })
  test('picks a sample only from this Basecamp, and no key reaches the record', async () => {
    const kept = () => [
      { record: 'other', appName: 'o', appId: APP, hostname: null, basecamp: 'elsewhere' },
      { record: 'mine',  appName: 'm', appId: APP, hostname: null, basecamp: 'box' },
    ]
    let file = ''
    const d = await startDrill({ mode: 'rehearse', approved: true }, { ...opts, kept, spawnRunner: f => { file = f } }) as Drill
    expect(d.sample?.record).toBe('mine')
    expect(readFileSync(file, 'utf8')).not.toContain('sekret')
  })
})
