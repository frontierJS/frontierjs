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
import { createService, createBaseService } from '../src/core/service.ts'
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

// ─── FJS-464 ────────────────────────────────────────────────────────────────
//
// Everything above declares `model: 'Order'` by hand, and that is the whole
// reason the mechanism could be dead for two months without a red test.
//
// No real service file writes that. `createBaseService({})` in orders.service.ts
// is the canonical shape — the accessor is resolved per call from the service
// NAME through accessorCandidates — and the model → service index this file
// exercises was built from `svc.model ?? singularize(name)`, where `svc.model`
// is filled with the service name when a file declares none. So it indexed
// `orders` and looked up `Order`, and missed, for every conventionally named
// service in every app.
//
// Two spellings are legal and both have to resolve: the accessor may be the
// singular or the plural (`createBaseService({ model: 'posts' })` is
// documented), and Litestone announces the model name.

describe('the model → service index (FJS-464)', () => {

  const sys = (d: unknown) =>
    (d as { asSystem(): Record<string, Record<string, (a: unknown) => Promise<unknown>>> }).asSystem()

  /** An app whose orders service declares `model:` however the caller says —
   *  including not at all, which is what an autoloaded file does. */
  async function appWith(model?: string) {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    app.services.register(createService({
      name: 'orders', db: db as never,
      ...(model !== undefined ? { model } : {}),
    }))
    await app._startForTest()
    const seen: string[] = []
    app.events.on('orders:created', (row: { id: number }) => { seen.push(`created#${row.id}`) })
    return { db, seen }
  }

  test('a service that declares no model at all still announces', async () => {
    const { db, seen } = await appWith()
    await sys(db).order.create({ data: { status: 'from-job' } })
    await tick()
    expect(seen).toEqual(['created#1'])
  })

  test('a service declaring the PLURAL accessor still announces', async () => {
    const { db, seen } = await appWith('orders')
    await sys(db).order.create({ data: { status: 'from-job' } })
    await tick()
    expect(seen).toEqual(['created#1'])
  })

  test('a service declaring the singular accessor still announces', async () => {
    const { db, seen } = await appWith('order')
    await sys(db).order.create({ data: { status: 'from-job' } })
    await tick()
    expect(seen).toEqual(['created#1'])
  })

  // The option-drop half of the same defect: `createBaseService` returned an
  // object with no `model` key, so the loader's `createService({ name, ...base })`
  // saw none and substituted the file name. A service declaring which model it
  // is reported a different one.
  test('createBaseService carries its declared model through createService', async () => {
    const base = createBaseService({ model: 'Order' }) as unknown as Record<string, unknown>
    expect(base.model).toBe('Order')
    expect((createService({ name: 'orders', ...base }) as { model?: string }).model).toBe('Order')
  })
})

// ─── A state move made somewhere else ───────────────────────────────────────
//
// `db.x.transition()` fires its own event kind, which this tap dropped on the
// floor: a webhook settling an order, or a job advancing a state, moved the row
// and told nobody. The write succeeded, every open tab stayed on the old value,
// and nothing logged.
//
// It announces under the MOVE's name, which is what `callService` announces
// when the same transition goes through the owning service — one event name
// however the move was made, and the browser store's custom-method branch
// already merges it as a patch.

describe('a transition announces (FJS-463)', () => {

  const TRANSITIONS = `
    enum OrderStatus { pending paid shipped }
    model Order {
      id     Int         @id
      status OrderStatus @default(pending)
      @@transitions(status, pay: pending -> paid, ship: paid -> shipped)
    }
    model Audit { id Int @id  note String }
  `

  async function mk() {
    const db = await createClient({ db: ':memory:', schema: TRANSITIONS })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'orders', db: db as never, channel: 'orders' }))
    app.configure(channels(() => {}))
    await app._startForTest()

    const frames: Array<{ event: string; data: Record<string, unknown> }> = []
    app.channels!.channel('orders').join({
      socket: { readyState: 1, send: (f: string) => { frames.push(JSON.parse(f)); return 1 } },
    } as never)

    const bus: string[] = []
    app.events.on('orders:pay', (row: { id: number; status: string }) => { bus.push(`${row.id}:${row.status}`) })
    return { db, app, frames, bus }
  }

  test('a move made outside its own service reaches the bus and the channel', async () => {
    const { db, frames, bus } = await mk()
    const client = db as never as Record<string, { create(a: unknown): Promise<{ id: number }>; transition(id: number, name: string): Promise<unknown> }>
    const row = await client.order.create({ data: {} })
    await client.order.transition(row.id, 'pay')
    await tick()

    expect(bus).toEqual(['1:paid'])
    // `created` from the create, then the move under its own name — and NOT an
    // `orders updated` beside it. A transition fires both event kinds and they
    // are one write.
    expect(frames.map(f => f.event)).toEqual(['orders created', 'orders pay'])
    // The ROW, so a store can merge it — not a summary a subscriber has to
    // re-read the server to act on.
    expect(frames[1]!.data).toMatchObject({ id: 1, status: 'paid' })
  })

  test('a move through the owning service announces once, not twice', async () => {
    const { db, app, frames } = await mk()
    const client = db as never as Record<string, { create(a: unknown): Promise<{ id: number }> }>
    await client.order.create({ data: {} })
    // The tap defers a tick, so the create's own frame has not arrived yet and
    // clearing before it does would leave it in the list to be counted below.
    await tick()
    frames.length = 0

    // `patch` to the target state IS the transition — Litestone enforces the
    // machine however the write arrives — so this is the service-call path.
    await app.service('orders').patch(1, { status: 'paid' })
    await tick()

    // One frame. The tap sees both an `update` and a `transition` for this
    // write, and callService is already announcing for this service, so
    // suppression has to cover the second kind as well as the first.
    expect(frames.map(f => f.event)).toEqual(['orders patched'])
  })
})

describe('two services over one model (FJS-765)', () => {
  // The index used to be model → ONE service, last claim wins, and the
  // suppression compared against that winner. So the LOSER was silently
  // unsubscribed from every write it did not make itself: measured on two
  // services over one `Order`, a write through the winner announced only the
  // winner, and an `asSystem()` write announced only the winner. Which of the
  // two won was registration order, so it moved when a file was renamed.
  //
  // Every assertion is a PAIR — both names, both directions — because a fix
  // that announced to nobody, or that announced the same write twice under one
  // name, would pass any test that only counted the missing one.

  async function twoServices() {
    const db  = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'orders',  model: 'Order', db: db as never }))
    app.services.register(createService({ name: 'orders2', model: 'Order', db: db as never }))
    await app._startForTest()

    const seen: string[] = []
    for (const e of ['orders:created', 'orders2:created', 'orders:updated', 'orders2:updated'])
      app.events.on(e, (row: { id: number }) => { seen.push(`${e}#${row.id}`) })
    return { db: db as never as Record<string, never> & Record<string, unknown>, app, seen }
  }

  test('a write through EITHER service reaches both, once each', async () => {
    const { app, seen } = await twoServices()

    await app.service('orders').create({ id: 1, status: 'draft' })
    await tick()
    expect(seen.sort()).toEqual(['orders2:created#1', 'orders:created#1'])
    seen.length = 0

    // The direction that used to announce nothing to `orders`.
    await app.service('orders2').create({ id: 2, status: 'draft' })
    await tick()
    expect(seen.sort()).toEqual(['orders2:created#2', 'orders:created#2'])
  })

  test('a write through NO service reaches both', async () => {
    const { db, app, seen } = await twoServices()
    await (db as never as { asSystem: () => { order: { create: (a: unknown) => Promise<unknown> } } })
      .asSystem().order.create({ data: { id: 3, status: 'draft' } })
    await tick()
    expect(seen.sort()).toEqual(['orders2:created#3', 'orders:created#3'])
  })

  test('one service over one model still announces exactly once', async () => {
    // The control that keeps the pair above honest: the fix must not turn every
    // ordinary app's single announcement into two.
    const { app, seen } = await mkApp()
    await app.service('orders').create({ status: 'draft' })
    await tick()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toStartWith('orders:created#')
  })

  test('a DECLARED model is the only spelling that service claims', async () => {
    // A service named for one model and declaring another used to be claimed by
    // both — its name-derived claim stayed in the index beside the declared
    // one. Harmless while a key held one name and a wrong announcement now that
    // every claimant gets one.
    const db  = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'orders', model: 'Audit', db: db as never }))
    await app._startForTest()

    const seen: string[] = []
    app.events.on('orders:created', (row: { id: number }) => { seen.push(`orders#${row.id}`) })

    await (db as never as { asSystem: () => Record<string, { create: (a: unknown) => Promise<unknown> }> })
      .asSystem().order.create({ data: { id: 4, status: 'draft' } })
    await tick()
    expect(seen).toEqual([])          // an Order write is not this service's

    await (db as never as { asSystem: () => Record<string, { create: (a: unknown) => Promise<unknown> }> })
      .asSystem().audit.create({ data: { id: 5, note: 'x' } })
    await tick()
    expect(seen).toEqual(['orders#5'])  // the declared one is
  })
})
