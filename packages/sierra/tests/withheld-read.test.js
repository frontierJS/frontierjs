/**
 * tests/withheld-read.test.js — a column the server did not send.
 *
 * A field `@allow('read', …)` is enforced by STRIPPING the key, which is the
 * one fact the whole reader turns on. Measured against `example`'s
 * `Customer.notes @allow('read', auth().role == 'admin')`, through a real
 * litestone client over a real database:
 *
 *   admin, row has a note   → key present, value 'SECRET staff note'
 *   admin, row has none     → key present, value null
 *   anyone else, either row → NO KEY, both times
 *
 * So the refusal and the empty column are one answer to anything that looks at
 * the VALUE, and `null` is a real answer that belongs to somebody who may read.
 * That is why this tests key presence and why the empty-but-permitted row is
 * the sharper of the two controls: a reader keyed off the value tells an admin
 * they lack a permission they have.
 *
 * The second half is why it matters at all. A read policy is not a write
 * policy — the same probe confirmed a caller who cannot READ `notes` can
 * overwrite it — so a form offering an ordinary empty box saves that emptiness
 * over a note nobody on the screen has seen. `<Form>` drops the key for that
 * reason, and `form-withheld.spec.mjs` is where the crossing is graded.
 */

import { describe, test, expect } from 'vitest'
import { buildFieldRules, withheldFields } from '../src/junction/field-rules.js'

// The shape litestone emits for a field `@allow('read', …)`. `notes` is the
// policed one; `name` is the control, and it is the whole reason the flag is
// carried — without it these two columns are indistinguishable from here.
const MODEL = {
  type: 'object',
  properties: {
    id:    { type: 'string', readOnly: true, title: 'Id' },
    name:  { type: 'string', title: 'Name' },
    notes: { type: ['string', 'null'], title: 'Notes', 'x-litestone-read-policy': true },
  },
}
const FIELDS = buildFieldRules(MODEL)

describe('withheldFields', () => {
  test('the flag is carried onto the rule at all', () => {
    // If this fails nothing below can pass for the right reason: a keyword the
    // generator emits and the rule builder drops is a flag no reader can see.
    expect(FIELDS.notes['x-litestone-read-policy']).toBe(true)
    expect(FIELDS.name['x-litestone-read-policy']).toBeUndefined()
  })

  test('a key the read did not carry is withheld', () => {
    expect(withheldFields(FIELDS, { id: 'c-3', name: 'Cy' })).toEqual(['notes'])
  })

  // The row that decides the mechanism. An admin reading a customer with no
  // note gets `notes: null` — present, and theirs to edit.
  test('a key that IS there and null is NOT withheld', () => {
    expect(withheldFields(FIELDS, { id: 'c-2', name: 'Bo', notes: null })).toEqual([])
  })

  test('a key that is there with a value is not withheld', () => {
    expect(withheldFields(FIELDS, { id: 'c-1', name: 'Ada', notes: 'Prefers email.' })).toEqual([])
  })

  // The control on the other axis: an absent column that carries no policy is
  // not withheld, it is merely absent. A reader that reported every missing key
  // would lock half of every partial row.
  test('an unpoliced column that is absent is not withheld', () => {
    expect(withheldFields(FIELDS, { id: 'c-4' })).toEqual(['notes'])
    expect(withheldFields({ name: FIELDS.name }, { id: 'c-4' })).toEqual([])
  })

  // No record is a create: a row being made has no stored value to keep back,
  // and a form that locked the column here would offer nobody a way to fill it.
  test('no record withholds nothing', () => {
    expect(withheldFields(FIELDS, null)).toEqual([])
    expect(withheldFields(FIELDS, undefined)).toEqual([])
  })

  test('no fields withholds nothing', () => {
    expect(withheldFields(null, { id: 'c-3' })).toEqual([])
  })

  // An array is not a row. Guarded because `withheld(record)` is reached from a
  // form that may be handed a list by a caller who meant `record={rows[0]}`.
  test('a list is not a record', () => {
    expect(withheldFields(FIELDS, [{ id: 'c-3' }])).toEqual([])
  })
})
