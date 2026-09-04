// test/clearing-required.test.ts
// Clearing a column that cannot be cleared (FJS-669).
//
// A partial write has two ways of saying nothing about a field and they mean
// opposite things: an ABSENT key means *leave it alone*, and an explicit `null`
// means *clear this* (Invariant 9). The required pre-flight is create-shaped,
// correctly — demanding every field on a patch would refuse every patch — so
// for a long time the one payload nobody could defend was the only one that
// reached SQLite, and came back as `NOT NULL constraint failed: item.name`: a
// bare Error, which junction answers 500 with a null body, where the same
// mistake on a create is a 400 naming the field.
//
// Every refusal here is PAIRED with the acceptance of a payload one character
// different. A guard that refused updates outright would satisfy any test that
// only checked the refusal (`FJS-351`).

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient, ValidationError } from '../src/index.js'

const SCHEMA = `
model Item {
  id        Int      @id @default(autoincrement())
  name      String   @label("Item name")
  code      String   @required("Give it a code")
  qty       Int      @default(1)
  tags      String[]
  touched   DateTime @updatedAt
  nickname  String?
}
`

let db: any
let row: any
beforeEach(async () => {
  db  = await createClient({ schema: SCHEMA, db: ':memory:' })
  row = await db.item.create({ data: { name: 'x', code: 'c' } })
})

const refusal = async (fn: () => unknown): Promise<any> => {
  try { await fn(); throw new Error('expected a refusal and the write succeeded') }
  catch (e) { return e }
}

describe('an explicit null on a column that is not optional', () => {
  test('is refused by name, where an optional column takes it', async () => {
    const err = await refusal(() => db.item.update({ where: { id: row.id }, data: { name: null } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.errors).toEqual([{ path: ['name'], message: 'Item name is required' }])

    // The pair. `null` is what an optional column is FOR, so the same payload
    // one field along has to go through.
    const after = await db.item.update({ where: { id: row.id }, data: { nickname: null } })
    expect(after.nickname).toBeNull()
  })

  test('names the field rather than a physical table', async () => {
    const err = await refusal(() => db.item.update({ where: { id: row.id }, data: { name: null } }))
    expect(String(err.message)).not.toContain('NOT NULL constraint failed')
    expect(String(err.message)).not.toContain('item.name')
    // `errors` is what puts the message under the box rather than in a banner.
    expect(err.errors[0].path).toEqual(['name'])
  })

  test('carries the field’s own wording, both spellings', async () => {
    const labelled = await refusal(() => db.item.update({ where: { id: row.id }, data: { name: null } }))
    expect(labelled.errors[0].message).toBe('Item name is required')   // @label
    const stated = await refusal(() => db.item.update({ where: { id: row.id }, data: { code: null } }))
    expect(stated.errors[0].message).toBe('Give it a code')            // @required("…")
  })

  // One owner for the sentence: the create-shaped pre-flight and this one ask
  // the same function, so the two cannot come to say different things about
  // one field.
  test('says exactly what the same mistake on a create says', async () => {
    const onCreate = await refusal(() => db.item.create({ data: { code: 'c' } }))
    const onUpdate = await refusal(() => db.item.update({ where: { id: row.id }, data: { name: null } }))
    expect(onUpdate.errors).toEqual(onCreate.errors)
  })
})

describe('what does NOT make a column clearable', () => {
  // A default fills an ABSENT key. This key is present, and `@default(1)` has
  // nothing to say about a caller who asked for null on purpose.
  test('a @default does not, and the absent key it is for still works', async () => {
    const err = await refusal(() => db.item.update({ where: { id: row.id }, data: { qty: null } }))
    expect(err.errors[0].path).toEqual(['qty'])

    const created = await db.item.create({ data: { name: 'y', code: 'd' } })
    expect(created.qty).toBe(1)
  })

  test('being an array does not, and the empty array it means still works', async () => {
    const err = await refusal(() => db.item.update({ where: { id: row.id }, data: { tags: null } }))
    expect(err.errors[0].path).toEqual(['tags'])

    const after = await db.item.update({ where: { id: row.id }, data: { tags: [] } })
    expect(after.tags).toEqual([])
  })

  test('being written by the engine does not', async () => {
    const err = await refusal(() => db.item.update({ where: { id: row.id }, data: { touched: null } }))
    expect(err.errors[0].path).toEqual(['touched'])
  })
})

describe('undefined is not null, and stays absent', () => {
  test('an undefined value leaves the column alone where null is refused', async () => {
    const after = await db.item.update({ where: { id: row.id }, data: { name: undefined, qty: 7 } })
    expect(after.name).toBe('x')
    expect(after.qty).toBe(7)

    // The pair, on the same field, one value different.
    const err = await refusal(() => db.item.update({ where: { id: row.id }, data: { name: null } }))
    expect(err).toBeInstanceOf(ValidationError)
  })

  test('and a patch naming nothing about it is untouched', async () => {
    const after = await db.item.update({ where: { id: row.id }, data: { qty: 3 } })
    expect(after.name).toBe('x')
  })
})

describe('every write verb that takes a payload', () => {
  test('updateMany refuses it, and moves rows when the value is real', async () => {
    const err = await refusal(() => db.item.updateMany({ where: {}, data: { name: null } }))
    expect(err.errors[0].path).toEqual(['name'])

    const { count } = await db.item.updateMany({ where: {}, data: { name: 'z' } })
    expect(count).toBe(1)
  })

  test('upsert refuses it in the update half, and its create half still lands', async () => {
    const err = await refusal(() => db.item.upsert({
      where: { id: row.id }, create: { name: 'a', code: 'e' }, update: { name: null },
    }))
    expect(err.errors[0].path).toEqual(['name'])

    const made = await db.item.upsert({
      where: { id: 999 }, create: { id: 999, name: 'a', code: 'e' }, update: { name: 'b' },
    })
    expect(made.name).toBe('a')
  })

  // The row is unreachable through a NOT NULL column whoever asks: the column
  // is the database's rule, so this is not one of the rules `asSystem()` drops.
  // Refusing it here is what turns a 500 into a sentence naming the field.
  test('asSystem() is refused too, and its ordinary write goes through', async () => {
    const sys = db.asSystem()
    const err = await refusal(() => sys.item.update({ where: { id: row.id }, data: { name: null } }))
    expect(err).toBeInstanceOf(ValidationError)

    const after = await sys.item.update({ where: { id: row.id }, data: { name: 'q' } })
    expect(after.name).toBe('q')
  })
})
