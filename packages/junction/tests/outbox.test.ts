// tests/outbox.test.ts
//
// `ctx.enqueue(job, payload)` — the durable half of `ctx.afterCommit(fn)`.
//
// afterCommit buys ORDERING: the effect runs only if the call succeeded and the
// transaction committed. It buys nothing against a crash — the process dies
// between the commit and the callback and the effect is never done, with
// nothing anywhere recording that it was owed. enqueue writes a row inside the
// call's own transaction instead, so the intent commits with the write or rolls
// back with it, and a relay delivers it afterwards (`FJS-D35`).
//
// Against a real Litestone client, for the reason after-commit.test.ts is: the
// entire claim is about what is in the database after a rollback, and a stub
// agrees with whatever it was written to agree with.
//
// The DELIVERY half is tested in caravan — the relay hands rows to a real
// queue, and junction has no queue to hand them to.

import { describe, test, expect } from 'bun:test'

import { createClient }                from '../../litestone/src/index.js'
import { createService, callService }  from '../src/core/service.ts'
import { withCallEffects }             from '../src/core/context.ts'
import type { ServiceContext }         from '../src/transport/bridge.ts'

// The SHIPPED fragment, not a copy of it: an outbox model this file wrote and
// the one an app installs would be free to disagree.
const OUTBOX = await Bun.file(new URL('../db/outbox.lite', import.meta.url)).text()

const SCHEMA = `
database main { path "./app.db" }

model Post {
  id    Int    @id @default(autoincrement())
  title String
  @@db(main)
}

${OUTBOX}
`

const mkDb = () => createClient({ databases: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

/** Enough app for enqueue: the relay only has to be PRESENT. */
const appWithRelay = () => ({ outbox: { deliver: async () => ({ delivered: 0, failed: 0 }) } })

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return withCallEffects({
    service: 'posts', method: 'create', id: null, data: { title: 't' },
    query: {}, directives: {}, auth: { user: null }, client: { headers: {} }, route: {},
    locals: { db }, app: appWithRelay(), result: null, error: null, type: 'before',
    transport: 'internal', model: 'posts', $raw: null, ...over,
  } as unknown as Parameters<typeof withCallEffects>[0])
}

const rows = (db: any) => db.asSystem().outboxMessage.findMany({ orderBy: { createdAt: 'asc' } })

/** A service that writes a post and records an effect in the same breath. */
const shippingService = (extra: Record<string, unknown> = {}) => createService({
  name:          'posts',
  transactional: ['create'],
  async create(c: ServiceContext) {
    const post = await (c.locals.db as any).post.create({ data: c.data })
    await c.enqueue('order.shipped', { postId: post.id })
    return post
  },
  async find() { return [] },
  ...extra,
})

describe('ctx.enqueue — the row commits with the write', () => {

  test('a committed call leaves a row naming the job and the payload', async () => {
    const db  = await mkDb()
    const svc = shippingService()

    await callService(svc, ctx(db, { app: appWithRelay() }))

    const owed = await rows(db)
    expect(owed).toHaveLength(1)
    expect(owed[0].job).toBe('order.shipped')
    expect(owed[0].payload).toEqual({ postId: 1 })
    expect(owed[0].deliveredAt).toBeNull()
    expect(owed[0].attempts).toBe(0)
  })

  test('a call that throws AFTER enqueuing leaves no row', async () => {
    // The whole point, and the half a second database could not deliver: the
    // intent has to roll back with the write it belongs to.
    const db  = await mkDb()
    const svc = createService({
      name:          'posts',
      transactional: ['create'],
      async create(c: ServiceContext) {
        await (c.locals.db as any).post.create({ data: c.data })
        await c.enqueue('order.shipped', { postId: 1 })
        throw new Error('the courier refused')
      },
      async find() { return [] },
    })

    await expect(callService(svc, ctx(db, { app: appWithRelay() })))
      .rejects.toThrow('the courier refused')

    expect(await rows(db)).toHaveLength(0)
    expect(await db.asSystem().post.count()).toBe(0)
  })

  test('the row records the principal who asked', async () => {
    const db = await mkDb()
    await callService(shippingService(), ctx(db, {
      app:  appWithRelay(),
      auth: { user: { userId: 'u-7' } },
    }))

    expect((await rows(db))[0].actorId).toBe('u-7')
  })

  test('actor: null says the effect is the app\'s own', async () => {
    // Absent is not null — the same rule caravan's dispatch makes.
    const db  = await mkDb()
    const svc = createService({
      name:          'posts',
      transactional: ['create'],
      async create(c: ServiceContext) {
        const post = await (c.locals.db as any).post.create({ data: c.data })
        await c.enqueue('sweep', {}, { actor: null })
        return post
      },
      async find() { return [] },
    })

    await callService(svc, ctx(db, {
      app:  appWithRelay(),
      auth: { user: { userId: 'u-7' } },
    }))

    expect((await rows(db))[0].actorId).toBeNull()
  })
})

describe('ctx.enqueue — what it refuses, and by what name', () => {

  test('outside a transaction', async () => {
    // A row written outside one can be recorded for a call that then fails,
    // which is the failure this feature exists to remove wearing its other face.
    const db  = await mkDb()
    const svc = createService({
      name: 'posts',
      async create(c: ServiceContext) { await c.enqueue('order.shipped', {}) },
      async find() { return [] },
    })

    await expect(callService(svc, ctx(db, { app: appWithRelay() })))
      .rejects.toThrow(/no transaction is open/)
  })

  test('with no relay installed', async () => {
    const db  = await mkDb()
    await expect(callService(shippingService(), ctx(db, { app: {} })))
      .rejects.toThrow(/no outbox relay is installed/)
  })

  test('on a schema that never installed the model', async () => {
    const bare = await createClient({
      databases: ':memory:',
      schema:    'database main { path "./a.db" }\nmodel Post { id Int @id @default(autoincrement())  title String  @@db(main) }',
    }) as any

    await expect(callService(shippingService(), ctx(bare, { app: appWithRelay() })))
      .rejects.toThrow(/declares no OutboxMessage/)
  })

  test('with no Litestone client on the call', async () => {
    // Not through shippingService: `transactional:` refuses a db with no
    // $transaction before the method runs at all, and says so better.
    const svc = createService({
      name: 'posts',
      async create(c: ServiceContext) { await c.enqueue('order.shipped', {}) },
      async find() { return [] },
    })

    await expect(callService(svc, ctx({}, { app: appWithRelay() })))
      .rejects.toThrow(/not a Litestone client/)
  })
})

describe('ctx.enqueue — the relay kick', () => {

  test('a committed call kicks the relay once', async () => {
    const db = await mkDb()
    let kicks = 0
    const app = { outbox: { deliver: async () => { kicks++; return { delivered: 1, failed: 0 } } } }

    await callService(shippingService(), ctx(db, { app }))
    await Bun.sleep(10)   // the kick is deliberately not awaited by the call

    expect(kicks).toBe(1)
  })

  test('a failed call kicks nothing', async () => {
    const db = await mkDb()
    let kicks = 0
    const app = { outbox: { deliver: async () => { kicks++; return { delivered: 0, failed: 0 } } } }
    const svc = createService({
      name:          'posts',
      transactional: ['create'],
      async create(c: ServiceContext) {
        await c.enqueue('order.shipped', {})
        throw new Error('nope')
      },
      async find() { return [] },
    })

    await expect(callService(svc, ctx(db, { app }))).rejects.toThrow('nope')
    await Bun.sleep(10)

    expect(kicks).toBe(0)
  })

  test('a relay that throws does not fail the call', async () => {
    // Observer tier: the row is committed and owed, and the sweep is what makes
    // swallowing this safe.
    const db  = await mkDb()
    const app = { outbox: { deliver: async () => { throw new Error('queue is down') } } }

    const real = console.error
    console.error = () => {}
    try {
      await expect(callService(shippingService(), ctx(db, { app }))).resolves.toBeUndefined()
      await Bun.sleep(10)
    } finally { console.error = real }

    expect(await rows(db)).toHaveLength(1)
  })
})
