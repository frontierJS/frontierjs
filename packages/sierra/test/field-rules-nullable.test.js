/**
 * test/field-rules-nullable.test.js
 *
 * A nullable column's flags reaching its rule (`FJS-1259`).
 *
 * Litestone emits a nullable column two ways: a bare type as
 * `type: ['string', 'null']`, and anything with a `format`, a constraint or a
 * `$ref` as an `anyOf` of the value branch and a null branch. The field's own
 * keywords — `readOnly`, `x-litestone-kind` — sit on the WRAPPER in both. A
 * rule read only off the deref'd branch keeps them for the first shape and
 * loses them for the second, and a nullable `@system` date then gets a control
 * the Data boundary answers 403 to.
 *
 * The schema is generated from `.lite` source, because where litestone puts
 * the flag is the fact under test and a hand-written schema could put it
 * anywhere.
 */

import { describe, test, expect } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import { buildFieldRules, controlFor } from '../src/junction/field-rules.js'

const SOURCE = `
enum Status { open closed }
model LeaveRequest {
  id          Int       @id @default(autoincrement())
  reason      String
  decidedAt   DateTime? @system
  decidedById String?   @system
  outcome     Status?   @system
  note        String?   @length(1, 20)
  @@gate("0.0.0.0")
}
`

const json = generateJsonSchema(parse(SOURCE).schema)
const fields = buildFieldRules(json.$defs.LeaveRequest, ref => json.$defs[ref.split('/').pop()] ?? null)

describe('a nullable @system column is refused a control whatever shape it is emitted as', () => {
  test.each(['decidedAt', 'decidedById', 'outcome'])('%s', (name) => {
    expect(fields[name].readOnly).toBe(true)
    expect(fields[name]['x-litestone-kind']).toBe('system')
    expect(controlFor(fields[name], { field: name })).toEqual({ control: null, reason: 'readOnly' })
  })
})

describe('the value branch still answers for what it states', () => {
  test('a nullable date keeps its format and its nullability', () => {
    expect(fields.decidedAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true })
  })

  test('a nullable enum keeps its members', () => {
    expect(fields.outcome.enum).toEqual(['open', 'closed'])
  })

  test('a writable nullable column carries its constraints and no readOnly', () => {
    expect(fields.note).toMatchObject({ minLength: 1, maxLength: 20, nullable: true })
    expect('readOnly' in fields.note).toBe(false)
    expect(controlFor(fields.note, { field: 'note' }).control).toBe('input')
  })
})
