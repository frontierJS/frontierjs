// test/commitments-clock.test.ts
//
// Who keeps the clock a `@@commitment` is owed on (`FJS-D938`, `FJS-2708`).
//
// One commitment in a schema refused every app built over it with no
// `commitments()` — including each test file that builds `createApp` in-process
// to call services, with no queue and nothing that runs on its own clock. Such
// an app keeps no time: its test does, by setting the client's clock and firing
// what is owed with `fireDue(app)`. A process that serves, or that carries the
// queue the sweep runs on, keeps time and is still refused.
//
// The sweep and the fire WITH a queue are caravan's `test/commitments.test.ts`;
// this file needs no queue, which is the point of it.

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, createTenantRegistry } from '../../litestone/src/index.js'
import { createApp } from '../index.ts'
import type { App, Plugin } from '../index.ts'
import { fireDue } from '../src/plugins/commitments/index.ts'
import type { CommitmentHookContext } from '../src/plugins/commitments/index.ts'

const SCHEMA = `
database main { path "./app.db" }

enum OrderStatus { pending paid cancelled }

model Order {
  id        Int         @id @default(autoincrement())
  status    OrderStatus @default(pending)
  createdAt DateTime    @default(now())
  @@transitions(status,
    pay:     pending -> paid,
    abandon: pending -> cancelled @system)
  @@commitment(abandon, on: createdAt + 14d)
  @@db(main)
}
`
const GATED = SCHEMA.replace('model Order {', 'model Order {\n  @@gate("0.0.4.4")')  // the app's system principal clears 4

const DAY    = 86_400_000
const T0     = Date.parse('2026-01-01T00:00:00.000Z')
const SYSTEM = { userId: 'system', role: 'system' } as any
const CONFIG = { port: 0, services: { dir: '/nonexistent' } }

/** A plugin answering to the name `commitments()` requires — the queue, as far as the check can see. */
const queue = (): Plugin => ({ name: 'caravan', register() {} })

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

type TestApp = App & { _startForTest(): Promise<void>; _startOnce(): Promise<void>; stop(): Promise<void> }

async function build(schema = SCHEMA, { system }: { system?: unknown } = {}) {
  let t = T0
  const db = await createClient({ databases: ':memory:', schema, now: () => new Date(t) }) as any
  closers.push(() => db.$close())
  const app = createApp({ db, system, config: CONFIG } as any) as unknown as TestApp
  return {
    app, db,
    advance: (ms: number) => { t += ms },
    status:  async (id: number) => (await db.asSystem().order.findUnique({ where: { id } })).status,
  }
}

// ─── the authoring check ──────────────────────────────────────────────────────

describe('an app with no queue keeps no clock, so it is not refused', () => {

  it('_startForTest() boots a schema that owes a move', async () => {
    const { app } = await build()
    await app._startForTest()
  })

  it('_startOnce() boots it too', async () => {
    const { app } = await build()
    await app._startOnce()
  })
})

describe('a process that keeps time is still refused', () => {

  it('start() is refused with no commitments() configured, naming it', async () => {
    const { app } = await build()
    closers.push(() => app.stop().catch(() => {}))
    await expect(app.start()).rejects.toThrow(/@@commitment and no commitments\(\) plugin/)
  })

  it('_startForTest() is refused once the app carries the queue the sweep runs on', async () => {
    const { app } = await build()
    app.configure(queue())
    await expect(app._startForTest()).rejects.toThrow(/@@commitment and no commitments\(\) plugin/)
  })

  it('a schema with no commitment starts with a queue and no commitments()', async () => {
    const { app } = await build(SCHEMA.replace(/  @@commitment.*\n/, ''))
    app.configure(queue())
    await app._startForTest()
  })
})

// ─── fireDue ──────────────────────────────────────────────────────────────────

describe('fireDue(app) fires what is owed on the client\'s clock, with no queue', () => {

  it('nothing before the due time, the move after it, and nothing twice', async () => {
    const { app, db, advance, status } = await build()
    await app._startForTest()
    const order = await db.order.create({ data: {} })

    expect(await fireDue(app)).toEqual({ due: 0, fired: 0, lapsed: 0 })
    expect(await status(order.id)).toBe('pending')

    advance(14 * DAY)
    expect(await fireDue(app)).toEqual({ due: 1, fired: 1, lapsed: 0 })
    expect(await status(order.id)).toBe('cancelled')

    expect(await fireDue(app)).toEqual({ due: 0, fired: 0, lapsed: 0 })
  })

  it('a row that moved first is no longer owed', async () => {
    const { app, db, advance, status } = await build()
    await app._startForTest()
    const order = await db.order.create({ data: {} })
    await db.order.transition(order.id, 'pay')

    advance(15 * DAY)
    expect(await fireDue(app)).toEqual({ due: 0, fired: 0, lapsed: 0 })
    expect(await status(order.id)).toBe('paid')
  })

  it('the move is made as createApp({ system }), so a gated model is moved', async () => {
    const { app, db, advance, status } = await build(GATED, { system: SYSTEM })
    await app._startForTest()
    const order = await db.asSystem().order.create({ data: {} })

    advance(14 * DAY)
    expect(await fireDue(app)).toEqual({ due: 1, fired: 1, lapsed: 0 })
    expect(await status(order.id)).toBe('cancelled')
  })

  it('with no system principal a gated move fails loudly, naming the missing principal', async () => {
    const { app, db, advance, status } = await build(GATED)
    await app._startForTest()
    const order = await db.asSystem().order.create({ data: {} })

    advance(14 * DAY)
    await expect(fireDue(app)).rejects.toThrow(/createApp\(\{ system \}\)/)
    expect(await status(order.id)).toBe('pending')
  })

  it('runs the hook the app would hand commitments(), in the move\'s transaction', async () => {
    const { app, db, advance } = await build()
    await app._startForTest()
    const order = await db.order.create({ data: {} })
    const seen: Array<Pick<CommitmentHookContext, 'model' | 'commitment'> & { status: string }> = []

    advance(14 * DAY)
    await fireDue(app, { hooks: { 'Order.abandon': ({ model, commitment, record }) => {
      seen.push({ model, commitment, status: record.status })
    } } })
    expect(seen).toEqual([{ model: 'Order', commitment: 'abandon', status: 'cancelled' }])
    expect((await db.asSystem().order.findUnique({ where: { id: order.id } })).status).toBe('cancelled')
  })

  it('a hook that throws rolls the move back and fails the call', async () => {
    const { app, db, advance, status } = await build()
    await app._startForTest()
    const order = await db.order.create({ data: {} })

    advance(14 * DAY)
    await expect(fireDue(app, { hooks: { 'Order.abandon': () => { throw new Error('no renewal') } } }))
      .rejects.toThrow(/no renewal/)
    expect(await status(order.id)).toBe('pending')
  })

  it('a hook key naming no declared commitment is refused, as commitments() refuses it', async () => {
    const { app } = await build()
    await app._startForTest()
    await expect(fireDue(app, { hooks: { 'Order.lapse': () => {} } }))
      .rejects.toThrow(/'Order\.lapse', which no @@commitment declares/)
  })

  it('walks every tenant under tenancy { strategy database }', async () => {
    // An offset BEHIND the anchor, so every row is due the moment it exists: a
    // registry opens its clients itself and the test holds no clock of theirs.
    const dir  = mkdtempSync(join(tmpdir(), 'commitments-clock-'))
    const path = join(dir, 'schema.lite')
    writeFileSync(path, `
tenancy {
  strategy database
  dir      "${dir}/tenants"
  registry "${dir}/registry.db"
}
${SCHEMA.replace('database main { path "./app.db" }', '').replace('  @@db(main)\n', '').replace('createdAt + 14d', 'createdAt - 1d')}
`)
    const registry: any = await createTenantRegistry({ path })
    closers.push(() => registry.close?.())
    for (const id of ['acme', 'globex']) await registry.create(id)
    for (const id of ['acme', 'globex']) await (await registry.get(id)).asSystem().order.create({ data: {} })

    const app = createApp({ tenants: registry, config: CONFIG } as any) as unknown as TestApp
    await app._startForTest()

    expect(await fireDue(app)).toEqual({ due: 2, fired: 2, lapsed: 0 })
    for (const id of ['acme', 'globex']) {
      const [row] = await (await registry.get(id)).asSystem().order.findMany({})
      expect(row.status).toBe('cancelled')
    }
  })
})
