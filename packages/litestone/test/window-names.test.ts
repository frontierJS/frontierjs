// A findMany `window` spec names columns in the SELECT, the way an aggregate
// does, and never builds a row — so it is the aggregate's door under another
// key (FJS-2296). `MAX("salary")` handed a scoped caller a @guarded column,
// `MAX("nope")` answered a constant, and a name holding a quote closed the
// identifier and appended a subquery. Every name a window spec carries is held
// to the aggregate key check, and every number and keyword it splices is held
// to its own shape.

import { describe, it, expect } from 'bun:test'
import { createClient, ValidationError } from '../src/index.js'

const SCHEMA = `
model Employee {
  id     Int    @id
  name   String
  dept   String
  salary Int    @guarded
  bonus  Int
}
`

async function seeded() {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
  const sys = db.asSystem()
  await sys.employee.create({ data: { id: 1, name: 'ada', dept: 'eng', salary: 90000, bonus: 5000 } })
  await sys.employee.create({ data: { id: 2, name: 'bea', dept: 'ops', salary: 40000, bonus: 1000 } })
  await sys.employee.create({ data: { id: 3, name: 'cy',  dept: 'eng', salary: 70000, bonus: 3000 } })
  return { db, sys, as: db.$setAuth({ id: 1 }) }
}

async function refuses(fn: () => Promise<unknown>) {
  try { await fn() } catch (e) { return e }
  throw new Error('expected a refusal')
}

describe('a window spec names only columns the caller may aggregate', () => {
  it('refuses a @guarded column to a scoped caller', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.findMany({ window: { p: { max: 'salary' } } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('salary')
  })

  it('refuses a @guarded column in partitionBy and orderBy', async () => {
    const { as } = await seeded()
    expect(await refuses(() => as.employee.findMany({
      window: { r: { rank: true, orderBy: { salary: 'desc' } } },
    }))).toBeInstanceOf(ValidationError)
    expect(await refuses(() => as.employee.findMany({
      window: { r: { rowNumber: true, partitionBy: 'salary' } },
    }))).toBeInstanceOf(ValidationError)
  })

  it('refuses an unknown name by name, rather than answering a constant', async () => {
    const { sys } = await seeded()
    for (const spec of [
      { sum: 'nope' }, { lag: 'nope' }, { firstValue: 'nope' }, { count: 'nope' },
      { rowNumber: true, partitionBy: ['dept', 'nope'] },
      { rowNumber: true, orderBy: { nope: 'asc' } },
    ]) {
      const err = await refuses(() => sys.employee.findMany({ window: { w: spec } as never }))
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as Error).message).toContain('nope')
    }
  })

  it('a name holding a quote cannot reach the pattern', async () => {
    const { sys } = await seeded()
    const crafted = 'name", 1, (select sqlite_version())) OVER () AS "z", LAG("name'
    const err = await refuses(() => sys.employee.findMany({ window: { w: { lag: crafted } } }))
    expect(err).toBeInstanceOf(ValidationError)
  })

  it('refuses a number or keyword that is not one', async () => {
    const { sys } = await seeded()
    for (const spec of [
      { lag: 'bonus', offset: '1) OVER () AS z, (select 1' },
      { nthValue: 'bonus', n: '1); --' },
      { ntile: '2) OVER (), (select 1' },
      { sum: 'bonus', rows: ['1 PRECEDING) --', 0] },
      { rank: true, orderBy: { bonus: 'desc) --' } },
      { rank: true, orderBy: { bonus: { dir: 'asc', nulls: 'first) --' } } },
    ]) {
      const err = await refuses(() => sys.employee.findMany({ window: { w: spec } as never }))
      expect(err).toBeInstanceOf(ValidationError)
    }
  })

  it('a real spec still runs', async () => {
    const { sys, as } = await seeded()
    const rows = await sys.employee.findMany({
      orderBy: { id: 'asc' },
      window: {
        top:  { max: 'salary', partitionBy: 'dept' },
        prev: { lag: 'bonus', offset: 1, default: 0, orderBy: { id: 'asc' } },
        run:  { sum: 'bonus', orderBy: { id: 'asc' }, rows: [null, 0] },
        r:    { rank: true, orderBy: { bonus: { dir: 'desc', nulls: 'last' } } },
      },
    })
    expect(rows.map((r: any) => [r.top, r.prev, r.run, r.r])).toEqual([
      [90000, 0, 5000, 1], [40000, 5000, 6000, 3], [90000, 1000, 9000, 2],
    ])
    const own = await as.employee.findMany({
      orderBy: { id: 'asc' },
      window:  { n: { count: true, partitionBy: 'dept' } },
    })
    expect(own.map((r: any) => r.n)).toEqual([2, 1, 2])
  })
})

describe('a window names the field, and the column under @map', () => {
  it('reads the mapped column', async () => {
    const db  = await createClient({ schema: `
model Sale {
  id     Int    @id
  region String @map("region_code")
  amount Int    @map("amount_cents")
}
`, db: ':memory:' })
    const sys = db.asSystem()
    await sys.sale.create({ data: { id: 1, region: 'n', amount: 10 } })
    await sys.sale.create({ data: { id: 2, region: 'n', amount: 20 } })
    await sys.sale.create({ data: { id: 3, region: 's', amount: 5 } })
    const rows = await sys.sale.findMany({
      orderBy: { id: 'asc' },
      window:  { total: { sum: 'amount', partitionBy: 'region', orderBy: { amount: 'asc' } } },
    })
    expect(rows.map((r: any) => r.total)).toEqual([10, 30, 5])
  })
})

// FJS-2389: a window column rides on the row, so `select` is the only place a
// caller can ask for it. Naming one was refused as an unknown field, and a
// select that named only stored columns dropped it with no word.
describe('a window name is a column a select may name', () => {
  const rn = { rn: { rowNumber: true, orderBy: { id: 'asc' } } }

  it('answers the window column beside the stored ones it names', async () => {
    const { sys } = await seeded()
    const rows = await sys.employee.findMany({ window: rn, select: { id: true, rn: true }, orderBy: { id: 'asc' } })
    expect(rows).toEqual([{ id: 1, rn: 1 }, { id: 2, rn: 2 }, { id: 3, rn: 3 }])
  })

  it('answers only the window column when it is the only one named', async () => {
    const { sys } = await seeded()
    const rows = await sys.employee.findMany({ window: rn, select: { rn: true }, orderBy: { id: 'asc' } })
    expect(rows).toEqual([{ rn: 1 }, { rn: 2 }, { rn: 3 }])
  })

  it('leaves a window column out of a select that does not name it', async () => {
    const { sys } = await seeded()
    const rows = await sys.employee.findMany({ window: rn, select: { id: true }, orderBy: { id: 'asc' } })
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('still refuses a name that is neither a field nor a window', async () => {
    const { sys } = await seeded()
    const err = await refuses(() => sys.employee.findMany({ window: rn, select: { id: true, nope: true } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('nope')
  })

  it('does not admit a window name when the call has no window', async () => {
    const { sys } = await seeded()
    expect(await refuses(() => sys.employee.findMany({ select: { id: true, rn: true } }))).toBeInstanceOf(ValidationError)
  })

  it('keeps a @guarded column out of a scoped select that names a window', async () => {
    const { as } = await seeded()
    const rows = await as.employee.findMany({ window: rn, select: { name: true, salary: true, rn: true }, orderBy: { id: 'asc' } })
    expect(rows[0]).toEqual({ name: 'ada', rn: 1 })
  })
})
