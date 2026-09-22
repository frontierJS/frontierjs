/**
 * test/field-rules-unit.test.js
 *
 * `@unit` reaching a form (`FJS-D348`).
 *
 * `_CARRIED` is an allowlist, so a keyword litestone emits and this file does
 * not name is dropped between the schema and `$context.form` — the declaration
 * then exists, is emitted, and reaches nobody, which is the whole failure
 * `@unit` was added to remove. That is what the first test here asserts.
 *
 * The second is the difference from its two neighbours. `@money` and `@scale`
 * answer `control: null` because the box and the column disagree — a person
 * types 42 and the column holds 4200. A `@unit(s)` column has no such gap: 300
 * typed is 300 stored, so the ordinary number input is the right answer and
 * this must NOT join them in the refusal.
 *
 * The schema is generated from `.lite` source, because `x-unit` is what
 * litestone emits and a hand-written rule table could carry any spelling.
 */

import { describe, test, expect } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import { buildFieldRules, controlFor } from '../src/junction/field-rules.js'

const SOURCE = `
model Job {
  id        Int   @id @default(autoincrement())
  timeout   Int   @unit(s)
  size      Int   @unit(MB)
  retention Int   @unit(mo)
  plain     Int
  @@gate("0.0.0.0")
}
`

const fields = buildFieldRules(
  generateJsonSchema(parse(SOURCE).schema).$defs.Job,
  () => null,
)

describe('@unit reaches the form', () => {
  test('the declaration survives _CARRIED, with its dimension', () => {
    expect(fields.timeout['x-unit']).toEqual({ symbol: 's', dimension: 'duration' })
    expect(fields.size['x-unit']).toEqual({ symbol: 'MB', dimension: 'information' })
  })

  test('a calendar unit arrives like any other', () => {
    // `mo` carries no conversion factor in the kit, and that is the kit's
    // refusal — nothing here needs to know, because nothing here converts.
    expect(fields.retention['x-unit']).toEqual({ symbol: 'mo', dimension: 'duration' })
  })

  test('a column with no unit carries none', () => {
    expect(fields.plain['x-unit']).toBeUndefined()
  })
})

describe('it does not join @money and @scale in refusing a control', () => {
  test('the ordinary number input is correct, because the box and the column agree', () => {
    for (const name of ['timeout', 'size', 'retention']) {
      const answer = controlFor(fields[name], { field: name, model: 'Job' })
      expect({ name, control: answer.control }).toEqual({ name, control: 'input' })
    }
  })
})
