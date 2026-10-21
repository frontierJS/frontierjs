/**
 * test/field-rules-collate.test.js
 *
 * `@collate` reaching a live list (`FJS-3234`). `_CARRIED` is an allowlist, so
 * an `x-collate` it does not name never reaches `createResource`, and a pushed
 * row is placed in BINARY order in a list the server ordered by the column.
 */

import { describe, test, expect } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'
import { comparatorFor } from '@frontierjs/toolbelt/query'

import { buildFieldRules } from '../src/resource/field-rules.js'

const SOURCE = `
model Source {
  id    Int    @id @default(autoincrement())
  label String @collate(nocase)
  code  String
  @@gate(0.0.0.0)
}
`

const fields = buildFieldRules(generateJsonSchema(parse(SOURCE).schema).$defs.Source, () => null)

describe('@collate reaches the field rules', () => {
  test('the declaration survives _CARRIED', () => {
    expect(fields.label['x-collate']).toBe('nocase')
    expect(fields.code['x-collate']).toBeUndefined()
  })

  test('the comparator it feeds orders as the column does', () => {
    const rows = [{ label: 'BNI' }, { label: 'apple' }, { label: 'Bing' }]
    const cmp = comparatorFor('label', { label: fields.label['x-collate'] })
    expect(rows.sort(cmp).map(r => r.label)).toEqual(['apple', 'Bing', 'BNI'])
  })
})
