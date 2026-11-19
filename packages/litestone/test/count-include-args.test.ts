// test/count-include-args.test.ts — `include._count`'s arguments get the questions
// an include's do (FJS-2734). Junction's `$count` hands a caller's relation names
// and where to this; a count filtered by a column is a read of it one number at a time.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../src/index.js'

const SCHEMA = `
  model Area {
    id      Int      @id
    surveys Survey[]
    @@allow(read, true)
  }
  model Survey {
    id     Int    @id
    day    String
    secret String @guarded
    areas  Area[]
    @@allow(read, true)
  }
`

async function mk() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as any
  const sys = db.asSystem()
  await sys.area.create({ data: { id: 1 } })
  await sys.survey.create({ data: { id: 1, day: '2026-01-05', secret: 'abc', areas: { connect: [{ id: 1 }] } } })
  return { db, sys, user: db.$setAuth({ id: 9 }) }
}

const countWhere = (where: object) => ({ include: { _count: { select: { surveys: { where } } } } })

describe('include._count', () => {
  test('a where on a @guarded target column is refused, as the same where on findMany is', async () => {
    const { user, sys } = await mk()
    await expect(user.area.findMany(countWhere({ secret: 'abc' }))).rejects.toThrow(/"secret" is @guarded/)
    // The system caller still counts by it.
    const rows = await sys.area.findMany(countWhere({ secret: 'abc' }))
    expect(rows[0]._count).toEqual({ surveys: 1 })
  })

  test('a where on a readable column counts', async () => {
    const { user } = await mk()
    const rows = await user.area.findMany(countWhere({ day: { gte: '2026-01-01' } }))
    expect(rows[0]._count).toEqual({ surveys: 1 })
  })

  test('an unknown relation is refused by name, as an unknown include is', async () => {
    const { user } = await mk()
    await expect(user.area.findMany({ include: { _count: { select: { survey: true } } } }))
      .rejects.toThrow(/Unknown relation 'survey' in _count on Area\. Did you mean: surveys\?/)
  })
})
