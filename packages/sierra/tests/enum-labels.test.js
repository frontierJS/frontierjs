/**
 * tests/enum-labels.test.js
 *
 * `x-labels` — the human text for each member of an enum — from the emitter
 * to the shape a control consumes.
 *
 * Litestone emits it beside `enum` rather than restructuring the array into
 * `oneOf: [{const, title}]`, because that array is what validation reads. So
 * a label arrives as a SECOND key that every existing reader ignores, and
 * turning the two into one option list has to happen exactly once.
 *
 * It happens here, in `buildFieldRules`, and not in the controls — because
 * `@frontierjs/ui` peers on mesa and css alone and cannot import this module.
 * A control that had to merge the two would be a copy of this rule living in
 * a package that cannot see the original.
 *
 * The invariant under all of it: **an enum that labels nothing behaves
 * exactly as it did before.** `rule.options` is absent, `rule.enum` is the
 * array, and `controlFor` answers the plain string list it always answered.
 */

import { describe, test, expect } from 'vitest'

const { buildFieldRules, controlFor } = await import('../src/junction/field-rules.js')

const LABELLED = {
  type: 'object', title: 'Account',
  properties: {
    plan: {
      type: 'string',
      enum: ['starter', 'pro', 'enterprise'],
      'x-labels': { starter: 'Starter', pro: 'Pro' },
    },
    bare: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['plan'],
}

describe('x-labels → rule.options', () => {
  test('every member appears, and one with no label falls back to its code', () => {
    // A partial map is the normal case: a schema labels the codes whose
    // spelling is not already the words, and leaves the rest. Dropping the
    // unlabelled ones would silently shorten the picker.
    const rule = buildFieldRules(LABELLED).plan
    expect(rule.options).toEqual([
      { value: 'starter',    label: 'Starter' },
      { value: 'pro',        label: 'Pro' },
      { value: 'enterprise', label: 'enterprise' },
    ])
  })

  test('the codes are untouched, so validation still reads a plain array', () => {
    const rule = buildFieldRules(LABELLED).plan
    expect(rule.enum).toEqual(['starter', 'pro', 'enterprise'])
  })

  test('an unlabelled enum carries no options at all', () => {
    const rule = buildFieldRules(LABELLED).bare
    expect(rule.options).toBeUndefined()
    expect(rule.enum).toEqual(['a', 'b'])
  })

  test('controlFor prefers the labelled list and falls back to the codes', () => {
    const rules = buildFieldRules(LABELLED)

    expect(controlFor(rules.plan)).toEqual({
      control: 'select',
      options: [
        { value: 'starter',    label: 'Starter' },
        { value: 'pro',        label: 'Pro' },
        { value: 'enterprise', label: 'enterprise' },
      ],
    })

    // Unchanged from before this feature — a bare string array, which is one
    // of the two shapes Select.mesa already normalises.
    expect(controlFor(rules.bare)).toEqual({ control: 'select', options: ['a', 'b'] })
  })
})
