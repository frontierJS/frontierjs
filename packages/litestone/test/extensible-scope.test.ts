// test/extensible-scope.test.ts
//
// `@@extensible(column, declaredBy: Model, scope: field)` (FJS-D592, FJS-1758)
// — declarations keyed per PARENT ROW, the way FJS-D365 keys a machine's moves.
// A Notion database, an Airtable table and a form builder's questions each own
// their columns, and a per-tenant key namespace refused 277 of 290 of them.
//
// Every refusal is paired with the schema one word away that must still parse.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse }        from '../src/core/parser.js'

const DECL = `
  enum PropKind { text number }
  model Property {
    id         Int      @id
    databaseId Int
    model      String   @default("Page")
    key        String
    type       PropKind
    slot       String?
    @@unique([databaseId, key])
    @@unique([databaseId, slot], nullsDistinct: true)
  }`

const PAGE = `
  model Page {
    id         Int  @id
    databaseId Int
    props      Json @default("{}")
    @@extensible(props, declaredBy: Property, scope: databaseId, max: { text: 4, number: 2 })
  }`

const SCHEMA = `${DECL}\n${PAGE}\n  database main { path ":memory:" }`

const seeded = async () => {
  const c = await createClient({ schema: SCHEMA, db: ':memory:' })
  const sys = c.asSystem()
  await sys.property.createMany({ data: [
    { databaseId: 1, key: 'status',   type: 'text' },
    { databaseId: 1, key: 'estimate', type: 'number' },
    { databaseId: 2, key: 'status',   type: 'number' },
  ] })
  return { c, sys }
}

describe('the declaration', () => {
  const ok = (src: string) => parse(`${DECL}\n${src}`)
  const refuses = (src: string, match: RegExp) => {
    const r = ok(src)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' · ')).toMatch(match)
  }

  test('a declarer unique on [scope, key] parses', () => {
    expect(ok(PAGE).valid).toBe(true)
  })

  test('the scope has to be a field of the extended model and of the declarer', () => {
    refuses(PAGE.replace('scope: databaseId', 'scope: nope'), /no field 'nope'/)
    refuses(`${PAGE}\n model Other { id Int @id  tag Int  props Json  @@extensible(props, declaredBy: Property, scope: tag) }`,
            /'Property' has no 'tag' column/)
  })

  test('a declarer that does not key on the scope is refused', () => {
    const r = parse(`${DECL.replace('@@unique([databaseId, key])', '@@unique([model, key])')}\n${PAGE}`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' · ')).toMatch(/does not declare @@unique\(\[databaseId, key\]\)/)
  })
})

describe('declarations per parent row', () => {
  test('two scopes declare one key in two kinds, and neither is a 409', async () => {
    const { sys } = await seeded()
    const rows = await sys.property.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => [r.databaseId, r.key, r.type, r.slot]))
      .toEqual([[1, 'status', 'text', 't1'], [1, 'estimate', 'number', 'n1'], [2, 'status', 'number', 'n1']])
  })

  test('a filter on a key reads ITS scope’s declarations and answers its scope’s rows', async () => {
    const { sys } = await seeded()
    await sys.page.create({ data: { databaseId: 1, props: { status: 'doing', estimate: 3 } } })
    await sys.page.create({ data: { databaseId: 2, props: { status: 2 } } })
    const one = await sys.page.findMany({ where: { databaseId: 1, props: { status: 'doing' } } })
    expect(one.map((r: any) => r.databaseId)).toEqual([1])
    const two = await sys.page.findMany({ where: { databaseId: 2, props: { status: 2 } } })
    expect(two.map((r: any) => r.databaseId)).toEqual([2])
    // Database 1's "status" is text in t1; database 2 keeps n1 for its own status,
    // so database 1's rows hold nothing in n1 that database 2's filter could match.
    expect(await sys.page.count({ where: { databaseId: 2, props: { status: 3 } } })).toBe(0)
  })

  test('a where that pins no scope is refused, not read across every scope', async () => {
    const { sys } = await seeded()
    await expect(sys.page.findMany({ where: { props: { status: 'doing' } } })).rejects.toThrow(/databaseId/)
  })

  test('a key another scope declared is not declared here', async () => {
    const { sys } = await seeded()
    await expect(sys.page.findMany({ where: { databaseId: 2, props: { estimate: 1 } } }))
      .rejects.toThrow(/not a field this Page declares/)
  })

  test('the pool is per scope row — a third declaration takes its own scope’s next slot', async () => {
    const { sys } = await seeded()
    const p = await sys.property.create({ data: { databaseId: 2, key: 'due', type: 'text' } })
    expect(p.slot).toBe('t1')
  })

  test('a row MOVED to another scope is re-mirrored against that scope’s declarations', async () => {
    const { sys } = await seeded()
    const page = await sys.page.create({ data: { databaseId: 1, props: { status: 'doing' } } })
    await sys.page.update({ where: { id: page.id }, data: { databaseId: 2, props: { status: 7 } } })
    expect(await sys.page.count({ where: { databaseId: 2, props: { status: 7 } } })).toBe(1)
    expect(await sys.page.count({ where: { databaseId: 1, props: { status: 'doing' } } })).toBe(0)
  })

  test('an edit by id reads the scope off the row', async () => {
    const { sys } = await seeded()
    const page = await sys.page.create({ data: { databaseId: 2, props: { status: 1 } } })
    await sys.page.update({ where: { id: page.id }, data: { props: { status: 9 } } })
    expect(await sys.page.count({ where: { databaseId: 2, props: { status: 9 } } })).toBe(1)
  })

  test('a move without the blob is refused, and a bulk write across scopes is too', async () => {
    const { sys } = await seeded()
    const page = await sys.page.create({ data: { databaseId: 1, props: { status: 'a' } } })
    await sys.page.create({ data: { databaseId: 2, props: { status: 1 } } })
    await expect(sys.page.update({ where: { id: page.id }, data: { databaseId: 2 } })).rejects.toThrow(/send 'props'/)
    await expect(sys.page.updateMany({ where: {}, data: { props: { status: 3 } } })).rejects.toThrow(/more than one 'databaseId'/)
  })

  test('$declaredFields narrows to one scope', async () => {
    const { c } = await seeded()
    const d = await c.asSystem().page.$declaredFields({ where: { databaseId: 1 } })
    expect(d.map((r: any) => r.key).sort()).toEqual(['estimate', 'status'])
  })
})
