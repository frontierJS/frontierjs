// gate-syntax.test.ts — one spelling for a gate (`FJS-D239`).
//
// `FJS-D43` made `@@gate(read: READER, write: USER)` canonical and kept the
// digit string as shorthand. Measured five weeks later: five named declarations
// against 320 digit ones, and all five of the named were in this package's own
// example. `FJS-D239` reverses it and deletes the named form.
//
// This file exists because the deleted branch never had one. The grammar
// carried a form nothing executed for five weeks, which is how it came to be
// canonical in the docs and absent from every app — so the refusal that
// replaced it gets the coverage the form itself never had, or the trade is one
// untested branch for another.
//
// **The refusal is asserted to NAME the digit string**, not merely to throw.
// § IV asks that muscle memory fail loudly and helpfully; a schema written last
// month should get the translation in place rather than a grammar error
// pointing at a colon. A test that only asserted `.valid === false` would pass
// against a bare `Expected STRING, got IDENT`.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'

const model = (gate: string) => `model M {\n  id Int @id\n  ${gate}\n}`
const gateOf = (src: string) => {
  const r = parse(src)
  return r.schema.models[0].attributes.find((a: any) => a.kind === 'gate')?.value
}
// `parse` reports errors as STRINGS, not objects — reading `.message` here
// yields undefined and every assertion below compares against ''.
const refusal = (src: string) => {
  const r = parse(src)
  return r.valid ? null : String(r.errors[0] ?? '')
}

describe('@@gate is written as digits', () => {
  it('four positions are read.create.update.delete', () => {
    expect(gateOf(model('@@gate("2.4.4.6")'))).toBe('2.4.4.6')
  })

  // The parser stores the string AS WRITTEN — the cascade of a missing position
  // is applied by whoever reads the gate, not here. Worth pinning, because the
  // refusal below builds a four-position string and it would be easy to read
  // that as the parser normalizing one.
  it('the string is stored verbatim; the cascade is the reader\'s', () => {
    expect(gateOf(model('@@gate("4")'))).toBe('4')
    expect(gateOf(model('@@gate("2.4")'))).toBe('2.4')
    expect(gateOf(model('@@gate("2.4.4.6")'))).toBe('2.4.4.6')
  })

  it('the sentinels are ordinary positions', () => {
    expect(gateOf(model('@@gate("1.8.8.9")'))).toBe('1.8.8.9')
  })
})

describe('@@gate refuses the named form and names the digits', () => {
  // Each row is the exact declaration that was in this package's example
  // schema, paired with what it was converted to — so the refusal is graded
  // against the conversion that actually happened rather than a fresh
  // computation of it.
  const CONVERTED: Array<[string, string]> = [
    ['read: READER, write: ADMINISTRATOR, delete: OWNER',          '2.5.5.6'],
    ['read: READER, write: USER, delete: OWNER',                   '2.4.4.6'],
    ['read: VISITOR, write: USER, delete: OWNER',                  '1.4.4.6'],
    ['read: CREATOR, create: CREATOR, update: USER, delete: OWNER', '3.3.4.6'],
    ['read: READER, write: USER, delete: ADMINISTRATOR',           '2.4.4.5'],
  ]

  for (const [named, digits] of CONVERTED) {
    it(`@@gate(${named}) is refused, naming "${digits}"`, () => {
      const msg = refusal(model(`@@gate(${named})`))
      expect(msg).toBeTruthy()
      expect(msg).toContain(`@@gate("${digits}")`)
    })
  }

  it('write: expands to create, update and delete when computing the answer', () => {
    // The expansion is kept ONLY to build the suggestion. If it is ever dropped
    // the refusal still fires and this row is what notices it went generic.
    expect(refusal(model('@@gate(write: USER)'))).toContain('@@gate("0.4.4.4")')
  })

  it('an unknown level is still named as a level, not as syntax', () => {
    expect(refusal(model('@@gate(read: SUPERUSER)'))).toContain('unknown level')
  })

  it('an unknown key is still named as a key', () => {
    // `all:` among them — `fli check`'s second parser of this grammar had
    // invented it, and the language never had it.
    expect(refusal(model('@@gate(all: READER)'))).toContain('unknown key')
  })
})
