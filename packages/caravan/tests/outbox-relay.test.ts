// tests/outbox-relay.test.ts
//
// The transactional outbox, end to end — junction writes the row, this queue
// runs the work (`FJS-D35`).
//
// It lives here because it is the only place all three real pieces are
// available at once: a real Litestone client to hold the row and the
// transaction, a real Junction app to run the relay, and a real Caravan queue
// to receive the handoff. Junction's own outbox.test.ts covers the enqueue side
// (it has no queue to hand anything to); this covers the delivery.
//
// The handoff crosses two SQLite files and therefore cannot be one transaction.
// That is the whole reason `dispatch({ id })` exists, and the replay test below
// is the proof it does what it claims.

import { describe, it, expect, afterEach } from 'bun:test'

import { createClient }  from '../../litestone/src/index.js'
import { createTestApp } from '../../junction/index.ts'
import { outbox }        from '../../junction/src/plugins/outbox/index.ts'
import type { App }      from '../../junction/index.ts'
import { createCaravan } from '../src/index.ts'

const OUTBOX = await Bun.file(new URL('../../junction/db/outbox.lite', import.meta.url)).text()

const SCHEMA = `
database main { path "./app.db" }

model Post {
  id    Int    @id @default(autoincrement())
  title String
  @@db(main)
}

${OUTBOX}
`

const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })

async function bootApp(pluginOpts: Parameters<typeof outbox>[0] = {}) {
  const db = await createClient({ databases: ':memory:', schema: SCHEMA }) as any
  closers.push(() => db.$close())

  const app = await createTestApp()
  app.db = db

  const queue = createCaravan({ db: ':memory:', pollInterval: 10 })
  app.configure(queue)
  // A long interval on purpose: every test below drives the relay by hand, so
  // a tick landing mid-assertion would make the counts non-deterministic.
  app.configure(outbox({ intervalMs: 60_000, ...pluginOpts }))
  await app._startForTest()

  closers.push(() => queue.stop())
  return { app: app as unknown as App, db, queue, jobs: db.asSystem().outboxMessage }
}

/** Put a row in the outbox the way `ctx.enqueue` does. */
const owe = (db: any, over: Record<string, unknown> = {}) =>
  db.asSystem().outboxMessage.create({
    data: { job: 'order.shipped', payload: { orderId: 1 }, actorId: null, ...over },
  })

async function until(what: string, ok: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

describe('the relay hands rows to the queue', () => {

  it('delivers an owed row and marks it', async () => {
    const { app, db, queue } = await bootApp()
    let ran = 0
    queue.handle('order.shipped', async () => { ran++ })

    const row = await owe(db)
    const result = await app.outbox!.deliver()

    expect(result).toEqual({ delivered: 1, failed: 0 })
    await until('the job to run', () => ran === 1)

    const after = await db.asSystem().outboxMessage.findUnique({ where: { id: row.id } })
    expect(after.deliveredAt).not.toBeNull()
    expect(after.attempts).toBe(1)
  })

  it('queues the job under the OUTBOX ROW\'s id, namespaced', async () => {
    // Not decoration: it is what makes the replay below a no-op. The `outbox:`
    // prefix is spelled out here rather than rebuilt with `occurrenceKey` — a
    // test that recomputes the key with the code under test cannot notice the
    // format moving, and this id is a primary key in a table shared with every
    // id a caller states on a dispatch of their own.
    const { app, db, queue } = await bootApp()
    queue.handle('order.shipped', async () => {})

    const row = await owe(db)
    await app.outbox!.deliver()

    expect(queue.find(`outbox:${row.id}`)!.name).toBe('order.shipped')
  })

  it('a replayed handoff queues nothing and runs nothing twice', async () => {
    // The crash this design cannot prevent and must survive: the job is queued,
    // the process dies before the delivery mark, and the next relay pass sees a
    // row that still looks owed. Simulated by clearing deliveredAt, which is
    // exactly the state that crash leaves behind.
    const { app, db, queue } = await bootApp()
    let ran = 0
    queue.handle('order.shipped', async () => { ran++ })

    const row = await owe(db)
    await app.outbox!.deliver()
    await until('the first run', () => ran === 1)

    await db.asSystem().outboxMessage.update({
      where: { id: row.id },
      data:  { deliveredAt: null, claimedAt: null },
    })

    const replay = await app.outbox!.deliver()
    await Bun.sleep(100)   // nothing to wait FOR — the claim is that nothing runs

    expect(replay).toEqual({ delivered: 1, failed: 0 })
    expect(ran).toBe(1)
    expect(queue.list({ limit: 50 }).length).toBe(1)
  })

  it('the job runs as whoever asked for the effect', async () => {
    const { app, db, queue } = await bootApp()
    queue.handle('order.shipped', async () => {})

    const row = await owe(db, { actorId: 'u-7' })
    await app.outbox!.deliver()

    expect(queue.find(`outbox:${row.id}`)!.actor_id).toBe('u-7')
  })

  it('a row nobody asked for carries no actor', async () => {
    const { app, db, queue } = await bootApp()
    queue.handle('sweep', async () => {})

    const row = await owe(db, { job: 'sweep', actorId: null })
    await app.outbox!.deliver()

    expect(queue.find(`outbox:${row.id}`)!.actor_id).toBeNull()
  })

  it('takes the oldest owed row first', async () => {
    // Asserted through a batch of one rather than by reading the queue's list
    // order back: two jobs inserted in the same millisecond have no order to
    // read, and the assertion that did flaked. A batch of one has to choose,
    // and which one it chooses IS the claim.
    const { app, db, queue } = await bootApp()
    queue.handle('order.shipped', async () => {})

    const first = await owe(db, { payload: { orderId: 1 } })
    await Bun.sleep(5)
    const second = await owe(db, { payload: { orderId: 2 } })

    expect(await app.outbox!.deliver({ batch: 1 })).toEqual({ delivered: 1, failed: 0 })
    expect(queue.list({ limit: 50 }).map(j => j.id)).toEqual([`outbox:${first.id}`])

    expect(await app.outbox!.deliver({ batch: 1 })).toEqual({ delivered: 1, failed: 0 })
    expect(queue.find(`outbox:${second.id}`)).not.toBeNull()
  })
})

describe('the relay recovers what a crash left behind', () => {

  it('retakes a claim older than the timeout', async () => {
    const { app, db, queue } = await bootApp({ claimTimeoutMs: 50 })
    queue.handle('order.shipped', async () => {})

    // A relay that claimed the row and died before dispatching it.
    const row = await owe(db)
    await db.asSystem().outboxMessage.update({
      where: { id: row.id },
      data:  { claimedAt: new Date(Date.now() - 5_000) },
    })

    expect(await app.outbox!.deliver()).toEqual({ delivered: 1, failed: 0 })
  })

  it('leaves a FRESH claim alone — another relay is on it', async () => {
    const { app, db, queue } = await bootApp({ claimTimeoutMs: 60_000 })
    queue.handle('order.shipped', async () => {})

    const row = await owe(db)
    await db.asSystem().outboxMessage.update({
      where: { id: row.id }, data: { claimedAt: new Date() },
    })

    expect(await app.outbox!.deliver()).toEqual({ delivered: 0, failed: 0 })
  })

  it('a dispatch that throws releases the claim and counts the attempt', async () => {
    const { app, db } = await bootApp()
    // No handler is registered and the queue is stopped underneath it, so the
    // insert itself fails — which is what a queue nobody can reach looks like.
    ;(app.jobs as { dispatch: unknown }).dispatch = async () => { throw new Error('queue is down') }

    const row = await owe(db)
    expect(await app.outbox!.deliver()).toEqual({ delivered: 0, failed: 1 })

    const after = await db.asSystem().outboxMessage.findUnique({ where: { id: row.id } })
    expect(after.claimedAt).toBeNull()
    expect(after.attempts).toBe(1)
    expect(after.lastError).toBe('queue is down')
    expect(after.deliveredAt).toBeNull()
  })

  it('two relay passes at once claim the row once between them', async () => {
    // The claim is a compare-and-set for this: two app processes, or a
    // post-commit kick landing on top of the timer's sweep. Both read the row
    // as owed; only the one whose UPDATE matches the claim it read takes it.
    // Without that, both report a delivery and the row counts two attempts for
    // one piece of work.
    const { app, db, queue } = await bootApp()
    let ran = 0
    queue.handle('order.shipped', async () => { ran++ })

    const row = await owe(db)
    const passes = await Promise.all([app.outbox!.deliver(), app.outbox!.deliver()])

    expect(passes.reduce((n, p) => n + p.delivered, 0)).toBe(1)
    await until('the job to run', () => ran === 1)
    await Bun.sleep(50)

    expect(ran).toBe(1)
    expect(queue.list({ limit: 50 }).length).toBe(1)
    expect((await db.asSystem().outboxMessage.findUnique({ where: { id: row.id } })).attempts).toBe(1)
  })

  it('pending() counts what is still owed', async () => {
    const { app, db, queue } = await bootApp()
    queue.handle('order.shipped', async () => {})

    await owe(db)
    await owe(db)
    expect(await app.outbox!.pending()).toBe(2)

    await app.outbox!.deliver()
    expect(await app.outbox!.pending()).toBe(0)
  })
})

describe('what /metrics is told', () => {

  it('counts both drivers and reports what is still owed', async () => {
    // The first question asked when something did not arrive, and until this
    // there was no way to ask it without opening the database.
    const { app, db, queue } = await bootApp()
    queue.handle('order.shipped', async () => {})

    const metrics = () =>
      (app as unknown as { _metricsSources: Map<string, () => unknown> })
        ._metricsSources.get('outbox')!() as
          { pending: number; dead: number; delivered: number; failed: number
            lastPassAt: string | null }

    // boot() runs one pass before the first tick, so the numbers exist already.
    expect(metrics()).toEqual({
      pending: 0, dead: 0, delivered: 0, failed: 0, lastPassAt: expect.any(String),
    })

    await owe(db)
    await owe(db)
    await app.outbox!.deliver()

    // A source must be synchronous — /metrics assigns fn() straight into the
    // body — so `pending` is as of the last PASS and a hand-driven deliver has
    // not refreshed it. The counters are immediate; the count is not.
    expect(metrics().delivered).toBe(2)
    expect(metrics().failed).toBe(0)
  })

  it('counts a failed handoff', async () => {
    const { app, db } = await bootApp()
    ;(app.jobs as { dispatch: unknown }).dispatch = async () => { throw new Error('queue is down') }

    await owe(db)
    await app.outbox!.deliver()

    const m = (app as unknown as { _metricsSources: Map<string, () => unknown> })
      ._metricsSources.get('outbox')!() as { delivered: number; failed: number }
    expect(m).toMatchObject({ delivered: 0, failed: 1 })
  })

  it('a row past the cap moves from pending to dead, and fails readiness', async () => {
    // Two numbers rather than one: a dead row is owed forever, so counting it
    // as pending keeps that number off zero for the life of the app — which is
    // what a readiness probe and an operator both read as *the relay is
    // behind*. `dead` is the only thing in this process that says an effect is
    // never going to happen.
    const { app, db } = await bootApp({ maxAttempts: 2, retryBackoffMs: 1, intervalMs: 60_000 })
    ;(app.jobs as { dispatch: unknown }).dispatch = async () => { throw new Error('queue is down') }

    const health = (app as unknown as { _healthChecks: Map<string, () => boolean> })
      ._healthChecks.get('outbox')!
    const metrics = () =>
      (app as unknown as { _metricsSources: Map<string, () => unknown> })
        ._metricsSources.get('outbox')!() as { pending: number; dead: number }

    await owe(db)
    await app.outbox!.pass()
    expect(metrics()).toMatchObject({ pending: 1, dead: 0 })
    expect(health()).toBe(true)

    // Past the cap. The row is still here — it is not deleted and not marked;
    // it simply stops matching the relay's query.
    await db.asSystem().outboxMessage.updateMany({
      where: { deliveredAt: null }, data: { nextAttemptAt: new Date(0) },
    })
    await app.outbox!.pass()

    expect(metrics()).toMatchObject({ pending: 0, dead: 1 })
    expect(health()).toBe(false)
    expect(await db.asSystem().outboxMessage.count()).toBe(1)
  })
})


describe('retention', () => {

  it('drops delivered rows past it and keeps owed ones', async () => {
    const { app, db, queue } = await bootApp()
    queue.handle('order.shipped', async () => {})

    const old = await owe(db)
    await app.outbox!.deliver()
    await db.asSystem().outboxMessage.update({
      where: { id: old.id }, data: { deliveredAt: new Date(Date.now() - 10_000) },
    })
    const owed = await owe(db)

    expect(await app.outbox!.sweep(5_000)).toBe(1)

    const left = await db.asSystem().outboxMessage.findMany({})
    expect(left.map((r: { id: string }) => r.id)).toEqual([owed.id])
  })
})

describe('what the relay refuses at startup', () => {

  it('a schema with no OutboxMessage is named at boot, not at the first enqueue', async () => {
    const db = await createClient({
      databases: ':memory:',
      schema:    'database main { path "./a.db" }\nmodel Post { id Int @id @default(autoincrement())  title String  @@db(main) }',
    }) as any
    closers.push(() => db.$close())

    const app = await createTestApp()
    app.db = db
    const queue = createCaravan({ db: ':memory:', pollInterval: 10 })
    closers.push(() => queue.stop())
    app.configure(queue)
    app.configure(outbox())

    await expect(app._startForTest()).rejects.toThrow(/declares no OutboxMessage/)
  })

  it('without a queue configured, the requirement is named at startup', async () => {
    const db = await createClient({ databases: ':memory:', schema: SCHEMA }) as any
    closers.push(() => db.$close())

    const app = await createTestApp()
    app.db = db
    app.configure(outbox())

    await expect(app._startForTest()).rejects.toThrow(/caravan/)
  })
})
