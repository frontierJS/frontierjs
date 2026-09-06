/**
 * tests/field-control-scaled.test.js
 *
 * A column whose STORED unit is not the unit a person types (`FJS-810`).
 *
 * `@money(USD)` stores cents and `@scale(2)` stores hundredths. The built-in
 * table answered `{ control: 'input', step: 1 }` for both, because both are
 * integers — which is the right control for a count and a spinner out by a
 * factor of a hundred for these. A person raising a telephone order for
 * forty-two dollars types 42, `validate()` reports nothing, the Data boundary
 * accepts it because 42 is a legal value of the column, and the shop has
 * charged forty-two cents. Nothing refuses it at any layer.
 *
 * The answer is the one the same table already gives an array, a `Json`
 * document and a type it does not know: `control: null` plus a reason, so the
 * field stays IN `formFields()` with the sentence beside it rather than being
 * quietly wrong. What the control IS remains an app's decision (`FJS-D17`),
 * and this is what happens when nobody has made it.
 *
 * The schemas here are generated from `.lite` source, because `x-money` and
 * `x-scale` are what litestone emits and a hand-written rule table could carry
 * either spelling.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import {
  buildFieldRules, controlFor, defaultControlFor, registerControl, unregisterControl,
} from '../src/junction/field-rules.js'

const SOURCE = `
model Order {
  id       Int    @id @default(autoincrement())
  total    Int    @money(USD)
  discount Int    @scale(2)
  qty      Int
  note     String?
  @@gate("0.0.0.0")
}
`

const fields = buildFieldRules(
  generateJsonSchema(parse(SOURCE).schema).$defs.Order,
  () => null,
)

afterEach(() => { unregisterControl('money'); unregisterControl('scale') })

describe('a scaled integer has no built-in control', () => {
  test('the declaration reaches the rule', () => {
    // The premise. `x-money` is carried by `_CARRIED` specifically so a control
    // can be chosen from the declaration.
    expect(fields.total['x-money']).toEqual({ currency: 'USD' })
    expect(fields.discount['x-scale']).toBe(2)
  })

  test('@money answers null and says why', () => {
    const answer = controlFor(fields.total, { field: 'total', model: 'Order' })
    expect(answer.control).toBeNull()
    expect(answer.reason).toMatch(/@money/)
    expect(answer.reason).toMatch(/register a control/)
  })

  test('@scale answers null and says why', () => {
    // The sibling, and the sharper one: a `@scale(2)` column cannot even be
    // EXPRESSED through a spinner stepping by 1 — `example`'s `Discount.value`
    // holds 1050 for $10.50 and for 10.50%.
    const answer = controlFor(fields.discount, { field: 'discount', model: 'Order' })
    expect(answer.control).toBeNull()
    expect(answer.reason).toMatch(/@scale/)
  })

  test('an ordinary integer still gets the spinner', () => {
    // The negative control on the refusal: an answer of null for every integer
    // would satisfy the two tests above and would empty every generated form.
    expect(defaultControlFor(fields.qty)).toEqual({ control: 'input', step: 1 })
    expect(controlFor(fields.note).control).toBe('input')
  })
})

describe('an app that has answered still wins', () => {
  test('a registered control claims the column', () => {
    // `example` ships exactly this (`web/src/money-control.js`), so a fix that
    // refused every money column would take that app's order form down.
    registerControl('money', (rule) => (rule?.['x-money'] ? 'money' : null))
    expect(controlFor(fields.total, { field: 'total', model: 'Order' }))
      .toEqual({ control: 'money', by: 'money' })

    // …and it does not claim the one it declined.
    expect(controlFor(fields.discount).control).toBeNull()
  })

  test('a registered control may claim @scale on its own terms', () => {
    registerControl('scale', (rule) => (rule?.['x-scale'] ? { control: 'scaled', places: rule['x-scale'] } : null))
    expect(controlFor(fields.discount)).toEqual({ control: 'scaled', places: 2, by: 'scale' })
  })

  test('defaultControlFor is the table alone, registry ignored', () => {
    registerControl('money', () => 'money')
    expect(defaultControlFor(fields.total).control).toBeNull()
  })
})
