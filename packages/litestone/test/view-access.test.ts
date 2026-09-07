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
import { createTestEnv } from '../src/testing.js'
import { generateTypeScript } from '../src/tools/typegen.js'
import { VIEW_REFUSED } from '../src/core/client.js'
import { generateJsonSchema } from '../src/jsonschema.js'
import { levelPasses } from '@frontierjs/toolbelt/gate'

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

// ─── the affordance a browser is handed ──────────────────────────────────────
//
// `FJS-999`. The generated JSON Schema walked `schema.models` and never
// `schema.views`, so `x-gate` was emitted for no projection at all and
// `can('read', 4)` answered YES against a gate of 5. Not a hole — Invariant 6
// makes the client's answer an affordance and the boundary grades again, which
// the pair at the bottom of this block asserts — but it is the affordance's
// whole job, and without it a report screen shows a caller who may not read it
// an EMPTY TABLE instead of a reason.
//
// Every claim here is PAIRED with the same question asked of a model, because
// a generator that emitted nothing for either would satisfy any test that only
// looked at the view.

describe('a view reaches the generated JSON Schema', () => {
  const SRC = `
    database main { path ":memory:" }
    model Order { id Int @id @default(autoincrement())  total Int  @@gate("1") }
    view revenueByStatus {
      status String
      orders Int
      total  Int?
      ${SQL}
      @@gate("5")
    }
  `
  const defs = (mode = 'create') =>
    generateJsonSchema(parse(SRC).schema, { mode }).$defs

  test('the projection has a definition of its own, beside the models', () => {
    expect(Object.keys(defs())).toContain('revenueByStatus')
    expect(Object.keys(defs())).toContain('Order')
  })

  test('its declared gate crosses, the way a model\'s does', () => {
    expect(defs().revenueByStatus['x-gate'].read).toBe(5)
    expect(defs().Order['x-gate'].read).toBe(1)
  })

  test('the three writes are LOCKED, whatever the gate string said', () => {
    // A view refuses every write at the Data boundary for every caller and for
    // asSystem() alike, which is what 9 means on the scale. Emitting the
    // declared 5 across all four would tell a screen an ADMINISTRATOR may
    // create one — false at every level. The model beside it keeps its own.
    const g = defs().revenueByStatus['x-gate']
    expect([g.create, g.update, g.delete]).toEqual([9, 9, 9])
    expect(levelPasses(g.create, 8)).toBe(false)
    const m = defs().Order['x-gate']
    expect([m.create, m.update, m.delete]).toEqual([1, 1, 1])
  })

  test('every column is readOnly and nothing is required', () => {
    const d = defs().revenueByStatus
    expect(Object.values(d.properties).every((p: any) => p.readOnly)).toBe(true)
    expect(d.required).toBeUndefined()
    // The control: the model's own columns are not readOnly, so this is a
    // statement about projections rather than about the generator.
    expect(defs().Order.properties.total.readOnly).toBeUndefined()
    expect(defs().Order.required).toEqual(['total'])
  })

  test('it says it is a projection, which readOnly columns alone do not', () => {
    expect(defs().revenueByStatus['x-litestone-view']).toBe(true)
    expect(defs().Order['x-litestone-view']).toBeUndefined()
  })

  test('the create and update modes are the same document', () => {
    // What makes a view cost the browser one definition rather than two:
    // `diffSchemaModes` finds nothing to patch.
    expect(defs('update').revenueByStatus).toEqual(defs('create').revenueByStatus)
  })

  test('an ungated view in an ungated schema emits no read level', () => {
    // An unknown affordance is permissive (Invariant 6), so the key stays
    // ABSENT rather than being invented — while the writes are still locked.
    const d = generateJsonSchema(
      parse(`model A { id Int @id }\nview v { a String ${SQL} }`).schema).$defs.v
    expect('read' in d['x-gate']).toBe(false)
    expect(d['x-gate'].create).toBe(9)
  })

  test('and the boundary refuses the caller the affordance refuses', async () => {
    // The pair the affordance is only ever a saving against. A schema-side
    // answer that had drifted from the boundary would pass every row above.
    const db = await createClient({ schema: SRC, resolveFrom: import.meta.dir })
    expect(defs().revenueByStatus['x-gate'].read).toBe(5)
    await expect(db.$setAuth({ id: 'u1', role: 'member' }).revenueByStatus.findMany())
      .rejects.toThrow()
    // The control, one level up: the caller the affordance would have let
    // through is the caller the boundary lets through.
    await expect(db.$setAuth({ id: 'a1', isAdmin: true }).revenueByStatus.findMany())
      .resolves.toBeDefined()
  })
})

// ─── the executed checks, over a projection ──────────────────────────────────
//
// `verifyGateLadder` walks every gated declaration, and a view is one. Its
// WRITES are not on the ladder — a projection refuses create, update and
// delete for every caller and for `asSystem()` alike, so no level grades them
// — and leaving them in made the checker build a fixture for a thing with no
// table and report *no fixture could be built, so the gate was never asked* 27
// times per view. A checker that emits 27 unaskable rows is one people stop
// reading.

describe('a view on the ladder is a READ and nothing else', () => {
  const SCHEMA = `
model Order {
  id    String @id @default(uuid())
  total Int
  @@gate("2")
}

view revenue {
  total Int
  @@sql("SELECT SUM(total) AS total FROM [order]")
  @@gate("2")
}
`

  test('the ladder is clean, and the read rows are what it asked', async () => {
    const env = await createTestEnv({ schema: SCHEMA })
    expect(await env.verifyGateLadder()).toEqual([])
    // The control: the read half really did run. A filter that dropped the
    // view entirely also returns [], and would say nothing about the gate a
    // projection DOES carry.
    expect(await env.verifyGateLadder({ ops: ['read'] })).toEqual([])
  })

  test('and the model beside it is still graded on all four', async () => {
    // The other control. Removing the write rows must not remove anybody
    // else's — a filter reading the wrong flag would empty the whole ladder
    // and every assertion above would still pass.
    const env = await createTestEnv({ schema: SCHEMA })
    const bad = await env.verifyGateLadder({ against: {
      ...env.schema,
      models: env.schema.models.map((m: any) =>
        m.name === 'Order'
          ? { ...m, attributes: m.attributes.map((a: any) =>
              a.kind === 'gate' ? { ...a, value: '5' } : a) }
          : m),
    } })
    // Order really reads at 2, so a ladder built against a gate of 5 has to
    // disagree — which is only possible if the model's rows were asked.
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((r: any) => r.model === 'Order')).toBe(true)
  })
})

// ─── the generated .d.ts ─────────────────────────────────────────────────────
//
// `typegen` walked `schema.models` and never `schema.views`, so a declared
// projection was absent from `schema.d.ts` and `db.<view>` was a type error in
// the one place a generated file is supposed to help. The same walk as
// `FJS-999`, one artefact along — and it stayed invisible in both apps that
// have a view because each reaches the client through an `any`.

describe('a view reaches the generated types', () => {
  const SRC = `
model Order {
  id     String @id @default(uuid())
  total  Int
  @@gate("2")
}

view revenue {
  status String
  total  Int?
  @@sql("SELECT status, SUM(total) AS total FROM [order] GROUP BY status")
  @@gate("2")
}
`
  const ts = () => generateTypeScript(parse(SRC).schema)

  test('the projection has a Row and a Where, and the model still has four', () => {
    const out = ts()
    expect(out).toContain('export interface Revenue {')
    expect(out).toContain('export interface RevenueWhere extends WhereBase {')
    // Absent by design: there is nothing to create and nothing to update.
    expect(out).not.toContain('export interface RevenueCreate')
    expect(out).not.toContain('export interface RevenueUpdate')
    // The control — the model beside it is unchanged.
    expect(out).toContain('export interface OrderCreate')
    expect(out).toContain('export interface OrderUpdate')
  })

  test('the client reaches it by its declared name, as a ViewClient', () => {
    expect(ts()).toContain('readonly revenue: ViewClient<Revenue, RevenueWhere>')
    expect(ts()).toContain('readonly order: TableClient<Order,')
  })

  test('the refused set is litestone\'s own, not a copy', () => {
    // The assertion that keeps the two from parting company: every verb the
    // client refuses is in the emitted union, and nothing else is.
    const union = ts().split('export type ViewRefusedVerb =')[1].split('export type ViewClient')[0]
    const emitted = [...union.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]).sort()
    expect(emitted).toEqual([...VIEW_REFUSED].sort())
  })

  test('an optional view column is optional in the Row', () => {
    // A view declares its own nullability and nothing infers it from @@sql.
    expect(ts()).toMatch(/export interface Revenue \{[^}]*total\?: number \| null/)
  })

  test('a schema with no view emits neither the section nor the type', () => {
    // The delete test: nothing is paid for by a schema that declares none.
    const out = generateTypeScript(parse('model Order { id Int @id  total Int }').schema)
    expect(out).not.toContain('ViewClient')
    expect(out).not.toContain('ViewRefusedVerb')
  })
})
