// Who fills a column the create omitted (FJS-1296).
//
// The create-mode JSON Schema's `required` list and `client.js`'s required
// pre-flight each kept a list of the attributes that exempt a column, and the
// schema's was shorter. `@sequence` was on one and not the other, so the
// browser — which validates against the schema — refused every create of a
// model that numbers its rows, before any request, for a value only the server
// can assign. `isServerFilled` in core/ids.js is now the one list.
//
// Each case is asserted three ways: the create schema leaves it out of
// `required`, a create that omits it succeeds against a real client, and the
// column is still OFFERED, because a caller may state one.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'
import { generateJsonSchema } from '../src/jsonschema.js'

const createDef = (src: string, model = 'M') =>
  generateJsonSchema(parse(src).schema, { mode: 'create' }).$defs[model]

const CASES: [string, string, string][] = [
  ['`@sequence(scope:)`',       `model M { id Int @id  teamId Int  number Int @sequence(scope: teamId)  x String }`, 'number'],
  ['`@updatedAt` on any name',  `model M { id Int @id  touched DateTime @updatedAt  x String }`,                     'touched'],
  ['a literal `@default`',      `model M { id Int @id  qty Int @default(1)  x String }`,                             'qty'],
]

describe('a column the Data boundary fills is not required of the caller', () => {
  for (const [label, src, col] of CASES) {
    it(`${label}: absent from required, still offered, and a create omitting it succeeds`, async () => {
      const def = createDef(src)
      expect(def.required).not.toContain(col)
      expect(def.required).toContain('x')
      expect(Object.keys(def.properties)).toContain(col)

      const db = await createClient({ schema: src, db: ':memory:' })
      try {
        const data: Record<string, unknown> = { x: 'a' }
        if ('teamId' in def.properties) data.teamId = 7
        const row = await db.m.create({ data })
        expect(row[col]).not.toBeNull()
      } finally { await db.$close() }
    })
  }

  it('a stated sequence value is honored, so the column stays writable', async () => {
    const src = CASES[0][1]
    expect(createDef(src).properties.number.readOnly).toBeUndefined()
    const db = await createClient({ schema: src, db: ':memory:' })
    try {
      const first  = await db.m.create({ data: { teamId: 1, x: 'a' } })
      const stated = await db.m.create({ data: { teamId: 1, x: 'b', number: 40 } })
      const next   = await db.m.create({ data: { teamId: 1, x: 'c' } })
      expect(first.number).toBe(1)
      expect(stated.number).toBe(40)
      expect(next.number).toBe(41)
    } finally { await db.$close() }
  })
})
