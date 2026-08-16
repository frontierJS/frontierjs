// tests/data-write-announcement.test.ts
//
// FJS-010 — a write that never went through a service announced nothing.
// `callService` is the single announcement point, so a `db.asSystem()` write in
// a job, a raw route or a Litestone plugin left every open tab holding the
// stale row with a 200.
//
// Litestone's `onEvent` is fixed at `createClient`, which happens before
// Junction exists; `$tapEvents` is the post-construction half it grew for this
// (FJS-D04). `announceDataWrites` installs the tap and routes what it sees into
// the same bus + channel fan-out `callService` uses.
//
// A REAL Litestone client throughout. A fake would pass every one of these and
// prove nothing: the whole mechanism is a Proxy accessor that throws on an
// unknown property, an emitter that defers a tick, and an AsyncLocalStorage
// scope that has to survive that deferral.
//
// Two traps this file exists to pin:
//
//   • Every service write ALSO passes the tap. Suppression is by service name,
//     not by a boolean — a blanket "am I in a call" swallowed the audit row an
//     orders hook writes, which is a different service and genuinely unannounced.
//   • The emitter fires through setImmediate, so the ALS scope read in the tap
//     is the one captured at schedule time. If that ever stops propagating,
//     every service write announces twice and `no double announcement` is the
//     test that says so.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { channels } from '../src/transport/channels.ts'

const SCHEMA = `
  model Order { id Int @id  status String }
  model Audit { id Int @id  note   String }
`

// The emitter defers one event-loop tick (setImmediate), so nothing it fires is
// visible in the same tick. Yield once — there is no timed buffer to wait for.
const tick = () => new Promise((r) => setImmediate(r))

async function mkApp(opts: { channel?: string | ((...a: unknown[]) => unknown) } = {}) {
  const db = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({ db: db as never })
  app.services.register(createService({
    name: 'orders', model: 'Order', db: db as never,
    ...(opts.channel !== undefined ? { channel: opts.channel as never } : {}),
  }))
  app.services.register(createService({ name: 'audits', model: 'Audit', db: db as never }))
  // The channel manager is a plugin, not a default — `app.channels` is
  // undefined until it is configured, which is also why the tap reads it
  // lazily rather than capturing it at install time.
  if (opts.channel !== undefined) app.configure(channels(() => {}))
  await app._startForTest()

  const seen: string[] = []
  for (const e of ['orders:created', 'orders:updated', 'orders:removed', 'audits:created']) {
    app.events.on(e, (row: { id: number }) => { seen.push(`${e}#${row.id}`) })
  }
  // A different payload, so a different collector: `changed` names no row and
  // carries a count instead.
  const changed: Array<Record<string, unknown>> = []
  app.events.on('orders:changed', (d: Record<string, unknown>) => { changed.push(d) })
  return { db: db as never as Record<string, never> & Record<string, unknown>, app, seen, changed }
}

describe('a write nothing announced (FJS-010)', () => {

  test('an asSystem() write announces on the bus', async () => {
    const { db, seen } = await mkApp()
    await (db as never as { asSystem(): { order: { create(a: unknown): Promise<unknown> } } })
      .asSystem().order.create({ data: { status: 'from-job' } })
    await tick()
    expect(seen).toEqual(['orders:created#1'])
  })

  test('update and remove announce too', async () => {
    const sys = (d: unknown) => (d as { asSystem(): Record<string, Record<string, (a: unknown) => Promise<unknown>>> }).asSystem()
    const { db, seen } = await mkApp()
    await sys(db).order.create({ data: { status: 'a' } })
    await sys(db).order.update({ where: { id: 1 }, data: { status: 'b' } })
    await sys(db).order.remove({ where: { id: 1 } })
    await tick()
    expect(seen).toEqual(['orders:created#1', 'orders:updated#1', 'orders:removed#1'])
  })

  test('no double announcement for a write through the service', async () => {
    const { app, seen } = await mkApp()
    await app.service('orders').create({ status: 'a' })
    await tick()
    expect(seen.filter(s => s.startsWith('orders:created'))).toHaveLength(1)
  })

  // The reason suppression is keyed on the service name. `orders created`
  // says nothing about the Audit row, so swallowing it loses a real event.
  test('a write to another model from inside a hook still announces', async () => {
    const { db, app, seen } = await mkApp()
    const sys = () => (db as never as { asSystem(): { audit: { create(a: unknown): Promise<unknown> } } }).asSystem()
    app.services.get('orders')!.hooks({
      after: { create: [async () => { await sys().audit.create({ data: { note: 'x' } }) }] },
    })
    await app.service('orders').create({ status: 'a' })
    await tick()
    expect(seen.filter(s => s.startsWith('orders:created'))).toHaveLength(1)
    expect(seen.filter(s => s.startsWith('audits:created'))).toHaveLength(1)
  })

  // A depth counter shared between interleaved calls decrements under the wrong
  // one; this is what would catch that.
  test('concurrent service calls and an orphan write each announce once', async () => {
    const { db, app, seen } = await mkApp()
    const sys = () => (db as never as { asSystem(): { order: { create(a: unknown): Promise<unknown> } } }).asSystem()
    await Promise.all([
      app.service('orders').create({ status: 'p1' }),
      app.service('orders').create({ status: 'p2' }),
      sys().order.create({ data: { status: 'orphan' } }),
    ])
    await tick()
    expect(seen.filter(s => s.startsWith('orders:created'))).toHaveLength(3)
  })

  test('a model no service is built over is silent, not an error', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'orders', model: 'Order', db: db as never }))
    await app._startForTest()
    const seen: string[] = []
    app.events.on('audits:created', () => { seen.push('audits') })
    await (db as never as { asSystem(): { audit: { create(a: unknown): Promise<unknown> } } })
      .asSystem().audit.create({ data: { note: 'nobody serves this' } })
    await tick()
    expect(seen).toEqual([])
  })

  // A Litestone client throws on an unknown property, so probing for
  // $tapEvents is itself a throwing expression. An older client must leave the
  // app running rather than take createApp down.
  test('a client that throws on the probe leaves the app working', async () => {
    const thrower = new Proxy({ $setAuth: () => thrower }, {
      get(t, p) {
        if (p in t) return (t as Record<string | symbol, unknown>)[p]
        throw new Error(`"${String(p)}" is not a table in this schema.`)
      },
    })
    expect(() => createApp({ db: thrower as never })).not.toThrow()
  })
})

// A write that cannot name its row is still a write, and dropping it is what
// the tap did for as long as it existed (FJS-307). Two arrive here — a bulk
// statement that answers `{count}`, and a `select: false` write that skipped
// its RETURNING — and they announce as `changed`, because the only honest
// answer on the other side is the same for both: ask the query again.
describe('a write with no row to hand over (FJS-307)', () => {

  const sys = (d: unknown) => (d as { asSystem(): Record<string, Record<string, (a: unknown) => Promise<unknown>>> }).asSystem()

  test('a bulk write announces changed, with the operation and the count', async () => {
    const { db, changed } = await mkApp()
    await sys(db).order.createMany({ data: [{ status: 'a' }, { status: 'b' }, { status: 'c' }] })
    await tick()
    expect(changed).toEqual([{ model: 'Order', operation: 'createMany', count: 3, where: undefined }])
  })

  test('every bulk method reaches it, not just create', async () => {
    const { db, changed } = await mkApp()
    await sys(db).order.createMany({ data: [{ status: 'a' }, { status: 'b' }] })
    await sys(db).order.updateMany({ where: { status: 'a' }, data: { status: 'z' } })
    await sys(db).order.deleteMany({ where: {} })
    await tick()
    expect(changed.map(c => `${c.operation}#${c.count}`))
      .toEqual(['createMany#2', 'updateMany#1', 'deleteMany#2'])
  })

  // The case that says `scope` has to be stated rather than read off `result`:
  // one row changed and this write cannot say which.
  test('a select: false write announces changed too', async () => {
    const { db, changed } = await mkApp()
    await sys(db).order.create({ data: { status: 'quiet' }, select: false })
    await tick()
    expect(changed).toHaveLength(1)
    expect(changed[0]!.operation).toBe('create')
    expect(changed[0]!.count).toBe(1)
  })

  test('a bulk write that matched nothing announces nothing', async () => {
    const { db, changed, seen } = await mkApp()
    await sys(db).order.updateMany({ where: { status: 'no-such' }, data: { status: 'z' } })
    await tick()
    expect(changed).toEqual([])
    expect(seen).toEqual([])
  })

  // Same rule as a row event: `callService` already announced for the service
  // whose call this is.
  test('a bulk write through the service is not announced twice', async () => {
    const { db, app, changed } = await mkApp()
    app.services.get('orders')!.hooks({
      after: { create: [async () => { await sys(db).order.updateMany({ where: {}, data: { status: 'swept' } }) }] },
    })
    await app.service('orders').create({ status: 'a' })
    await tick()
    expect(changed).toEqual([])
  })
})

describe('the socket half', () => {

  test('a string channel: broadcasts an orphan write', async () => {
    const { db, app } = await mkApp({ channel: 'orders' })
    const frames: string[] = []
    // Stand in for a subscribed browser at the one seam a broadcast has to
    // cross — the connection's socket.
    app.channels!.channel('orders').join({
      socket: { readyState: 1, send: (f: string) => { frames.push(f); return 1 } },
    } as never)

    await (db as never as { asSystem(): { order: { create(a: unknown): Promise<unknown> } } })
      .asSystem().order.create({ data: { status: 'from-job' } })
    await tick()

    expect(frames).toHaveLength(1)
    const frame = JSON.parse(frames[0]!)
    expect(frame.event).toBe('orders created')
    expect(frame.data.status).toBe('from-job')
  })

  test('a bulk write broadcasts changed, and the filter does not go with it', async () => {
    const { db, app, changed } = await mkApp({ channel: 'orders' })
    const frames: string[] = []
    app.channels!.channel('orders').join({
      socket: { readyState: 1, send: (f: string) => { frames.push(f); return 1 } },
    } as never)

    const sys = (d: unknown) => (d as { asSystem(): Record<string, Record<string, (a: unknown) => Promise<unknown>>> }).asSystem()
    await sys(db).order.createMany({ data: [{ id: 1, status: 'a' }, { id: 2, status: 'b' }] })
    await sys(db).order.updateMany({ where: { status: 'a' }, data: { status: 'z' } })
    await tick()

    expect(frames).toHaveLength(2)
    const wire = frames.map(f => JSON.parse(f))
    expect(wire.map(w => w.event)).toEqual(['orders changed', 'orders changed'])
    expect(wire[1].data).toEqual({ model: 'Order', operation: 'updateMany', count: 1 })

    // The bus is in-process and may hold the filter; a channel goes to every
    // subscribed browser, and a filter is made of the caller's own values.
    expect(changed[1]!.where).toEqual({ status: 'a' })
    expect('where' in wire[1].data).toBe(false)
  })

  // A function resolver takes (rows, ctx) and an orphan write has no
  // ServiceContext to give it. The bus still fires; inventing a ctx would hand
  // the app's own resolver a principal nobody authenticated.
  test('a function channel: falls back to the bus alone', async () => {
    const { db, app, seen } = await mkApp({ channel: () => app.channels!.channel('orders') })
    const frames: string[] = []
    app.channels!.channel('orders').join({
      socket: { readyState: 1, send: (f: string) => { frames.push(f); return 1 } },
    } as never)

    await (db as never as { asSystem(): { order: { create(a: unknown): Promise<unknown> } } })
      .asSystem().order.create({ data: { status: 'from-job' } })
    await tick()

    expect(seen).toEqual(['orders:created#1'])
    expect(frames).toEqual([])
  })
})
