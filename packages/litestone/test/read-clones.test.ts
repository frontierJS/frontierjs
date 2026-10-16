// read-clones.test.ts — a read shapes one owned row, not a fresh copy per stage.
//
// read/readAll spread a new object for the scalars, the @from pass, @computed,
// the field policy and the @@extensible mirror drop, and include.js ran a
// second copy of the chain (`FJS-3001`). A stage now writes into the row it is
// handed and the caller clones once, so the stages' contract is identity: the
// row that went in is the row that comes out. The client-level case grades the
// whole chain against the values a Json + Boolean + @computed + @omit model
// must answer.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { deserializeRow, coerceBooleans } from '../src/core/query.js'
import { deserializeFromRow } from '../src/core/include.js'
import { applyComputed } from '../src/core/computed.js'
import { applyFieldPolicyTo } from '../src/core/field-policy.js'

describe('a read stage shapes the row it is handed', () => {
  test('deserializeRow parses Json in place', () => {
    const row: any = { id: 1, meta: '{"a":1}' }
    const out = deserializeRow(row, new Set(['meta']))
    expect(out).toBe(row)
    expect(row.meta).toEqual({ a: 1 })
  })

  test('coerceBooleans coerces in place', () => {
    const row: any = { id: 1, done: 1, off: 0, none: null }
    const out = coerceBooleans(row, new Set(['done', 'off', 'none']))
    expect(out).toBe(row)
    expect(row).toEqual({ id: 1, done: true, off: false, none: null })
  })

  test('deserializeFromRow coerces in place', () => {
    const row: any = { id: 1, hasKids: 1, last: '{"n":2}' }
    const out = deserializeFromRow(row, { hasKids: { isBool: true }, last: { isObject: true } } as any)
    expect(out).toBe(row)
    expect(row).toEqual({ id: 1, hasKids: true, last: { n: 2 } })
  })

  test('applyComputed writes the computed value onto the row', () => {
    const row: any = { id: 1, a: 2 }
    const out = applyComputed(row, 'T', { T: { double: { compute: (r: any) => r.a * 2 } } }, {} as any)
    expect(out).toBe(row)
    expect(row.double).toBe(4)
  })

  test('applyFieldPolicyTo strips from the row', () => {
    const row: any = { id: 1, secret: 'x' }
    const out = applyFieldPolicyTo(row, 'T', { secret: { omit: 'all' } } as any, { isSystem: false } as any)
    expect(out).toBe(row)
    expect('secret' in row).toBe(false)
  })
})

describe('a read through every stage', () => {
  const schema = `
    model Task {
      id     Int     @id
      title  String
      meta   Json?
      done   Boolean @default(false)
      notes  String? @omit(all)
      label  String  @computed
    }
  `
  test('answers the shaped row and leaves the stored one alone', async () => {
    const db: any = await createClient({
      schema, db: ':memory:',
      computed: { Task: { label: (r: any) => `${r.title}!` } },
    })
    await db.task.create({ data: { id: 1, title: 'a', meta: { k: [1, 2] }, done: true, notes: 'n' } })
    await db.task.create({ data: { id: 2, title: 'b', done: false } })

    const one = await db.task.findUnique({ where: { id: 1 } })
    expect(one).toEqual({ id: 1, title: 'a', meta: { k: [1, 2] }, done: true, label: 'a!' })

    const all = await db.task.findMany({ orderBy: { id: 'asc' } })
    expect(all.map((r: any) => [r.done, r.meta, r.label, 'notes' in r])).toEqual([
      [true, { k: [1, 2] }, 'a!', false],
      [false, null, 'b!', false],
    ])
  })
})
