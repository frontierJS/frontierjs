// A field `@allow('write', auth().isStaff)` crosses to the client as the claims
// the caller must hold, beside the bit (`FJS-1671`, `FJS-D578`).
//
// The subset is `auth().<claim>` truthiness, `auth().<claim> == <literal>` and
// `&&`. Anything else — a row column, `||`, `!=`, a second allow — stays the bare
// bit, because the browser has no reader for the policy language and an unknown
// answer is permissive. Every case is PAIRED with one that must not carry.

import { describe, it, expect } from 'bun:test'
import { generateJsonSchema } from '../src/jsonschema.js'
import { parse } from '../src/core/parser.js'

const SRC = `
model Thing {
  id       Int     @id
  ownerId  Int
  staff    String  @allow('write', auth().isStaff)
  litTrue  String  @allow('write', auth().isStaff == true)
  staffRo  String? @allow('all',   auth().isStaff)
  staffReq String  @allow('all',   auth().isStaff)
  kind     String  @allow('write', auth().role == 'admin' && auth().isStaff)
  flipped  String  @allow('write', 'admin' == auth().role)
  mine     String  @allow('write', ownerId == auth().id)
  mixed    String  @allow('write', auth().isStaff && ownerId == auth().id)
  either   String  @allow('write', auth().isStaff || auth().isAdmin)
  notEq    String  @allow('write', auth().role != 'guest')
  signedIn String  @allow('write', auth() != null)
  twice    String  @allow('write', auth().isStaff) @allow('write', auth().isAdmin)
  plain    String
}
`

function props(mode: string, audience = 'client') {
  const parsed: any = parse(SRC)
  const js: any = generateJsonSchema(parsed.schema ?? parsed, { audience, mode })
  return js.$defs.Thing.properties
}

const claims = (p: any, k: string) => p[k]?.['x-litestone-write-claims']
const bit    = (p: any, k: string) => !!p[k]?.['x-litestone-write-policy']

describe('x-litestone-write-claims', () => {
  for (const mode of ['create', 'update']) {
    it(`${mode}: carries a caller-only predicate beside the bit`, () => {
      const p = props(mode)
      expect(bit(p, 'staff')).toBe(true)
      expect(claims(p, 'staff')).toEqual({ isStaff: true })
      expect(claims(p, 'litTrue')).toEqual({ isStaff: true })
      expect(claims(p, 'kind')).toEqual({ role: 'admin', isStaff: true })
      expect(claims(p, 'flipped')).toEqual({ role: 'admin' })
    })
  }

  it('hoists past the nullable wrapper the read half builds', () => {
    const p = props('update')
    expect(p.staffReq.anyOf).toBeDefined()
    expect(claims(p, 'staffReq')).toEqual({ isStaff: true })
    expect(claims(p, 'staffRo')).toEqual({ isStaff: true })
  })

  it('leaves a predicate that reads the row, or is not in the subset, as the bare bit', () => {
    const p = props('update')
    for (const k of ['mine', 'mixed', 'either', 'notEq', 'signedIn', 'twice']) {
      expect(bit(p, k)).toBe(true)
      expect(claims(p, k)).toBeUndefined()
    }
    expect(claims(p, 'plain')).toBeUndefined()
  })

  it('says nothing to a system audience', () => {
    const p = props('update', 'system')
    expect(claims(p, 'staff')).toBeUndefined()
  })
})
