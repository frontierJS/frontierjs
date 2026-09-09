// test/extensible.test.ts
//
// `@@extensible(fields, declaredBy: CustomField[, max: …])` — a column whose
// keys a tenant declares at runtime.
//
// The feature is two tiers and the test is arranged to prove they are ONE:
// without `max:` a declared key stores, renders and edits; with it, some of
// those keys also reach a composite index. Everything above the Data boundary
// is the same either way, which is why `max:` is an argument and not a second
// attribute.
//
// Two things here are not behavioral and cannot be, so they are asserted
// against the emitted DDL and the EXPLAIN instead:
//
//   · the pool's ALLOCATION order and its INDEX order are one list. They were
//     two hand-written lists in the app this was lifted from and they had
//     drifted, which costs a two-term query its second column with nothing
//     failing — an index changes no answer.
//   · the index is ONE composite. Twelve single-column indexes measured 139 ms
//     against the composite's 2.7 ms on a three-term query, because SQLite
//     picks one index and filters the rest.
//
// Every refusal is PAIRED with the schema one word away that must still parse,
// because a check that refuses the legitimate shape too proves nothing.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse }        from '../src/core/parser.js'

const DECL = `
  enum FieldKind { text number }
  model CustomField {
    id    Int    @id
    model String
    key   String
    type  FieldKind
    slot  String?
    @@unique([model, key])
    @@unique([model, slot], nullsDistinct: true)
  }`

const SCHEMA = `${DECL}
  model Customer {
    id     Int    @id
    name   String
    fields Json   @default("{}")
    @@extensible(fields, declaredBy: CustomField, max: { text: 8, number: 4 })
  }
  model Product {
    id     Int    @id
    name   String
    fields Json   @default("{}")
    @@extensible(fields, declaredBy: CustomField)
  }
  database main { path ":memory:" }`

const client = async () => await createClient({ schema: SCHEMA, db: ':memory:' })
const seeded = async () => {
  const c = await client()
  await c.asSystem().customField.createMany({ data: [
    { model: 'Customer', key: 'tier', type: 'text',   slot: 't1' },
    { model: 'Customer', key: 'ltv',  type: 'number', slot: 'n1' },
    { model: 'Product',  key: 'care', type: 'text',   slot: null },
  ] })
  return c
}

describe('the declaration', () => {
  const ok = (src: string) => parse(`${DECL}\n${src}`)

  test('both tiers parse — max: is the optional half', () => {
    expect(ok('model P { id Int @id  fields Json  @@extensible(fields, declaredBy: CustomField) }').valid).toBe(true)
    expect(ok('model C { id Int @id  fields Json  @@extensible(fields, declaredBy: CustomField, max: { text: 2 }) }').valid).toBe(true)
  })

  const refuses = (src: string, match: RegExp) => {
    const r = ok(src)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' · ')).toMatch(match)
  }

  test('the named column has to exist, and be Json', () => {
    refuses('model P { id Int @id  fields Json  @@extensible(nope, declaredBy: CustomField) }', /no field 'nope'/)
    refuses('model P { id Int @id  fields String  @@extensible(fields, declaredBy: CustomField) }', /is String and has to be Json/)
  })

  test('a @type on the same column is refused — a type is closed on write', () => {
    refuses('type T { a String? }\nmodel P { id Int @id  fields Json @type(T)  @@extensible(fields, declaredBy: CustomField) }',
            /closes it to the keys this file names/)
    // The control: the same model with the type on a DIFFERENT column is fine,
    // which is the shape an app wanting both actually writes.
    expect(ok('type T { a String? }\nmodel P { id Int @id  addr Json @type(T)  fields Json  @@extensible(fields, declaredBy: CustomField) }').valid).toBe(true)
  })

  test('the declaring model is resolved by convention, and says what is missing', () => {
    refuses('model P { id Int @id  fields Json  @@extensible(fields, declaredBy: Nope) }', /no model 'Nope'/)
    refuses(`model D { id Int @id  model String  type FieldKind  @@unique([model, key]) }
             model P { id Int @id  fields Json  @@extensible(fields, declaredBy: D) }`, /has no 'key' column/)
    refuses(`model D { id Int @id  model String  key String  type String  @@unique([model, key]) }
             model P { id Int @id  fields Json  @@extensible(fields, declaredBy: D) }`, /'D\.type' is String and has to be an enum/)
  })

  test('a pool needs a slot column, and a pool-less declaration does not', () => {
    refuses(`model D { id Int @id  model String  key String  type FieldKind  @@unique([model, key]) }
             model C { id Int @id  fields Json  @@extensible(fields, declaredBy: D, max: { text: 2 }) }`, /has no 'slot' column/)
    expect(ok(`model D { id Int @id  model String  key String  type FieldKind  @@unique([model, key]) }
               model P { id Int @id  fields Json  @@extensible(fields, declaredBy: D) }`).valid).toBe(true)
  })

  test('max: is keyed by the declaring model’s own enum', () => {
    refuses('model C { id Int @id  fields Json  @@extensible(fields, declaredBy: CustomField, max: { colour: 4 }) }',
            /not a member of FieldKind/)
    expect(ok('model C { id Int @id  fields Json  @@extensible(fields, declaredBy: CustomField, max: { number: 4 }) }').valid).toBe(true)
  })

  test('the declaring model must make a key unique PER model', () => {
    refuses(`model D { id Int @id  model String  key String  type FieldKind }
             model P { id Int @id  fields Json  @@extensible(fields, declaredBy: D) }`, /@@unique\(\[model, key\]\)/)
  })

  test('one column carries one set of declarations', () => {
    refuses('model P { id Int @id  fields Json  @@extensible(fields, declaredBy: CustomField)  @@extensible(fields, declaredBy: CustomField) }',
            /declared extensible twice/)
  })

  test('declaredBy is not optional — a blob nobody describes is a Json column', () => {
    expect(ok('model P { id Int @id  fields Json  @@extensible(fields) }').valid).toBe(false)
  })

  test('a pool of nothing is refused rather than silently empty', () => {
    expect(ok('model C { id Int @id  fields Json  @@extensible(fields, declaredBy: CustomField, max: { text: 0 }) }').valid).toBe(false)
  })
})

describe('what max: expands to', () => {
  const customer = () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    return r.schema.models.find((m: any) => m.name === 'Customer')
  }

  test('a mirror, one generated column per slot, and ONE composite index', () => {
    const c = customer()
    const gen = c.fields.filter((f: any) => f.generated === 'extensible').map((f: any) => f.name)
    expect(gen[0]).toBe('fieldsSlots')
    expect(gen.length).toBe(13)                       // the mirror + 8 text + 4 number
    const idx = c.attributes.filter((a: any) => a.kind === 'index' && a.generated === 'extensible')
    expect(idx.length).toBe(1)
  })

  test('the allocation order and the index order are ONE list', () => {
    const c = customer()
    const slots = c.fields.filter((f: any) => f.generated === 'extensible' && f.name !== 'fieldsSlots').map((f: any) => f.name)
    const index = c.attributes.find((a: any) => a.kind === 'index' && a.generated === 'extensible').fields
    expect(index).toEqual(slots)
  })

  test('the pool follows the ratio max: declared — 8:4 is two text per number', () => {
    expect(customer().attributes.find((a: any) => a.kind === 'index' && a.generated === 'extensible').fields)
      .toEqual(['t1','t2','n1','t3','t4','n2','t5','t6','n3','t7','t8','n4'])
  })

  test('the mirror is @system, and a slot takes its kind’s affinity', () => {
    const c = customer()
    expect(c.fields.find((f: any) => f.name === 'fieldsSlots').attributes.some((a: any) => a.kind === 'system')).toBe(true)
    expect(c.fields.find((f: any) => f.name === 't1').type.name).toBe('String')
    expect(c.fields.find((f: any) => f.name === 'n1').type.name).toBe('Float')
  })

  test('no max: expands to NOTHING — the control', () => {
    const r = parse(SCHEMA)
    const p = r.schema.models.find((m: any) => m.name === 'Product')
    expect(p.fields.some((f: any) => f.generated === 'extensible')).toBe(false)
    expect(p.attributes.some((a: any) => a.kind === 'index')).toBe(false)
  })
})

describe('$declaredFields', () => {
  test('a model answers with its OWN declarations, and the other with its own', async () => {
    const db = (await seeded()).asSystem()
    const cust = await db.customer.$declaredFields()
    const prod = await db.product.$declaredFields()
    expect(cust.map((d: any) => d.key).sort()).toEqual(['ltv', 'tier'])
    expect(prod.map((d: any) => d.key)).toEqual(['care'])
  })

  test('a caller cannot widen the scope — the silent failure this exists for', async () => {
    const db = (await seeded()).asSystem()
    const widened = await db.product.$declaredFields({ where: { model: 'Customer' } })
    expect(widened.map((d: any) => d.key)).toEqual(['care'])
  })

  test('a model with no @@extensible refuses rather than answering an empty list', async () => {
    const db = (await seeded()).asSystem()
    expect(db.customField.$declaredFields()).rejects.toThrow(/@@extensible/)
  })
})

describe('the pool at work', () => {
  test('a promoted key is filterable, and the number slot has REAL affinity', async () => {
    const db = (await seeded()).asSystem()
    await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold',   ltv: 900 } } })
    await db.customer.create({ data: { name: 'Bo',  fields: { tier: 'bronze', ltv: 40  } } })
    expect((await db.customer.findMany({ where: { t1: 'gold' } })).length).toBe(1)
    expect((await db.customer.findMany({ where: { n1: { gte: 500 } } })).length).toBe(1)
  })

  test('the mirror is refused to a caller that names it', async () => {
    const c = await seeded()
    expect(c.customer.create({ data: { name: 'x', fieldsSlots: { t1: 'no' } } })).rejects.toThrow()
  })

  // The other half of that refusal: asSystem() MAY name it, and the derivation
  // still wins — the mirror is what the blob says, whoever is writing.
  test('a hand-written mirror is overwritten by the derivation', async () => {
    const db = (await seeded()).asSystem()
    const r = await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold' }, fieldsSlots: { t1: 'FORGED' } } })
    expect((await db.customer.findUnique({ where: { id: r.id } })).t1).toBe('gold')
  })

  test('an unpromoted key stores and reads back, on a model with no pool at all', async () => {
    const db = (await seeded()).asSystem()
    const p = await db.product.create({ data: { name: 'Shirt', fields: { care: 'hand wash' } } })
    expect((await db.product.findUnique({ where: { id: p.id } })).fields.care).toBe('hand wash')
  })

  test('an undeclared key is ACCEPTED — declaring is not a whitelist', async () => {
    const db = (await seeded()).asSystem()
    const p = await db.product.create({ data: { name: 'Scarf', fields: { nobody_declared_this: 1 } } })
    expect((await db.product.findUnique({ where: { id: p.id } })).fields.nobody_declared_this).toBe(1)
  })

  // An index changes no answer, so every row above passes with it dropped.
  //
  // Written through the tenant's own keys, because the mirror is DERIVED: a
  // payload naming `fieldsSlots` by hand is rebuilt from the blob and the hand
  // value is gone, which is the point rather than a limitation.
  test('a two-term query over the pool reaches BOTH columns of the composite', async () => {
    const db = (await seeded()).asSystem()
    await db.customField.create({ data: { model: 'Customer', key: 'band', type: 'text', slot: 't2' } })
    const bulk = []
    for (let i = 0; i < 3000; i++)
      bulk.push({ name: `P${i}`, fields: { tier: ['gold','silver','bronze'][i % 3], band: `s${i % 5}`, ltv: i } })
    await db.customer.createMany({ data: bulk })
    await db.sql`ANALYZE`
    const plan = (await db.sql`EXPLAIN QUERY PLAN SELECT id FROM customer WHERE t1 = 'gold' AND t2 = 's1'`)
      .map((r: any) => r.detail).join(' | ')
    expect(plan).toMatch(/USING (COVERING )?INDEX/)
    expect(plan).toMatch(/t1=\? AND t2=\?/)
  })
})

describe('the slot a declaration takes', () => {
  // The app writes no allocator. `slot` is `@system`, so a caller cannot send
  // one, and it is filled here for the same reason the mirror is: the three
  // things it takes — the pool, its order, and what is already spoken for —
  // are all facts the schema states.
  //
  // Every row is PAIRED with the model that has NO pool, because *the pool is
  // full* and *nothing allocates* answer identically from the reading side: a
  // slotless declaration stores, renders and edits either way.
  const decl = async () => {
    const c = await client()
    return c.asSystem()
  }

  test('a declaration is bound to a slot with nothing in the payload naming one', async () => {
    const db = await decl()
    const row = await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
    expect(row.slot).toBe('t1')
  })

  test('and a model with no pool gets null rather than an error', async () => {
    const db = await decl()
    const row = await db.customField.create({ data: { model: 'Product', key: 'care', type: 'text' } })
    expect(row.slot).toBe(null)
  })

  test('the kind decides which queue it comes out of', async () => {
    const db = await decl()
    const t = await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
    const n = await db.customField.create({ data: { model: 'Customer', key: 'ltv',  type: 'number' } })
    expect(t.slot).toBe('t1')
    expect(n.slot).toBe('n1')
  })

  // INDEX order and not declaration order. The two were separate hand-written
  // lists in the app this was lifted from and they had drifted: the columns ran
  // t1…t8 then n1…n4 while the index interleaved them, so a shop's first two
  // fields landed in t1 and n1 and a two-term query reached one column.
  test('slots are handed out in the order the composite reads them', async () => {
    const db = await decl()
    const got = []
    for (let i = 0; i < 4; i++)
      got.push((await db.customField.create({ data: { model: 'Customer', key: `k${i}`, type: 'text' } })).slot)
    expect(got).toEqual(['t1', 't2', 't3', 't4'])
  })

  // One declaring table serves both models, so an unnarrowed read of what is
  // taken would refuse a product the slot a customer holds — and every field on
  // the second model would then be unpromoted, silently.
  test('two models do not take slots from each other', async () => {
    const c  = await client()
    const db = c.asSystem()
    await db.customField.create({ data: { model: 'Product',  key: 'care', type: 'text' } })
    const cust = await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
    expect(cust.slot).toBe('t1')
  })

  test('the thirteenth text field gets no slot, and the write is not refused', async () => {
    const db = await decl()
    for (let i = 0; i < 8; i++)
      await db.customField.create({ data: { model: 'Customer', key: `k${i}`, type: 'text' } })
    const over = await db.customField.create({ data: { model: 'Customer', key: 'over', type: 'text' } })
    expect(over.slot).toBe(null)
    // The pair: the number pool is untouched by a full text pool.
    const num = await db.customField.create({ data: { model: 'Customer', key: 'ltv', type: 'number' } })
    expect(num.slot).toBe('n1')
  })

  test('a value the row already declared is what the pool skips', async () => {
    const db = await decl()
    await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text', slot: 't2' } })
    const next = await db.customField.create({ data: { model: 'Customer', key: 'band', type: 'text' } })
    expect(next.slot).toBe('t1')
  })

  // Absent means allocate; STATED is honored. An import restoring declarations
  // has to be able to say which slot each one held — re-deriving them would
  // repoint live fields onto slots whose mirrors were written for other keys,
  // which does not self-heal the way the mirror does.
  test('a stated slot is honored rather than recomputed', async () => {
    const db = await decl()
    const row = await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text', slot: 't7' } })
    expect(row.slot).toBe('t7')
  })

  // Not an asSystem() path. Declaring a field is an ordinary write by whoever
  // the declaring model's own gate admits, and the allocation is the framework
  // filling a column rather than a bypass — which is what lets the column be
  // `@system` in an app without the declaration having to go around itself.
  test('an ordinary caller gets one too', async () => {
    const c   = await client()
    const row = await c.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
    expect(row.slot).toBe('t1')
  })

  // The declaration is frozen once bound. Re-pointing a live field would leave
  // every existing row's value in the old slot, so every query on it would
  // match nothing — the failure the feature exists to prevent, by an edit.
  test('an update does not re-allocate', async () => {
    const db = await decl()
    const row = await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
    const after = await db.customField.update({ where: { id: row.id }, data: { key: 'renamed' } })
    expect(after.slot).toBe('t1')
  })

  // The crossing, and the reason the allocation is worth having at all: a field
  // declared with nothing said about a slot is a field a query can filter on
  // the same day.
  test('declare, write a value, filter on it', async () => {
    const c  = await client()
    const db = c.asSystem()
    await db.customField.create({ data: { model: 'Customer', key: 'tier', type: 'text' } })
    await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold'   } } })
    await db.customer.create({ data: { name: 'Bo',  fields: { tier: 'bronze' } } })
    const hits = await db.customer.findMany({ where: { fields: { tier: 'gold' } } })
    expect(hits.length).toBe(1)
    expect(hits[0].name).toBe('Ada')
  })
})

describe('the mirror, derived at the Data boundary', () => {
  // The caller sends the tenant's keys and never names a slot. The projection
  // lives in `writeData` — the one place every payload passes through, because
  // `makeTable` hand-restates its rule sequence per method and a derived column
  // added at eight call sites has a ninth nobody noticed.
  const seed = async () => {
    const c = await client()
    const db = c.asSystem()
    await db.customField.createMany({ data: [
      { model: 'Customer', key: 'tier', type: 'text',   slot: 't1' },
      { model: 'Customer', key: 'ltv',  type: 'number', slot: 'n1' },
    ] })
    return db
  }

  test('it is built with nobody naming it, and the blob is untouched', async () => {
    const db = await seed()
    const r  = await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold', ltv: 900 } } })
    const back = await db.customer.findUnique({ where: { id: r.id } })
    expect(back.t1).toBe('gold')
    expect(back.n1).toBe(900)
    expect(typeof back.n1).toBe('number')       // REAL affinity, not text
    expect(back.fields.tier).toBe('gold')
  })

  test('it is rebuilt WHOLE — a key removed from the blob leaves the mirror', async () => {
    const db = await seed()
    const r  = await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold', ltv: 900 } } })
    await db.customer.update({ where: { id: r.id }, data: { fields: { ltv: 950 } } })
    const back = await db.customer.findUnique({ where: { id: r.id } })
    expect(back.t1).toBeNull()
    expect(back.n1).toBe(950)
  })

  test('absent means leave it alone — the control for the row above', async () => {
    const db = await seed()
    const r  = await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold', ltv: 900 } } })
    await db.customer.update({ where: { id: r.id }, data: { name: 'Ada L' } })
    expect((await db.customer.findUnique({ where: { id: r.id } })).n1).toBe(900)
  })

  test('emptying the blob empties the mirror', async () => {
    const db = await seed()
    const r  = await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold' } } })
    await db.customer.update({ where: { id: r.id }, data: { fields: {} } })
    expect((await db.customer.findUnique({ where: { id: r.id } })).t1).toBeNull()
  })

  test('a key declared AFTER a write is projected by the next one', async () => {
    const db = await seed()
    await db.customer.create({ data: { name: 'Ada', fields: { tier: 'gold' } } })   // warms the cache
    await db.customField.create({ data: { model: 'Customer', key: 'band', type: 'text', slot: 't2' } })
    const bo = await db.customer.create({ data: { name: 'Bo', fields: { band: 'A', tier: 'silver' } } })
    const back = await db.customer.findUnique({ where: { id: bo.id } })
    expect(back.t2).toBe('A')
    expect(back.t1).toBe('silver')
  })

  test('an undeclared key stores and reaches no slot', async () => {
    const db = await seed()
    const r  = await db.customer.create({ data: { name: 'Cz', fields: { nope: 'x', tier: 'bronze' } } })
    const back = await db.customer.findUnique({ where: { id: r.id } })
    expect(back.fields.nope).toBe('x')
    expect(back.t1).toBe('bronze')
  })

  test('a pool-less model gets no mirror at all', async () => {
    const db = await seed()
    const p = await db.product.create({ data: { name: 'Shirt', fields: { care: 'hand wash' } } })
    expect('fieldsSlots' in p).toBe(false)
  })
})

describe('querying by the tenant’s own key', () => {
  const seed = async () => {
    const c  = await client()
    const db = c.asSystem()
    await db.customField.createMany({ data: [
      { model: 'Customer', key: 'tier',  type: 'text',   slot: 't1' },
      { model: 'Customer', key: 'ltv',   type: 'number', slot: 'n1' },
      { model: 'Customer', key: 'notes', type: 'text',   slot: null },
    ] })
    await db.customer.createMany({ data: [
      { name: 'Ada', fields: { tier: 'gold',   ltv: 900 } },
      { name: 'Bo',  fields: { tier: 'bronze', ltv: 40  } },
    ] })
    return db
  }

  test('the slot never leaves the Data boundary', async () => {
    const db = await seed()
    const hit = await db.customer.findMany({ where: { fields: { tier: 'gold' } } })
    expect(hit.map((r: any) => r.name)).toEqual(['Ada'])
  })

  test('two keys narrow, with the pair that matches nobody beside it', async () => {
    const db = await seed()
    expect((await db.customer.findMany({ where: { fields: { tier: 'gold', ltv: { gte: 500 } } } })).length).toBe(1)
    expect((await db.customer.findMany({ where: { fields: { tier: 'gold', ltv: { gte: 5000 } } } })).length).toBe(0)
  })

  // Dropping an unknown term widens the answer in silence, which is the one
  // failure nothing downstream can see: the request succeeds and the count is
  // plausible. Both refusals name the key.
  test('an undeclared key is refused, not dropped', async () => {
    const db = await seed()
    expect(db.customer.findMany({ where: { fields: { nope: 1 } } })).rejects.toThrow(/'nope' is not a field/)
  })

  test('a declared key with no slot is refused rather than scanned', async () => {
    const db = await seed()
    expect(db.customer.findMany({ where: { fields: { notes: 'x' } } })).rejects.toThrow(/holds no slot/)
  })

  test('naming a slot directly still works — nothing was taken away', async () => {
    const db = await seed()
    expect((await db.customer.findMany({ where: { t1: 'gold' } })).length).toBe(1)
  })

  test('and the rewrite lands on the INDEX rather than a scan', async () => {
    const db = await seed()
    const bulk = []
    for (let i = 0; i < 3000; i++) bulk.push({ name: `P${i}`, fields: { tier: ['gold','silver','bronze'][i % 3], ltv: i } })
    await db.customer.createMany({ data: bulk })
    await db.sql`ANALYZE`
    const plan = (await db.sql`EXPLAIN QUERY PLAN SELECT id FROM customer WHERE t1 = 'gold'`)
      .map((r: any) => r.detail).join(' | ')
    expect(plan).toMatch(/USING (COVERING )?INDEX/)
  })
})
