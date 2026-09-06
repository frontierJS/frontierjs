// tests/adapter-cache-key.test.ts
//
// Every adapter cache was keyed on the CLIENT — the generated JSON Schema, the
// compiled validators, a model's column set, its `@version` column, its gate
// levels, whether it is row-scoped (`FJS-777`, `adapter-5` of `FJS-708`).
//
// Junction resolves a principal per request, so `$setAuth(user)` hands back a
// fresh proxy every time and every one of those missed on every call. Measured
// on the 188-model fixture, a create cost **7.38 ms** with a fresh principal
// and **0.49 ms** with one reused — 6.9 ms of rederivation per write, on work
// that does not depend on who is asking.
//
// `$schema` is the identity they always meant: litestone shares the parsed
// schema BY REFERENCE across every flavor of client.
//
// The behavioral rows come first, because a cache key is the kind of change that
// is invisible until it is wrong — and when it is wrong it is wrong about
// ACCESS, since `_gateFor` and `_rowScoped` are in the set. So what is asserted
// is that two principals still get two different answers out of a shared entry.

import { describe, test, expect, beforeAll } from 'bun:test'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { createClient }  from '../../litestone/src/index.js'

// 80 models, because the cost being measured is `generateJsonSchema` over the
// WHOLE schema and a two-model fixture cannot tell a cache hit from a miss —
// the first version of this test passed with the fix reverted, which is a test
// that proves nothing (`FJS-351`).
const FILLER = Array.from({ length: 80 }, (_, i) => `
  model Filler${i} {
    id    Int    @id @default(autoincrement())
    a     String
    b     String?
    c     Int     @default(0)
    d     Boolean @default(false)
    @@db(main)
  }`).join('\n')

const SCHEMA = `
  database main { path ":memory:" }
${FILLER}

  model User {
    id      Int    @id @default(autoincrement())
    email   String @unique
    isAdmin Boolean @default(false)
    @@auth
    @@db(main)
  }

  model Doc {
    id      Int    @id @default(autoincrement())
    title   String
    ownerId Int
    @@gate("0.4.4.5")
    @@allow('read', auth().id == ownerId)
    @@db(main)
  }
`

let db: any
let app: any

beforeAll(async () => {
  db = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.asSystem().doc.createMany({ data: [
    { title: 'alice', ownerId: 1 },
    { title: 'bob',   ownerId: 2 },
  ] })
  app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  app.services.register(createService({ name: 'docs', model: 'Doc' } as never))
})

describe('a shared cache still answers per caller', () => {
  test('a row policy: each principal gets its own rows', async () => {
    const svc = app.service('docs')
    // FRESH principal objects, which is what a request is — and the shape that
    // made every cache miss before. Two callers, one cache entry, two answers.
    const a = await svc.find({}, { auth: { user: { id: 1 } } })
    const b = await svc.find({}, { auth: { user: { id: 2 } } })
    expect(a.data.map((r: any) => r.title)).toEqual(['alice'])
    expect(b.data.map((r: any) => r.title)).toEqual(['bob'])
  })

  test('a gate: the level is the CALLER\'s, not the first caller\'s', async () => {
    const svc = app.service('docs')
    // `_gateFor` is one of the caches being shared. If a gate answer were
    // cached per PRINCIPAL rather than per model this would pass anyway, so the
    // order is deliberate: the refused caller goes first.
    await expect(svc.remove(1, { auth: { user: { id: 1 } } })).rejects.toThrow()
    await expect(svc.remove(1, { auth: { user: { id: 1, isAdmin: true } } })).resolves.toBeDefined()
  })

  test('validation still refuses, per call, on a fresh principal each time', async () => {
    const svc = app.service('docs')
    for (let i = 0; i < 3; i++)
      await expect(svc.create({ ownerId: 1 } as never, { auth: { user: { id: 1, isAdmin: true } } }))
        .rejects.toThrow(/title/)
  })
})

describe('the key is the schema, not the client', () => {
  test('every flavor of client answers the same $schema object', async () => {
    // The property the fix rests on. If litestone ever copied the schema per
    // flavor this would go false and the caches would silently start missing
    // again — which is exactly the failure that has no symptom but latency.
    const a = db.$setAuth({ id: 1 })
    const b = db.$setAuth({ id: 2 })
    expect(a.$schema).toBe(db.$schema)
    expect(b.$schema).toBe(db.$schema)
    expect(db.asSystem().$schema).toBe(db.$schema)
    expect(db.$scopedBy({}).$schema).toBe(db.$schema)

    // …and the clients themselves are NOT the same object, or the whole finding
    // would not exist and this test would be asserting nothing.
    expect(a).not.toBe(b)
  })

  test('a write on a fresh principal costs what a reused one costs', async () => {
    const svc = app.service('docs')
    const admin = { id: 1, isAdmin: true }
    const time = async (mk: () => any, n: number) => {
      for (let i = 0; i < 3; i++) await svc.create({ title: 'w', ownerId: 1 }, { auth: { user: mk() } })
      const t0 = Bun.nanoseconds()
      for (let i = 0; i < n; i++) await svc.create({ title: 'w', ownerId: 1 }, { auth: { user: mk() } })
      return (Bun.nanoseconds() - t0) / n / 1e6
    }
    const fresh  = await time(() => ({ id: 1, isAdmin: true }), 20)
    const reused = await time(() => admin, 20)

    // A RATIO, not a budget: absolute numbers move with the machine and the
    // schema; what must stay true is that the two are the SAME WORK. Measured
    // on this fixture: 1.3x with the key on the schema, 6.6x with it back on
    // the client, and 15x on the 188-model one.
    //
    // The floor below is not decoration. The first version of this test used a
    // two-model schema and a bound with a constant in it, and it passed with
    // the fix reverted — a test that proves nothing (`FJS-351`). If the fixture
    // is ever too small or the machine too fast to measure, this fails saying
    // so rather than passing by accident.
    expect(reused).toBeGreaterThan(0.05)
    expect(fresh / reused).toBeLessThan(3)
  })
})
