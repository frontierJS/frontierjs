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

  test('a currency this runtime does not know', () => {
    // The one that matters most: `Intl.NumberFormat` does NOT throw on `UDS`,
    // it answers two decimal places, so nothing downstream would notice.
    expect(errsOf(`model P { id Int @id  t Int @money(UDS) }`)).toMatch(/not a currency this runtime knows/)
    expect(errsOf(`model P { id Int @id  t Int @money(BTC) }`)).toMatch(/not a currency this runtime knows/)
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
