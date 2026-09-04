/**
 * tests/field-errors-writer.test.js — the shape has a writer now, and it is
 * Junction's.
 *
 * `toFieldErrors` has always been able to READ `[{ field, message }]` off a
 * thrown value, through each of the three wrappings a hop adds. What produced
 * that shape was Junction's own validator and nothing else, so an app's
 * hand-written business rule threw one sentence with no field and rendered as a
 * banner or as nothing, while a declared rule rendered under its control.
 *
 * `@frontierjs/junction`'s `fieldErrors()` / `validateFields()` are the writer.
 * These tests run the REAL builder into the REAL reader rather than restating
 * the shape in a literal — a fixture agreeing with itself is exactly how the
 * two halves would drift, and the reader is the only thing that decides whether
 * a message reaches a control.
 *
 * Direction is fine: sierra may import junction (Invariant 1).
 */

import { describe, test, expect } from 'vitest'
// The leaf module by relative path, not the package entry: junction is
// Bun-only (`bun:sqlite` in its cache) and this suite is vitest on node, and an
// in-repo test reads workspace source directly anyway — `bun install` resolves
// `workspace:*` to a COPY, so the entry point would be yesterday's bytes.
// `field-errors.ts` imports `errors.ts` and nothing else.
import { fieldErrors, validateFields } from '../../junction/src/core/field-errors.ts'
import { toFieldErrors } from '../src/junction/field-rules.js'

/** What a thrown value looks like after Junction's HTTP boundary and the
 *  browser client have each wrapped it once — the `err.data.data` shape. */
const overTheWire = err => ({ data: { data: err.data, message: err.message }, message: err.message })

const thrown = async fn => { try { await fn(); return null } catch (e) { return e } }

describe('a hand-written rule renders like a declared one', () => {

  test('every recorded field reaches its control', async () => {
    const err = await thrown(() => validateFields(e => {
      e.invalid('items', 'Out of stock')
      e.invalid('card',  'This card has expired')
    }))
    const { fields } = toFieldErrors(err)
    expect(fields).toEqual({
      items: 'Out of stock',
      card:  'This card has expired',
    })
  })

  test('the same, after the two wrappings a real request adds', async () => {
    const err = await thrown(() => validateFields(e => e.invalid('items', 'Out of stock')))
    expect(toFieldErrors(overTheWire(err)).fields).toEqual({ items: 'Out of stock' })
  })

  test('payload() lands on the form message, not on a control', async () => {
    const err = await thrown(() => {
      const e = fieldErrors()
      e.payload('An order needs at least one line')
      e.throwIfAny()
    })
    const { fields, message } = toFieldErrors(err)
    expect(fields).toEqual({})
    expect(message).toBe('An order needs at least one line')
  })

  test('a field message and a payload message travel together', async () => {
    const err = await thrown(() => validateFields(e => {
      e.invalid('card', 'This card has expired')
      e.payload('This order cannot be placed')
    }))
    const { fields, message } = toFieldErrors(err)
    expect(fields).toEqual({ card: 'This card has expired' })
    expect(message).toBe('This order cannot be placed')
  })

  test('first message per field wins, which is what one control has room for', async () => {
    const err = await thrown(() => validateFields(e => {
      e.invalid('card', 'This card has expired')
      e.invalid('card', 'This card was declined')
    }))
    expect(toFieldErrors(err).fields.card).toBe('This card has expired')
  })
})

// ─── the other writer ─────────────────────────────────────────────────────────
//
// `FJS-436`. There are TWO producers of a per-field refusal and they name the
// field differently. Junction's validator says `field`; litestone's
// `ValidationError` says `path: ['color']` — and litestone is the one that
// carries every rule a browser cannot pre-check, because the check needs a
// query or a stored row: a value set, a `@@transitions` move, a soft-deleted
// `@unique`. Reading only `field` sent all of those to the form-level message,
// where they render away from the control they name and `<Form>` cannot mark it
// invalid. Found by putting a value set into `example` and refusing a save from
// a real browser.

describe('litestone speaks `path`, and it is the half a browser cannot pre-check', () => {
  // The real class, constructed the way litestone constructs it.
  class ValidationError extends Error {
    constructor(errors) {
      super(`Validation failed — ${errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`)
      this.name = 'ValidationError'
      this.errors = errors
    }
  }

  test('a path-shaped entry reaches its control', () => {
    const err = new ValidationError([{ path: ['color'], message: 'Ochre is not offered by ProductColor' }])
    expect(toFieldErrors(err).fields).toEqual({ color: 'Ochre is not offered by ProductColor' })
  })

  test('…through the two wrappings a hop adds', () => {
    const err = new ValidationError([{ path: ['status'], message: 'pending → shipped is not a declared move' }])
    const wire = overTheWire({ data: err.errors, message: err.message })
    expect(toFieldErrors(wire).fields).toEqual({ status: 'pending → shipped is not a declared move' })
  })

  test('a nested path is joined, not dropped', () => {
    // No form field is named `address.city`, so it still falls to the message —
    // but it says which field rather than reporting none.
    const err = new ValidationError([{ path: ['address', 'city'], message: 'Required' }])
    expect(toFieldErrors(err).fields).toEqual({ 'address.city': 'Required' })
  })

  test('an empty path is a whole-payload failure and stays one', () => {
    const err = new ValidationError([{ path: [], message: 'Expected an object' }])
    const { fields, message } = toFieldErrors(err)
    expect(fields).toEqual({})
    expect(message).toBe('Expected an object')
  })

  test('`field` still wins where both are present', () => {
    expect(toFieldErrors({ errors: [{ field: 'sku', path: ['color'], message: 'Taken' }] }).fields)
      .toEqual({ sku: 'Taken' })
  })
})
