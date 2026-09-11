/**
 * tests/declined-write.test.js — a write the boundary kept, said out loud.
 *
 * A field `@allow('write', …)` is a predicate over the caller AND the row, so
 * the Data boundary answers it by keeping the stored value: the write succeeds,
 * every other column lands, and nothing throws. That is deliberate (`FJS-D129`)
 * — the same payload is legitimate for somebody else, so a refusal by name
 * would be wrong.
 *
 * What was wrong is that the column reached the browser indistinguishable from
 * an unpoliced one, so a generated form offered a box, a person typed in it and
 * the save button went green over a write that never happened (`FJS-1071`).
 *
 * The chain is litestone → the rule → this function, and the assertions here
 * are the last two links: the flag is CARRIED onto the rule (a keyword the
 * generator emits and `_CARRIED` drops is a flag nobody downstream can see),
 * and the comparison names the right column.
 *
 * **Every decline is PAIRED with a column that must not be reported** — an
 * unpoliced column that also changed, and a policed one that came back as sent.
 * A comparison that reported everything satisfies any test asking only about
 * the decline.
 */

import { describe, test, expect } from 'vitest'
import { buildFieldRules, declinedFields } from '../src/junction/field-rules.js'

// The shape litestone emits: `x-litestone-write-policy` on the policed column
// and nothing on the others. Written as a model definition rather than as a
// rules literal, so `_CARRIED` is on the path — which is the half that was
// missing and the half a literal cannot see.
const MODEL = {
  type: 'object',
  properties: {
    id:       { type: 'integer' },
    name:     { type: 'string' },
    isStaff:  { type: 'boolean', 'x-litestone-write-policy': true },
    role:     { type: 'string', title: 'Role', 'x-litestone-write-policy': true },
    notes:    { type: ['string', 'null'] },
    meta:     { type: 'object', 'x-litestone-write-policy': true },
  },
}

const fields = buildFieldRules(MODEL)

describe('the flag reaches the rule', () => {
  test('carried onto the policed column and absent from the plain one', () => {
    expect(fields.isStaff['x-litestone-write-policy']).toBe(true)
    expect(fields.role['x-litestone-write-policy']).toBe(true)
    expect(fields.name['x-litestone-write-policy']).toBeUndefined()
  })
})

describe('declinedFields', () => {

  test('names a policed column the boundary kept', () => {
    const out = declinedFields(fields, { isStaff: true }, { isStaff: false })
    expect(Object.keys(out)).toEqual(['isStaff'])
    expect(out.isStaff).toContain('permission')
  })

  test('uses the column\'s own label where it has one', () => {
    const out = declinedFields(fields, { role: 'admin' }, { role: 'user' })
    expect(out.role).toMatch(/^Role /)
  })

  // The control. An unpoliced column that changed between send and answer is a
  // server-side transform, a stamp, or a recomputation — never a decline.
  test('says nothing about an unpoliced column that moved', () => {
    const out = declinedFields(fields, { name: 'ada', isStaff: true }, { name: 'ADA', isStaff: true })
    expect(out).toEqual({})
  })

  // The other control. A policed column that came back as sent is the caller
  // the predicate ADMITS, which is most of them.
  test('says nothing when the policed write landed', () => {
    const out = declinedFields(fields, { isStaff: true }, { isStaff: true })
    expect(out).toEqual({})
  })

  // A column ABSENT from the answer is `@allow('read', …)` on the same column
  // or a narrow select. Neither says anything about the write, and reporting it
  // would make every read-policied column report on every save.
  test('says nothing about a column the answer does not carry', () => {
    const out = declinedFields(fields, { isStaff: true }, { name: 'ada' })
    expect(out).toEqual({})
  })

  // An object comes back re-serialized and compares unequal by reference for
  // reasons that have nothing to do with a policy.
  test('does not compare a non-primitive', () => {
    const out = declinedFields(fields, { meta: { a: 1 } }, { meta: { a: 1 } })
    expect(out).toEqual({})
  })

  test('an explicit null cleared is not a decline when it comes back null', () => {
    const out = declinedFields(fields, { isStaff: null }, { isStaff: null })
    expect(out).toEqual({})
  })

  test('a null the boundary replaced IS a decline', () => {
    const out = declinedFields(fields, { isStaff: null }, { isStaff: true })
    expect(Object.keys(out)).toEqual(['isStaff'])
  })

  test('answers empty for the shapes that carry no write at all', () => {
    expect(declinedFields(fields, null, {})).toEqual({})
    expect(declinedFields(fields, {}, null)).toEqual({})
    expect(declinedFields(null, {}, {})).toEqual({})
    expect(declinedFields(fields, [{ isStaff: true }], {})).toEqual({})
  })
})
