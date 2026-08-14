// tests/bulk-partial-success.test.ts
//
// A bulk create returns PARTIAL SUCCESS: rows that saved in `data`, rows that
// didn't in `errors`, each paired with the input that failed and why.
//
// This is the shape Feathers' 2017 envelope proposal (issue #562) specified —
// `errors: [{ data, error }]  // for failed records in bulk changes` — and
// never shipped, because the migration cost across its ecosystem killed it.
// Junction carried the `errors` field from that proposal for years with nothing
// ever writing to it. This makes it load-bearing.
//
// Three separate defects had to be fixed before one bulk create could work:
//
//   1. the bridge did `{ ...body }` on an array, producing { 0: …, 1: … }, so
//      Array.isArray(ctx.data) was false and the bulk branch never ran
//   2. the validators called parse() on the array itself, which rejects an
//      array outright — every bulk create 400'd before reaching the service
//   3. validating element-wise then threw on the FIRST bad row, which makes
//      partial success unreachable by construction
//
// A filtered bulk PATCH and REMOVE answer the same protocol (`FJS-044`, ruled
// by `FJS-D11`) — the second half of this file. They select their rows and then
// write them one at a time, which is what gives each row an outcome AND what
// makes `@@transitions` and `@version` apply: both are properties of `update()`
// and neither runs on `updateMany()`. Those tests need a REAL Litestone client
// for exactly that reason — a stand-in db has no state machine to walk past.

import { describe, test, expect } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { createService } from '../src/core/service.ts'
import { createSchema } from '../src/core/schema.ts'
import { BULK_FAILURES, partitionBulk, wrapResult, type BulkFailure } from '../src/core/envelope.ts'
import { createClient }        from '../../litestone/src/index.js'
import type { ServiceContext } from '../src/transport/bridge.ts'

describe('an array body survives the bridge', () => {

  test('ctx.data is an array, not { 0: …, 1: … }', async () => {
    let seen: unknown = null
    const app = await createTestApp({
      services: [() => createService({
        name: 'things',
        create: async (ctx) => { seen = ctx.data; return { ok: true } },
      })],
    })

    await request(app).post('/things').send([{ a: 1 }, { a: 2 }])

    expect(Array.isArray(seen)).toBe(true)
    expect(seen).toHaveLength(2)
  })
})

describe('validation partitions instead of throwing', () => {

  const schema = createSchema({ title: { type: 'string', required: true, minLength: 1 } })

  test('good rows pass through, bad rows are parked', () => {
    const ctx = { locals: {} as Record<string, unknown>, data: null }
    const kept = partitionBulk(
      ctx,
      [{ title: 'ok' }, { title: '' }, { title: 'fine' }],
      row => schema.parse(row),
    )

    expect(kept).toHaveLength(2)
    const parked = ctx.locals[BULK_FAILURES] as BulkFailure[]
    expect(parked).toHaveLength(1)
    expect(parked[0]!.data).toEqual({ title: '' })
    expect(parked[0]!.error.message).toContain('title')
  })

  test('failures accumulate rather than clobbering', () => {
    // Several hooks may each contribute — gate, validate, a custom check.
    const ctx = { locals: {} as Record<string, unknown> }
    partitionBulk(ctx, [{ title: '' }], row => schema.parse(row))
    partitionBulk(ctx, [{ title: '' }], row => schema.parse(row))
    expect((ctx.locals[BULK_FAILURES] as BulkFailure[])).toHaveLength(2)
  })

  test('all rows bad → empty result, every failure reported', () => {
    const ctx = { locals: {} as Record<string, unknown> }
    const kept = partitionBulk(ctx, [{ title: '' }, { title: '' }], row => schema.parse(row))
    expect(kept).toHaveLength(0)
    expect((ctx.locals[BULK_FAILURES] as BulkFailure[])).toHaveLength(2)
  })

  test('a single (non-array) body still throws — nothing to be partial about', () => {
    const compiled = createSchema({ title: { type: 'string', required: true } })
    const ctx = { data: { title: undefined }, locals: {} } as never
    expect(() => compiled.hook()(ctx)).toThrow()
  })
})

describe('the service reports both halves', () => {

  test('bulk create returns saved rows and failed inputs together', async () => {
    // A service whose create() rejects one specific row, standing in for a
    // constraint violation at the write stage.
    const app = await createTestApp({
      services: [() => createService({
        name:      'things',
        allowBulk: true,
        create: async (ctx) => {
          const rows = ctx.data as Record<string, unknown>[]
          const data: unknown[] = []
          const errors: BulkFailure[] = []
          for (const r of rows) {
            if (r.title === 'bad') errors.push({ data: r, error: { name: 'Conflict', message: 'duplicate' } })
            else data.push({ ...r, id: data.length + 1 })
          }
          return { data, total: data.length, errors }
        },
      })],
    })

    const res = await request(app).post('/things').send([
      { title: 'one' }, { title: 'bad' }, { title: 'two' },
    ])

    const body = res.body as { kind: string; data: unknown[]; errors: BulkFailure[] }
    expect(body.kind).toBe('list')
    expect(body.data).toHaveLength(2)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]!.data).toEqual({ title: 'bad' })
    expect(body.errors[0]!.error.message).toBe('duplicate')
  })

  test('a fully successful bulk create reports no errors', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:      'things',
        allowBulk: true,
        create: async (ctx) => {
          const rows = ctx.data as Record<string, unknown>[]
          return { data: rows, total: rows.length, errors: [] }
        },
      })],
    })

    const body = (await request(app).post('/things').send([{ t: 1 }, { t: 2 }])).body as
      { data: unknown[]; errors: unknown[] }
    expect(body.data).toHaveLength(2)
    expect(body.errors).toEqual([])
  })

  test('bulk is opt-in — an array body without allowBulk is a 400', async () => {
    // Guards against a missing id in a bulk patch wiping a table by accident.
    const app = await createTestApp({
      services: [() => createService({ name: 'things', model: 'thing' })],
    })
    const res = await request(app).post('/things').send([{ t: 1 }])
    expect(res.status).toBe(400)
  })
})


// ─── Filtered bulk patch / remove ──────────────────────────────────────────
// Below here the db is a real Litestone client — see the header.

type Client = Record<string, never>

const ORDERS = `
  model Order {
    id     Int    @id
    ref    String @default("x")
    status Status @default(draft)
    @@transitions(status,
      submit: draft   -> pending,
      pay:    pending -> paid,
      ship:   paid    -> shipped
    )
  }
  enum Status { draft pending paid shipped }
`

const VERSIONED = `
  model Doc {
    id    Int    @id
    title String
    ver   Int    @version
  }
`

async function mkDb(schema: string): Promise<Client> {
  return await createClient({ db: ':memory:', schema }) as unknown as Client
}

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'orders', method: 'patch', id: undefined, data: null,
    query: {}, directives: {}, auth: {}, client: {},
    locals: { db }, app: {},
    ...over,
  } as unknown as ServiceContext
}

type Bulk = { data: Record<string, unknown>[]; total: number; errors: { data: unknown; error: { name: string } }[] }

describe('a filtered bulk patch enforces what a single patch enforces', () => {

  test('a forbidden transition is refused per row, not walked past', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    await db.order!.create({ data: { id: 1 } })   // draft
    await db.order!.create({ data: { id: 2 } })   // draft

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    // draft -> shipped is not a declared move. Single patch has always refused
    // it; before FJS-044 the bulk path answered { count: 2 } and wrote both.
    const out = await svc.patch(ctx(db, { data: { status: 'shipped' }, query: { status: 'draft' } }))

    expect(out.data).toHaveLength(0)
    expect(out.errors).toHaveLength(2)
    expect(out.errors.map(e => e.error.name)).toEqual(['TransitionViolationError', 'TransitionViolationError'])

    const rows = await (db.order as never as { findMany(a?: unknown): Promise<{ status: string }[]> })
      .findMany({ select: { status: true } })
    expect(rows.every(r => r.status === 'draft')).toBe(true)
  })

  test('a legal transition still goes through', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    await db.order!.create({ data: { id: 1 } })
    await db.order!.create({ data: { id: 2 } })

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    const out = await svc.patch(ctx(db, { data: { status: 'pending' }, query: { status: 'draft' } }))

    expect(out.errors).toHaveLength(0)
    expect(out.data).toHaveLength(2)
    expect(out.data.map(r => r.status)).toEqual(['pending', 'pending'])
  })

  test('partial success — the rows that can make the move do, the rest report why', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    await db.order!.create({ data: { id: 1, status: 'paid'  } })
    await db.order!.create({ data: { id: 2, status: 'draft' } })
    await db.order!.create({ data: { id: 3, status: 'paid'  } })

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    // No filter — every row is a target, and only paid -> shipped is legal.
    const out = await svc.patch(ctx(db, { data: { status: 'shipped' } }))

    expect(out.data.map(r => r.id)).toEqual([1, 3])
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]!.data).toEqual({ id: 2 })
    expect(out.errors[0]!.error.name).toBe('TransitionViolationError')
  })

  test('the answer is a LIST envelope carrying errors, as bulk create already was', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    await db.order!.create({ data: { id: 1, status: 'paid' } })

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    const raw = await svc.patch(ctx(db, { data: { status: 'shipped' } }))
    const env = wrapResult(raw, 'orders', 'patch') as { kind: string; data: unknown[]; errors: unknown[] }

    // It used to answer { count: 1 }, which wrapResult reads as a SINGLE — so a
    // bulk patch and a bulk create came back in two different shapes.
    expect(env.kind).toBe('list')
    expect(env.data).toHaveLength(1)
    expect(env.errors).toEqual([])
  })
})

describe('@version on a filtered bulk write', () => {

  test('each row is written against its OWN version', async () => {
    const db  = await mkDb(VERSIONED) as never as Record<string, { create(a: unknown): Promise<unknown>; findMany(a?: unknown): Promise<Record<string, unknown>[]> }>
    await db.doc!.create({ data: { id: 1, title: 'a' } })
    await db.doc!.create({ data: { id: 2, title: 'b' } })
    // Move row 2 on, so the two rows are at different versions.
    await (db.doc as never as { update(a: unknown): Promise<unknown> }).update({ where: { id: 2 }, data: { title: 'b2', ver: 1 } })

    const svc = createService({ name: 'docs', model: 'Doc', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    const out = await svc.patch(ctx(db, { service: 'docs', data: { title: 'z' } }))

    expect(out.errors).toHaveLength(0)
    expect(out.data).toHaveLength(2)
    // Both bumped from wherever they were, which a single shared version could
    // not have done.
    expect(out.data.map(r => r.ver)).toEqual([2, 3])
  })

  test('a caller-supplied version is refused by name', async () => {
    const db  = await mkDb(VERSIONED) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    await db.doc!.create({ data: { id: 1, title: 'a' } })

    const svc = createService({ name: 'docs', model: 'Doc', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<unknown> }

    const err = await svc.patch(ctx(db, { service: 'docs', data: { title: 'z', ver: 1 } })).catch(e => e as Error)

    expect((err as Error).message).toContain('ver')
    expect((err as Error).message).toContain('per row')
  })

  test('a model with no @version is unaffected', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    await db.order!.create({ data: { id: 1 } })

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    const out = await svc.patch(ctx(db, { data: { ref: 'renamed' } }))
    expect(out.data).toHaveLength(1)
    expect(out.data[0]!.ref).toBe('renamed')
  })
})

describe('a filtered bulk remove', () => {

  test('answers the removed rows and reports a row it could not remove', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Account { id Int @id  name String  users User[] }
      model User    { id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id]) }
    ` }) as never as Record<string, { create(a: unknown): Promise<unknown>; count(a?: unknown): Promise<number> }>

    await db.account!.create({ data: { id: 1, name: 'a' } })
    await db.account!.create({ data: { id: 2, name: 'b' } })
    await db.user!.create({ data: { id: 1, accountId: 1 } })   // holds account 1 down

    const svc = createService({ name: 'accounts', model: 'Account', allowBulk: true }) as never as
      { remove(c: ServiceContext): Promise<Bulk> }

    const out = await svc.remove(ctx(db, { service: 'accounts', method: 'remove', query: { name: { $ne: '' } } }))

    // Account 2 goes; account 1 is refused by the FK and says so, where
    // removeMany would have failed the whole statement or taken both.
    expect(out.data.map(r => r.id)).toEqual([2])
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]!.data).toEqual({ id: 1 })
    expect(await db.account!.count()).toBe(1)
  })

  test('the no-filter guard still refuses before anything is selected', async () => {
    const db  = await mkDb(ORDERS)
    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true }) as never as
      { remove(c: ServiceContext): Promise<unknown> }

    const err = await svc.remove(ctx(db, { method: 'remove' })).catch(e => e as Error)
    expect((err as Error).message).toContain('no filter conditions')
  })

  test('allowBulk: false still refuses both verbs', async () => {
    const db  = await mkDb(ORDERS)
    const svc = createService({ name: 'orders', model: 'Order' }) as never as
      { patch(c: ServiceContext): Promise<unknown>; remove(c: ServiceContext): Promise<unknown> }

    const p = await svc.patch(ctx(db, { data: { ref: 'x' } })).catch(e => e as Error)
    const r = await svc.remove(ctx(db, { method: 'remove', query: { ref: 'x' } })).catch(e => e as Error)

    expect((p as Error).message).toContain('Bulk patch is disabled')
    expect((r as Error).message).toContain('Bulk remove is disabled')
  })
})

describe('bulkMax', () => {

  test('a filter matching more rows than the cap is refused, naming the count', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    for (let i = 1; i <= 5; i++) await db.order!.create({ data: { id: i } })

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true, bulkMax: 3 }) as never as
      { patch(c: ServiceContext): Promise<unknown> }

    const err = await svc.patch(ctx(db, { data: { ref: 'touched' } })).catch(e => e as Error)

    expect((err as Error).message).toContain('matched 5 rows')
    expect((err as Error).message).toContain('limit of 3')
    // Refused BEFORE any write — the cap is a precondition, not a stop-after-N.
    // ('touched' rather than the column default, or the assertion passes on a
    // table nothing wrote to.)
    const rows = await (db.order as never as { findMany(a?: unknown): Promise<{ ref: string }[]> }).findMany({})
    expect(rows.some(r => r.ref === 'touched')).toBe(false)
  })

  test('at the cap exactly, the write goes through', async () => {
    const db  = await mkDb(ORDERS) as never as Record<string, { create(a: unknown): Promise<unknown> }>
    for (let i = 1; i <= 3; i++) await db.order!.create({ data: { id: i } })

    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true, bulkMax: 3 }) as never as
      { patch(c: ServiceContext): Promise<Bulk> }

    const out = await svc.patch(ctx(db, { data: { ref: 'x' } }))
    expect(out.data).toHaveLength(3)
  })

  test('the declaration survives the autoloader spread and reaches describe()', async () => {
    // Same shape as FJS-231/the transactional: carry-through — a base spread
    // into createService must not drop the option, or the service runs on the
    // default cap while its file says otherwise.
    const svc = createService({ name: 'orders', model: 'Order', allowBulk: true, bulkMax: 25 }) as never as
      { describe(): { bulkMax: number; allowBulk: boolean } }

    expect(svc.describe().bulkMax).toBe(25)
    expect(svc.describe().allowBulk).toBe(true)
  })
})

describe('a filtered bulk restore', () => {

  const NOTES = `
    model Note { id Int @id  title String  deletedAt DateTime?  @@softDelete }
  `

  test('answers the restored rows — it used to be a 500 on every service', async () => {
    const db = await mkDb(NOTES) as never as Record<string, {
      create(a: unknown): Promise<unknown>
      removeMany(a: unknown): Promise<unknown>
      findMany(a?: unknown): Promise<Record<string, unknown>[]>
    }>
    for (let i = 1; i <= 3; i++) await db.note!.create({ data: { id: i, title: `t${i}` } })
    await db.note!.removeMany({ where: {} })

    const svc = createService({ name: 'notes', model: 'Note', allowBulk: true }) as never as
      { restore(c: ServiceContext): Promise<Record<string, unknown>[]> }

    // The bulk branch called table.restoreMany, which a Litestone table does
    // not have — so this threw "restoreMany is not a function" for every
    // filtered restore ever made.
    const out = await svc.restore(ctx(db, { service: 'notes', method: 'restore', query: { title: 't2' } }))

    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe(2)
    expect(out[0]!.deletedAt).toBeNull()

    // And only that one came back.
    const live = await db.note!.findMany({})
    expect(live.map(r => r.id)).toEqual([2])
  })

  test('restoring by id is unaffected', async () => {
    const db = await mkDb(NOTES) as never as Record<string, {
      create(a: unknown): Promise<unknown>
      removeMany(a: unknown): Promise<unknown>
    }>
    await db.note!.create({ data: { id: 1, title: 't1' } })
    await db.note!.removeMany({ where: {} })

    const svc = createService({ name: 'notes', model: 'Note', allowBulk: true }) as never as
      { restore(c: ServiceContext): Promise<Record<string, unknown>[]> }

    const out = await svc.restore(ctx(db, { service: 'notes', method: 'restore', id: 1 }))
    expect(out).toHaveLength(1)
  })
})
