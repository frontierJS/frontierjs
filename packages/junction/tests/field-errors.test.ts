// tests/field-errors.test.ts
//
// An app's own rules report per field, like the declared ones do.
//
// The shape had a reader and no writer. Sierra's `toFieldErrors` knows how to
// pull `[{ field, message }]` off a thrown value through the three wrappings
// each hop adds, and `<Form>` renders each message under its own control — but
// the only thing producing that shape was junction's own validator. So a
// DECLARED rule reported every field at once and rendered in place, while a
// hand-written business rule threw one sentence with no field and rendered as a
// banner or as nothing. Same service, same request, two grades of error.
//
// What is asserted here is mostly that ONE function produces the shape:
// `fieldError()`. The validator's `parse()` throws through it too, so a
// declared rule and a hand-written one are indistinguishable downstream — which
// is the whole claim, and the reason the last test compares the two.

import { describe, test, expect }              from 'bun:test'
import { fieldErrors, validateFields, fieldError } from '../src/core/field-errors.ts'
import { createSchema }                        from '../src/core/schema.ts'

const caught = async (fn: () => unknown): Promise<any> => {
  try { await fn(); return null } catch (e) { return e }
}

describe('the builder', () => {

  test('records one message per field and throws them together', async () => {
    const err = await caught(() => {
      const e = fieldErrors()
      e.invalid('items', 'Out of stock')
      e.invalid('card',  'This card has expired')
      e.throwIfAny()
    })
    expect(err.code).toBe(400)
    expect(err.data).toEqual([
      { field: 'items', message: 'Out of stock' },
      { field: 'card',  message: 'This card has expired' },
    ])
    // A caller that is not a form still has to be told something true.
    expect(err.message).toBe('items: Out of stock, card: This card has expired')
  })

  test('throwIfAny with nothing recorded is a no-op, so it is safe to call unconditionally', async () => {
    expect(await caught(() => fieldErrors().throwIfAny())).toBeNull()
  })

  test('payload() records against the whole body, not a field', async () => {
    const err = await caught(() => {
      const e = fieldErrors()
      e.payload('An order needs at least one line')
      e.throwIfAny()
    })
    // '_' is the slot junction's own validator uses for "Expected an object",
    // and what sierra renders as a form's one overall message.
    expect(err.data).toEqual([{ field: '_', message: 'An order needs at least one line' }])
  })

  test('it chains, and answers what it holds', () => {
    const e = fieldErrors()
    expect(e.any).toBe(false)
    e.invalid('a', 'x').invalid('b', 'y').payload('z')
    expect(e.any).toBe(true)
    expect(e.list().map(f => f.field)).toEqual(['a', 'b', '_'])
    // A copy — a caller cannot reach in and edit what was recorded.
    e.list().push({ field: 'c', message: 'no' })
    expect(e.list()).toHaveLength(3)
  })

  test('a blank field or message is refused rather than rendered blank', () => {
    const e = fieldErrors()
    expect(() => e.invalid('', 'x')).toThrow(/needs a field name/)
    expect(() => e.invalid('a', '')).toThrow(/needs a message/)
    expect(() => e.payload('  ')).toThrow(/needs a message/)
  })

  test('a stated summary beats the joined one', async () => {
    const err = await caught(() => {
      const e = fieldErrors()
      e.invalid('items', 'Out of stock')
      e.throwIfAny('This order cannot be placed')
    })
    expect(err.message).toBe('This order cannot be placed')
    expect(err.data).toHaveLength(1)
  })
})

describe('validateFields — the form that cannot be forgotten', () => {

  test('runs the checks and throws everything at once', async () => {
    const err = await caught(() => validateFields(e => {
      e.invalid('items', 'Out of stock')
      e.invalid('card',  'This card has expired')
    }))
    expect(err.data).toHaveLength(2)
  })

  test('clean checks throw nothing', async () => {
    expect(await caught(() => validateFields(() => {}))).toBeNull()
  })

  test('a rule that has to ask the database is an ordinary rule', async () => {
    const stock = async (_id: number) => 0
    const err = await caught(() => validateFields(async e => {
      if (await stock(1) === 0) e.invalid('items', 'Out of stock')
    }))
    expect(err.data).toEqual([{ field: 'items', message: 'Out of stock' }])
  })

  test('a throw from inside the checks is not swallowed by the accumulator', async () => {
    const err = await caught(() => validateFields(() => { throw new Error('boom') }))
    expect(err.message).toBe('boom')
  })
})

describe('one owner for the shape', () => {

  test('a declared rule and a hand-written one throw the same shape', async () => {
    const schema = createSchema({
      email: { type: 'string', required: true },
      total: { type: 'number', required: true },
    })

    const declared = await caught(() => schema.parse({}))
    const written  = await caught(() => validateFields(e => {
      e.invalid('email', 'x')
      e.invalid('total', 'y')
    }))

    // Not the same messages — the same SHAPE, which is what every reader
    // downstream keys off. `parse()` throws through fieldError() too, so this
    // cannot drift without both sides moving.
    const shapeOf = (err: any) => ({
      code:   err.code,
      keys:   Object.keys(err.data[0]).sort(),
      fields: err.data.map((d: any) => d.field),
    })
    expect(shapeOf(declared)).toEqual(shapeOf(written))
  })

  test('fieldError can carry a different status for an app that wants the distinction', () => {
    const err = fieldError([{ field: 'a', message: 'x' }], undefined, 422)
    expect(err.code).toBe(422)
    expect(err.data).toEqual([{ field: 'a', message: 'x' }])
  })
})
