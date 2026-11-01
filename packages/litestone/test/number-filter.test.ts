// test/number-filter.test.ts — an Int or Float column filtered by text that is not a number (FJS-3727).
//
// SQLite compares an INTEGER column to the text '@me' as unequal, so
// `{ not: '@me' }` matched every row and `{ gt: 'abc' }` answered by storage
// class rather than by value -- a 200 with the wrong rows. Numeric text still
// works (`?qty=5` converts by column affinity), so only text that is not a
// number is refused, by field and type.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Claim {
    id     Int    @id
    owner  Int
    amount Float
    note   String
  }
`

let db: any

beforeEach(async () => {
  db = (await createClient({ db: ':memory:', schema: SCHEMA })).asSystem()
  await db.claim.create({ data: { id: 1, owner: 7, amount: 1.5, note: '@me' } })
  await db.claim.create({ data: { id: 2, owner: 8, amount: 2.5, note: 'x' } })
})

const refused = async (where: unknown) => {
  try { await db.claim.findMany({ where }) } catch (e: any) { return e.message ?? String(e) }
  return null
}

describe('a number column filtered by text that is not a number', () => {
  test('numeric text still filters by value', async () => {
    expect((await db.claim.findMany({ where: { owner: '7' } })).length).toBe(1)
    expect((await db.claim.findMany({ where: { owner: { not: '7' } } })).length).toBe(1)
    expect((await db.claim.findMany({ where: { amount: { gt: '2' } } })).length).toBe(1)
    expect((await db.claim.findMany({ where: { owner: { in: ['7', 8] } } })).length).toBe(2)
  })

  test('not: @me is refused naming the field and the type', async () => {
    const m = await refused({ owner: { not: '@me' } })
    expect(m).toContain('owner')
    expect(m).toContain('number')
  })

  test('every comparison and the bare form are refused', async () => {
    for (const where of [
      { owner: '@me' }, { owner: { equals: 'abc' } }, { owner: { gt: 'abc' } }, { owner: { lte: 'abc' } },
      { owner: { in: [1, 'abc'] } }, { owner: { notIn: ['abc'] } }, { owner: ['abc'] }, { amount: { not: 'abc' } },
    ]) expect(await refused(where)).not.toBeNull()
  })

  test('a text column is untouched', async () => {
    expect((await db.claim.findMany({ where: { note: { not: '@me' } } })).length).toBe(1)
  })
})
