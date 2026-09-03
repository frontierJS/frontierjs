/**
 * test/immutable.test.ts — `@immutable` (`FJS-D162`).
 *
 * A column written once, at create, and never again by anybody. Two things
 * separate it from every other protection in this package and both are asserted
 * below, because a test that only checks the happy refusal would pass against a
 * rule with either of them missing:
 *
 *   1. It refuses the KEY, not the value — the same number sent back is still
 *      refused. Nothing here can see the stored row beside the incoming one, so
 *      a rule that compared would be a rule that could not be written.
 *   2. `asSystem()` does not drop it. The gate, the row policies and `@guarded`
 *      all fall away there; a renewal job runs as system, so a rule it can drop
 *      is absent from the caller that actually writes invoices.
 */

import { describe, test, expect } from 'bun:test'
import { parse, createClient, generateJsonSchema } from '../src/index.js'

const DOC = `
database main { path ":memory:" }
model Doc {
  id     Int    @id @default(autoincrement())
  number String @immutable
  total  Int    @immutable
  status String @default("draft")
}
`
const client = () => createClient({ schema: DOC, resolveFrom: import.meta.dir })
const errsOf = (src: string) => parse(src).errors.join(' · ')

describe('what parses', () => {
  test('it takes no arguments, and the refusal points at the row-level shape', () => {
    expect(parse(`model D { id Int @id  n String @immutable }`).valid).toBe(true)
    expect(errsOf(`model D { id Int @id  n String @immutable(all) }`)).toMatch(/takes no arguments/)
  })

  test('it is refused on the columns the ENGINE writes on every update', () => {
    expect(errsOf(`model D { id Int @id  v Int @version @immutable }`)).toMatch(/@version/)
    expect(errsOf(`model D { id Int @id  u DateTime @updatedAt @immutable }`)).toMatch(/@updatedAt/)
  })

  test('it is refused where there is no column to freeze', () => {
    expect(errsOf(`model D { id Int @id  c String @computed @immutable }`)).toMatch(/nothing to freeze/)
    expect(errsOf(`model D { id Int @id  t String @transient @immutable }`)).toMatch(/nothing to freeze/)
  })
})

describe('the write half', () => {
  test('create writes it, and the row keeps the value', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-1', total: 1000 } })
    expect(row.number).toBe('INV-1')
    expect(row.total).toBe(1000)
  })

  test('a column the freeze does not name still moves', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-2', total: 1000 } })
    await db.doc.update({ where: { id: row.id }, data: { status: 'issued' } })
    expect((await db.doc.findFirst({ where: { id: row.id } })).status).toBe('issued')
  })

  test('an update naming it is refused, and the refusal names the column', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-3', total: 1000 } })
    await expect(db.doc.update({ where: { id: row.id }, data: { total: 5 } }))
      .rejects.toThrow(/total is @immutable/)
    expect((await db.doc.findFirst({ where: { id: row.id } })).total).toBe(1000)
  })

  test('THE SAME VALUE is refused too — it grades the key, not the value', async () => {
    // The negative control for the whole design. A rule that compared would let
    // this through, and a form round-tripping a frozen column would then be
    // fine right up until somebody changed the box.
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-4', total: 1000 } })
    await expect(db.doc.update({ where: { id: row.id }, data: { total: 1000 } }))
      .rejects.toThrow(/total is @immutable/)
  })

  test('asSystem() does not drop it', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-5', total: 1000 } })
    await expect(db.asSystem().doc.update({ where: { id: row.id }, data: { total: 5 } }))
      .rejects.toThrow(/total is @immutable/)
    expect((await db.asSystem().doc.findFirst({ where: { id: row.id } })).total).toBe(1000)
  })

  test('updateMany and upsert refuse it on the same terms', async () => {
    const db = await client()
    await db.doc.create({ data: { number: 'INV-6', total: 1000 } })
    await expect(db.doc.updateMany({ where: {}, data: { number: 'X' } }))
      .rejects.toThrow(/number is @immutable/)
    // The insert branch of an upsert is a create and writes it; the update
    // branch is an update and does not.
    await expect(db.doc.upsert({
      where:  { number: 'INV-6' },
      create: { number: 'INV-6', total: 1 },
      update: { total: 7 },
    })).rejects.toThrow(/total is @immutable/)
  })

  test('a bulk create writes it, which is the path `creating` had to be threaded through', async () => {
    const db = await client()
    const r  = await db.doc.createMany({ data: [
      { number: 'INV-7', total: 1 },
      { number: 'INV-8', total: 2 },
    ] })
    expect(r.count).toBe(2)
  })
})

describe('what the client is told', () => {
  test('readOnly in the update schema and writable in create — the one kind that differs by mode', async () => {
    const parsed = parse(DOC)
    const create = generateJsonSchema(parsed.schema ?? parsed, { mode: 'create' })
    const update = generateJsonSchema(parsed.schema ?? parsed, { mode: 'update' })

    expect(create.$defs.Doc.properties.total.readOnly).toBeUndefined()
    expect(update.$defs.Doc.properties.total.readOnly).toBe(true)
    expect(update.$defs.Doc.properties.total['x-litestone-kind']).toBe('immutable')
    // A create form must still offer the box, or the model is uncreatable
    // through anything generated.
    expect(create.$defs.Doc.properties.number.readOnly).toBeUndefined()
  })
})
