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

import { describe, test, expect } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { createService } from '../src/core/service.ts'
import { createSchema } from '../src/core/schema.ts'
import { BULK_FAILURES, partitionBulk, type BulkFailure } from '../src/core/envelope.ts'

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
