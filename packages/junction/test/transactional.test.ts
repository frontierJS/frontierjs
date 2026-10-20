// test/transactional.test.ts
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
import { callService, resolveTransactional, buildService } from '../src/core/service.ts'
import { withLitestoneDb } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { $, setCallDb } from '../src/core/context.ts'

const SCHEMA = `model Post { id Int @id @default(autoincrement())  title String }`

const mkDb = () => createClient({ db: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return setCallDb({
    service: 'posts', method: 'create', id: undefined, data: { title: 't' },
    query: {}, auth: { user: null }, caller: {}, route: {},
    locals: {}, app: {}, result: null, type: 'before', ...over,
  } as unknown as ServiceContext, db)
}

const writes = (extra: Record<string, unknown> = {}) => ({
  name: 'posts',
  async create(c: ServiceContext) { return ($.db as any).post.create({ data: c.data }) },
  async find()  { return [] },
  ...extra,
})

describe('transactional: the write is atomic with the whole pipeline', () => {

  test('an after hook throwing rolls the method write back', async () => {
    const db  = await mkDb()
    const svc = buildService(writes({
      transactional: true,
      hooks: { after: { create: [function boom() { throw new Error('a later after hook fails') }] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/later after hook/)
    expect(await db.asSystem().post.count()).toBe(0)
  })

  test('and the happy path commits', async () => {
    const db  = await mkDb()
    const svc = buildService(writes({ transactional: true }) as never)
    await callService(svc, ctx(db))
    expect(await db.asSystem().post.count()).toBe(1)
  })

  test('without the declaration the row survives the same failure — which is the defect', async () => {
    // The control. Same service, same throwing hook, no `transactional:` — the
    // client is told the create failed and the row is there.
    const db  = await mkDb()
    const svc = buildService(writes({
      hooks: { after: { create: [function boom() { throw new Error('boom') }] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(1)
  })

  test('a nested service call rolls back with its caller', async () => {
    // Every client flavor shares one write connection and one depth counter, so
    // the inner write lands inside the outer transaction with no propagation.
    const db    = await mkDb()
    const inner = buildService(writes() as never)
    const outer = buildService({
      name: 'outer',
      transactional: true,
      async create(c: ServiceContext) {
        await callService(inner, ctx($.db, { data: { title: 'inner' } }))
        return ($.db as any).post.create({ data: { title: 'outer' } })
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
    const svc = buildService(writes({
      transactional: ['patch'],
      async patch(c: ServiceContext) { return ($.db as any).post.create({ data: c.data }) },
      hooks: { after: { all: [function boom() { throw new Error('boom') }] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(1)          // create: not wrapped

    await expect(callService(svc, ctx(db, { method: 'patch', id: 1 }))).rejects.toThrow(/boom/)
    expect(await db.asSystem().post.count()).toBe(1)          // patch: wrapped, rolled back
  })

  test('describe() reports the resolved list', () => {
    const svc = buildService({ name: 'posts', model: 'Post', transactional: true } as never)
    expect(svc.describe().transactional).toContain('create')
    expect(svc.describe().transactional).not.toContain('find')
    expect(buildService({ name: 'p2', model: 'Post' } as never).describe().transactional).toEqual([])
  })
})

describe('it refuses rather than quietly doing nothing', () => {

  test('a service declaring it without a Litestone client throws, naming the service', async () => {
    const svc = buildService(writes({ transactional: true }) as never)
    await expect(callService(svc, ctx({ /* not a litestone client */ })))
      .rejects.toThrow(/Service 'posts' declares transactional: but its client \(\$\.db\) has no \$transaction/)
  })
})

describe('the scope survives into the transaction', () => {

  test('withLitestoneDb runs outside it, so the tx client is still caller-scoped', async () => {
    // withLitestoneDb is an APP-level around hook and app hooks merge first, so
    // $.db is already $setAuth'd when the transaction opens. If the
    // order were reversed the transaction would run unscoped and every row
    // policy would match nothing — silently.
    const db  = await createClient({
      db: ':memory:',
      schema: `model Post {
        id      Int    @id @default(autoincrement())
        title   String
        ownerId Int    @default(auth().id)
        @@allow(read, ownerId == auth().id)
        @@allow(create, auth() != null)
      }`,
    }) as any

    const svc = buildService(writes({ transactional: true }) as never)
    const appHooks = { around: { all: [withLitestoneDb(db)] } }

    const c = ctx(undefined, { auth: { user: { id: 7, userId: 7 } } })
    await callService(svc, c, appHooks as never)

    const rows = await db.asSystem().post.findMany({})
    expect(rows.length).toBe(1)
    expect(rows[0].ownerId).toBe(7)      // @default(auth().id) stamped inside the tx
  })
})

describe('the derived hook installs once', () => {

  test('a built service opens one scope, not a nested second', async () => {
    // A second scope would still be CORRECT — it nests as a savepoint — so the
    // only way to see a doubled install is to count the opens.
    const db: any = await mkDb()
    let opens = 0
    const orig = db.$transaction.bind(db)
    db.$transaction = (fn: any, p: any) => { opens++; return orig(fn, p) }

    const built = buildService({ name: 'posts', model: 'Post', transactional: true } as never)

    await callService(built, ctx(db))
    expect(opens).toBe(1)
    expect(await db.asSystem().post.count()).toBe(1)
  })
})

describe('transactional: makes a bulk write all or nothing (FJS-2149)', () => {

  // A bulk write catches each row's failure to report it, so without this the
  // transaction around the call saw no throw and committed the rows that
  // succeeded — partial success under the one declaration that trades it away
  // (`FJS-D11`).
  const UNIQUE = `model Event { id Int @id @default(autoincrement())  key String @unique }`
  const events = (over: Record<string, unknown> = {}) =>
    buildService({ name: 'events', model: 'Event', allowBulk: true, ...over } as never)

  test('one failing row in a bulk create rolls back the rest and answers the failures', async () => {
    const db = await createClient({ db: ':memory:', schema: UNIQUE }) as any
    await db.event.create({ data: { key: 'dup' } })

    const err = await callService(events({ transactional: ['create'] }),
      ctx(db, { service: 'events', data: [{ key: 'a' }, { key: 'dup' }, { key: 'b' }] }))
      .then(() => null, (e: unknown) => e) as { code: number; data: { errors: { data: unknown }[] } } | null

    expect(err?.code).toBe(422)
    expect(err!.data.errors.map(e => e.data)).toEqual([{ key: 'dup' }])
    expect(await db.asSystem().event.count()).toBe(1)
  })

  test('a filtered bulk patch rolls back the same way', async () => {
    const db = await createClient({ db: ':memory:', schema: UNIQUE }) as any
    await db.event.create({ data: { key: 'a' } })
    await db.event.create({ data: { key: 'b' } })

    // Every row targeted takes the same key, so the second write breaks @unique.
    await expect(callService(events({ transactional: true }),
      ctx(db, { service: 'events', method: 'patch', data: { key: 'same' }, query: { key: { in: ['a', 'b'] } }, directives: {} })))
      .rejects.toMatchObject({ code: 422 })
    const keys = (await db.asSystem().event.findMany({ orderBy: { id: 'asc' } })).map((r: { key: string }) => r.key)
    expect(keys).toEqual(['a', 'b'])
  })

  test('without the declaration the same bulk create is partial success', async () => {
    const db = await createClient({ db: ':memory:', schema: UNIQUE }) as any
    await db.event.create({ data: { key: 'dup' } })

    await callService(events(), ctx(db, { service: 'events', data: [{ key: 'a' }, { key: 'dup' }, { key: 'b' }] }))
    expect(await db.asSystem().event.count()).toBe(3)
  })
})

describe('a method that calls out before it writes scopes the write itself (FJS-2620)', () => {

  // `transactional:` opens BEGIN IMMEDIATE before the method runs, so a vendor
  // call inside the method holds the write lock for its whole latency. The
  // guide's alternative is `$.db.$transaction` around the writes alone; this
  // pins that the lock is taken there and not before the call out.
  test('no lock before the call out, one around the writes, none after', async () => {
    const db = await mkDb()
    const seen: boolean[] = []
    const svc = buildService({
      name: 'posts',
      async create(c: ServiceContext) {
        const d = $.db as any
        seen.push(d.$inTransaction)                       // the vendor call happens here
        const row = await d.$transaction(async (tx: any) => {
          seen.push(tx.$inTransaction)
          return tx.post.create({ data: c.data })
        })
        seen.push(d.$inTransaction)
        return row
      },
      async find() { return [] },
    } as never)

    await callService(svc, ctx(db))
    expect(seen).toEqual([false, true, false])
    expect(await db.asSystem().post.count()).toBe(1)
  })

  test('declared transactional:, the call out is already inside the lock', async () => {
    const db = await mkDb()
    let before: boolean | undefined
    const svc = buildService(writes({
      transactional: true,
      async create(c: ServiceContext) {
        before = ($.db as any).$inTransaction
        return ($.db as any).post.create({ data: c.data })
      },
    }) as never)

    await callService(svc, ctx(db))
    expect(before).toBe(true)
  })
})
