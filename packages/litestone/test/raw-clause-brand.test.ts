// What identifies a RawClause — and why it cannot be a property.
//
// A raw clause is the one value litestone puts in the SQL PATTERN rather than
// the parameter list (Invariant 8). Two callers ask whether they have one, and
// they ask for opposite reasons: `where: { $raw: … }` is an escape hatch a
// DEVELOPER writes, while a named aggregate's `filter` is checked precisely to
// tell a developer's fragment from data that came off the wire — its own
// refusal of a plain string says a string "is how an injected fragment
// arrives".
//
// The test was `val._litestoneRaw === true`, which `JSON.parse` can produce. So
// the guard refused the shape nobody sends and accepted the one an attacker
// does: a request body carrying `{ _litestoneRaw: true, sql: '…' }` had its
// text interpolated verbatim into `FILTER (WHERE …)`, which closes with a
// paren and appends a subquery — measured, a whole @guarded column in one
// request (`FJS-955`). The brand is a symbol now, and JSON has no symbols.
//
// Every refusal here is paired with the same call made through the real `sql``
// tag, because a brand that refused everything would satisfy a suite that only
// asked about the forgery.

import { describe, it, expect } from 'bun:test'
import { createClient, sql, ValidationError } from '../src/index.js'

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
  return { db, sys, as: db.$setAuth({ id: 1 }) }
}

// Exactly what a request body can carry: no symbols, no functions, no tag.
const fromTheWire = (o: unknown) => JSON.parse(JSON.stringify(o))

const refuses = async (fn: () => Promise<unknown>) => {
  try { await fn() } catch (e) { return e }
  return null
}

describe('a forged fragment is not a fragment', () => {
  it('refuses an object shaped like a RawClause in a named aggregate filter', async () => {
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy(fromTheWire({
      by: ['dept'],
      _leak: { count: true, filter: { _litestoneRaw: true, sql: 'salary > 50000', params: [] } },
    })))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('sql')
  })

  it('refuses the breakout that dumped a @guarded column in one request', async () => {
    // `FILTER (WHERE <text>)` — closing the paren and aliasing lets a subquery
    // ride in the SELECT list. It answered `ada=90000,bea=40000` to a caller
    // whose own rows carry no salary at all.
    const { as } = await seeded()
    const err = await refuses(() => as.employee.groupBy(fromTheWire({
      by: ['dept'],
      _x: { count: true, filter: { _litestoneRaw: true,
            sql: `1=1) AS "__nagg__x", (SELECT group_concat(name || '=' || salary) FROM employee`, params: [] } },
    })))
    expect(err).toBeInstanceOf(ValidationError)
  })

  it('refuses it through query(), which is the documented dispatch shape', async () => {
    // `db.order.query(req.query)` is what the docs show, so this path takes a
    // caller's own object by design.
    const { as } = await seeded()
    expect(await refuses(() => as.employee.query(fromTheWire({
      by: ['dept'],
      _leak: { count: true, filter: { _litestoneRaw: true, sql: 'salary > 50000', params: [] } },
    })))).toBeInstanceOf(ValidationError)
  })

  it('a plain string is still refused, which is where the guard started', async () => {
    const { as } = await seeded()
    expect(await refuses(() => as.employee.groupBy({
      by: ['dept'], _leak: { count: true, filter: 'bonus > 2000' } as never,
    }))).toBeInstanceOf(ValidationError)
  })
})

describe('the real tag still works, everywhere it worked before', () => {
  it('a named aggregate filter written with sql`` runs', async () => {
    const { as } = await seeded()
    const rows = await as.employee.groupBy({
      by: ['dept'], _count: true,
      _rich: { count: true, filter: sql`bonus > ${2000}` },
    })
    expect(rows.find((r: any) => r.dept === 'eng')._rich).toBe(1)
    expect(rows.find((r: any) => r.dept === 'ops')._rich).toBe(0)
  })

  it('where: { $raw: sql`…` } still filters', async () => {
    const { as } = await seeded()
    const rows = await as.employee.findMany({ where: { $raw: sql`bonus > ${2000}` } })
    expect(rows.map((r: any) => r.name)).toEqual(['ada'])
  })

  it('the plain-string $raw escape hatch is untouched', async () => {
    // Deliberate, and a different question: `$raw` never claimed to tell a
    // developer's SQL from a caller's. A `$` key is transport syntax and the
    // bridge routes it to directives, so it cannot arrive from a request.
    const { as } = await seeded()
    const rows = await as.employee.findMany({ where: { $raw: 'bonus > 2000' } })
    expect(rows.map((r: any) => r.name)).toEqual(['ada'])
  })

  it('the tag still carries the public shape it declares', async () => {
    const clause = sql`bonus > ${1}` as { _litestoneRaw: true, sql: string, params: unknown[] }
    expect(clause._litestoneRaw).toBe(true)
    expect(clause.params).toEqual([1])
  })
})

describe('the producers inside litestone are branded too', () => {
  it('a row policy compiles to a clause the where builder accepts', async () => {
    // policy.js builds its own fragments. Unbranded, a policy'd read throws
    // rather than filtering — which is the control that keeps the brand honest.
    const db = await createClient({ schema: `
model Note {
  id      Int    @id
  ownerId Int
  body    String
  @@allow("read", ownerId == auth().id)
}
`, db: ':memory:' })
    const sys = db.asSystem()
    await sys.note.create({ data: { id: 1, ownerId: 1, body: 'mine' } })
    await sys.note.create({ data: { id: 2, ownerId: 2, body: 'theirs' } })
    const rows = await db.$setAuth({ id: 1 }).note.findMany({})
    expect(rows.map((r: any) => r.body)).toEqual(['mine'])
  })
})
