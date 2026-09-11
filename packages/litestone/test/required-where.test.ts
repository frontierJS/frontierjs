// `@required(where: …)` — required in the rows the predicate admits.
//
// One attribute rather than two (`@@unique([a], where: …)`'s shape), and the
// two halves want OPPOSITE types: bare, `@required` only carries the message
// and the absence of `?` is the rule; with `where:` it IS the rule, so it needs
// the `?` that bare `@required` forbids. Both directions are asserted, because
// a validation that accepted everything and one that refused everything are the
// same observation from one side.
//
// It expands to a CHECK, which is the reach a boundary rule cannot have — a
// migration, a seed, `asSystem()` and a raw statement are all held to it — and
// the boundary attributes the refusal to the FIELD, which is the half a table
// constraint cannot do: SQLite reports a violation by the constraint's source
// text and has no field to blame.
//
// The predicate is over THIS ROW's own columns and nothing else. Every refusal
// below is PAIRED with the legal shape one character away (`FJS-351`).

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const M = (field: string, extra = '') => `
enum S { draft shipped cancelled }
model Order {
  id           Int    @id
  status       S      @default(draft)
  priority     Int    @default(0)
  name         String @default("x")
  ${field}
  ${extra}
}`

const errsOf = (src: string) => ((parse(src) as any).errors ?? []).filter(Boolean)
const one    = (field: string, extra = '') => errsOf(M(field, extra))

describe('@required — which type each half wants', () => {

  it('bare on a required field is the message, as it always was', () => {
    expect(one('note String @required("Say something")')).toHaveLength(0)
  })

  it('bare on an OPTIONAL field is still refused, and now names the third way out', () => {
    const e = one('note String? @required("Say something")')
    expect(e).toHaveLength(1)
    expect(e[0]).toContain("state 'where:'")
  })

  it('where: on an optional field is the whole point', () => {
    expect(one("note String? @required(where: status == 'shipped')")).toHaveLength(0)
  })

  it('…and takes the message beside it', () => {
    expect(one("note String? @required(where: status == 'shipped', \"needs a note\")")).toHaveLength(0)
  })

  // The pair. A non-optional field is already required by its type, so a
  // predicate saying only SOME rows need it is a second answer to a question
  // the type has answered — and the two can disagree about a row.
  it('where: on a field that is already required is refused', () => {
    const e = one("note String @required(where: status == 'shipped')")
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('already required')
  })
})

describe('what the predicate may read', () => {
  const legal = "note String? @required(where: status == 'shipped')"

  // Each refusal is stated with the legal predicate beside it, or a rule that
  // refused every predicate would satisfy all four.
  it('refuses auth() — one answer for the row, not one per caller', () => {
    expect(one('note String? @required(where: auth().isAdmin)')[0]).toContain('auth()')
    expect(one(legal)).toHaveLength(0)
  })

  it('refuses now() — a row correct when written would stop being correct', () => {
    const e = one('note String? @required(where: priority > 0 && name != null && createdAt < now())',
                  '  createdAt DateTime @default(now())')
    expect(e[0]).toContain('now()')
    expect(one(legal)).toHaveLength(0)
  })

  it('refuses a column of another model', () => {
    expect(one('note String? @required(where: nope == 1)')[0]).toContain('is not a column')
    expect(one(legal)).toHaveLength(0)
  })

  it('refuses a relation hop — a CHECK has no other table in scope', () => {
    const src = `
model Customer { id Int @id  tier String  orders Order[] }
enum S { draft shipped }
model Order {
  id Int @id
  status S @default(draft)
  customerId Int
  customer Customer @relation(fields: [customerId], references: [id])
  note String? @required(where: customer.tier == 'gold')
}`
    expect(errsOf(src).join(' ')).toMatch(/another model|not a column/)
  })

  it('takes a compound predicate over its own columns', () => {
    expect(one("note String? @required(where: status == 'cancelled' || priority > 5)")).toHaveLength(0)
  })
})

describe('the predicate compiles to standalone SQL with its literals inlined', () => {
  // SQLite takes no bound parameter in a CHECK, so a predicate that compiled to
  // `?` would build DDL that fails at migration time naming a table the author
  // is no longer looking at.
  it('inlines, and binds nothing', () => {
    const s: any = parse(M("note String? @required(where: status == 'shipped')")).schema
    const sql = s.models[0].fields.find((f: any) => f.name === 'note')
      .attributes.find((a: any) => a.kind === 'required').whereSql
    expect(sql).toBe(`"status" = 'shipped'`)
    expect(sql).not.toContain('?')
  })
})

async function shop(field = "trackingCode String? @required(where: status == 'shipped', \"A shipped order needs a tracking code\")") {
  const db: any = await createClient({ db: ':memory:', schema: `
enum S { draft shipped cancelled }
model Order {
  id Int @id
  status S @default(draft)
  ${field}
}` })
  return { db, sys: db.asSystem() }
}

describe('the rule, enforced', () => {

  it('a row the predicate does not admit needs no value', async () => {
    const { sys } = await shop()
    const row = await sys.order.create({ data: { id: 1 } })
    expect(row.status).toBe('draft')
    expect(row.trackingCode).toBeNull()
  })

  it('a row it does admit is refused without one', async () => {
    const { sys } = await shop()
    await sys.order.create({ data: { id: 1 } })
    await expect(sys.order.update({ where: { id: 1 }, data: { status: 'shipped' } })).rejects.toThrow()
  })

  // The pair, and the one that matters: a refusal that names the whole record
  // is what a hand-written `@@check` already gives. The FIELD is what this
  // declaration buys, and `path` is what `<Form>` reads to put the sentence
  // beside the control.
  it('and the refusal names the field, in the wording the schema declared', async () => {
    const { sys } = await shop()
    await sys.order.create({ data: { id: 1 } })
    try {
      await sys.order.update({ where: { id: 1 }, data: { status: 'shipped' } })
      throw new Error('not refused')
    } catch (e: any) {
      expect(e.errors).toEqual([
        { path: ['trackingCode'], message: 'A shipped order needs a tracking code' },
      ])
    }
  })

  it('with no message it still names the field', async () => {
    const { sys } = await shop("trackingCode String? @required(where: status == 'shipped')")
    await sys.order.create({ data: { id: 1 } })
    try {
      await sys.order.update({ where: { id: 1 }, data: { status: 'shipped' } })
      throw new Error('not refused')
    } catch (e: any) {
      expect(e.errors[0].path).toEqual(['trackingCode'])
      expect(e.errors[0].message).toContain('required')
    }
  })

  it('satisfied in the same write that enters the state', async () => {
    const { sys } = await shop()
    await sys.order.create({ data: { id: 1 } })
    const row = await sys.order.update({ where: { id: 1 }, data: { status: 'shipped', trackingCode: 'T1' } })
    expect(row.trackingCode).toBe('T1')
  })

  it('refuses a CREATE straight into the state', async () => {
    const { sys } = await shop()
    await expect(sys.order.create({ data: { id: 2, status: 'shipped' } })).rejects.toThrow()
  })

  // The reach a boundary rule cannot have, and the reason the user chose the
  // expansion. asSystem() is the boundary's own bypass and the table still
  // holds; a raw statement never reaches the boundary at all.
  it('holds against asSystem() and against raw SQL', async () => {
    const { db, sys } = await shop()
    await expect(sys.order.create({ data: { id: 3, status: 'shipped' } })).rejects.toThrow()
    expect(() => db.$rawDbs.main
      .query(`INSERT INTO "order" (id, status, trackingCode) VALUES (4, 'shipped', NULL)`).run())
      .toThrow(/CHECK constraint failed/)
  })

  // SQL's own answer, stated rather than discovered: a predicate whose own
  // column is NULL is UNKNOWN, and a CHECK admits a row it cannot judge. The
  // rule is *required in the rows the predicate ADMITS*.
  it('an UNKNOWN predicate admits the row', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Thing {
  id Int @id
  kind String?
  note String? @required(where: kind == 'x')
}` })
    const row = await db.asSystem().thing.create({ data: { id: 1 } })
    expect(row.note).toBeNull()
    await expect(db.asSystem().thing.create({ data: { id: 2, kind: 'x' } })).rejects.toThrow()
  })
})
