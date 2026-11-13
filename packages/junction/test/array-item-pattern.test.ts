// FJS-4244: a pattern on an array's items def was never compiled to a RegExp,
// so validateField's string case threw on `.test` instead of reporting.

import { describe, test, expect } from 'bun:test'
import { createSchema }           from '../src/core/schema.ts'

describe('pattern on array items', () => {
  const schema = () => createSchema({
    colors: { type: 'array', items: { type: 'string', pattern: '^#[0-9a-f]{6}$' } },
  })

  test('a matching list validates', () => {
    const r = schema().validate({ colors: ['#aabbcc'] })
    expect(r.valid).toBe(true)
  })

  test('a non-matching item is a field error naming its index', () => {
    const r = schema().validate({ colors: ['#aabbcc', 'red'] })
    expect(r.valid).toBe(false)
    expect(r.errors[0].field).toBe('colors[1]')
  })

  test('items of items compile too', () => {
    const s = createSchema({
      grid: { type: 'array', items: { type: 'array', items: { type: 'string', pattern: '^x$' } } },
    })
    expect(s.validate({ grid: [['x']] }).valid).toBe(true)
    expect(s.validate({ grid: [['x', 'y']] }).valid).toBe(false)
  })
})
