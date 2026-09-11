/**
 * tests/required-where.test.js — a column that becomes required as you type.
 *
 * `@required(where: …)` is required in the rows a predicate admits, so the
 * answer is in the RECORD and not in the schema — the field is not in the
 * schema's `required` list and carries the predicate instead. `sealedFor` is
 * the sibling one attribute over and this is its opposite number: that one
 * answers which columns a row has frozen, this one which it has made necessary.
 *
 * **The evaluator is not sierra's.** `@frontierjs/toolbelt/predicate` IS
 * litestone's own `evalJs` with a different environment passed in
 * (`FJS-D259`), so what is asserted here is the SEAM — that the predicate is
 * carried onto the rule and handed down — and never the semantics of the
 * language, which are graded where both compilers are (`policy-interpreters`).
 *
 * Two rows carry the design and both are about being wrong in the SAFE
 * direction: UNKNOWN is not required, and no record is not required. An
 * affordance stricter than the boundary is the one direction a form must not be
 * wrong in — it produces a control nobody can satisfy, with the server happy to
 * accept the write.
 */

import { describe, test, expect } from 'vitest'
import { buildFieldRules, requiredFor } from '../src/junction/field-rules.js'

// The shape litestone emits for
//   trackingCode String? @required(where: status == 'shipped', "…")
const WHERE = {
  type: 'compare', op: '==',
  left:  { type: 'field', name: 'status' },
  right: { type: 'literal', value: 'shipped' },
}

const MODEL = {
  type: 'object',
  required: ['status'],
  properties: {
    id:           { type: 'integer' },
    status:       { type: 'string', enum: ['draft', 'shipped', 'cancelled'] },
    trackingCode: { type: ['string', 'null'], 'x-litestone-required-where': WHERE,
                    'x-messages': { required: 'A shipped order needs a tracking code' } },
    note:         { type: ['string', 'null'] },
  },
}

const fields = buildFieldRules(MODEL)

describe('the predicate reaches the rule', () => {
  test('carried, and absent from the column beside it', () => {
    expect(fields.trackingCode['x-litestone-required-where']).toEqual(WHERE)
    expect(fields.note['x-litestone-required-where']).toBeUndefined()
  })

  test('the column is NOT unconditionally required', () => {
    // If it were, every draft order would demand a tracking code.
    expect(fields.trackingCode.required).toBeFalsy()
    expect(fields.status.required).toBe(true)
  })
})

describe('requiredFor', () => {

  test('answers true for a record the predicate admits', () => {
    expect(requiredFor(fields.trackingCode, { status: 'shipped' })).toBe(true)
  })

  // The pair. A rule that answered true for everything would satisfy the row
  // above and make the column permanently required.
  test('and false for one it does not', () => {
    expect(requiredFor(fields.trackingCode, { status: 'draft' })).toBe(false)
    expect(requiredFor(fields.trackingCode, { status: 'cancelled' })).toBe(false)
  })

  test('an unconditionally required column stays required whatever the row', () => {
    expect(requiredFor(fields.status, { status: 'draft' })).toBe(true)
    expect(requiredFor(fields.status, null)).toBe(true)
  })

  test('a column with no rule at all is never required by this', () => {
    expect(requiredFor(fields.note, { status: 'shipped' })).toBe(false)
  })

  // UNKNOWN is not required, and it is the CHECK's own answer: SQLite admits a
  // row it cannot judge. Marking the control required here would be an
  // affordance stricter than the rule.
  test('an UNKNOWN predicate is not required', () => {
    expect(requiredFor(fields.trackingCode, {})).toBe(false)
    expect(requiredFor(fields.trackingCode, { status: null })).toBe(false)
  })

  // No record is a create form: the row is being made and its columns are being
  // typed, so reading the predicate off an absent row would demand a value for
  // a state nobody has chosen.
  test('no record is not required', () => {
    expect(requiredFor(fields.trackingCode, null)).toBe(false)
    expect(requiredFor(fields.trackingCode, undefined)).toBe(false)
  })

  // Invariant 6: an affordance the client cannot decide is permissive, and the
  // server enforces regardless. A schema newer than this client is exactly that.
  test('an expression this client does not know is permissive, not a throw', () => {
    const rule = { 'x-litestone-required-where': { type: 'nosuchnode' } }
    expect(requiredFor(rule, { status: 'shipped' })).toBe(false)
  })

  test('the answer MOVES with the record, which is the whole point', () => {
    const record = { status: 'draft' }
    expect(requiredFor(fields.trackingCode, record)).toBe(false)
    expect(requiredFor(fields.trackingCode, { ...record, status: 'shipped' })).toBe(true)
  })

  // ── a bare column predicate ───────────────────────────────────────────────
  //
  // `@required(where: active)` is what somebody writes for a boolean column,
  // and it is the shape that separates a truth VALUE from an expression's
  // value. `evaluate` is an expression evaluator, so a `field` node answers the
  // column — and SQLite stores a boolean as 1, which is what a record read back
  // out of the database carries. The SQL half compiles to `"active"` and treats
  // 1 as true, so a reader testing `=== true` says *optional* about a row the
  // CHECK refuses: not a missing affordance but the two halves disagreeing,
  // which is the one failure `FJS-D259` exists to keep out.
  //
  // Every row is a PAIR against `active == true`, which compiles to
  // `"active" = 1` and has always agreed — so a fix that broke the explicit
  // spelling to rescue the bare one would look identical from the bare side.
  describe('a boolean column, bare and compared', () => {
    // Both shapes exactly as litestone's parser emits them.
    const bare     = { 'x-litestone-required-where': { type: 'field', name: 'active' } }
    const compared = { 'x-litestone-required-where': {
      type: 'compare', op: '==',
      left:  { type: 'field', name: 'active' },
      right: { type: 'literal', value: true },
    } }

    // What the database actually hands back. `true`/`false` is what a form
    // holds mid-edit, 1/0 is what a read returns, and both reach this reader.
    for (const [label, on, off] of [['1 and 0', 1, 0], ['true and false', true, false]]) {
      test(`stored as ${label}, bare agrees with compared`, () => {
        expect(requiredFor(bare,     { active: on  })).toBe(true)
        expect(requiredFor(compared, { active: on  })).toBe(true)
        expect(requiredFor(bare,     { active: off })).toBe(false)
        expect(requiredFor(compared, { active: off })).toBe(false)
      })
    }

    // The column absent is UNKNOWN, and SQLite admits a row it cannot judge.
    test('an absent column is not required, either way', () => {
      expect(requiredFor(bare,     {})).toBe(false)
      expect(requiredFor(compared, {})).toBe(false)
    })
  })
})
