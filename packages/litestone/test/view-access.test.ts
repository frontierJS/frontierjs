// view-access.test.ts — a view is a read path, so it carries the rules.
//
// `FJS-970`. A `view` used to accept exactly four attributes and reach
// `makeTable` with `{ tableName, modelName }`, so it had no gate, no row
// policy and no tenant scope over models that declared all three — and the
// author could not give it any, because every access attribute was a parse
// error on a view. Under `strategy row` that was a cross-tenant read.
//
// The fix is registration rather than a second engine: a view walks with the
// models in `buildAccessMap` and `buildPolicyMap`, and the tenancy desugar
// gives it the READ deny. Its policies compile against the columns the VIEW
// declares, which is why nothing here reads `@@sql`.
//
// Every refusal is paired with the legal shape one character away — a rule
// that refused the correct spelling too would satisfy any test asking only
// about the refusal (`FJS-351`).

import { test, expect, describe } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'

const errs = (src: string) => parse(src).errors

// ─── the schema guards something ─────────────────────────────────────────────

const GUARDED = `
model Order { id Int @id  total Int  @@gate("4") }
`
const UNGUARDED = `
model Order { id Int @id  total Int }
`
const SQL = `@@sql("SELECT SUM(total) AS total FROM [order]")`

describe('a view must be gated wherever the schema gates anything', () => {
  test('an ungated view over a gated schema is refused, naming the way out', () => {
    const e = errs(`${GUARDED}view revenue { total Int ${SQL} }`)
    expect(e.length).toBe(1)
    expect(e[0]).toContain("View 'revenue' must declare @@gate")
    expect(e[0]).toContain('@@gate("0")')
  })

  test('and the control — the same view with a gate parses clean', () => {
    expect(errs(`${GUARDED}view revenue { total Int ${SQL} @@gate("5") }`)).toEqual([])
  })

  test('@@gate("0") is how a schema says the view is public on purpose', () => {
    expect(errs(`${GUARDED}view revenue { total Int ${SQL} @@gate("0") }`)).toEqual([])
  })

  test('the second control — a schema that guards NOTHING does not fire the rule', () => {
    // Without this row the rule is indistinguishable from one that refuses
    // every view in every schema.
    expect(errs(`${UNGUARDED}view revenue { total Int ${SQL} }`)).toEqual([])
  })

  test('a field-level @allow is enough to make the schema a guarding one', () => {
    const src = `model Order { id Int @id  total Int  margin Int? @allow('read', auth().isAdmin == true) }\nview revenue { total Int ${SQL} }`
    expect(errs(src)[0]).toContain("must declare @@gate")
  })
})

describe('the gate is enforced on the view, not only declared', () => {
  const SCHEMA = `
database main { path ":memory:" }
model Order {
  id    Int @id @default(autoincrement())
  total Int
  @@gate("4")
}
view revenue {
  total Int
  @@sql("SELECT SUM(total) AS total FROM [order]")
  @@gate("5")
}
`
  const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })

  test('a caller below the view’s gate is refused', async () => {
    const db = await client()
    await db.asSystem().order.createMany({ data: [{ total: 10 }, { total: 32 }] })
    // Level 4: passes Order's own gate, and not the view's.
    await expect(db.$setAuth({ id: 'u1', role: 'member' }).revenue.findMany()).rejects.toThrow()
  })

  test('and the control — a caller at the level reads it', async () => {
    const db = await client()
    await db.asSystem().order.createMany({ data: [{ total: 10 }, { total: 32 }] })
    const rows = await db.$setAuth({ id: 'a1', isAdmin: true }).revenue.findMany()
    expect(rows[0].total).toBe(42)
  })

  test('the view can be gated ABOVE the model it reads, which is the point', async () => {
    // Order reads at 4 and revenue at 5: an aggregate is not automatically as
    // readable as the rows under it, and until FJS-970 it was more readable.
    const db = await client()
    await db.asSystem().order.create({ data: { total: 7 } })
    const member = db.$setAuth({ id: 'u1', role: 'member' })
    expect((await member.order.findMany()).length).toBe(1)
    await expect(member.revenue.findMany()).rejects.toThrow()
  })
})

describe('a row policy on a view filters the projection', () => {
  const SCHEMA = `
database main { path ":memory:" }
model Order {
  id      Int    @id @default(autoincrement())
  ownerId String
  total   Int
  @@gate("1")
}
view ownerTotals {
  ownerId String
  total   Int
  @@sql("SELECT ownerId, SUM(total) AS total FROM [order] GROUP BY ownerId")
  @@gate("1")
  @@allow('read', ownerId == auth().id)
}
`
  const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })
  const seed = async (db: any) => db.asSystem().order.createMany({ data: [
    { ownerId: 'u-a', total: 10 },
    { ownerId: 'u-b', total: 99 },
  ]})

  test('a caller sees only the rows the policy admits', async () => {
    const db = await client(); await seed(db)
    const rows = await db.$setAuth({ id: 'u-a', role: 'member' }).ownerTotals.findMany()
    expect(rows.map((r: any) => r.ownerId)).toEqual(['u-a'])
    expect(rows[0].total).toBe(10)
  })

  test('and the control — the other caller sees theirs and not the first’s', async () => {
    const db = await client(); await seed(db)
    const rows = await db.$setAuth({ id: 'u-b', role: 'member' }).ownerTotals.findMany()
    expect(rows.map((r: any) => r.ownerId)).toEqual(['u-b'])
  })

  test('asSystem() reads the whole projection — the mechanism is the ordinary one', async () => {
    const db = await client(); await seed(db)
    expect((await db.asSystem().ownerTotals.findMany()).length).toBe(2)
  })
})

// ─── tenancy ─────────────────────────────────────────────────────────────────

const ROW_TENANCY = `
tenancy { strategy row  column tenantId  claim tenantId }
model Order { id Int @id  tenantId String  total Int  @@gate("4") }
`

describe('under strategy row a view must say how it is scoped', () => {
  test('a view with no @@tenant is refused, naming both ways out', () => {
    const e = errs(`${ROW_TENANCY}view revenue { total Int ${SQL} @@gate("4") }`)
    expect(e.length).toBe(1)
    expect(e[0]).toContain("View 'revenue' must declare @@tenant")
    expect(e[0]).toContain('@@tenant(none)')
  })

  test('and the control — naming its own tenant column parses clean', () => {
    const src = `${ROW_TENANCY}view revenue { tenantId String  total Int @@sql("SELECT tenantId, SUM(total) AS total FROM [order] GROUP BY tenantId") @@gate("4") @@tenant(column: "tenantId") }`
    expect(errs(src)).toEqual([])
  })

  test('@@tenant(none) is the other way out and is not the same statement', () => {
    expect(errs(`${ROW_TENANCY}view revenue { total Int ${SQL} @@gate("4") @@tenant(none) }`)).toEqual([])
  })

  test('a column the view does not declare is refused — the projection is the scope', () => {
    // The view selects no tenantId, so there is nothing for the predicate to
    // compare; inferring it would mean reading @@sql.
    const e = errs(`${ROW_TENANCY}view revenue { total Int ${SQL} @@gate("4") @@tenant(column: "tenantId") }`)
    expect(e[0]).toContain('names no column this view declares')
  })

  test('@@tenant(via:) is refused — a view declares no relations to hop', () => {
    const e = errs(`${ROW_TENANCY}view revenue { total Int ${SQL} @@gate("4") @@tenant(via: order) }`)
    expect(e.some(x => x.includes('needs a relation and a view declares none'))).toBe(true)
  })

  test('the scoped view gets a READ deny and nothing else — it has no writes to guard', () => {
    const src = `${ROW_TENANCY}view revenue { tenantId String  total Int @@sql("SELECT tenantId, SUM(total) AS total FROM [order] GROUP BY tenantId") @@gate("4") @@tenant(column: "tenantId") }`
    const view = parse(src).schema.views[0]
    const denies = view.attributes.filter((a: any) => a.kind === 'deny')
    expect(denies.length).toBe(1)
    expect(denies[0].operations).toEqual(['read'])
    expect(denies[0].generated).toBe('tenancy')
  })

  test('and @@tenant(none) generates none, which is what makes it a statement', () => {
    const src = `${ROW_TENANCY}view revenue { total Int ${SQL} @@gate("4") @@tenant(none) }`
    const view = parse(src).schema.views[0]
    expect(view.attributes.filter((a: any) => a.kind === 'deny').length).toBe(0)
  })

  test('@@tenant on a view under strategy database is refused, as it is on a model', () => {
    const src = `tenancy { strategy database  dir "./t"  registry "./r.db" }\nmodel Order { id Int @id  total Int  @@gate("4") }\nview revenue { total Int ${SQL} @@gate("4") @@tenant(none) }`
    expect(errs(src).some(x => x.includes('strategy row attribute'))).toBe(true)
  })
})

describe('the unknown-attribute message names what a view can carry', () => {
  test('an attribute a view does not take lists the access ones too', () => {
    const e = errs(`${GUARDED}view revenue { total Int ${SQL} @@gate("4") @@index([total]) }`)
    expect(e[0]).toContain("Unknown view attribute '@@index'")
    expect(e[0]).toContain('@@gate')
    expect(e[0]).toContain('@@tenant')
  })
})

// ─── the verb surface ─────────────────────────────────────────────────────
//
// `FJS-997`. Registration made a view carry the rules; this is the other half —
// whether the API realm can reach it at all. `buildTableForView` hand-listed the
// ten reads it forwarded from `makeTable`, and four that `makeTable` grew after
// that list was written were simply not on a view: `findManyAndCount`,
// `cursorFor`, `orderTotal` and `query`. The first is what junction's `find`
// calls, so no service could list a projection and `example`'s Reports screen
// failed on its first request with `table.findManyAndCount is not a function`.
//
// Inverted: reads forward, writes are enumerated. These rows are what makes that
// direction safe — the surface is compared against a MODEL's rather than against
// a list written here, so a verb added to `makeTable` needs no edit, and a verb
// added to the blocked set is asserted to actually refuse.

describe('a view offers every read a model does, and no write', () => {

  const SCHEMA = `
    database main { path ":memory:" }
    model Sale { id Int @id @default(autoincrement())  kind String  amount Int  @@gate("0") }
    view salesByKind {
      kind  String
      total Int
      @@sql("SELECT kind, SUM(amount) AS total FROM [sale] GROUP BY kind")
      @@gate("0")
    }
  `
  const seeded = async () => {
    const db = await createClient({ databases: ':memory:', schema: SCHEMA }) as any
    for (const [kind, amount] of [['a', 10], ['a', 5], ['b', 7]])
      await db.asSystem().sale.create({ data: { kind, amount } })
    return db
  }
  const callable = (t: any) => new Set(Object.keys(t).filter(k => typeof t[k] === 'function'))

  test('the callable surface is the model\'s, with nothing missing', async () => {
    const db = await seeded()
    const missing = [...callable(db.asSystem().sale)].filter(v => !callable(db.asSystem().salesByKind).has(v))
    expect(missing.sort()).toEqual([])
  })

  test('findManyAndCount answers — the verb a service list needs', async () => {
    const db = await seeded()
    const page = await db.asSystem().salesByKind.findManyAndCount({})
    expect(page.total).toBe(2)
    expect(page.rows.map((r: any) => [r.kind, r.total])).toEqual([['a', 15], ['b', 7]])
  })

  // The pair that keeps the inversion honest. Forwarding everything is only safe
  // while the blocked set is complete, so each one is asked rather than assumed —
  // and a `@@materialized` view is a real TABLE, so a forwarded write would
  // SUCCEED and then be destroyed by the next refresh.
  test('every blocked write refuses by name, and says it is a view', async () => {
    const db = await seeded()
    const view = db.asSystem().salesByKind
    const attempts: Record<string, () => unknown> = {
      create:      () => view.create({ data: { kind: 'c', total: 1 } }),
      createMany:  () => view.createMany({ data: [{ kind: 'c', total: 1 }] }),
      update:      () => view.update({ where: { kind: 'a' }, data: { total: 0 } }),
      updateMany:  () => view.updateMany({ where: {}, data: { total: 0 } }),
      upsert:      () => view.upsert({ where: { kind: 'a' }, create: {}, update: {} }),
      upsertMany:  () => view.upsertMany({ data: [] }),
      remove:      () => view.remove({ where: { kind: 'a' } }),
      removeMany:  () => view.removeMany({ where: {} }),
      delete:      () => view.delete({ where: { kind: 'a' } }),
      deleteMany:  () => view.deleteMany({ where: {} }),
      restore:     () => view.restore({ where: { kind: 'a' } }),
      search:      () => view.search('a'),
      optimizeFts: () => view.optimizeFts(),
    }
    const leaked: string[] = []
    for (const [verb, run] of Object.entries(attempts)) {
      try { await run(); leaked.push(verb) }
      catch (e: any) { if (!/is a view/.test(e.message)) leaked.push(`${verb} (wrong message: ${e.message})`) }
    }
    expect(leaked).toEqual([])
  })

  // The control for the row above: a MODEL of the same shape accepts every one
  // of those. Without it, a build where nothing worked at all would pass.
  test('the same calls against a model are not refused', async () => {
    const db = await seeded()
    await db.asSystem().sale.create({ data: { kind: 'c', amount: 1 } })
    expect(await db.asSystem().sale.count({})).toBe(4)
  })

  // Present and refusing is the right answer, not absent. A projection has no
  // key, so no ordering over it is total — the same refusal a model gives for a
  // partial sort, which is what makes it a rule rather than a gap.
  test('cursorFor is reachable and refuses for a reason it states', async () => {
    const db = await seeded()
    const view = db.asSystem().salesByKind
    expect(typeof view.cursorFor).toBe('function')
    const row = (await view.findMany({}))[0]
    expect(() => view.cursorFor(row, [{ kind: 'asc' }])).toThrow(/total order/i)
  })
})
