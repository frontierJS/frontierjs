// json-string-roundtrip.test.ts — a Json column stores what it was given, as JSON.
//
// A JS string was written verbatim, so '42' read back as 42, 'null' as null and
// '{"a":1}' as an object; the column's type depended on what the text looked
// like (`FJS-2038`).

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Doc { id Int @id  body Json?  @@allow(all, true) }
`

describe('a Json column round-trips a string as a string', () => {
  for (const value of ['42', 'null', '{"a":1}', 'true', 'plain text', '']) {
    test(`${JSON.stringify(value)}`, async () => {
      const db: any = await createClient({ schema: SCHEMA, databases: ':memory:' })
      const sys = db.asSystem()
      await sys.doc.create({ data: { id: 1, body: value } })
      expect((await sys.doc.findUnique({ where: { id: 1 } })).body).toBe(value)
      await sys.doc.update({ where: { id: 1 }, data: { body: 'x' } })
      await sys.doc.update({ where: { id: 1 }, data: { body: value } })
      expect((await sys.doc.findMany())[0].body).toBe(value)
    })
  }

  test('objects, numbers and null still round-trip', async () => {
    const db: any = await createClient({ schema: SCHEMA, databases: ':memory:' })
    const sys = db.asSystem()
    for (const [id, v] of [[1, { a: 1 }], [2, 42], [3, [1, 'b']], [4, null]] as const) {
      await sys.doc.create({ data: { id, body: v } })
      expect((await sys.doc.findUnique({ where: { id } })).body).toEqual(v)
    }
  })
})
