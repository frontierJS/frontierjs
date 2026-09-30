/**
 * test/field-control-scaled.test.js
 *
 * A column whose STORED unit is not the unit a person types (`FJS-810`).
 *
 * `@money(USD)` stores cents and `@scale(2)` stores hundredths. The integer row
 * answers `{ control: 'input', step: 1 }`, which is the right control for a
 * count and a spinner out by a factor of a hundred for these: a person raising
 * a telephone order for forty-two dollars types 42, `validate()` reports
 * nothing, the Data boundary accepts it because 42 is a legal value of the
 * column, and the shop has charged forty-two cents.
 *
 * `@money` therefore answers the kit's `money` box, carrying the currency the
 * box converts by (`FJS-D555`). `@scale` answers `control: null` plus a reason,
 * because what its number measures is the app's to say.
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
  tip      Int    @money(JPY)
  refund   Int    @money(field: currency)
  currency String
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

describe('a scaled integer never gets the integer spinner', () => {
  test('the declaration reaches the rule', () => {
    // The premise. `x-money` is carried by `_CARRIED` specifically so a control
    // can be chosen from the declaration.
    expect(fields.total['x-money']).toEqual({ currency: 'USD' })
    expect(fields.discount['x-scale']).toBe(2)
  })

  test('@money answers the money box, carrying both shapes', () => {
    // The currency rides on the answer in `displayFor`'s spelling, so a form
    // never parses `x-money` itself.
    const at = (name) => controlFor(fields[name], { field: name, model: 'Order' })
    expect(at('total')).toEqual({ control: 'money', task: 'quantify', currency: 'USD', currencyField: undefined })
    expect(at('tip')).toMatchObject({ control: 'money', currency: 'JPY' })
    expect(at('refund')).toMatchObject({ control: 'money', currency: undefined, currencyField: 'currency' })
  })

  test('@scale answers null and says why', () => {
    // A `@scale(2)` column cannot be EXPRESSED through a spinner stepping by 1,
    // and whether its number is money or a percentage is not in the schema:
    // `example`'s `Discount.value` holds 1050 for $10.50 and for 10.50%.
    const answer = controlFor(fields.discount, { field: 'discount', model: 'Order' })
    expect(answer.control).toBeNull()
    expect(answer.reason).toMatch(/@scale/)
  })

  test('an ordinary integer still gets the spinner', () => {
    // The negative control: an answer of money or null for every integer would
    // satisfy the tests above and break every count on every form.
    expect(defaultControlFor(fields.qty)).toEqual({ control: 'input', task: 'quantify', step: 1 })
    expect(controlFor(fields.note).control).toBe('input')
  })
})

describe('an app that has answered still wins', () => {
  test('a registered control replaces the money box', () => {
    registerControl('money', (rule) => (rule?.['x-money'] ? 'ledger' : null))
    expect(controlFor(fields.total, { field: 'total', model: 'Order' }))
      .toEqual({ control: 'ledger', by: 'money', task: 'quantify' })

    // …and it does not claim the one it declined.
    expect(controlFor(fields.discount).control).toBeNull()
  })

  test('a registered control may claim @scale on its own terms', () => {
    registerControl('scale', (rule) => (rule?.['x-scale'] ? { control: 'scaled', places: rule['x-scale'] } : null))
    expect(controlFor(fields.discount)).toEqual({ control: 'scaled', places: 2, by: 'scale', task: 'quantify' })
  })

  test('defaultControlFor is the table alone, registry ignored', () => {
    registerControl('money', () => 'ledger')
    expect(defaultControlFor(fields.total).control).toBe('money')
  })
})
