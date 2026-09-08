// `aggregate` — counts, sums and groups on the auto surface (`FJS-D226`).
//
// The ruling's substance is that the ARGUMENTS ARE AN ALLOW-LIST rather than a
// pass-through, and it was argued from measurement: grading the surface this
// verb exposes found two silent holes in it — `having` and an aggregate
// `orderBy` named columns that reached no field ladder (`FJS-954`), and a
// request-shaped object forged a `sql`` fragment whose text went into the
// statement (`FJS-955`). A body handed to litestone whole re-opens that class
// every time the language grows a key, once per app.
//
// So the rows below are in three groups, and the middle one is the point:
//
//   1. it answers — one row for an aggregate, one per group for a groupBy
//   2. what it REFUSES, each refusal paired with the legal shape one key away
//   3. it is `find`'s twin — the same where, the same hooks, the same clamp
//
// The third is not decoration. An aggregate summarizes rows it does not return,
// so a leak there is a NUMBER that looks perfectly ordinary.

import { describe, test, expect } from 'bun:test'
import { request }       from '../src/testing/index.ts'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { createClient }  from '../../litestone/src/index.js'

const SCHEMA = `
  model Sale {
    id     Int    @id
    region String
    rep    String
    amount Int
  }
`

const ROWS = [
  { id: 1, region: 'north', rep: 'ada', amount: 100 },
  { id: 2, region: 'north', rep: 'bea', amount: 250 },
  { id: 3, region: 'south', rep: 'ada', amount:  40 },
  { id: 4, region: 'south', rep: 'cai', amount:  10 },
]

async function appWith() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  // The shipped client indexes its models as `unknown` — a schema written here
  // is not one it can type — so the seed states the shape it uses, the same way
  // `tests/announcement-row.test.ts` does.
  const sys = db.asSystem() as unknown as Record<string, { create(a: unknown): Promise<unknown> }>
  for (const row of ROWS) await sys.sale!.create({ data: row })

  const app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })

  app.services.register(createService({ name: 'sales', model: 'Sale' } as never))

  // A service whose hook narrows the read the way a tenancy filter does. What
  // it proves is that the narrowing reaches the AGGREGATE and not only `find`.
  app.services.register(createService({
    name: 'northOnly', model: 'Sale',
    hooks: { before: { all: [(ctx: ServiceContext) => { ctx.query.region = 'north' }] } },
  } as never))

  // The allow-list is the framework's, so a read-only service still answers it.
  app.services.register(createService({ name: 'readonly', model: 'Sale', methods: 'readOnly' } as never))

  return app
}

const agg = (app: unknown, service: string, body: unknown) =>
  request(app as never).post(`/${service}`).set('X-Service-Method', 'aggregate').send(body as never)

describe('it answers', () => {
  test('an aggregate over the whole selection is ONE row', async () => {
    const res = await agg(await appWith(), 'sales', { _count: true, _sum: { amount: true } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ _count: 4, _sum: { amount: 400 } })
  })

  test('naming no aggregate at all counts the rows', async () => {
    const res = await agg(await appWith(), 'sales', {})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ _count: 4 })
  })

  test('`by` makes it a groupBy — one row per group', async () => {
    const res = await agg(await appWith(), 'sales', { by: ['region'], _count: true, _sum: { amount: true } })
    expect(res.status).toBe(200)
    // A groupBy is a LIST and gets the list envelope; an aggregate is one row
    // and does not. One owner wraps both (Invariant 4) and the shapes differ
    // because the answers do.
    expect((res.body as { kind: string }).kind).toBe('list')
    const rows = (res.body as { data: { region: string, _count: number, _sum: { amount: number } }[] }).data
    expect(rows.map(r => [r.region, r._count, r._sum.amount]).sort())
      .toEqual([['north', 2, 350], ['south', 2, 50]])
  })

  test('having and an aggregate orderBy travel', async () => {
    const res = await agg(await appWith(), 'sales', {
      by: ['region'], _sum: { amount: true },
      having:  { _sum: { amount: { gt: 100 } } },
      orderBy: { _sum: { amount: 'desc' } },
    })
    expect(res.status).toBe(200)
    expect((res.body as { data: { region: string }[] }).data.map(r => r.region)).toEqual(['north'])
  })

  test('a read-only service still answers it', async () => {
    // `readOnly` is ['find','get','aggregate']: a service that could not say
    // HOW MANY would surprise everyone.
    const res = await agg(await appWith(), 'readonly', { _count: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ _count: 4 })
  })
})

describe('what the allow-list refuses, each beside the shape one key away', () => {
  test('_stringAgg is refused by name — and _sum in its place is not', async () => {
    const app = await appWith()
    const bad = await agg(app, 'sales', { by: ['region'], _stringAgg: { field: 'rep' } })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/_stringAgg/)

    const ok = await agg(app, 'sales', { by: ['region'], _sum: { amount: true } })
    expect(ok.status).toBe(200)
  })

  test('a named aggregate is refused, naming the reason — its filter is a sql`` tag', async () => {
    const app = await appWith()
    const bad = await agg(app, 'sales', {
      by: ['region'],
      _big: { count: true, filter: { _litestoneRaw: true, sql: '1=1', params: [] } },
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/_big/)

    const ok = await agg(app, 'sales', { by: ['region'], _count: true })
    expect(ok.status).toBe(200)
  })

  test('an unknown key is refused with the list of what is taken', async () => {
    const app = await appWith()
    const bad = await agg(app, 'sales', { by: ['region'], distinct: true })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/distinct/)
    expect(JSON.stringify(bad.body)).toMatch(/_count/)      // …and what it does take
  })

  test('an array body is refused rather than aggregated', async () => {
    const bad = await agg(await appWith(), 'sales', [{ _count: true }])
    expect(bad.status).toBe(400)
  })

  test('a column that cannot be aggregated is still litestone’s refusal', async () => {
    // The allow-list grades KEYS. Which columns may be named is the Data
    // boundary's answer and stays there — one owner, not two.
    const bad = await agg(await appWith(), 'sales', { _sum: { nope: true } })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/nope/)
  })
})

describe('it is find’s twin', () => {
  test('a hook that narrows ctx.query narrows the aggregate too', async () => {
    // The row that matters most: an aggregate reading only its own body would
    // answer over rows the same caller's `find` cannot see, and the answer is a
    // number that looks perfectly ordinary.
    const app = await appWith()
    const all  = await agg(app, 'sales',     { _count: true, _sum: { amount: true } })
    const some = await agg(app, 'northOnly', { _count: true, _sum: { amount: true } })

    expect(all.body).toMatchObject({ _count: 4, _sum: { amount: 400 } })
    expect(some.body).toMatchObject({ _count: 2, _sum: { amount: 350 } })
  })

  test('the caller’s own where is honoured, and ANDed with the hook’s', async () => {
    const app = await appWith()
    const mine = await agg(app, 'northOnly', { where: { rep: 'ada' }, _count: true })
    expect(mine.body).toMatchObject({ _count: 1 })       // north AND ada
  })

  test('a query-string filter narrows it the way it narrows find', async () => {
    const app = await appWith()
    const res = await request(app as never)
      .post('/sales?region=south')
      .set('X-Service-Method', 'aggregate')
      .send({ _count: true } as never)
    expect(res.body).toMatchObject({ _count: 2 })
  })

  test('the group count is CLAMPED like a page, not refused', async () => {
    // `limit` bounds what comes back; the work bound is the where, exactly as
    // it is for find. A caller asking for more than the ceiling gets the
    // ceiling rather than an error.
    const res = await agg(await appWith(), 'sales', { by: ['id'], limit: 1000, _count: true })
    expect(res.status).toBe(200)
    expect((res.body as { data: unknown[] }).data.length).toBe(4)   // 4 groups, ceiling 100
  })
})

describe('the numbers are computed over the rows the caller may READ', () => {
  // The assertion nothing else can make, and the reason the verb is graded at
  // all: an aggregate summarizes rows it does not return, so a leak here is a
  // NUMBER that looks perfectly ordinary. A count over everybody's rows and a
  // count over mine are both plausible integers.
  const OWNED = `
    model Note {
      id      Int    @id
      ownerId Int
      amount  Int
      @@allow("read", ownerId == auth().id)
    }
    model User { id Int @id  @@auth }
  `

  async function owned() {
    const db = await createClient({ db: ':memory:', schema: OWNED })
    const sys = db.asSystem() as unknown as Record<string, { create(a: unknown): Promise<unknown> }>
    await sys.user!.create({ data: { id: 1 } })
    await sys.user!.create({ data: { id: 2 } })
    await sys.note!.create({ data: { id: 1, ownerId: 1, amount: 10 } })
    await sys.note!.create({ data: { id: 2, ownerId: 1, amount: 20 } })
    await sys.note!.create({ data: { id: 3, ownerId: 2, amount: 100 } })

    const app = createApp({
      db: db as never,
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    })
    app.services.register(createService({ name: 'notes', model: 'Note' } as never))
    return app
  }

  // In process, with the principal on the call — the shape a hook or another
  // service uses, and the one that puts a real session in front of the policy
  // without a login.
  const as = (app: unknown, userId: number, body: Record<string, unknown>) =>
    (app as { service: (n: string) => { aggregate: (b: unknown, o: unknown) => Promise<unknown> } })
      .service('notes')
      .aggregate(body, { auth: { user: { userId, userType: 'user', authMethod: 'session', role: 'user' } } })

  test('one caller’s total is their own rows, not the table’s', async () => {
    const app = await owned()
    const mine   = await as(app, 1, { _count: true, _sum: { amount: true } })
    const theirs = await as(app, 2, { _count: true, _sum: { amount: true } })

    expect(mine).toMatchObject({ _count: 2, _sum: { amount: 30 } })
    expect(theirs).toMatchObject({ _count: 1, _sum: { amount: 100 } })
  })

  test('a group-by groups only what they may read', async () => {
    const app = await owned()
    // An in-process caller gets the same list envelope an HTTP one does — one
    // owner wraps both (Invariant 4).
    const res = await as(app, 1, { by: ['ownerId'], _count: true }) as { data: { ownerId: number }[] }
    expect(res.data.map(r => r.ownerId)).toEqual([1])
  })
})
