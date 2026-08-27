/**
 * test/time-column.test.ts — `@time` reaching the client (`FJS-522`).
 *
 * The validator has always been there. What was missing is everything above the
 * Data boundary: the emitter had no `case 'time'` at all, so a `String @time`
 * column arrived at a form as a bare string, got a plain text box, and every
 * value a person typed was accepted in the browser and refused at the write.
 *
 * The substance here is WHICH keyword carries it. `format: 'time'` means RFC
 * 3339 full-time, which requires seconds and an offset; `@time` requires
 * neither and admits no offset. Emitting the format would have made the two
 * boundaries disagree about `09:30` — accepted by one, refused by the other —
 * which is a worse failure than the silence it replaced. So the emitter carries
 * the validator's OWN regex as a `pattern`, imported rather than restated, and
 * the tests below run the same values through both sides.
 */

import { describe, test, expect } from 'bun:test'
import { parse, generateJsonSchema } from '../src/index.js'
import { validateField } from '../src/core/validate.js'

const SRC = `model Shift {
  id    Int    @id
  opens String @time
  shuts String @time(seconds: true)
}`

const fieldSchema = (name: string) => {
  const r = parse(SRC)
  expect(r.valid).toBe(true)
  const out: any = generateJsonSchema(r.schema, { mode: 'full' })
  return out.$defs.Shift.properties[name]
}

// The Data boundary's answer for the same value, so the two can be compared.
const accepts = (src: string, field: string, value: string) => {
  const r = parse(src)
  const f = r.schema.models[0].fields.find((x: any) => x.name === field)!
  return validateField(field, value, f.attributes).length === 0
}

describe('what the emitter produces', () => {
  test('a pattern, and not a format', () => {
    const s = fieldSchema('opens')
    expect(s.type).toBe('string')
    expect(s.pattern).toBeTruthy()
    // RFC 3339 full-time requires seconds AND an offset. Claiming it here would
    // make a strict consumer refuse `09:30`, which the boundary accepts.
    expect(s.format).toBeUndefined()
  })

  test('x-time carries the one thing the pattern cannot say', () => {
    expect(fieldSchema('opens')['x-time']).toEqual({ seconds: false })
    expect(fieldSchema('shuts')['x-time']).toEqual({ seconds: true })
  })

  test('the seconds flag widens the pattern', () => {
    expect(fieldSchema('opens').pattern).not.toBe(fieldSchema('shuts').pattern)
  })

  test('a plain String column is untouched', () => {
    const r = parse(`model P { id Int @id  name String }`)
    const out: any = generateJsonSchema(r.schema, { mode: 'full' })
    expect(out.$defs.P.properties.name.pattern).toBeUndefined()
    expect(out.$defs.P.properties.name['x-time']).toBeUndefined()
  })
})

describe('the two boundaries agree, value by value', () => {
  const CASES: [string, boolean, boolean][] = [
    // value        HH:MM   seconds:true
    ['09:30',        true,   true],
    ['00:00',        true,   true],
    ['23:59',        true,   true],
    ['09:30:45',     false,  true],
    ['23:59:59',     false,  true],
    ['9:30',         false,  false],   // leading zeros are required — they are what makes it sort
    ['24:00',        false,  false],
    ['09:60',        false,  false],
    ['09:30:60',     false,  false],
    ['09:30Z',       false,  false],   // an offset is what `format: 'time'` would have demanded
    ['09:30+01:00',  false,  false],
    ['',             false,  false],
    ['half nine',    false,  false],
  ]

  for (const [value, okHm, okHms] of CASES) {
    test(`${JSON.stringify(value)} — ${okHm ? 'HH:MM' : 'not HH:MM'}, ${okHms ? 'seconds ok' : 'seconds no'}`, () => {
      const patHm  = new RegExp(fieldSchema('opens').pattern)
      const patHms = new RegExp(fieldSchema('shuts').pattern)

      // The pattern, which is what a browser checks…
      expect(patHm.test(value)).toBe(okHm)
      expect(patHms.test(value)).toBe(okHms)
      // …and the validator, which is what the write checks. Same answer, or the
      // person is told one thing on screen and another by the server.
      expect(accepts(SRC, 'opens', value)).toBe(okHm)
      expect(accepts(SRC, 'shuts', value)).toBe(okHms)
    })
  }
})

describe('the flag widens and does not narrow', () => {
  test('seconds: true still accepts a value with none', () => {
    // A finer value being ALLOWED is not the same as it being required, and the
    // regexes used to be two alternatives rather than one optional group.
    expect(accepts(SRC, 'shuts', '09:30')).toBe(true)
  })
})

describe("the author's own message finds its keyword", () => {
  test('x-messages keys @time under pattern', () => {
    // Named arguments only — `@time` is the one validator with no positional
    // message form, which is why this reads differently from `@date("...")`.
    const r = parse(`model P {
      id    Int    @id
      opens String @time(message: "we open on the hour or the half hour")
    }`)
    expect(r.valid).toBe(true)
    const out: any = generateJsonSchema(r.schema, { mode: 'full' })
    const msgs = out.$defs.P.properties.opens['x-messages']
    // Keyed by the keyword a consumer actually checks. This said `format` for as
    // long as the emitter produced nothing at all.
    expect(msgs.pattern).toBe('we open on the hour or the half hour')
  })
})
