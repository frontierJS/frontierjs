/**
 * test/exact-numbers.test.ts — `@scale(n)` and `@money` (`FJS-D142`).
 *
 * The feature is one sentence — the column is an integer and the point sits n
 * places in — and almost all of its value is in the refusals. A `Float` column
 * accepts every wrong thing silently; this one has to say what to send instead,
 * because the moment somebody writes `total: 12.99` is the moment the bug would
 * have happened.
 *
 * The aggregate case is here too, and it is NOT the motivation: SQLite's `sum()`
 * is Kahan-compensated and sums REALs exactly at this size, which is what
 * retired the original argument for the feature. What a float loses is
 * multiplication and comparison — asserted at the bottom.
 */

import { describe, test, expect } from 'bun:test'
import { parse, createClient, generateJsonSchema } from '../src/index.js'
import { generateDDL } from '../src/core/ddl.js'

const errsOf = (src: string) => parse(src).errors.join(' · ')

describe('what parses', () => {
  test('every shape of the pair', () => {
    const r = parse(`model P {
      id       Int @id
      qty      Int @scale(6)
      total    Int @money(USD)
      quoted   Int @money("JPY")
      dflt     Int @money
      perRow   Int @money(field: currency)
      currency String
    }`)
    expect(r.valid).toBe(true)

    const at = (n: string, k: string) =>
      r.schema.models[0].fields.find((f: any) => f.name === n)!.attributes.find((a: any) => a.kind === k)

    expect(at('qty',    'scale')).toMatchObject({ places: 6 })
    expect(at('total',  'money')).toMatchObject({ currency: 'USD', field: null })
    expect(at('quoted', 'money')).toMatchObject({ currency: 'JPY' })
    expect(at('dflt',   'money')).toMatchObject({ currency: null, field: null })
    expect(at('perRow', 'money')).toMatchObject({ currency: null, field: 'currency' })
  })
})

describe('what is refused at parse', () => {
  test('a type that is not Int — the storage class stays true', () => {
    expect(errsOf(`model P { id Int @id  t Float @money(USD) }`)).toMatch(/requires an Int field, got Float/)
    expect(errsOf(`model P { id Int @id  t String @scale(2) }`)).toMatch(/requires an Int field, got String/)
  })

  test('both attributes — two answers to where the point is', () => {
    expect(errsOf(`model P { id Int @id  t Int @scale(2) @money(USD) }`))
      .toMatch(/@money derives the scale from the currency/)
  })

  test('a currency ISO 4217 does not carry', () => {
    // The one that matters most: `Intl.NumberFormat` does NOT throw on `UDS`,
    // it answers two decimal places, so nothing downstream would notice.
    expect(errsOf(`model P { id Int @id  t Int @money(UDS) }`)).toMatch(/not an ISO 4217 currency/)
    expect(errsOf(`model P { id Int @id  t Int @money(BTC) }`)).toMatch(/not an ISO 4217 currency/)
    // Zimbabwe Gold: a live currency node's ICU carries and bun's does not, so
    // this model parsed on one runtime and was refused as a typo on the other
    // until the table was shipped (`FJS-745`).
    expect(parse(`model P { id Int @id  t Int @money(ZWG) }`).valid).toBe(true)
  })

  test('a real currency with no minor unit is fine — the point of deriving it', () => {
    expect(parse(`model P { id Int @id  t Int @money(JPY) }`).valid).toBe(true)
    expect(parse(`model P { id Int @id  t Int @money(KWD) }`).valid).toBe(true)
  })

  test('more places than an integer has room for', () => {
    expect(errsOf(`model P { id Int @id  t Int @scale(12) }`)).toMatch(/at most 9 places/)
    expect(errsOf(`model P { id Int @id  t Int @scale(-1) }`)).toMatch(/whole number, 0 or more/)
    expect(parse(`model P { id Int @id  t Int @scale(9) }`).valid).toBe(true)
  })

  test('an array — the scale describes one value', () => {
    expect(errsOf(`model P { id Int @id  t Int[] @scale(2) }`)).toMatch(/cannot be an array/)
  })

  test('a field: naming nothing, or naming the wrong kind of column', () => {
    expect(errsOf(`model P { id Int @id  t Int @money(field: nope) }`)).toMatch(/no field 'nope'/)
    expect(errsOf(`model P { id Int @id  c Int  t Int @money(field: c) }`)).toMatch(/must be String, got Int/)
  })

  test('a `type` is not a column, so neither belongs there', () => {
    expect(errsOf(`type T { amount Int @money(USD) }`)).toMatch(/@money/)
  })
})

describe('the boundary', () => {
  const SCHEMA = `model Line {
    id    Int @id @default(autoincrement())
    total Int @money(USD)
    qty   Int @scale(6)
  }`
  const open = () => createClient({ schema: SCHEMA, db: ':memory:' })

  test('a whole number of minor units is stored and read back as itself', async () => {
    const db  = await open()
    const row = await db.line.create({ data: { total: 1299, qty: 1_500_000 } })
    expect(row.total).toBe(1299)
    expect(row.qty).toBe(1_500_000)
  })

  test('a fraction is refused BY NAME, saying what to send', async () => {
    const db = await open()
    // Without the rule this is SQLite's `cannot store REAL value in INTEGER
    // column line.total`, which names a physical column and helps nobody.
    await expect(db.line.create({ data: { total: 12.99, qty: 0 } }))
      .rejects.toThrow(/whole number of minor units of USD — 12\.99 is 1299/)
  })

  test('a scaled column names its own places in the refusal', async () => {
    const db = await open()
    await expect(db.line.create({ data: { total: 0, qty: 1.5 } }))
      .rejects.toThrow(/6 decimal place\(s\)/)
  })

  test('the column sorts, groups and sums — which JSON storage would not', async () => {
    const db = await open()
    for (const t of [1299, 100, 250_00]) await db.line.create({ data: { total: t, qty: 0 } })

    const asc = (await db.line.findMany({ orderBy: { total: 'asc' } })).map((r: any) => r.total)
    expect(asc).toEqual([100, 1299, 25000])

    const summed = await db.line.aggregate({ _sum: { total: true } })
    expect(summed._sum.total).toBe(100 + 1299 + 25000)
  })
})

describe('the range — the ceiling is 2^53, not int64 (`FJS-583`)', () => {
  // SQLite's INTEGER is 64-bit, but the value arrives and leaves as a JS number
  // and `bun:sqlite` returns one on every path. Past 2^53 the rounded double is
  // stored and a different number is read back with nothing raised — which is
  // exactly the failure `FJS-D142` cites `prisma#20635` for, one layer up.
  const SCHEMA = `model Rate {
    id    Int @id @default(autoincrement())
    price Int @scale(9)
    total Int @money(USD)
  }`
  const open = () => createClient({ schema: SCHEMA, db: ':memory:' })

  test('the failure this exists to stop — two distinct values, one double', () => {
    // Not a claim about litestone: a claim about the numbers themselves, which
    // is why nothing below could have caught it by being more careful.
    expect(Number('12345678900000001')).toBe(Number('12345678900000000'))
    expect(Number.isInteger(Number('12345678900000001'))).toBe(true)
  })

  test('a value past the range is refused by name, and names the bound', async () => {
    const db = await open()
    await expect(db.rate.create({ data: { price: 12345678900000001, total: 0 } }))
      .rejects.toThrow(/at most 9,007,199,254,740,991 minor units/)
  })

  test("the refusal works the value out at the column's own places", async () => {
    const db = await open()
    await expect(db.rate.create({ data: { price: Number.MAX_SAFE_INTEGER + 10, total: 0 } }))
      .rejects.toThrow(/at 9 decimal place\(s\) that is 9,007,199/)
  })

  test('@money says the bound and works nothing out — at 2 places it is £90bn away', async () => {
    const db = await open()
    const bad = () => db.rate.create({ data: { price: 0, total: Number.MAX_SAFE_INTEGER + 10 } })
    await expect(bad()).rejects.toThrow(/at most 9,007,199,254,740,991 minor units/)
    await expect(bad()).rejects.not.toThrow(/decimal place\(s\) that is/)
  })

  test('the bound itself is legal and round-trips', async () => {
    const db = await open()
    const row = await db.rate.create({ data: { price: Number.MAX_SAFE_INTEGER, total: 1299 } })
    expect(row.price).toBe(Number.MAX_SAFE_INTEGER)
    expect((await db.rate.findUnique({ where: { id: row.id } })).price).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('a fraction still gets the OTHER sentence — two mistakes, two answers', async () => {
    const db = await open()
    await expect(db.rate.create({ data: { price: 1.5, total: 0 } }))
      .rejects.toThrow(/whole number of minor units/)
  })

  test('the CHECK holds where the boundary is not — asSystem() and raw SQL', async () => {
    const db = await open()
    // asSystem() drops the gate, the row policies and @@softDelete, and cannot
    // drop this: the rule is in the table (`FJS-519`).
    await expect(db.asSystem().sql`INSERT INTO rate (price, total) VALUES (9007199254740999, 0)`)
      .rejects.toThrow(/CHECK constraint failed/)
  })

  test('the DDL carries it, so a migration and a seed are held to it too', () => {
    const ddl = generateDDL(parse(`model P { id Int @id  t Int @money(USD)  q Int @scale(6)  n Int }`).schema)
    expect(ddl).toMatch(/"t" INTEGER NOT NULL CHECK \("t" BETWEEN -9007199254740991 AND 9007199254740991\)/)
    expect(ddl).toMatch(/"q" INTEGER NOT NULL CHECK \("q" BETWEEN/)
    // A plain Int is NOT bounded. It makes no exactness promise, and bounding
    // every integer column in every app to buy back one is the wrong trade —
    // stated here so the scope is a decision rather than an oversight.
    expect(ddl).toMatch(/"n" INTEGER NOT NULL\n/)
  })
})

describe('on the wire', () => {
  test('the JSON type stays integer and the scale travels beside it', () => {
    const r = parse(`model P {
      id Int @id
      qty Int @scale(6)  total Int @money(USD)  amt Int @money(field: cur)  cur String  fee Int @money
    }`)
    const props = (generateJsonSchema(r.schema) as any).$defs.P.properties

    expect(props.qty).toMatchObject({ type: 'integer', 'x-scale': 6 })
    expect(props.total).toMatchObject({ type: 'integer', 'x-money': { currency: 'USD' } })
    expect(props.amt).toMatchObject({ 'x-money': { field: 'cur' } })
    // The default-currency form carries the marker and no answer, which is the
    // honest shape: the app knows its default and the schema does not.
    expect(props.fee['x-money']).toEqual({})
  })

  test('a per-row currency does NOT resolve a scale', () => {
    const r = parse(`model P { id Int @id  amt Int @money(field: cur)  cur String }`)
    const props = (generateJsonSchema(r.schema) as any).$defs.P.properties
    expect(props.amt['x-money']).not.toHaveProperty('scale')
  })
})

describe('why — measured, so the argument in the docs can be checked', () => {
  test('SUM over REAL is NOT the case: SQLite compensates it', async () => {
    // The original argument for this feature, retired 2026-08-25. Kept as a
    // test so nobody reinstates it from memory.
    const db = await createClient({
      schema: `model R { id Int @id @default(autoincrement())  v Float }`, db: ':memory:',
    })
    let exact = 0
    for (let i = 1; i <= 2000; i++) { const cents = i * 7 % 9973; exact += cents; await db.r.create({ data: { v: cents / 100 } }) }
    const sum = (await db.r.aggregate({ _sum: { v: true } }))._sum.v
    expect(Math.abs(sum - exact / 100)).toBeLessThan(1e-9)
  })

  test('multiplication and comparison ARE the case', () => {
    expect(0.1 * 3).not.toBe(0.3)
    let acc = 0
    for (let i = 0; i < 10; i++) acc += 0.1
    expect(acc >= 1).toBe(false)
    // The same two quantities as scaled integers, exactly.
    expect(10 * 3).toBe(30)
  })
})
