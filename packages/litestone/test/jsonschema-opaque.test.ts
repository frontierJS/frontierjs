/**
 * jsonschema-opaque.test.ts — the JSON Schema export names every rule it
 * cannot express (`FJS-D2130`, `FJS-4294`). A `@@check` has no JSON Schema
 * keyword, and dropping it in silence left a client validating against the
 * document accepting a row the server refuses. The model carries
 * `x-opaque: [{ rule, message }]` and the root one list of
 * `{ path, rule, message }`; an empty root list means the document is exactly
 * as strict as the schema.
 */

import { describe, test, expect } from 'bun:test'
import { parse, generateJsonSchema } from '../src/index.js'
import { CATALOG, typed, probeFor, PROBE } from '../src/core/catalog.js'

const exportOf = (src: string, opts = {}) => {
  const { schema, errors } = parse(src) as any
  if (errors?.length) throw new Error(errors.join('\n'))
  return generateJsonSchema(schema, opts) as any
}

describe('x-opaque', () => {
  test('a @@check is named on the model and in the root list', () => {
    const doc = exportOf(`
model Discount {
  id       Int       @id
  startsAt DateTime?
  endsAt   DateTime?
  @@check("startsAt IS NULL OR endsAt IS NULL OR startsAt < endsAt", "a discount must end after it starts")
}`)
    const rule = '@@check("startsAt IS NULL OR endsAt IS NULL OR startsAt < endsAt")'
    expect(doc.$defs.Discount['x-opaque']).toEqual([{ rule, message: 'a discount must end after it starts' }])
    expect(doc['x-opaque']).toEqual([{ path: 'Discount', rule, message: 'a discount must end after it starts' }])
  })

  test('a field @check and an @@arc are listed, a rule without a message says null', () => {
    const doc = exportOf(`
model Line {
  id        Int  @id
  qty       Int  @check("qty % 2 = 0")
  orderId   Int?
  productId Int?
  @@arc([orderId, productId], message: "a line belongs to an order or a product")
}`)
    expect(doc.$defs.Line['x-opaque']).toEqual([
      { field: 'qty', rule: '@check("qty % 2 = 0")', message: null },
      { rule: '@@arc([orderId, productId])', message: 'a line belongs to an order or a product' },
    ])
    expect(doc['x-opaque'].map((o: any) => o.path)).toEqual(['Line.qty', 'Line'])
  })

  test('a schema whose every rule has a keyword carries an empty root list and no model list', () => {
    const doc = exportOf(`
model Item {
  id   Int    @id
  name String @length(1, 80)
}`)
    expect(doc['x-opaque']).toEqual([])
    expect(doc.$defs.Item['x-opaque']).toBeUndefined()
  })

  test('the flat format lists the same rules', () => {
    const doc = exportOf(`
model Window {
  id Int @id
  a  Int
  b  Int
  @@check("a < b")
}`, { format: 'flat' })
    expect(doc['x-opaque']).toEqual([{ path: 'Window', rule: '@@check("a < b")', message: null }])
  })

  // Every word that refuses a value either changes the export or is listed:
  // a new validator that is neither is the silent drop this row was.
  const refusing = CATALOG.filter((r: any) =>
    (r.level === 'field' || r.level === 'model') &&
    (r.group === 'validate' || ['check', 'arc'].includes(r.word)))

  test.each(refusing.map((r: any) => [typed(r), r]))('%s is emitted as a keyword or listed', (_word, row: any) => {
    const probe   = probeFor(row)
    const without = probe.replace(new RegExp(`\\s${typed(row).replace(/\$/g, '\\$')}(\\([^)]*\\))?(?=\\s|$)`), '')
    expect(without).not.toBe(probe)
    const withRule = exportOf(probe)
    const bare     = exportOf(without)
    const listed   = withRule['x-opaque'].some((o: any) => o.rule.startsWith(`${typed(row)}(`) || o.rule === typed(row))
    const changed  = JSON.stringify(withRule.$defs[PROBE]) !== JSON.stringify(bare.$defs[PROBE])
    expect(listed || changed).toBe(true)
  })
})
