// A name inside an aggregate EXPRESSION — `having`, and an `orderBy` over an
// aggregate.
//
// `_max: { salary }` and `by: ['salary']` are graded by `refuseAggregateKeys`,
// which is the whole ladder: @hashed, @encrypted, @guarded, @omit(all) and a
// field-level @allow('read') that an aggregate has no row to decide. The two
// grammars that name a column INSIDE an expression reached none of it, so a
// @guarded column was recoverable by asking about it — a binary search on a
// HAVING threshold gave an exact value in 18 requests, and one aggregate sort
// ordered every group by it (`FJS-954`). That is `FJS-393`'s attack, which the
// where and the plain orderBy already refuse.
//
// Two more failures shared the gap, and both were silent. An unknown name
// answered rather than refused, because SQLite reads an unresolvable quoted
// identifier as a string constant and `SUM('nope') > 1` is false (`FJS-202`).
// And a @map'd field compared against its own NAME, since these two expressions
// interpolated the field where every other aggregate site calls `_aggCol`.
//
// Every refusal here is paired with the same shape one column away: a guard
// that refused `having` outright, or refused every name in it, would satisfy a
// suite that only asked about the refusal (`FJS-351`).

import { describe, it, expect } from 'bun:test'
import { createClient, ValidationError } from '../src/index.js'

const SCHEMA = `
model Employee {
  id       Int    @id
  name     String
  dept     String
  salary   Int    @guarded
  bonus    Int
  homeTown String @map("home_town")
}
`

async function seeded() {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
  const sys = db.asSystem()
  await sys.employee.create({ data: { id: 1, name: 'ada', dept: 'eng', salary: 90000, bonus: 5000, homeTown: 'york' } })
  await sys.employee.create({ data: { id: 2, name: 'bea', dept: 'ops', salary: 40000, bonus: 1000, homeTown: 'hull' } })
  return { db, sys, as: db.$setAuth({ id: 1 }) }
}

const refuses = async (fn: () => Promise<unknown>) => {
  try { await fn() } catch (e) { return e }
  return null
}

describe('having — a @guarded column cannot be recovered by filtering on it', () => {
  it('refuses the aggregate a binary search would walk', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, having: { _sum: { salary: { gt: 50000 } } },
    }))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('salary')
    expect((err as Error).message).toContain('@guarded')
  })

  it('the search itself recovers nothing — every threshold refuses alike', async () => {
    // The measurement that opened FJS-954: 18 requests, one bit each, against a
    // caller whose rows carry no `salary` at all. A refusal that varied with the
    // threshold would still be an oracle.
    const { as } = await seeded()
    const answers = new Set<string>()
    for (const gt of [1000, 50000, 89999, 90000, 200000]) {
      const err = await refuses(() => as.employee.groupBy({
        by: ['dept'], _count: true, having: { _sum: { salary: { gt } } },
      }))
      answers.add(err instanceof ValidationError ? 'refused' : 'answered')
    }
    expect([...answers]).toEqual(['refused'])
  })

  it('still filters on a column the caller may read', async () => {
    const { as } = await seeded()
    const rows = await as.employee.groupBy({
      by: ['dept'], _count: true, having: { _sum: { bonus: { gt: 2000 } } },
    })
    expect(rows.map((r: any) => r.dept)).toEqual(['eng'])
  })

  it('asSystem() reads it, which is what @guarded means', async () => {
    const { sys } = await seeded()
    const rows = await sys.employee.groupBy({
      by: ['dept'], _count: true, having: { _sum: { salary: { gt: 50000 } } },
    })
    expect(rows.map((r: any) => r.dept)).toEqual(['eng'])
  })
})

describe('orderBy over an aggregate — one request, every group', () => {
  it('refuses a sort over the guarded column', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { _sum: { salary: 'desc' } },
    }))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('@guarded')
  })

  it('still sorts by an aggregate the caller may read', async () => {
    const { as } = await seeded()
    const rows = await as.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { _sum: { bonus: 'desc' } },
    })
    expect(rows.map((r: any) => r.dept)).toEqual(['eng', 'ops'])
  })

  it('asSystem() sorts by it', async () => {
    const { sys } = await seeded()
    const rows = await sys.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { _sum: { salary: 'asc' } },
    })
    expect(rows.map((r: any) => r.dept)).toEqual(['ops', 'eng'])
  })
})

describe('a name that is not a column is refused rather than answered', () => {
  it('having: an unknown field answered [] before this', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, having: { _sum: { bonuss: { gt: 1 } } },
    }))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('bonus')      // the did-you-mean
  })

  it('orderBy: an unknown field sorted by nothing', async () => {
    const { as } = await seeded()
    expect(await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { _max: { bonuss: 'desc' } },
    }))).toBeInstanceOf(ValidationError)
  })

  it('names the supported set when the WRAPPER is the typo', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, having: { _total: { bonus: { gt: 1 } } },
    })) as Error
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('_sum')
  })

  it('refuses a sort by a column that is not a group key', async () => {
    // It emitted `"name" ASC` against a SELECT that has no such output, which
    // SQLite reads as a constant — a sort that silently did nothing.
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { name: 'asc' },
    })) as Error
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('dept')                  // the group keys it lists
  })

  it('sorts by the group key itself, and by _count', async () => {
    const { as } = await seeded()
    expect((await as.employee.groupBy({ by: ['dept'], _count: true, orderBy: { dept: 'desc' } }))
      .map((r: any) => r.dept)).toEqual(['ops', 'eng'])
    expect((await as.employee.groupBy({ by: ['dept'], _count: true, orderBy: { _count: 'desc' } }))
      .length).toBe(2)
  })
})

describe('the identifier is the column, not the field name', () => {
  // Against the field name as a string constant, 'homeTown' > 'j' is false and
  // the answer is empty — so the assertion is a THRESHOLD that separates the
  // two rows, not merely a non-empty result.
  it('having resolves a @map column', async () => {
    const { as } = await seeded()
    const rows = await as.employee.groupBy({
      by: ['dept'], _count: true, having: { _max: { homeTown: { gt: 'j' } } },
    })
    expect(rows.map((r: any) => r.dept)).toEqual(['eng'])   // york, not hull
  })

  it('orderBy resolves a @map column', async () => {
    const { as } = await seeded()
    const rows = await as.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { _max: { homeTown: 'desc' } },
    })
    expect(rows.map((r: any) => r.dept)).toEqual(['eng', 'ops'])   // york > hull
  })
})

describe('caller text never reaches the SQL', () => {
  it('refuses a name carrying a quote rather than emitting it (Invariant 8)', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, having: { _sum: { ['bonus") > 0 OR (SUM("bonus']: { gt: 0 } } },
    }))
    expect(err).toBeInstanceOf(ValidationError)
  })

  it('still refuses $raw on a groupBy orderBy, with the sentence that explains it', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy({
      by: ['dept'], _count: true, orderBy: { $raw: 'anything' } as any,
    })) as Error
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('$raw')
  })
})
