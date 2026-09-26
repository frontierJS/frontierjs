// prove.test.js — the order `fli prove` runs a drive's steps in.
//
// Every process and port is a fake: what is under test is the ORDER — seed,
// then servers until their ports answer, then the drive, then the stops — and
// the refusals. A server port that already answers must fail the drive and
// start nothing, or a stale server from another tree passes it (`FJS-740`).

import { describe, test, expect } from 'bun:test'

import { prove } from '../core/prove.js'

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

  test('a script target with no runnable row still runs, under an id of its own', async () => {
    const w   = world()
    const out = await run(w, [{ targets: [{ name: 'test:widgets', dir: 'packages/sierra', kind: 'script', id: null, command: 'bun run test:widgets' }] }], [])

    expect(w.log).toEqual(['start test:widgets', 'stop test:widgets'])
    expect(out.ran[0]).toMatchObject({ ok: true, command: 'bun run test:widgets' })
  })
})
