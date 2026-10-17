// prove.test.js — the order `fli prove` runs a drive's steps in.
//
// Every process and port is a fake: what is under test is the ORDER — seed,
// then servers until their ports answer, then the drive, then the stops — and
// the refusals. A server port that already answers must fail the drive and
// start nothing, or a stale server from another tree passes it (`FJS-740`).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prove, knownFailures, brokenDrives } from '../core/prove.js'
import { treeHold } from '../core/guard.js'

const API  = { id: 'surface:example/api', name: 'api', dir: 'example', kind: 'surface', port: 8110, argv: ['bun', 'run', 'api'] }
const SEED = { id: 'task:example/db:seed', name: 'db:seed', dir: 'example', kind: 'task', port: null, argv: ['bun', 'run', 'db:seed'] }

function drive(name, needs = []) {
  return { id: `drive:example/${name}`, name, dir: 'example', kind: 'drive', port: null, argv: ['bun', 'run', name], needs }
}

const need = (row, script) => ({ script, run: `bun run ${script}`, id: row?.id ?? null, kind: row?.kind ?? null, port: row?.port ?? null })

function target(row, kind = 'row') {
  return { name: row.name, dir: row.dir, where: row.dir, kind, id: row.id, command: `bun run ${row.name}` }
}

/** Processes that exit with `codes[id]` (default 0); a server "answers" once started. */
function world({ codes = {}, answeringAtStart = [] } = {}) {
  const log  = []
  const up   = new Set(answeringAtStart)
  const live = new Map()
  const procs = {
    startRow(row) {
      log.push(`start ${row.name}`)
      live.set(row.id, row)
      if (typeof row.port === 'number') up.add(row.port)
      return { ok: true, pid: 1 }
    },
    stopRow(id) {
      const row = live.get(id)
      log.push(`stop ${row?.name ?? id}`)
      if (typeof row?.port === 'number') up.delete(row.port)
      live.delete(id)
      return { ok: true }
    },
    childOf(id) {
      const row = live.get(id)
      if (!row) return null
      return { exit: typeof row.port === 'number' ? null : { code: codes[id] ?? 0 } }
    },
    outputOf: id => [`\x1b[31moutput of ${id}\x1b[0m`],
  }
  return { log, procs, answering: async port => up.has(port) }
}

const run = (w, proofs, rows) => prove({ proofs, rows, procs: w.procs, answering: w.answering, sleep: async () => {} })

describe('prove', () => {
  test('seeds, starts the server until it answers, runs the drive, then stops the server', async () => {
    const live = drive('verify:live', [need(SEED, 'db:seed'), need(API, 'api')])
    const w    = world()
    const out  = await run(w, [{ targets: [target(live)] }], [API, SEED, live])

    expect(w.log).toEqual(['start db:seed', 'stop db:seed', 'start api', 'start verify:live', 'stop verify:live', 'stop api'])
    expect(out.ran).toHaveLength(1)
    expect(out.ran[0].ok).toBe(true)
  })

  test('a server port that already answers fails the drive and starts nothing', async () => {
    const live = drive('verify:live', [need(API, 'api')])
    const w    = world({ answeringAtStart: [8110] })
    const out  = await run(w, [{ targets: [target(live)] }], [API, live])

    expect(w.log).toEqual([])
    expect(out.ran[0].ok).toBe(false)
    expect(out.ran[0].reason).toContain('8110')
    expect(out.ran[0].reason).toContain('FJS-740')
  })

  test('a Start first step the directory does not declare fails the drive', async () => {
    const live = drive('verify:live', [need(null, 'db:reseed')])
    const w    = world()
    const out  = await run(w, [{ targets: [target(live)] }], [live])

    expect(w.log).toEqual([])
    expect(out.ran[0].reason).toContain('db:reseed')
  })

  test('a failing seed stops before any server starts', async () => {
    const live = drive('verify:live', [need(SEED, 'db:seed'), need(API, 'api')])
    const w    = world({ codes: { [SEED.id]: 1 } })
    const out  = await run(w, [{ targets: [target(live)] }], [API, SEED, live])

    expect(w.log).toEqual(['start db:seed', 'stop db:seed'])
    expect(out.ran[0].ok).toBe(false)
    expect(out.ran[0].reason).toBe('db:seed exited 1')
  })

  test('a failed drive reports its exit and a tail with no escape codes, and still stops its server', async () => {
    const cart = drive('verify:cart', [need(API, 'api')])
    const w    = world({ codes: { [cart.id]: 2 } })
    const out  = await run(w, [{ targets: [target(cart)] }], [API, cart])

    expect(w.log.at(-1)).toBe('stop api')
    expect(out.ran[0]).toMatchObject({ ok: false, code: 2, reason: 'exited 2' })
    expect(out.ran[0].tail).toEqual([`output of ${cart.id}`])
  })

  test('a file target is listed, an unknown one reported, and a target named twice runs once', async () => {
    const jobs = drive('verify:jobs')
    const w    = world()
    const out  = await run(w, [
      { targets: [target(jobs), { name: 'test/x.test.js', dir: 'example', kind: 'file', command: null }] },
      { targets: [target(jobs), { name: 'verify:gone', where: 'example', dir: 'example', kind: 'unknown', command: null }] },
    ], [jobs])

    expect(out.ran).toHaveLength(1)
    expect(out.read.map(t => t.name)).toEqual(['test/x.test.js'])
    expect(out.gone.map(t => t.name)).toEqual(['verify:gone'])
  })

  test('a drive the caller skips starts nothing and is listed with its rows, not among the passes', async () => {
    const values = drive('verify:values', [need(SEED, 'db:seed'), need(API, 'api')])
    const cart   = drive('verify:cart')
    const w      = world()
    const out    = await prove({
      proofs: [{ targets: [target(values), target(cart)] }], rows: [API, SEED, values, cart],
      procs: w.procs, answering: w.answering, sleep: async () => {},
      skip: t => t.name === 'verify:values' ? ['FJS-1366'] : null,
    })

    expect(w.log).toEqual(['start verify:cart', 'stop verify:cart'])
    expect(out.ran.map(r => r.name)).toEqual(['verify:cart'])
    expect(out.skipped).toEqual([{ name: 'verify:values', dir: 'example', command: 'bun run verify:values', open: ['FJS-1366'] }])
  })

  test('a script target with no runnable row still runs, under an id of its own', async () => {
    const w   = world()
    const out = await run(w, [{ targets: [{ name: 'test:widgets', dir: 'packages/sierra', kind: 'script', id: null, command: 'bun run test:widgets' }] }], [])

    expect(w.log).toEqual(['start test:widgets', 'stop test:widgets'])
    expect(out.ran[0]).toMatchObject({ ok: true, command: 'bun run test:widgets' })
  })
})

describe('holds', () => {
  const held = (name, holds) => ({ ...drive(name), holds })

  // `busy` resources answer held by a pid until `free` is called, as a peer's prove would.
  function table(busy = []) {
    const log  = []
    const busyNow = new Set(busy)
    return {
      log, free: name => busyNow.delete(name),
      hold(name) {
        if (busyNow.has(name)) { log.push(`wait ${name}`); return { ok: false, by: 4242 } }
        log.push(`take ${name}`)
        return { ok: true, release: () => log.push(`release ${name}`) }
      },
    }
  }

  const go = (w, t, d, extra = {}) => prove({ proofs: [{ targets: [target(d)] }], rows: [d], procs: w.procs, answering: w.answering, sleep: async () => {}, hold: t.hold, ...extra })

  test('takes what the drive holds in the table order, and releases after it stops', async () => {
    const d = held('verify:pay', ['db', 'ports'])
    const w = world()
    const t = table()
    const out = await go(w, t, d)

    expect(out.ran[0].ok).toBe(true)
    expect(t.log).toEqual(['take ports', 'take db', 'release db', 'release ports'])
  })

  test('a drive holding nothing asks for nothing', async () => {
    const w = world()
    const t = table()
    await go(w, t, drive('verify:cart'))
    expect(t.log).toEqual([])
  })

  test('waits while another run holds the resource, says so once, and then runs', async () => {
    const d = held('verify:pay', ['ports'])
    const w = world()
    const t = table(['ports'])
    const said = []
    let polls = 0
    const out = await go(w, t, d, { say: l => said.push(l), sleep: async () => { if (++polls === 3) t.free('ports') } })

    expect(out.ran[0].ok).toBe(true)
    expect(t.log.filter(l => l === 'wait ports')).toHaveLength(3)
    expect(said.filter(l => l.includes('waiting on ports'))).toHaveLength(1)
    expect(said.find(l => l.includes('waiting on ports'))).toContain('4242')
    expect(w.log).toEqual(['start verify:pay', 'stop verify:pay'])
  })

  test('a hold never freed fails the drive by name and starts nothing', async () => {
    const d = held('verify:pay', ['db'])
    const w = world()
    const t = table(['db'])
    const out = await go(w, t, d, { holdMs: 3000 })

    expect(out.ran[0].ok).toBe(false)
    expect(out.ran[0].reason).toContain('db still held by pid 4242')
    expect(w.log).toEqual([])
  })

  test('a second resource that cannot be taken gives back the first', async () => {
    const d = held('verify:pay', ['ports', 'db'])
    const w = world()
    const t = table(['db'])
    const out = await go(w, t, d, { holdMs: 1000 })

    expect(out.ran[0].ok).toBe(false)
    expect(t.log).toContain('release ports')
    expect(t.log.at(-1)).toBe('release ports')
  })

  test('a resource the table does not name fails the drive rather than holding nothing', async () => {
    const d = held('verify:pay', ['port'])
    const w = world()
    const t = table()
    const out = await go(w, t, d)

    expect(out.ran[0].reason).toContain('`port`')
    expect(out.ran[0].reason).toContain('ports, db')
    expect(t.log).toEqual([])
    expect(w.log).toEqual([])
  })

  test('a failed drive still releases', async () => {
    const d = held('verify:pay', ['ports'])
    const w = world({ codes: { [d.id]: 1 } })
    const t = table()
    const out = await go(w, t, d)

    expect(out.ran[0].ok).toBe(false)
    expect(t.log.at(-1)).toBe('release ports')
  })
})

describe('treeHold', () => {
  test('one checkout holds a resource once, another checkout and another resource are free, and release gives it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-holds-'))
    try {
      const a = treeHold('/tmp/tree-a', dir)
      const b = treeHold('/tmp/tree-b', dir)

      const first = a('ports')
      expect(first.ok).toBe(true)
      // Held by this very process, which is alive, so a second asker is refused naming it.
      expect(a('ports')).toEqual({ ok: false, by: process.pid })
      expect(a('db').ok).toBe(true)
      expect(b('ports').ok).toBe(true)

      first.release()
      expect(a('ports').ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a hold left by a process that died is taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fli-holds-'))
    try {
      const hold = treeHold('/tmp/tree-a', dir)
      hold('ports')
      // Rewrite the guard as a pid nothing is running.
      const [file] = readdirSync(dir)
      writeFileSync(join(dir, file), '2147483646')
      expect(hold('ports').ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('knownFailures', () => {
  const issues = [
    { id: 'FJS-1', closed: false, body: 'the offline shell grew — verify:shell fails on size' },
    { id: 'FJS-2', closed: true,  body: 'verify:shell was red once' },
    { id: 'FJS-3', closed: false, body: 'verify:shell:strict is a different drive' },
    { id: 'FJS-4', closed: false, body: 'run verify and bun run test first' },
  ]

  test('an open row naming the drive, and not a closed one or a longer name', () => {
    expect(knownFailures(issues, 'verify:shell')).toEqual(['FJS-1'])
  })

  test('a name with no colon is prose and looks nothing up', () => {
    expect(knownFailures(issues, 'verify')).toEqual([])
    expect(knownFailures(issues, 'bun run test')).toEqual([])
  })
})

describe('brokenDrives', () => {
  const issues = [
    { id: 'FJS-1', closed: false, title: 'verify:values hangs: a CDP evaluate times out at HEAD',        body: 'verify:values hangs' },
    { id: 'FJS-2', closed: false, title: 'relation filters drop a row — prove with verify:values',       body: 'prove with verify:values' },
    { id: 'FJS-3', closed: true,  title: 'verify:values was red once',                                   body: 'verify:values was red once' },
    { id: 'FJS-4', closed: false, title: 'verify:values:strict is a different drive',                    body: 'verify:values:strict' },
  ]

  test('only an open row whose title opens with the drive — a row citing it as its proof is the reason to run it', () => {
    expect(brokenDrives(issues, 'verify:values')).toEqual(['FJS-1'])
    expect(knownFailures(issues, 'verify:values')).toEqual(['FJS-1', 'FJS-2'])
  })

  test('a name with no colon looks nothing up', () => {
    expect(brokenDrives(issues, 'verify')).toEqual([])
  })
})
