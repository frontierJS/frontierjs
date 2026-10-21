// test/generated-expression.test.ts
//
// `@generated(round(unitPrice * quantity * 0.01))` — the unquoted form, which
// is the expression language rather than SQL text (`FJS-D1112`). The point of
// the form is that a screen can answer it for a draft: it reaches the client
// as `x-litestone-generated` and is evaluated by `@frontierjs/toolbelt/predicate`,
// the evaluator litestone's own policies run. A backtick template reaches it
// too, shaped by the same `templateShape` the SQL is compiled from.
//
// So the assertion that matters is the ORACLE below: every row written here is
// read back through SQLite's generated column and answered again in JS from
// the emitted rule, and the two must agree — a null operand, a negative half,
// a REAL product rounding into an Int column, a template with a missing field.
// A preview that disagreed with the stored value is the restatement `FJS-2747`
// was filed against, with the copy moved into the framework.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { generateJsonSchema } from '../src/jsonschema.js'
import { evaluate, formatTemplate } from '@frontierjs/toolbelt/predicate'

const SCHEMA = `
  model Line {
    id        Int     @id
    unitPrice Int?
    quantity  Int?
    hours     Float?
    budget    Float?
    first     String?
    middle    String?
    last      String?
    code      String?

    amount   Int?    @generated(round(unitPrice * quantity * 0.01))
    gross    Int?    @generated(unitPrice * quantity + 5, stored)
    variance Float?  @generated(hours - budget)
    name     String? @generated(\`{first} {middle} {last}\`)
    ref      String? @generated(\`[{code}-{quantity}]\`)
  }
`

const ROWS = [
  { unitPrice: 1250, quantity: 250 },
  { unitPrice: 333,  quantity: 7 },          // 23.31 → 23
  { unitPrice: -250, quantity: 1 },          // -2.5 → -3, half away from zero
  { unitPrice: 50,   quantity: 1 },          // 0.5 → 1
  { unitPrice: null, quantity: 3 },
  { unitPrice: 7,    quantity: null },
  { hours: 7.5, budget: 8 },
  { hours: 0.1, budget: 0.2 },               // the double, not the decimal
  { hours: null, budget: 2 },
  { first: 'Ada', middle: null, last: 'Lovelace' },
  { first: null, middle: 'B', last: null },
  { first: '', middle: 'x', last: 'y' },     // '' is a value, not a null
  { code: 'Q', quantity: 12 },
  { code: null, quantity: 12 },
  { code: null, quantity: null },
]

const GENERATED = ['amount', 'gross', 'variance', 'name', 'ref']

describe('the unquoted form — what it compiles to', () => {
  test('arithmetic over quoted column names, round() as SQLite spells it', () => {
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toContain(`"amount" INTEGER GENERATED ALWAYS AS (round((("unitPrice" * "quantity") * 0.01))) VIRTUAL`)
    expect(ddl).toContain(`"gross" INTEGER GENERATED ALWAYS AS ((("unitPrice" * "quantity") + 5)) STORED`)
  })

  test('the client is handed the rule, and a quoted SQL @generated hands it none', () => {
    const src = SCHEMA.replace('  }\n', '    legacy Int? @generated("{unitPrice} * 2")\n  }\n')
    const props = generateJsonSchema(parse(src).schema, { mode: 'full' }).$defs.Line.properties
    expect(props.amount['x-litestone-generated'].expr.type).toBe('round')
    expect(props.name['x-litestone-generated']).toEqual({ template: '{first} {middle} {last}' })
    expect(props.legacy['x-litestone-generated']).toBeUndefined()
    expect(props.legacy['x-litestone-kind']).toBe('generated')
  })
})

describe('the oracle — the stored value and the preview agree on every row', () => {
  test('SQLite and the emitted rule answer the same', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA })
    const props = generateJsonSchema(parse(SCHEMA).schema, { mode: 'full' }).$defs.Line.properties
    const preview = (name: string, row: object) => {
      const gen = props[name]['x-litestone-generated']
      return gen.template != null ? formatTemplate(gen.template, row) : evaluate(gen.expr, { record: row })
    }
    let id = 0
    for (const data of ROWS) {
      const stored = await db.line.create({ data: { id: ++id, ...data } })
      for (const name of GENERATED)
        expect({ row: data, name, value: preview(name, data) }).toEqual({ row: data, name, value: stored[name] })
    }
  })
})

describe('refused by name', () => {
  const errorsOf = (field: string) => {
    const r = parse(`model T {\n  id Int @id\n  qty Int\n  price Int\n  label String?\n  secret Int? @encrypted\n  ${field}\n}`)
    return r.valid ? [] : r.errors.join('\n')
  }

  test('an Int column over a REAL product says round(), which STRICT needs at insert', () => {
    expect(errorsOf('total Int @generated(qty * price * 0.01)')).toContain('wrap it in round()')
    expect(errorsOf('total Int @generated(round(qty * price * 0.01))')).toEqual([])
  })

  test('a non-numeric operand, a non-numeric column, and a constant', () => {
    expect(errorsOf('total Int @generated(qty * label)')).toContain(`'label' is String`)
    expect(errorsOf('total Int @generated(qty * secret)')).toContain('@encrypted')
    expect(errorsOf('total String @generated(qty * price)')).toContain(`'total' is String`)
    expect(errorsOf('total Int @generated(3 * 2)')).toContain('belongs in @default')
  })

  test('anything wider than arithmetic points at the quoted SQL form', () => {
    for (const expr of ['qty > 3', 'qty > 3 ? qty : price', 'now()', 'auth().id'])
      expect(errorsOf(`total Int @generated(${expr})`)).toContain('SQL goes in double quotes')
  })

  test('a name that is not a stored column is the existing refusal', () => {
    expect(errorsOf('total Int @generated(nope * 2)')).toContain(`unknown field 'nope'`)
  })
})

// ─── an @from's where: ────────────────────────────────────────────────────────
//
// The same argument one level up (`FJS-D1368`): a quote's weekly subtotal is an
// @from over its lines, filtered. The filter is the expression language, so the
// client is handed its AST, and the rows SQLite counts must be exactly the rows
// `evaluate` answers TRUE for — a null status is UNKNOWN and counted by neither,
// a Boolean is 1/0 in SQL and true/false in a draft, a @map'd column is read by
// its field name.

const FROM_SCHEMA = `
  model Quote {
    id     Int    @id
    lines  Part[]
    weekly Int    @from(Part, count: true, where: status != 'lost' && per == 'week')
    taxed  Int    @from(Part, count: true, where: taxable && !(status == 'lost'))
    open   Int    @from(Part, count: true, where: doneAt == null || doneAt > now())
    total  Int    @from(Part, sum: amount, where: status in ['won', 'quoted'])
  }
  model Part {
    id      Int       @id
    quoteId Int
    quote   Quote     @relation(fields: [quoteId], references: [id])
    status  String?
    per     String?   @map("period")
    taxable Boolean?
    doneAt  DateTime?
    amount  Int?
  }
`

const PARTS = [
  { status: 'won',    per: 'week',  taxable: true,  amount: 10 },
  { status: 'lost',   per: 'week',  taxable: true,  amount: 20 },
  { status: null,     per: 'week',  taxable: false, amount: 40 },
  { status: 'quoted', per: null,    taxable: null,  amount: null },
  { status: 'won',    per: 'month', taxable: true,  amount: 80, doneAt: '2020-01-01T00:00:00.000Z' },
  { status: 'quoted', per: 'week',  taxable: false, amount: 160, doneAt: '2999-01-01T00:00:00.000Z' },
]

describe('an @from where: — SQLite and the emitted filter count the same rows', () => {
  test('every subset of the parts, every filter', async () => {
    const db = await createClient({ db: ':memory:', schema: FROM_SCHEMA })
    const props = generateJsonSchema(parse(FROM_SCHEMA).schema, { mode: 'full' }).$defs.Quote.properties
    const now = new Date().toISOString()
    const kept = (name: string, rows: any[]) =>
      rows.filter(r => evaluate(props[name]['x-litestone-from'].where, { record: r, now }) === true)
    let partId = 0
    for (let mask = 0; mask < 1 << PARTS.length; mask++) {
      const rows = PARTS.filter((_, i) => mask & (1 << i))
      await db.quote.create({ data: { id: mask + 1 } })
      for (const p of rows) await db.part.create({ data: { id: ++partId, quoteId: mask + 1, ...p } })
      const q = await db.quote.findFirst({ where: { id: mask + 1 } })
      const js = {
        weekly: kept('weekly', rows).length,
        taxed:  kept('taxed', rows).length,
        open:   kept('open', rows).length,
        total:  kept('total', rows).reduce((s, r) => s + (r.amount ?? 0), 0),
      }
      expect({ mask, ...js }).toEqual({ mask, weekly: q.weekly, taxed: q.taxed, open: q.open, total: q.total })
    }
  })

  test('the client is handed the list it reads and the filter', () => {
    const props = generateJsonSchema(parse(FROM_SCHEMA).schema, { mode: 'full' }).$defs.Quote.properties
    expect(props.total['x-litestone-from']).toMatchObject({ target: 'Part', op: 'sum', rel: 'lines', field: 'amount' })
    expect(props.weekly['x-litestone-from'].where.type).toBe('and')
  })

  test('refused by name: a quoted string, a name the target lacks, a reader', () => {
    const errorsOf = (where: string) => {
      const r = parse(FROM_SCHEMA.replace(`where: status != 'lost' && per == 'week'`, where))
      return r.valid ? [] : r.errors.join('\n')
    }
    expect(errorsOf(`where: "status = 'won'"`)).toContain('takes the expression language, unquoted')
    expect(errorsOf(`where: nope == 1`)).toContain(`'nope', which is not a field of Part`)
    expect(errorsOf(`where: auth().id == 1`)).toContain('not one per reader')
    expect(errorsOf(`where: quote.id == 1`)).toContain('reads past Part')
  })
})
