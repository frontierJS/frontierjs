// tests/commit-scope.test.ts
//
// When is a write DONE, and who says so.
//
// `callService` decided both by asking whether the pipeline threw, and that is
// the right owner in neither case. With `transactional:` the rows belong to the
// OUTERMOST transaction, so a nested call settled on the wrong clock; without
// one the rows are durable the moment the method returned, so a later hook
// throwing does not take them back (`FJS-682`, `FJS-688`).
//
// Measured on the shipped code before any of this was written:
//
//   [rollback]  afterCommitRan=["inner effect"]  events=["posts:created"]
//               — the effect ran and the announcement went out, for a row that
//                 the rollback had already removed
//   [nested tx] events=["posts:created","outer:created","posts:created"]
//               — three for ONE inner create, because litestone buffers a
//                 transaction's events to the commit and the tap's
//                 `announcingService()` comparison then sees the OUTER span
//   [688]       rowsInDb=1  events=[]  caller="GeneralError"
//               — the row is real and permanent, the caller is told it failed,
//                 and every open tab still shows the old value
//
// Against a real Litestone client, because every claim here is about when a
// commit happens and a stub would agree with whatever it was written to agree
// with.
import { describe, test, expect } from 'bun:test'
import { createClient }              from '../../litestone/src/index.js'
import { createService, callService } from '../src/core/service.ts'
import { announceDataWrites }        from '../src/core/litestone.ts'
import type { ServiceContext }       from '../src/transport/bridge.ts'

const SCHEMA = `model Post { id Int @id @default(autoincrement())  title String }`
const mkDb = () => createClient({ db: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

function mkCtx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method: 'create', id: undefined, data: { title: 't' },
    query: {}, auth: { user: null }, client: {}, route: {},
    locals: { db }, app: {}, result: null, type: 'before', ...over,
  } as unknown as ServiceContext
}

const writes = (extra: Record<string, unknown> = {}) => ({
  name: 'posts',
  async create(c: ServiceContext) { return (c.locals.db as any).post.create({ data: c.data }) },
  async find() { return [] },
  ...extra,
})

/** A bus we can read back, plus the `services` shape the litestone tap indexes. */
function busApp(services: Record<string, unknown> = {}) {
  const events: string[] = []
  return {
    events:   { emit: (e: string) => { events.push(e) }, onAny: () => {} },
    services: { list: () => Object.keys(services), get: (n: string) => (services as any)[n] },
    _events:  events,
  }
}

const settle = () => new Promise(r => setTimeout(r, 20))

// ─── a nested call under an outer transaction ─────────────────────────────

describe('a nested call hands its effects and its announcement to the commit', () => {

  /** outer(transactional) → inner create → optionally throw. */
  async function nest(opts: { boom?: boolean; transactional?: boolean } = {}) {
    const db  = await mkDb()
    const ran: string[] = []
    const inner = createService(writes({
      hooks: { after: { create: [(c: ServiceContext) => { c.afterCommit(() => { ran.push('inner effect') }) }] } },
    }) as never)
    const app = busApp({ posts: inner })

    const outer = createService({
      name: 'outer',
      transactional: opts.transactional !== false,
      async create(c: ServiceContext) {
        await callService(inner, mkCtx(c.locals.db, { app, data: { title: 'inner' } }), undefined, app.events as never)
        if (opts.boom) throw new Error('outer rolls back')
        return { ok: true }
      },
      async find() { return [] },
    } as never)

    let threw = ''
    try { await callService(outer, mkCtx(db, { app, service: 'outer' }), undefined, app.events as never) }
    catch (e) { threw = (e as Error).message }
    return { db, ran, events: app._events, threw }
  }

  test('a rollback discards the inner effect AND the inner announcement', async () => {
    const { db, ran, events, threw } = await nest({ boom: true })
    expect(threw).toMatch(/outer rolls back/)
    expect(await db.asSystem().post.count()).toBe(0)
    // Both used to happen. The announcement is the sharper half: a subscriber
    // was told a row was created that the same transaction had just removed.
    expect(ran).toEqual([])
    expect(events).toEqual([])
  })

  test('a commit runs them — the control, without which discarding everything would pass', async () => {
    const { db, ran, events } = await nest()
    expect(await db.asSystem().post.count()).toBe(1)
    expect(ran).toEqual(['inner effect'])
    expect(events).toEqual(['posts:created', 'outer:created'])
  })

  test('the announcement precedes the effect at the drain, as it does without one', async () => {
    const db  = await mkDb()
    const order: string[] = []
    const inner = createService(writes({
      hooks: { after: { create: [(c: ServiceContext) => { c.afterCommit(() => { order.push('effect') }) }] } },
    }) as never)
    const app = {
      events:   { emit: (e: string) => { if (e === 'posts:created') order.push('announced') }, onAny: () => {} },
      services: { list: () => ['posts'], get: () => inner },
    }
    const outer = createService({
      name: 'outer', transactional: true,
      async create(c: ServiceContext) {
        await callService(inner, mkCtx(c.locals.db, { app, data: { title: 'i' } }), undefined, app.events as never)
        return { ok: true }
      },
      async find() { return [] },
    } as never)
    await callService(outer, mkCtx(db, { app, service: 'outer' }), undefined, app.events as never)
    expect(order).toEqual(['announced', 'effect'])
  })

  test('no transaction: the inner call settles on its own, exactly as before', async () => {
    const { ran, events } = await nest({ transactional: false })
    expect(ran).toEqual(['inner effect'])
    expect(events).toEqual(['posts:created', 'outer:created'])
  })

  test('a nested TRANSACTIONAL service reuses the scope rather than draining early', async () => {
    // Two `transactional:` services, one inside the other. The inner
    // `$transaction` is a SAVEPOINT, so its rows are not durable until the
    // outer commits — and its effect must wait for that, not for its own.
    const db  = await mkDb()
    const seen: string[] = []
    const app = busApp()

    const middle = createService({
      name: 'middle', transactional: true,
      async create(c: ServiceContext) {
        c.afterCommit(() => { seen.push('middle effect') })
        await (c.locals.db as any).post.create({ data: { title: 'm' } })
        return { ok: true }
      },
      async find() { return [] },
    } as never)

    const outer = createService({
      name: 'outer', transactional: true,
      async create(c: ServiceContext) {
        await callService(middle, mkCtx(c.locals.db, { app, service: 'middle' }), undefined, app.events as never)
        seen.push('outer body done')
        throw new Error('outer rolls back')
      },
      async find() { return [] },
    } as never)

    await expect(callService(outer, mkCtx(db, { app, service: 'outer' }), undefined, app.events as never))
      .rejects.toThrow(/rolls back/)
    // The middle call finished successfully and its effect is still discarded,
    // because the transaction that made its row durable never committed.
    expect(seen).toEqual(['outer body done'])
    expect(await db.asSystem().post.count()).toBe(0)
  })
})

// ─── the Litestone tap under a transaction ────────────────────────────────

describe('the write tap does not double-announce under a transaction', () => {

  async function withTap(transactional: boolean) {
    const db    = await mkDb()
    const inner = createService(writes() as never)
    const app   = busApp({ posts: inner })
    announceDataWrites(app as never, db as never)
    const outer = createService({
      name: 'outer', transactional,
      async create(c: ServiceContext) {
        await callService(inner, mkCtx(c.locals.db, { app, data: { title: 'i' } }), undefined, app.events as never)
        return { ok: true }
      },
      async find() { return [] },
    } as never)
    await callService(outer, mkCtx(db, { app, service: 'outer' }), undefined, app.events as never)
    await settle()
    return app._events
  }

  test('one inner create is announced once, under a transaction', async () => {
    // Three, before: `callService`'s inner announcement, the outer's own, and
    // the tap announcing `posts:created` a second time — because litestone
    // buffers the event to the commit, where the innermost service span is the
    // OUTER call's and the tap's comparison misses.
    expect(await withTap(true)).toEqual(['posts:created', 'outer:created'])
  })

  test('and once without one — the control that says the transaction is the variable', async () => {
    expect(await withTap(false)).toEqual(['posts:created', 'outer:created'])
  })

  test('a write NO service call covers is still announced by the tap', async () => {
    // The control that keeps the two above honest: a suppression that swallowed
    // everything would satisfy both of them, and this is the case the tap
    // exists for.
    const db    = await mkDb()
    const inner = createService(writes() as never)
    const app   = busApp({ posts: inner })
    announceDataWrites(app as never, db as never)
    await db.asSystem().post.create({ data: { title: 'direct' } })
    await settle()
    expect(app._events).toEqual(['posts:created'])
  })
})

// ─── a throw after the method, with nothing to roll back ──────────────────

describe('a write that is committed is announced, whatever the pipeline does next', () => {

  async function afterHookThrows(hooks: Record<string, unknown>) {
    const db  = await mkDb()
    const app = busApp()
    const svc = createService(writes({ hooks }) as never)
    let err: any = null
    try { await callService(svc, mkCtx(db, { app }), undefined, app.events as never) }
    catch (e) { err = e }
    return { rows: await db.asSystem().post.count(), events: app._events, err }
  }

  test('the row is real, so the subscribers are told', async () => {
    const { rows, events } = await afterHookThrows({
      after: { create: [() => { throw new Error('after hook blew up') }] },
    })
    expect(rows).toBe(1)
    expect(events).toEqual(['posts:created'])
  })

  test('and the error says the write landed, so a client re-reads instead of retrying', async () => {
    const { err } = await afterHookThrows({
      after: { create: [() => { throw new Error('after hook blew up') }] },
    })
    expect(err?.data?.committed).toBe(true)
  })

  test('a BEFORE hook that fails the call wrote nothing, announces nothing, and says nothing', async () => {
    // The pair. Without it, marking every error `committed` and announcing on
    // every throw would pass the two above.
    const { rows, events, err } = await afterHookThrows({
      before: { create: [() => { throw new Error('refused before the method') }] },
    })
    expect(rows).toBe(0)
    expect(events).toEqual([])
    expect(err?.data?.committed).toBeUndefined()
  })

  test('under a transaction the same throw rolls back, so nothing is announced or claimed', async () => {
    const db  = await mkDb()
    const app = busApp()
    const svc = createService(writes({
      transactional: true,
      hooks: { after: { create: [() => { throw new Error('after hook blew up') }] } },
    }) as never)
    let err: any = null
    try { await callService(svc, mkCtx(db, { app }), undefined, app.events as never) }
    catch (e) { err = e }
    expect(await db.asSystem().post.count()).toBe(0)
    expect(app._events).toEqual([])
    expect(err?.data?.committed).toBeUndefined()
  })

  test('the EFFECT still follows the call, which is the opposite answer on purpose', async () => {
    // `FJS-089`'s ruling, and the one thing here that did not change: a client
    // told the call failed must not also get the email, where a subscriber must
    // still be told the row moved. Two questions about one throw.
    const db  = await mkDb()
    const app = busApp()
    let sent  = 0
    const svc = createService(writes({
      hooks: { after: { create: [
        (c: ServiceContext) => { c.afterCommit(() => { sent++ }) },
        function boom() { throw new Error('a later after hook fails') },
      ] } },
    }) as never)
    await expect(callService(svc, mkCtx(db, { app }), undefined, app.events as never)).rejects.toThrow(/later after hook/)
    expect(sent).toBe(0)
    expect(app._events).toEqual(['posts:created'])   // announced, not delivered
    expect(await db.asSystem().post.count()).toBe(1)
  })
})
