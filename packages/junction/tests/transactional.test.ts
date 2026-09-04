// tests/transactional.test.ts
//
// FJS-089's write half. `around` is the only phase that wraps the after hooks,
// so a transaction opened there covers before → method → after: a later `after`
// hook throwing rolls the write back instead of leaving a committed row behind
// a rejected response.
//
// Against a REAL Litestone client, not a fake. The whole feature is a claim
// about $transaction's behavior, and a stub that records calls would pass every
// assertion here while proving nothing (house rule, and how the accessor bug
// shipped once).

import { describe, test, expect } from 'bun:test'
import { createClient }   from '../../litestone/src/index.js'
import { createService, createBaseService, callService, resolveTransactional } from '../src/core/service.ts'
import { withLitestoneDb } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const SCHEMA = `model Post { id Int @id @default(autoincrement())  title String }`

const mkDb = () => createClient({ db: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method: 'create', id: undefined, data: { title: 't' },
    query: {}, auth: { user: null }, client: {}, route: {},
    locals: { db }, app: {}, result: null, type: 'before', ...over,
  } as unknown as ServiceContext
}

const writes = (extra: Record<string, unknown> = {}) => ({
  name: 'posts',
  async create(c: ServiceContext) { return (c.locals.db as any).post.create({ data: c.data }) },
  async find()  { return [] },
  ...extra,
})

describe('transactional: the write is atomic with the whole pipeline', () => {

  test('an after hook throwing rolls the method write back', async () => {
    const db  = await mkDb()
    const svc = createService(writes({
      transactional: true,
      hooks: { after: { create: [function boom() { throw new Error('a later after hook fails') }] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/later after hook/)
    expect(await db.asSystem().post.count()).toBe(0)
  })

  test('and the happy path commits', async () => {
    const db  = await mkDb()
    const svc = createService(writes({ transactional: true }) as never)
    await callService(svc, ctx(db))
    expect(await db.asSystem().post.count()).toBe(1)
  })

  test('without the declaration the row survives the same failure — which is the defect', async () => {
    // The control. Same service, same throwing hook, no `transactional:` — the
    // client is told the create failed and the row is there.
    const db  = await mkDb()
    const svc = createService(writes({
      hooks: { after: { create: [function boom() { throw new Error('boom') }] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(1)
  })

  test('a nested service call rolls back with its caller', async () => {
    // Every client flavor shares one write connection and one depth counter, so
    // the inner write lands inside the outer transaction with no propagation.
    const db    = await mkDb()
    const inner = createService(writes() as never)
    const outer = createService({
      name: 'outer',
      transactional: true,
      async create(c: ServiceContext) {
        await callService(inner, ctx(c.locals.db, { data: { title: 'inner' } }))
        return (c.locals.db as any).post.create({ data: { title: 'outer' } })
      },
      hooks: { after: { create: [function boom() { throw new Error('boom') }] } },
    } as never)

    await expect(callService(outer, ctx(db))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(0)
  })
})

describe('what it is and is not applied to', () => {

  test('find is never wrapped, whatever is declared', async () => {
    // A read taking BEGIN IMMEDIATE would serialize every reader. Excluded by
    // name, the same rule the announcement uses.
    expect(resolveTransactional(true, ['find', 'get', 'create', 'patch'])).toEqual(['create', 'patch'])
    expect(resolveTransactional(['find', 'create'], ['find', 'create'])).toEqual(['create'])
  })

  test('false is a declared opt-out and undefined is off', () => {
    expect(resolveTransactional(false, ['create'])).toEqual([])
    expect(resolveTransactional(undefined, ['create'])).toEqual([])
  })

  test('a named list leaves the other methods alone', async () => {
    const db  = await mkDb()
    const svc = createService(writes({
      transactional: ['patch'],
      async patch(c: ServiceContext) { return (c.locals.db as any).post.create({ data: c.data }) },
      hooks: { after: { all: [function boom() { throw new Error('boom') }] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(1)          // create: not wrapped

    await expect(callService(svc, ctx(db, { method: 'patch', id: 1 }))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(1)          // patch: wrapped, rolled back
  })

  test('describe() reports the resolved list', () => {
    const svc = createService({ name: 'posts', model: 'Post', transactional: true } as never)
    expect(svc.describe().transactional).toContain('create')
    expect(svc.describe().transactional).not.toContain('find')
    expect(createService({ name: 'p2', model: 'Post' } as never).describe().transactional).toEqual([])
  })
})

describe('it refuses rather than quietly doing nothing', () => {

  test('a service declaring it without a Litestone client throws, naming the service', async () => {
    const svc = createService(writes({ transactional: true }) as never)
    await expect(callService(svc, ctx({ /* not a litestone client */ })))
      .rejects.toThrow(/Service 'posts' declares transactional: but ctx.locals.db has no \$transaction/)
  })
})

describe('the scope survives into the transaction', () => {

  test('withLitestoneDb runs outside it, so the tx client is still caller-scoped', async () => {
    // withLitestoneDb is an APP-level around hook and app hooks merge first, so
    // ctx.locals.db is already $setAuth'd when the transaction opens. If the
    // order were reversed the transaction would run unscoped and every row
    // policy would match nothing — silently.
    const db  = await createClient({
      db: ':memory:',
      schema: `model Post {
        id      Int    @id @default(autoincrement())
        title   String
        ownerId Int    @default(auth().id)
        @@allow('read', ownerId == auth().id)
        @@allow('create', auth() != null)
      }`,
    }) as any

    const svc = createService(writes({ transactional: true }) as never)
    const appHooks = { around: { all: [withLitestoneDb(db)] } }

    const c = ctx(undefined, { auth: { user: { id: 7, userId: 7 } } })
    await callService(svc, c, appHooks as never)

    const rows = await db.asSystem().post.findMany({})
    expect(rows.length).toBe(1)
    expect(rows[0].ownerId).toBe(7)      // @default(auth().id) stamped inside the tx
  })
})

describe('the derived hook installs once', () => {

  test('a base spread back through createService does not stack a second scope', async () => {
    // The FJS-231 shape: the autoloader spreads a base straight back through
    // createService, and a base returns the MERGED hook map. An unmarked hook
    // appended unconditionally installs itself again. A second scope would still
    // be CORRECT — it nests as a savepoint — so the only way to see it is to
    // count the opens.
    const db: any = await mkDb()
    let opens = 0
    const orig = db.$transaction.bind(db)
    db.$transaction = (fn: any, p: any) => { opens++; return orig(fn, p) }

    // The loader's actual shape: a factory returns a BASE, the loader spreads it
    // into createService with the filename-derived name.
    const base  = createBaseService({ model: 'Post', transactional: true } as never)
    const built = createService({ name: 'posts', ...(base as unknown as Record<string, unknown>) } as never)

    await callService(built, ctx(db))
    expect(opens).toBe(1)
    expect(await db.asSystem().post.count()).toBe(1)
  })
})
