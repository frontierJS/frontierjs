// test/boolean-filter.test.ts — a Boolean column filtered by text.
//
// SQLite stores a Boolean as INTEGER 0/1, a JS `true` binds as 1, and the
// string `'true'` binds as the text and matches no row — an empty list with a
// 200, which is the worst of the three possible answers. It surfaced from the
// wire (`FJS-450`): a query string carries text, so `?live=true` reached the
// Data boundary as `'true'` and every screen filtering on a flag came back
// empty. `@frontierjs/toolbelt/query` fixes the transports; this fixes the
// boundary, because an internal call or a hand-built where can carry the same
// text and nothing else would say so.
//
// Only the two spellings are converted. Everything else is left to SQLite's
// column affinity, which converts numeric text before comparing — which is why
// `?qty=5` on an Int column has always worked and `?live=true` never did.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Item {
    id     Int     @id
    name   String
    live   Boolean @default(true)
    label  String
  }
`

let db: any

beforeEach(async () => {
  db = (await createClient({ db: ':memory:', schema: SCHEMA })).asSystem()
  await db.item.create({ data: { id: 1, name: 'on',  live: true,  label: 'true'  } })
  await db.item.create({ data: { id: 2, name: 'off', live: false, label: 'false' } })
})

const count = async (where: unknown) => (await db.item.findMany({ where })).length

describe('a Boolean column filtered by text', () => {

  test('the boolean itself still works', async () => {
    expect(await count({ live: true })).toBe(1)
    expect(await count({ live: false })).toBe(1)
  })

  test("'true' and 'false' mean what they say", async () => {
    expect(await count({ live: 'true'  })).toBe(1)
    expect(await count({ live: 'false' })).toBe(1)
  })

  test('the two agree, which is the whole property', async () => {
    expect(await count({ live: 'true'  })).toBe(await count({ live: true  }))
    expect(await count({ live: 'false' })).toBe(await count({ live: false }))
  })

  test('it applies through an operator, not just equality', async () => {
    expect(await count({ live: { not: 'true' } })).toBe(1)
    expect(await count({ live: { in: ['true', 'false'] } })).toBe(2)
  })

  test('a String column holding "true" is untouched', async () => {
    // The conversion is keyed on the COLUMN, so text that happens to spell a
    // boolean is still text where the column is one.
    expect(await count({ label: 'true'  })).toBe(1)
    expect(await count({ label: 'false' })).toBe(1)
  })

  test('any other string is left to SQLite, which is where the rest already worked', async () => {
    // The column has INTEGER affinity, so SQLite converts numeric text before
    // comparing — `'1'` has always matched, and that is why `?qty=5` on an Int
    // column worked while `?live=true` did not. `'true'` is the gap because it
    // is the one spelling affinity cannot convert.
    expect(await count({ live: '1' })).toBe(1)
    expect(await count({ live: '0' })).toBe(1)
    expect(await count({ live: 'yes' })).toBe(0)
  })

  test('null still asks for null', async () => {
    expect(await count({ live: null })).toBe(0)
  })
})

// The write side of the same column (`FJS-2031`). It was coerced by
// truthiness, so `'false'` — a non-empty string — was stored as 1 and read back
// `true`, where `loadRows` reading the same cell stored 0. A write now takes
// the spellings the filter and `loadRows` take and refuses the rest.
describe('a Boolean column written as text', () => {

  const live = async (v: unknown) => (await db.item.create({ data: { id: 9, name: 'x', live: v, label: '' } })).live

  test("'false' and '0' store false, 'true' and '1' store true", async () => {
    expect(await live('false')).toBe(false)
    await db.item.delete({ where: { id: 9 } })
    expect(await live('0')).toBe(false)
    await db.item.delete({ where: { id: 9 } })
    expect(await live('TRUE')).toBe(true)
    await db.item.delete({ where: { id: 9 } })
    expect(await live('1')).toBe(true)
  })

  test('an update parses the same way', async () => {
    expect((await db.item.update({ where: { id: 1 }, data: { live: 'false' } })).live).toBe(false)
    expect((await db.item.update({ where: { id: 2 }, data: { live: '1' } })).live).toBe(true)
  })

  test('the number a stored row holds still writes', async () => {
    expect(await live(0)).toBe(false)
    await db.item.delete({ where: { id: 9 } })
    expect(await live(1)).toBe(true)
  })

  test('anything else is refused, never stored by truthiness', async () => {
    for (const v of ['no', 'off', 'yes', '', 2, {}]) {
      await expect(live(v)).rejects.toMatchObject({ name: 'ValidationError', errors: [{ path: ['live'] }] })
    }
    expect(await count({})).toBe(2)
  })
})
