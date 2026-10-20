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
      perRow   Int @money(field: currency)
      currency String
    }`)
    expect(r.valid).toBe(true)

    const at = (n: string, k: string) =>
      r.schema.models[0].fields.find((f: any) => f.name === n)!.attributes.find((a: any) => a.kind === k)

    expect(at('qty',    'scale')).toMatchObject({ places: 6 })
    expect(at('total',  'money')).toMatchObject({ currency: 'USD', field: null })
    expect(at('quoted', 'money')).toMatchObject({ currency: 'JPY' })
    expect(at('perRow', 'money')).toMatchObject({ currency: null, field: 'currency' })
  })
})

describe('what is refused at parse', () => {
  test('a bare @money — the currency decides the scale, so it is stated', () => {
    expect(errsOf(`model P { id Int @id  t Int @money }`)).toMatch(/@money needs its currency/)
    // The pair: either stated shape passes the same rule.
    expect(errsOf(`model P { id Int @id  t Int @money(USD) }`)).toBe('')
    expect(errsOf(`model P { id Int @id  t Int @money(field: c)  c String }`)).toBe('')
  })

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

// FJS-2172: every row is capped at 2^53 by the CHECK, and the sum of three is
// not. SQLite adds in int64 and the read rounds the answer to a double.
describe('a sum past 2^53 is refused by name, never rounded', () => {
  const CAP = Number.MAX_SAFE_INTEGER
  const open = async () => {
    const db = await createClient({
      schema: `model Line {
        id    Int @id @default(autoincrement())
        total Int @money(USD)
        kind  String
        rate  Float @default(0)
      }`,
      db: ':memory:',
    })
    for (const kind of ['a', 'a', 'a']) await db.line.create({ data: { total: CAP, kind } })
    return db
  }

  test('aggregate names the field and the cap', async () => {
    const db = await open()
    await expect(db.line.aggregate({ _sum: { total: true } })).rejects.toThrow(/_sum of 'total' .*2\^53/)
    await expect(db.line.aggregate({ where: { id: 1 }, _sum: { total: true } })).resolves.toEqual({ _sum: { total: CAP } })
  })

  test('groupBy refuses the same sum, per group', async () => {
    const db = await open()
    await expect(db.line.groupBy({ by: ['kind'], _sum: { total: true } })).rejects.toThrow(/_sum of 'total' .*2\^53/)
  })

  test('a REAL sum that large is a float and is returned', async () => {
    const db = await open()
    await db.line.update({ where: { id: 1 }, data: { rate: 1e20 } })
    expect((await db.line.aggregate({ _sum: { rate: true } }))._sum.rate).toBe(1e20)
  })
})

// FJS-2171: $49, €45 and ¥7,000 summed to one bare 16,400.
describe('a per-row currency is aggregated one currency at a time', () => {
  const SCHEMA = `model Invoice {
    id       Int    @id @default(autoincrement())
    amount   Int    @money(field: currency)
    currency String
    status   String @default("paid")
  }`
  const open = async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    for (const [amount, currency] of [[4900, 'USD'], [4500, 'EUR'], [7000, 'JPY']] as const)
      await db.invoice.create({ data: { amount, currency } })
    return db
  }

  test('across currencies, every value-reading aggregate is refused naming the currency column', async () => {
    const db = await open()
    for (const agg of ['_sum', '_avg', '_min', '_max'])
      await expect(db.invoice.aggregate({ [agg]: { amount: true } }))
        .rejects.toThrow(/'amount'.*currency/)
    await expect(db.invoice.aggregate({ _revenue: { sum: 'amount' } })).rejects.toThrow(/currency/)
    await expect(db.invoice.groupBy({ by: ['status'], _sum: { amount: true } })).rejects.toThrow(/currency/)
    // Neither selects the sum, and each still compares one across currencies.
    await expect(db.invoice.groupBy({ by: ['status'], _count: true, having: { _sum: { amount: { gt: 0 } } } })).rejects.toThrow(/currency/)
    await expect(db.invoice.groupBy({ by: ['status'], _count: true, orderBy: { _max: { amount: 'desc' } } })).rejects.toThrow(/currency/)
  })

  test('a where that pins the currency, or a by that names it, is one currency', async () => {
    const db = await open()
    expect((await db.invoice.aggregate({ where: { currency: 'USD' }, _sum: { amount: true } }))._sum.amount).toBe(4900)
    expect((await db.invoice.aggregate({ where: { currency: { equals: 'EUR' } }, _avg: { amount: true } }))._avg.amount).toBe(4500)
    expect((await db.invoice.aggregate({ where: { AND: [{ status: 'paid' }, { currency: { in: ['JPY'] } }] }, _max: { amount: true } }))._max.amount).toBe(7000)
    expect((await db.invoice.aggregate({ where: { currency: 'USD' }, _usd: { sum: 'amount' } }))._usd).toBe(4900)
    const grouped = await db.invoice.groupBy({ by: ['currency'], _sum: { amount: true }, orderBy: { currency: 'asc' } })
    expect(grouped.map((g: any) => [g.currency, g._sum.amount])).toEqual([['EUR', 4500], ['JPY', 7000], ['USD', 4900]])
  })

  test('counting rows reads no amount, so it is not refused', async () => {
    const db = await open()
    expect((await db.invoice.aggregate({ _count: true }))._count).toBe(3)
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
    // biome-ignore lint/correctness/noPrecisionLoss: the lost precision is the input under test
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
    expect(ddl).toMatch(/"q" INTEGER NOT NULL CONSTRAINT "q_scale_6" CHECK \("q" BETWEEN/)
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
      qty Int @scale(6)  total Int @money(USD)  amt Int @money(field: cur)  cur String
    }`)
    const props = (generateJsonSchema(r.schema) as any).$defs.P.properties

    expect(props.qty).toMatchObject({ type: 'integer', 'x-scale': 6 })
    expect(props.total).toMatchObject({ type: 'integer', 'x-money': { currency: 'USD' } })
    expect(props.amt).toMatchObject({ 'x-money': { field: 'cur' } })
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

// ─── @money(…, places: n) — a rate finer than the minor unit (FJS-2049, FJS-D1043) ───

describe('@money places — digits past the currency\'s minor unit', () => {
  test('parses on a stated and a per-row currency, and rides on the JSON Schema', () => {
    const r = parse(`model P {
      id       Int @id
      rate     Int @money(USD, places: 6)
      perRow   Int @money(field: currency, places: 3)
      plain    Int @money(USD)
      currency String
    }`)
    expect(r.valid).toBe(true)
    const at = (n: string) =>
      r.schema.models[0].fields.find((f: any) => f.name === n)!.attributes.find((a: any) => a.kind === 'money')
    expect(at('rate')).toMatchObject({ currency: 'USD', places: 6 })
    expect(at('perRow')).toMatchObject({ field: 'currency', places: 3 })
    expect(at('plain')).toMatchObject({ places: null })

    const props = (generateJsonSchema(r.schema) as any).$defs?.P?.properties
      ?? (generateJsonSchema(r.schema) as any).definitions?.P?.properties
    expect(props.rate['x-money']).toEqual({ currency: 'USD', places: 6 })
    expect(props.perRow['x-money']).toEqual({ field: 'currency', places: 3 })
    expect(props.plain['x-money']).toEqual({ currency: 'USD' })
  })

  test('the 9-place cap counts the currency\'s own places', () => {
    expect(errsOf(`model P { id Int @id  t Int @money(USD, places: 7) }`)).toBe('')
    expect(errsOf(`model P { id Int @id  t Int @money(USD, places: 8) }`)).toMatch(/at most 7 extra/)
    expect(errsOf(`model P { id Int @id  t Int @money(JPY, places: 9) }`)).toBe('')
    expect(errsOf(`model P { id Int @id  t Int @money(KWD, places: 7) }`)).toMatch(/at most 6 extra/)
    expect(errsOf(`model P { id Int @id  t Int @money(field: c, places: 6)  c String }`)).toMatch(/at most 5 extra/)
  })

  test('places is a whole number of 1 or more, and no other key is accepted', () => {
    expect(errsOf(`model P { id Int @id  t Int @money(USD, places: 0) }`)).toMatch(/whole number of 1 or more/)
    expect(errsOf(`model P { id Int @id  t Int @money(USD, scale: 4) }`)).toMatch(/takes 'places:'/)
  })

  test('still refused beside @scale and @big', () => {
    expect(errsOf(`model P { id Int @id  t Int @scale(9) @money(USD, places: 6) }`))
      .toMatch(/@money derives the scale from the currency/)
  })

  test('a fixed @default and a bound read the widened scale', () => {
    // 0.00025 USD at 8 places is 25000; at the bare two it would read as 0.
    expect(errsOf(`model P { id Int @id  t Int @money(USD, places: 6) @default(0.00025) }`))
      .toMatch(/Write it in minor units: @default\(25000\)/)
  })
})

// ─── a scale change is a migration ───────────────────────────────────────────
//
// @scale(9) and @scale(6) emitted the same CHECK, so the differ saw nothing, and
// a rebuild for any other reason copied every stored integer verbatim — worth
// 1000x after the move (FJS-2140). The scale is in the constraint's NAME now
// (FJS-D1335); a table with rows is refused naming the UPDATE, an empty one
// rebuilds.
describe('a @scale change', () => {
  const fee = (n: number) => `model Fee { id Int @id @default(autoincrement())  units Int @scale(${n}) }`
  const fs  = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { Database } = require('bun:sqlite')
  const migrations = require('../src/core/migrations.js')

  const project = () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'ls-rescale-'))
    const dirM = join(dir, 'migrations')
    fs.mkdirSync(dirM)
    const db = new Database(join(dir, 'app.db'))
    return { dirM, db, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
  }
  const at9 = async () => {
    const p = project()
    migrations.create(null, parse(fee(9)), 'init', p.dirM)
    expect((await migrations.apply(p.db, p.dirM)).error).toBeUndefined()
    return p
  }
  const ddl = (db: any) => db.query(`SELECT sql FROM sqlite_master WHERE name = 'fee'`).get().sql as string

  test('the scale is named into the CHECK', () => {
    expect(generateDDL(parse(fee(6)).schema)).toContain(`CONSTRAINT "units_scale_6" CHECK ("units" BETWEEN`)
  })

  test('migrate create sees it, and writes nothing when the scale holds', async () => {
    const p = await at9()
    expect(migrations.create(null, parse(fee(9)), 'same', p.dirM).created).toBe(false)
    const r = migrations.create(null, parse(fee(6)), 'rescale', p.dirM)
    expect(r.created).toBe(true)
    expect(r.summary).toContain('@scale(9) → @scale(6)')
    expect(r.sql).toContain('UPDATE "fee" SET "units" = "units" / 1000;')
    p.done()
  })

  test('a table with rows is refused, naming the UPDATE, and keeps its rows as they were', async () => {
    const p = await at9()
    p.db.run(`INSERT INTO "fee" (units) VALUES (5000000000)`)
    migrations.create(null, parse(fee(6)), 'rescale', p.dirM)
    const r = await migrations.apply(p.db, p.dirM)
    expect(r.error).toContain('write UPDATE fee SET units = units / 1000 above this guard')
    expect(p.db.query(`SELECT units FROM "fee"`).get().units).toBe(5000000000)
    expect(ddl(p.db)).toContain('units_scale_9')
    p.done()
  })

  test('an empty table rebuilds, and the next create sees nothing', async () => {
    const p = await at9()
    migrations.create(null, parse(fee(6)), 'rescale', p.dirM)
    expect((await migrations.apply(p.db, p.dirM)).error).toBeUndefined()
    expect(ddl(p.db)).toContain('units_scale_6')
    expect(migrations.create(null, parse(fee(6)), 'again', p.dirM).created).toBe(false)
    p.done()
  })

  test('a widening multiplies, and autoMigrate refuses rows by the same statement', async () => {
    const p = await at9()
    p.db.run(`INSERT INTO "fee" (units) VALUES (5)`)
    const r = migrations.autoMigrate({ $db: p.db }, parse(fee(12)))
    expect(r.main.state).toBe('blocked')
    expect(r.main.reason).toContain('UPDATE "fee" SET "units" = "units" * 1000;')
    p.db.run(`DELETE FROM "fee"`)
    expect(migrations.autoMigrate({ $db: p.db }, parse(fee(12))).main.state).toBe('migrated')
    expect(migrations.autoMigrate({ $db: p.db }, parse(fee(12)), { force: true }).main.state).toBe('in-sync')
    p.done()
  })

  test('a CHECK written before the scale was named rebuilds once, with no rescale', async () => {
    const p = project()
    p.db.run(`CREATE TABLE "fee" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ` +
             `"units" INTEGER NOT NULL CHECK ("units" BETWEEN -9007199254740991 AND 9007199254740991)) STRICT`)
    p.db.run(`INSERT INTO "fee" (units) VALUES (7)`)
    const r = migrations.autoMigrate({ $db: p.db }, parse(fee(6)))
    expect(r.main.state).toBe('migrated')
    expect(r.main.sql).not.toContain('_litestone_rescale')
    expect(ddl(p.db)).toContain('units_scale_6')
    expect(p.db.query(`SELECT units FROM "fee"`).get().units).toBe(7)
    expect(migrations.autoMigrate({ $db: p.db }, parse(fee(6)), { force: true }).main.state).toBe('in-sync')
    p.done()
  })
})
