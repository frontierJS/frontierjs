// test/data-write-announcement.test.ts
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

async function mkApp(opts: {
  channel?: string | ((...a: unknown[]) => unknown)
  transactional?: boolean
  methods?: Record<string, (ctx: never) => Promise<unknown>>
} = {}) {
  const db = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({ db: db as never })
  app.services.register(createService({
    name: 'orders', model: 'Order', db: db as never,
    ...(opts.transactional ? { transactional: true } : {}),
    ...(opts.methods ? { methods: Object.keys(opts.methods), ...opts.methods } : {}),
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

  // The call announces the row it returns and never a count, so a bulk
  // write made inside it is announced here or nowhere (`FJS-1308`): the sweep
  // below changed a row the `orders created` payload shows before the sweep.
  test('a bulk write inside its own service call still announces changed', async () => {
    const { db, app, changed, seen } = await mkApp()
    app.services.get('orders')!.hooks({
      after: { create: [async () => { await sys(db).order.updateMany({ where: {}, data: { status: 'swept' } }) }] },
    })
    await app.service('orders').create({ status: 'a' })
    await tick()
    expect(seen).toEqual(['orders:created#1'])
    expect(changed.map(c => `${c.operation}#${c.count}`)).toEqual(['updateMany#1'])
  })

  // The shape measured in linear: a transactional renumber, `updateMany` over
  // the siblings and `update()` of the row the method returns. Under a
  // transaction the suppression is the commit scope's, so it is its own case.
  test('a transactional renumber announces its siblings once, and the moved row once', async () => {
    const { db, app, changed } = await mkApp({ transactional: true })
    const patched: number[] = []
    app.events.on('orders:patched', (row: { id: number }) => { patched.push(row.id) })
    await sys(db).order.createMany({ data: [{ status: 'a' }, { status: 'b' }, { status: 'c' }] })
    await tick()
    changed.length = 0
    app.services.get('orders')!.hooks({
      after: { patch: [async () => { await sys(db).order.updateMany({ where: { id: { gt: 1 } }, data: { status: 'shifted' } }) }] },
    })
    await app.service('orders').patch(1, { status: 'moved' })
    await tick()
    expect(patched).toEqual([1])
    expect(changed.map(c => `${c.operation}#${c.count}`)).toEqual(['updateMany#2'])
  })

  // The per-row half (`FJS-1357`): the call announces the row it
  // returns, so only THAT row is covered. A method closing a parent's children
  // one `update()` at a time changed rows the call never announces.
  for (const transactional of [false, true]) {
    test(`a single-row write to a sibling inside its own call announces${transactional ? ' (transactional)' : ''}`, async () => {
      const { db, app, seen } = await mkApp({
        transactional,
        methods: {
          async close() {
            for (const id of [2, 3]) await sys(db).order.update({ where: { id }, data: { status: 'closed' } })
            return sys(db).order.update({ where: { id: 1 }, data: { status: 'closed' } })
          },
        },
      })
      const closed: number[] = []
      app.events.on('orders:close', (row: { id: number }) => { closed.push(row.id) })
      await sys(db).order.createMany({ data: [{ status: 'a' }, { status: 'b' }, { status: 'c' }] })
      await tick()
      await (app.service('orders') as never as { call(m: string): Promise<unknown> }).call('close')
      await tick()
      expect(closed).toEqual([1])
      expect(seen.sort()).toEqual(['orders:updated#2', 'orders:updated#3'])
    })
  }
})

describe('the socket half', () => {

  test('a string channel: broadcasts an orphan write', async () => {
    const { db, app } = await mkApp({ channel: 'orders' })
    const frames: string[] = []
    // Stand in for a subscribed browser at the one seam a broadcast has to
    // cross — the connection's socket.
    app.channels.channel('orders').join({
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
    app.channels.channel('orders').join({
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

  // FJS-1741. A function resolver is called with the row and `ctx` null:
  // there is no request, and inventing one would hand the app's resolver a
  // principal nobody authenticated. One that reads the row needs none.
  test('a function channel: is called with the row and a null ctx', async () => {
    const calls: unknown[][] = []
    const { db, app, seen } = await mkApp({
      channel: (row: unknown, ctx: unknown) => { calls.push([row, ctx]); return app.channels.channel('orders') },
    })
    const frames: string[] = []
    app.channels.channel('orders').join({
      socket: { readyState: 1, send: (f: string) => { frames.push(f); return 1 } },
    } as never)

    await (db as never as { asSystem(): { order: { create(a: unknown): Promise<unknown> } } })
      .asSystem().order.create({ data: { status: 'from-job' } })
    await tick(); await tick()

    expect(seen).toEqual(['orders:created#1'])
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toMatchObject({ id: 1, status: 'from-job' })
    expect(calls[0]![1]).toBeNull()
    expect(frames.map(f => JSON.parse(f).event)).toEqual(['orders created'])
  })

  // A resolver written against a request -- `ctx.user.workspaceId` --
  // throws on null. The write is not failed by it, the bus still hears it,
  // and the warning names the fix.
  test('a resolver that reads ctx throws, and the bus alone hears it', async () => {
    const { db, app, seen } = await mkApp({
      channel: ((_row: unknown, ctx: { user: { w: string } }) => app.channels.channel(`w:${ctx.user.w}`)) as never,
    })
    const warn = console.warn, said: string[] = []
    console.warn = (m: string) => { said.push(String(m)) }
    try {
      await (db as never as { asSystem(): { order: { create(a: unknown): Promise<unknown> } } })
        .asSystem().order.create({ data: { status: 'from-job' } })
      await tick(); await tick()
    } finally { console.warn = warn }

    expect(seen).toEqual(['orders:created#1'])
    expect(said.join('\n')).toContain('ctx is null')
  })
})

describe('a count reaches a per-tenant function channel (FJS-1741)', () => {

  // A bulk write names no row, so a resolver routing off the row had nothing
  // to read. Litestone names the tenants the statement touched, and each is
  // handed over as `{ agencyId }` -- the shape `agency:<row.agencyId>` reads.
  const TENANTED = `
    claim agencyId
    tenancy { strategy row  column agencyId  claim agencyId }
    model Agency { id String @id  legs Leg[]  @@tenant(none) }
    model Leg {
      id       String @id
      agencyId String
      agency   Agency @relation(fields: [agencyId], references: [id])
      status   String @default("ringing")
    }
  `

  test('updateMany sends one count to each tenant it touched, and none to the rest', async () => {
    const db  = await createClient({ db: ':memory:', schema: TENANTED })
    const app = createApp({ db: db as never })
    const routed: unknown[] = []
    app.services.register(createService({
      name: 'legs', model: 'Leg', db: db as never,
      channel: ((row: { agencyId?: string }, ctx: unknown) => {
        routed.push([row, ctx])
        return row?.agencyId ? app.channels.channel(`agency:${row.agencyId}`) : null
      }) as never,
    }))
    app.configure(channels(() => {}))
    await app._startForTest()

    const sys = (db as never as { asSystem(): Record<string, { createMany(a: unknown): Promise<unknown>; updateMany(a: unknown): Promise<unknown> }> }).asSystem()
    await sys.agency.createMany({ data: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] })
    await sys.leg.createMany({ data: [
      { id: 'l1', agencyId: 'a1' }, { id: 'l2', agencyId: 'a1' }, { id: 'l3', agencyId: 'a2' },
    ] })
    await tick(); await tick()

    const heard: Record<string, string[]> = { a1: [], a2: [], a3: [] }
    for (const a of Object.keys(heard)) app.channels.channel(`agency:${a}`).join({
      socket: { readyState: 1, send: (f: string) => { heard[a]!.push(f); return 1 } },
    } as never)
    routed.length = 0

    await sys.leg.updateMany({ where: { agencyId: 'a1' }, data: { status: 'ended' } })
    await tick(); await tick()

    expect(routed).toEqual([[{ agencyId: 'a1' }, null]])
    expect(heard.a1.map(f => JSON.parse(f)).map(w => [w.event, w.data])).toEqual([
      ['legs changed', { model: 'Leg', operation: 'updateMany', count: 2 }],
    ])
    expect(heard.a2).toEqual([])
    expect(heard.a3).toEqual([])
  })

  // A Note is scoped through its Leg and carries no agencyId. The resolver is
  // handed the row with the parent's tenant stamped on; the frame carries the
  // row as written. And `legs` -- plural, no `model:` -- is regraded by a Note
  // write its read policy reaches: Litestone's accessor index is exact, and
  // asking it `legs` alone reached nothing.
  test('a child scoped through its parent routes by the parent\'s tenant, and regrades a plural service', async () => {
    const VIA = `
      claim agencyId
      tenancy { strategy row  column agencyId  claim agencyId }
      model Agency { id String @id  legs Leg[]  @@tenant(none) }
      model Leg {
        id       String @id
        agencyId String
        agency   Agency @relation(fields: [agencyId], references: [id])
        notes    Note[]
        @@allow(read, notes.some(body != 'hidden'))
      }
      model Note {
        id    String @id
        legId String
        leg   Leg    @relation(fields: [legId], references: [id])
        body  String @default("")
        @@tenant(via: leg)
      }
    `
    const db  = await createClient({ db: ':memory:', schema: VIA })
    const app = createApp({ db: db as never })
    const byRow = (row: { agencyId?: string }) => row?.agencyId ? app.channels.channel(`agency:${row.agencyId}`) : null
    const routed: unknown[] = []
    app.services.register(createService({
      name: 'notes', model: 'Note', db: db as never,
      channel: ((row: { agencyId?: string }) => { routed.push(row); return byRow(row) }) as never,
    }))
    app.services.register(createService({ name: 'legs', db: db as never, channel: byRow as never }))
    // A row frame is graded as its recipient, and the agency claim is the
    // channel's to answer (FJS-D191): a member of agency:a1 holds a1.
    app.configure(channels(() => {}, { claims: (name: string) => ({ agencyId: name.slice('agency:'.length) }) }))
    await app._startForTest()

    const sys = (db as never as { asSystem(): Record<string, { create(a: unknown): Promise<unknown>; createMany(a: unknown): Promise<unknown> }> }).asSystem()
    await sys.agency.createMany({ data: [{ id: 'a1' }, { id: 'a2' }] })
    await sys.leg.createMany({ data: [{ id: 'l1', agencyId: 'a1' }, { id: 'l2', agencyId: 'a2' }] })
    await tick(); await tick()

    const heard: Record<string, string[]> = { a1: [], a2: [] }
    for (const a of Object.keys(heard)) app.channels.channel(`agency:${a}`).join({
      socket: { readyState: 1, send: (f: string) => { heard[a]!.push(f); return 1 } },
    } as never)
    routed.length = 0

    await sys.note.create({ data: { id: 'n1', legId: 'l1' } })
    await tick(); await tick()

    expect(routed).toEqual([expect.objectContaining({ id: 'n1', legId: 'l1', agencyId: 'a1' })])
    const wire = heard.a1.map(f => JSON.parse(f))
    expect(wire.map(w => w.event).sort()).toEqual(['legs changed', 'notes created'])
    expect('agencyId' in wire.find(w => w.event === 'notes created').data).toBe(false)
    expect(heard.a2).toEqual([])
  })
})

// ─── FJS-464 ────────────────────────────────────────────────────────────────
//
// Everything above declares `model: 'Order'` by hand, and that is the whole
// reason the mechanism could be dead for two months without a red test.
//
// No real service file writes that. `createService({})` in orders.service.ts
// is the canonical shape — the accessor is resolved per call from the service
// NAME through accessorCandidates — and the model → service index this file
// exercises was built from `svc.model ?? singularize(name)`, where `svc.model`
// is filled with the service name when a file declares none. So it indexed
// `orders` and looked up `Order`, and missed, for every conventionally named
// service in every app.
//
// Two spellings are legal and both have to resolve: the accessor may be the
// singular or the plural (`createService({ model: 'posts' })` is
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
// however the move was made, and the browser tether's custom-method branch
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
    app.channels.channel('orders').join({
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
    // The ROW, so a tether can merge it — not a summary a subscriber has to
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
    const { db, seen } = await twoServices()
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

// ─── A move made inside ANOTHER service's call (FJS-567) ────────────────────
//
// The webhook shape. `payments.record` settles an order: the call in progress
// is `payments`, the model being moved belongs to `orders`, and the write goes
// through `$.db.order.transition()` rather than the owning service. Suppression
// compares `announcingService()` against the service the MODEL indexes to, so
// the two names differ and the move has to announce — a suppression widened to
// "any service call is announcing" would swallow this and leave the seller's
// tab on `pending` with the money taken.
//
// The control is the pair below it: the same move made inside the OWNING
// service's call still announces exactly once, because that is the case
// suppression exists for. A fix that announced everything passes the first
// assertion alone.

describe('a transition inside another service call announces (FJS-567)', () => {

  const TRANSITIONS = `
    enum OrderStatus { pending paid shipped }
    model Order {
      id     Int         @id
      status OrderStatus @default(pending)
      @@transitions(status, pay: pending -> paid, ship: paid -> shipped)
    }
    model Payment { id Int @id  note String }
  `

  async function mk() {
    const db = await createClient({ db: ':memory:', schema: TRANSITIONS })
    const app = createApp({ db: db as never })
    const move = (id: number) =>
      (db as never as Record<string, { transition(i: number, n: string): Promise<unknown> }>)
        .order.transition(id, 'pay')

    app.services.register(createService({ name: 'orders', model: 'Order', db: db as never, channel: 'orders' }))
    // The webhook's caller. It owns Payment and moves an Order.
    app.services.register(createService({
      name: 'payments', model: 'Payment', db: db as never,
      // The move rides an ordinary payments write, which is what a webhook
      // route does: the call in progress is `payments` throughout.
      hooks: { after: { create: [async () => { await move(1) }] } },
    } as never))
    app.configure(channels(() => {}))
    await app._startForTest()

    const frames: Array<{ event: string }> = []
    app.channels.channel('orders').join({
      socket: { readyState: 1, send: (f: string) => { frames.push(JSON.parse(f)); return 1 } },
    } as never)
    return { db, app, frames, move }
  }

  test('the move reaches the channel under its own name', async () => {
    const { db, app, frames } = await mk()
    await (db as never as Record<string, { create(a: unknown): Promise<{ id: number }> }>)
      .order.create({ data: {} })
    await tick()
    frames.length = 0

    await app.service('payments').create({ id: 1, note: 'webhook' })
    await tick()

    expect(frames.map(f => f.event)).toEqual(['orders pay'])
  })

  test('the same move inside the OWNING service call announces once', async () => {
    const { db, app, frames } = await mk()
    await (db as never as Record<string, { create(a: unknown): Promise<{ id: number }> }>)
      .order.create({ data: {} })
    await tick()
    frames.length = 0

    // `patch` to the target state IS the move, and callService announces it.
    await app.service('orders').patch(1, { status: 'paid' })
    await tick()
    expect(frames.map(f => f.event)).toEqual(['orders patched'])
  })
})

// FJS-1739 — the model → service index was built on the FIRST write the tap
// heard and kept, so a seed written before the services registered froze an
// empty index and every later background write announced nothing, for good.
describe('a write before the services register (FJS-1739)', () => {

  test('a seed written before registration does not silence later writes', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    const sys = () => (db as never as { asSystem(): Record<string, Record<string, (a: unknown) => Promise<unknown>>> }).asSystem()
    await sys().order.create({ data: { status: 'seed' } })
    await tick()

    app.services.register(createService({ name: 'orders', model: 'Order', db: db as never }))
    await app._startForTest()
    const seen: string[] = []
    app.events.on('orders:updated', (row: { id: number }) => { seen.push(`orders:updated#${row.id}`) })

    await sys().order.update({ where: { id: 1 }, data: { status: 'later' } })
    await tick()
    expect(seen).toEqual(['orders:updated#1'])
  })

  test('a service registered after a write is announced', async () => {
    const { db, app } = await mkApp()
    const sys = () => (db as never as { asSystem(): Record<string, Record<string, (a: unknown) => Promise<unknown>>> }).asSystem()
    await sys().order.create({ data: { status: 'a' } })
    await tick()
    // A second service over the same model, registered after the index exists.
    app.services.register(createService({ name: 'orderFeed', model: 'Order', db: db as never }))
    const seen: string[] = []
    app.events.on('orderFeed:updated', (row: { id: number }) => { seen.push(`orderFeed:updated#${row.id}`) })
    await sys().order.update({ where: { id: 1 }, data: { status: 'b' } })
    await tick()
    expect(seen).toEqual(['orderFeed:updated#1'])
  })
})

// FJS-2632 — a `@from` value moves when a CHILD row is written, and the write
// announced the child only. The parent a count was read off held the old number
// on every screen, in the tab that wrote and in every other one.
describe('a write moves a @from on another model (FJS-2632)', () => {
  const FROM = `
    model Shift      { id Int @id  name String  adults Int @from(Assignment, count: true)
                       assignments Assignment[] }
    model Assignment { id Int @id  shiftId Int  shift Shift @relation(fields: [shiftId], references: [id]) }
    model Note       { id Int @id  text String }
  `
  type Sys = Record<string, Record<string, (a: unknown) => Promise<unknown>>>

  async function mk() {
    const db  = await createClient({ db: ':memory:', schema: FROM })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'shifts', model: 'Shift', db: db as never }))
    app.services.register(createService({ name: 'assignments', model: 'Assignment', db: db as never }))
    app.services.register(createService({ name: 'notes', model: 'Note', db: db as never }))
    await app._startForTest()
    const sys = () => (db as never as { asSystem(): Sys }).asSystem()
    await sys().shift.create({ data: { id: 1, name: 'am' } })
    await tick()
    const seen: string[] = []
    for (const s of ['shifts', 'assignments', 'notes'])
      app.events.on(`${s}:changed`, (d: { operation: string }) => { seen.push(`${s}:changed:${d.operation}`) })
    return { db, app, sys, seen }
  }

  test('creating a child tells the parent\'s service to re-read', async () => {
    const { sys, seen } = await mk()
    await sys().assignment.create({ data: { id: 1, shiftId: 1 } })
    await tick(); await tick()
    expect(seen).toEqual(['shifts:changed:regrade'])
  })

  test('removing a child does too, and a write to an unrelated model does not', async () => {
    const { sys, seen } = await mk()
    await sys().assignment.create({ data: { id: 1, shiftId: 1 } })
    await tick(); await tick()
    seen.length = 0
    await sys().note.create({ data: { id: 1, text: 'x' } })
    await sys().assignment.delete({ where: { id: 1 } })
    await tick(); await tick()
    expect(seen).toEqual(['shifts:changed:regrade'])
  })
})

// FJS-2919 — a model counting its own children: the child write announces the
// child row, and the parent whose count moved was dropped as the written
// model's own service.
describe('a write moves a @from on its own table (FJS-2919)', () => {
  const TREE = `
    model Task { id Int @id  parentId Int?  parent Task? @relation("sub", fields: [parentId], references: [id])
                 subs Task[] @relation("sub")
                 subCount Int @from(Task, count: true, via: parent) }
  `
  type Sys = Record<string, Record<string, (a: unknown) => Promise<unknown>>>

  test('creating a sub-task tells the task\'s own service to re-read', async () => {
    const db  = await createClient({ db: ':memory:', schema: TREE })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'tasks', model: 'Task', db: db as never }))
    await app._startForTest()
    const sys = () => (db as never as { asSystem(): Sys }).asSystem()
    await sys().task.create({ data: { id: 1 } })
    await tick(); await tick()
    const seen: string[] = []
    app.events.on('tasks:changed', (d: { operation: string }) => { seen.push(`tasks:changed:${d.operation}`) })
    await sys().task.create({ data: { id: 2, parentId: 1 } })
    await tick(); await tick()
    expect(seen).toEqual(['tasks:changed:regrade'])
  })
})

// FJS-2255 — the service announces the row it removed and SQLite removes the
// cascade children inside the same statement, so no `removed` frame named them
// and every other open tab kept showing rows that no longer exist.
describe('a delete that cascades announces the children (FJS-2255)', () => {
  const FEED = `
    model Follow { id Int @id  posts Post[] }
    model Post   { id Int @id  followId Int
                   follow Follow @relation(fields: [followId], references: [id], onDelete: Cascade) }
  `

  test('the child service announces removed, once per row, after a delete of the parent', async () => {
    const db  = await createClient({ db: ':memory:', schema: FEED })
    const app = createApp({ db: db as never })
    app.services.register(createService({ name: 'follows', model: 'Follow', db: db as never }))
    app.services.register(createService({ name: 'posts', model: 'Post', db: db as never }))
    await app._startForTest()
    const sys: any = (db as any).asSystem()
    await sys.follow.create({ data: { id: 1 } })
    await sys.post.create({ data: { id: 10, followId: 1 } })
    await sys.post.create({ data: { id: 11, followId: 1 } })
    await tick(); await tick()
    const seen: string[] = []
    for (const s of ['follows', 'posts'])
      app.events.on(`${s}:removed`, (row: { id: number }) => { seen.push(`${s}:removed#${row.id}`) })
    await sys.follow.delete({ where: { id: 1 } })
    await tick(); await tick()
    expect(seen.sort()).toEqual(['follows:removed#1', 'posts:removed#10', 'posts:removed#11'])
  })
})

// FJS-3127 — a write to a column no read policy reads regraded every dependent
// service: a runner stamping `Run.heartbeatAt` every 2 s sent each open LogChunk
// list a `changed`, and a live store re-read its whole window to learn nothing.
describe('a write to a column no read verdict reads regrades nothing (FJS-3127)', () => {
  const RUNS = `
    model Project { id Int @id  open Boolean  runs Run[]
                    @@allow(read, open) }
    model Run     { id Int @id  projectId Int  project Project @relation(fields: [projectId], references: [id])
                    heartbeatAt DateTime?  chunks Chunk[]
                    @@allow(read, check(project)) }
    model Chunk   { id Int @id  runId Int  run Run @relation(fields: [runId], references: [id])  body String
                    @@allow(read, check(run)) }
  `
  type Sys = Record<string, Record<string, (a: unknown) => Promise<unknown>>>

  async function mk() {
    const db  = await createClient({ db: ':memory:', schema: RUNS })
    const app = createApp({ db: db as never })
    for (const [name, model] of [['projects', 'Project'], ['runs', 'Run'], ['chunks', 'Chunk']])
      app.services.register(createService({ name, model, db: db as never }))
    await app._startForTest()
    const sys = () => (db as never as { asSystem(): Sys }).asSystem()
    await sys().project.create({ data: { id: 1, open: true } })
    await sys().run.create({ data: { id: 1, projectId: 1 } })
    await tick(); await tick()
    const seen: string[] = []
    for (const s of ['projects', 'runs', 'chunks'])
      app.events.on(`${s}:changed`, (d: { operation: string }) => { seen.push(`${s}:changed:${d.operation}`) })
    return { sys, seen }
  }

  test('a heartbeat on the run leaves the chunk list alone', async () => {
    const { sys, seen } = await mk()
    await sys().run.update({ where: { id: 1 }, data: { heartbeatAt: new Date() } })
    await tick(); await tick()
    expect(seen).toEqual([])
  })

  test('a column the policy reads still regrades, through the whole chain', async () => {
    const { sys, seen } = await mk()
    await sys().project.update({ where: { id: 1 }, data: { open: false } })
    await tick(); await tick()
    expect(seen.sort()).toEqual(['chunks:changed:regrade', 'runs:changed:regrade'])
  })

  test('a join key moving regrades, and so does a write that names no row', async () => {
    const { sys, seen } = await mk()
    await sys().project.create({ data: { id: 2, open: false } })
    await sys().run.update({ where: { id: 1 }, data: { projectId: 2 } })
    await tick(); await tick()
    expect(seen).toContain('chunks:changed:regrade')
    seen.length = 0
    await sys().run.updateMany({ where: { id: 1 }, data: { heartbeatAt: new Date() } })
    await tick(); await tick()
    expect(seen).toContain('chunks:changed:regrade')
  })
})
