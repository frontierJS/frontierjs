// queryability.test.ts — what the schema tells the browser it may sort and filter by.
//
// `$checkOrderBy` and `$checkWhere` are the runtime half: they refuse a bad key
// at the Data boundary. Nothing answered the question in the other direction —
// *given this model, which keys MAY I send* — so a generated table would render
// a sortable header for a column whose sort throws, and a hand-written one gets
// it right only by its author knowing (`FJS-553`, `FJS-554`).
//
// The emitter and the refusal read the SAME two functions, which is the point of
// the pairing below: every assertion about an emitted key is made beside the
// runtime answer for the same column, so the two cannot drift into disagreeing.
// A copy of the classification in `jsonschema.js` would satisfy every assertion
// here except those.
//
// ONLY EXCEPTIONS ARE EMITTED — absent means yes, a string says why not. So each
// refusal is paired with an ordinary column that must stay silent, or a build
// that stamped every field would pass every "why not" row.

import { test, expect, describe } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'
import { generateJsonSchema } from '../src/jsonschema.js'

const SRC = `
database main { path ":memory:" }

model Doc {
  id        String   @id @default(cuid())
  title     String
  tags      String[]
  meta      Json?
  secretly  String?  @encrypted
  lookup    String?  @encrypted(deterministic: true)
  digest    String?  @hashed
  words     Int      @computed
  ssn       String?  @guarded
  createdAt DateTime @default(now())
}
`

function props(mode: 'full' | 'create' = 'full') {
  const r = parse(SRC)
  expect(r.valid).toBe(true)
  return generateJsonSchema(r.schema!, { mode })!.$defs!.Doc.properties as Record<string, any>
}

describe('x-sortable / x-filterable', () => {

  test('an ordinary column carries neither key', () => {
    const p = props()
    for (const name of ['id', 'title']) {
      expect(p[name]).not.toHaveProperty('x-sortable')
      expect(p[name]).not.toHaveProperty('x-filterable')
    }
  })

  test('a column whose stored text is a serialization says so, and still filters', () => {
    const p = props()
    expect(p.tags['x-sortable']).toBe('array')
    expect(p.meta['x-sortable']).toBe('json')
    // The pair. An array IS filterable — `has` compiles to json_each — so
    // stamping both keys off one "is it opaque" test would be wrong here.
    expect(p.tags).not.toHaveProperty('x-filterable')
    expect(p.meta).not.toHaveProperty('x-filterable')
  })

  test('encryption splits on whether the encoding is stable', () => {
    const p = props()
    // Random IV: no plaintext can match, and ciphertext sorts meaninglessly.
    expect(p.secretly['x-sortable']).toBe('encrypted')
    expect(p.secretly['x-filterable']).toBe('encrypted')
    // Deterministic and @hashed are both matchable, so both stay filterable —
    // and both are still UNSORTABLE, which is the half that is easy to lose:
    // a derived IV is stable, so equality works, and the order it gives is
    // still the order of ciphertext. Two axes, one column, opposite answers.
    expect(p.lookup).not.toHaveProperty('x-filterable')
    expect(p.lookup['x-sortable']).toBe('encrypted')
    expect(p.digest).not.toHaveProperty('x-filterable')
    expect(p.digest['x-sortable']).toBe('hashed')
  })

  test('a @computed field is neither, and it is emitted from a branch that continues', () => {
    // The case FJS-553 names. It is emitted by the virtual-field branch, which
    // returns early — a per-field call inside the loop reaches it never.
    const p = props()
    expect(p.words['x-sortable']).toBe('computed')
    expect(p.words['x-filterable']).toBe('computed')
  })

  test('a @guarded column is in neither the schema nor the answer', () => {
    // FJS-D205 excludes it from the client audience entirely, so there is no
    // property to carry a key. Asserted because the alternative — a property
    // marked unsortable — would disclose the name this ruling hides.
    expect(props()).not.toHaveProperty('ssn')
    expect(props('create')).not.toHaveProperty('ssn')
  })

  test('the emitted answer IS the answer the boundary refuses with', async () => {
    // The whole reason the classifiers moved into core/query.js. A second copy
    // in jsonschema.js would pass every test above and fail these two.
    const db  = await createClient({ schema: SRC, resolveFrom: import.meta.dir, encryptionKey: 'a'.repeat(64) })
    const p   = props()
    const sys = db.asSystem()

    for (const name of ['tags', 'meta', 'secretly', 'lookup', 'digest', 'words']) {
      const refused = sys.$checkOrderBy('doc', { [name]: 'asc' })
      expect(refused.length, `${name} must be refused an orderBy`).toBeGreaterThan(0)
      expect(p[name], `${name} must be marked unsortable`).toHaveProperty('x-sortable')
    }
    // And the pair, in both directions at once: a column the schema stays
    // silent about is one the boundary accepts.
    for (const name of ['id', 'title', 'createdAt']) {
      expect(sys.$checkOrderBy('doc', { [name]: 'asc' }), name).toEqual([])
      expect(p[name], name).not.toHaveProperty('x-sortable')
    }
    db.$close()
  })
})
