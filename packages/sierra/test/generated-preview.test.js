/**
 * test/generated-preview.test.js — a `@generated` and an `@from` answered for a draft.
 *
 * A quote editor shows a line's amount and the quote's total while the lines
 * are being typed, before any of them is written. The amount is a generated
 * column, so the server's rule is in the schema; restated in the app it is a
 * second copy that drifts (`FJS-2747`). An unquoted `@generated` and a backtick
 * template reach the client as `x-litestone-generated` (`FJS-D1112`), an
 * aggregate `@from`'s filter as `x-litestone-from` (`FJS-D1368`), and
 * `resource.preview(draft)` answers both with the evaluator litestone's own
 * policies run.
 *
 * The schema here is REAL litestone output, so what is asserted is the seam —
 * emitted, carried onto the rule, answered — and a quoted SQL `@generated`
 * answers nothing, because the browser cannot run its SQL. Whether the JS and
 * SQL halves agree on the same rows is graded in litestone
 * (`test/generated-expression.test.ts`).
 */

import { describe, test, expect, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmp.js'

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({}),
    resource: () => ({
      service: {},
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { buildFieldRules, generatedFor, fromFor } = await import('../src/resource/field-rules.js')
const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas, readSchemaFor } = await import('../src/resource/schema-registry.js')
const { generateSchemas } = await import('../src/build/schema-plugin.js')

const SOURCE = `
model Quote {
  id       Int         @id @default(autoincrement())
  lines    QuoteLine[]
  weekly   Int         @from(QuoteLine, sum: amount, where: status != 'lost' && per == 'week')
  taxed    Int         @from(QuoteLine, sum: amount, where: per == 'week' && taxable)
  kept     Int         @from(QuoteLine, count: true, where: status != 'lost')
  anyLost  Boolean     @from(QuoteLine, exists: true, where: status == 'lost')
  biggest  Int?        @from(QuoteLine, max: amount)
  @@gate(0.0.0.0)
}

model QuoteLine {
  id        Int     @id @default(autoincrement())
  quoteId   Int?
  quote     Quote?  @relation(fields: [quoteId], references: [id])
  status    String  @default("quoted")
  per       String  @default("once")
  taxable   Boolean @default(false)
  unitPrice Int
  quantity  Int
  firstName String?
  lastName  String?
  amount    Int     @generated(round(unitPrice * quantity * 0.01))
  who       String? @generated(\`{firstName} {lastName}\`)
  legacy    Int     @generated("{unitPrice} * {quantity}")
  @@gate(0.0.0.0)
}
`

// The build's own schema step: a generated column is in the READ table only.
const path = join(tmpDir('generated-'), 'schema.lite')
writeFileSync(path, SOURCE)
const built = await generateSchemas(path, () => {}, join(dirname(fileURLToPath(import.meta.url)), '..'))
registerSchemas(built.defs, built.models, built.updatePatch, built.readPatch)
const fields = buildFieldRules(readSchemaFor('QuoteLine'), () => null)
const quote  = buildFieldRules(readSchemaFor('Quote'), () => null)

describe('the rule reaches the field', () => {
  test('an expression and a template are carried; quoted SQL is not', () => {
    expect(fields.amount['x-litestone-generated']?.expr?.type).toBe('round')
    expect(fields.who['x-litestone-generated']).toEqual({ template: '{firstName} {lastName}' })
    expect(fields.legacy['x-litestone-generated']).toBeUndefined()
  })
})

describe('generatedFor', () => {
  test('answers the amount the server will write', () => {
    expect(generatedFor(fields.amount, { unitPrice: 1250, quantity: 250 })).toBe(3125)
    // SQLite's round, half away from zero.
    expect(generatedFor(fields.amount, { unitPrice: -250, quantity: 1 })).toBe(-3)
  })

  test('a field not typed yet is null, as SQL answers it', () => {
    expect(generatedFor(fields.amount, { unitPrice: 1250 })).toBe(null)
  })

  test('a template takes the separator with a missing field', () => {
    expect(generatedFor(fields.who, { firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace')
    expect(generatedFor(fields.who, { lastName: 'Lovelace' })).toBe('Lovelace')
  })

  test('no answer for quoted SQL, an ordinary column, or no record', () => {
    expect(generatedFor(fields.legacy, { unitPrice: 2, quantity: 3 })).toBeUndefined()
    expect(generatedFor(fields.unitPrice, { unitPrice: 2 })).toBeUndefined()
    expect(generatedFor(fields.amount, null)).toBeUndefined()
  })
})

describe('through the resource', () => {
  test('a draft line reports its amount without the app writing the formula', () => {
    const lines = createResource('quoteLines', { model: 'QuoteLine' })
    expect(lines.preview({ unitPrice: 1250, quantity: 250, firstName: 'Ada' }))
      .toEqual({ amount: 3125, who: 'Ada' })
  })

  test('a draft quote reports its totals over lines not yet written', () => {
    const quotes = createResource('quotes', { model: 'Quote' })
    // The second line's stored amount is stale: its quantity was just retyped.
    const draft = { lines: [
      { status: 'won',  per: 'week', taxable: true, unitPrice: 1000, quantity: 100 },
      { status: 'won',  per: 'week', unitPrice: 500, quantity: 200, amount: 1 },
      { status: 'lost', per: 'week', taxable: true, unitPrice: 9900, quantity: 100 },
      { status: 'won',  per: 'once', unitPrice: 300, quantity: 100 },
    ] }
    expect(quotes.preview(draft))
      .toEqual({ weekly: 2000, taxed: 10900, kept: 3, anyLost: true, biggest: 9900 })
  })
})

describe('fromFor', () => {
  test('the filter reaches the rule as an expression, with the list it reads', () => {
    expect(quote.weekly['x-litestone-from']).toMatchObject({ op: 'sum', rel: 'lines', field: 'amount' })
    expect(quote.weekly['x-litestone-from'].where?.type).toBe('and')
  })

  test('over no children: a sum is 0 and a max is null, as SQLite answers them', () => {
    expect(fromFor(quote.weekly,  { lines: [] })).toBe(0)
    expect(fromFor(quote.biggest, { lines: [] })).toBe(null)
    expect(fromFor(quote.anyLost, { lines: [] })).toBe(false)
  })

  test('a filter answering UNKNOWN does not count the row', () => {
    expect(fromFor(quote.kept, { lines: [{ status: null }, { status: 'won' }] })).toBe(1)
  })

  test('no answer without the children in the record', () => {
    expect(fromFor(quote.weekly, {})).toBeUndefined()
    expect(fromFor(fields.amount, { lines: [] })).toBeUndefined()
  })
})
