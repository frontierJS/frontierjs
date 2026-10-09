/**
 * test/field-rules-unique-items.test.js
 *
 * `@uniqueItems` on a `String[]` (`FJS-1441`).
 *
 * The rule a control resolver is handed used to drop `uniqueItems`, so the
 * browser let a repeated tag through and the API refused it with a 400.
 */

import { describe, test, expect } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'
import { buildFieldRules, validateAgainstFields } from '../src/resource/field-rules.js'

const { schema } = parse(
  'model Bookmark {\n' +
  '  id Int @id\n' +
  '  url String\n' +
  '  tags String[] @default([]) @uniqueItems\n' +
  '  notes String[] @default([])\n' +
  '}\n',
)
const fields = buildFieldRules(generateJsonSchema(schema).$defs.Bookmark)

describe('uniqueItems on a scalar list', () => {
  test('the rule carries it and the item type', () => {
    expect(fields.tags.uniqueItems).toBe(true)
    expect(fields.tags.items).toEqual({ type: 'string' })
    expect(fields.notes.uniqueItems).toBeUndefined()
  })

  test('a repeated item is refused in the browser, as the API refuses it', () => {
    const errors = validateAgainstFields(fields, { url: 'x', tags: ['a', 'a'] }, 'create')
    expect(errors).toEqual([{ field: 'tags', message: expect.stringMatching(/unique/) }])
  })

  test('a list without it may repeat, and a create may leave the list to its default', () => {
    expect(validateAgainstFields(fields, { url: 'x', notes: ['a', 'a'] }, 'create')).toEqual([])
    expect(validateAgainstFields(fields, { url: 'x' }, 'create')).toEqual([])
  })
})
