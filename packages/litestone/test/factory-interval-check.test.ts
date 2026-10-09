// FJS-2056 — an auto factory wrote one value into every DateTime of a row, so
// `@@check("endAt > startAt")` refused every row it invented.
import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateFactory } from '../src/testing.js'

const row = (src: string, seq = 1) => {
  const { schema } = parse(src)
  return generateFactory(schema, 'T')(seq, null) as Record<string, any>
}

describe('generateFactory honors a two-column @@check', () => {
  test('endAt > startAt', () => {
    const r = row(`model T { id Int @id; startAt DateTime; endAt DateTime; @@check("endAt > startAt") }`)
    expect(new Date(r.endAt).getTime()).toBeGreaterThan(new Date(r.startAt).getTime())
  })

  test('the smaller side named first, and >= / <= / <', () => {
    for (const expr of ['startAt < endAt', 'endAt >= startAt', 'startAt <= endAt']) {
      const r = row(`model T { id Int @id; startAt DateTime; endAt DateTime; @@check("${expr}") }`)
      expect(new Date(r.endAt).getTime()).toBeGreaterThanOrEqual(new Date(r.startAt).getTime())
      if (!expr.includes('=')) expect(new Date(r.endAt).getTime()).toBeGreaterThan(new Date(r.startAt).getTime())
    }
  })

  test('numbers: max > min', () => {
    for (const seq of [1, 2, 7]) {
      const r = row(`model T { id Int @id; min Int; max Int; @@check("max > min") }`, seq)
      expect(r.max).toBeGreaterThan(r.min)
    }
  })

  test('a check naming a quoted or non-field operand leaves the row alone', () => {
    const r = row(`model T { id Int @id; startAt DateTime; endAt DateTime; @@check("endAt > '2020-01-01'") }`)
    expect(r.startAt).toBe(r.endAt)
  })
})
