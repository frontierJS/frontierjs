// test/array-element-rules.test.ts
//
// A value rule on an array COLUMN grades each element, as it already did on an
// array inside a typed document. `@email` on `String[]` used to grade
// `String(list)`: one address passed and any two were refused (their joined
// text holds two @), so a list of good addresses could not be saved and a
// one-element list was the only one graded at all. The item-count rules stay
// about the list.

import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Alert {
  id     Int      @id @default(autoincrement())
  emails String[] @email @maxItems(3)
  codes  String[] @length(1, 4)
}`

const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e: any) { return e as { message: string; errors?: { path: unknown[]; message: string }[] } }
}

describe('a value rule on an array column', () => {
  test('grades each element: two good addresses are accepted', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.alert.create({ data: { emails: ['a@x.test', 'B@x.test'], codes: ['MOW', 'PLAN'] } })
    expect(row.emails).toEqual(['a@x.test', 'B@x.test'])
  })

  test('refuses the bad element, by its index', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const e = await refusal(() => db.alert.create({ data: { emails: ['a@x.test', 'not-an-address'], codes: [] } }))
    expect(e?.message).toContain('must be a valid email address')
    expect(e?.errors?.[0].path).toEqual(['emails', 1])
    const len = await refusal(() => db.alert.create({ data: { emails: [], codes: ['MOW', 'TOO LONG'] } }))
    expect(len?.errors?.[0].path).toEqual(['codes', 1])
  })

  test('the item-count rules stay about the list', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const e = await refusal(() => db.alert.create({ data: { emails: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'], codes: [] } }))
    expect(e?.message).toContain('at most 3')
    expect(await db.alert.count()).toBe(0)
  })

  test('an update is graded the same way', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const { id } = await db.alert.create({ data: { emails: ['a@x.test'], codes: [] } })
    expect(await refusal(() => db.alert.update({ where: { id }, data: { emails: ['a@x.test', 'b@x.test'] } }))).toBeNull()
    expect((await refusal(() => db.alert.update({ where: { id }, data: { emails: ['a@x.test', 'nope'] } })))?.errors?.[0].path).toEqual(['emails', 1])
  })
})

describe('the JSON Schema a realm grades by', () => {
  test('puts an element rule on items, and an item-count rule on the list', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js') as any
    const { parse } = await import('../src/core/parser.js') as any
    const js = generateJsonSchema(parse(SCHEMA).schema, { mode: 'create' }).$defs.Alert
    expect(js.properties.emails).toMatchObject({ type: 'array', maxItems: 3, items: { type: 'string', format: 'email' } })
    expect(js.properties.emails.format).toBeUndefined()
    expect(js.properties.codes).toMatchObject({ type: 'array', items: { type: 'string', minLength: 1, maxLength: 4 } })
    expect(js.properties.codes.minLength).toBeUndefined()
  })
})
