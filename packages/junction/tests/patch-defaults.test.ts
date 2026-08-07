// patch-defaults.test.ts — a PATCH must not invent values for absent keys.
//
// `jsonSchemaToJunctionSchema(model, schema, 'update')` already drops
// required-ness, because a partial body is the whole point of a patch. It kept
// every field's `default`, and `validate()` fills a default in for any absent
// key — so a one-field patch was rewritten into a full record on its way to the
// model.
//
// On an ordinary column that silently reset it to the default. On a column
// under `@@transitions` it was loud and looked like somebody else's bug:
//
//   PATCH /orders/3 {"note":"x"}   (order is 'shipped')
//   → 409 Cannot transition order.status from 'shipped' to 'pending'
//
// Found 2026-08-06 by a Caravan job writing a tracking code onto a shipped
// order — the job's own retries were the thing that made it visible.

import { describe, it, expect } from 'bun:test'
import { jsonSchemaToJunctionSchema } from '../src/core/litestone.ts'
import { createSchema } from '../src/core/schema.ts'

const SCHEMA = {
  $defs: {
    OrderStatus: { type: 'string', enum: ['pending', 'paid', 'shipped'], title: 'OrderStatus' },
    Order: {
      type: 'object',
      required: ['reference', 'customerId'],
      properties: {
        reference:    { type: 'string' },
        status:       { anyOf: [{ $ref: '#/$defs/OrderStatus' }], default: 'pending' },
        total:        { type: 'number', default: 0 },
        active:       { type: 'boolean', default: true },
        note:         { anyOf: [{ type: 'string' }, { type: 'null' }] },
        trackingCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        customerId:   { type: 'integer' },
      },
    },
  },
}

const compiled = (mode: 'create' | 'update') =>
  createSchema(jsonSchemaToJunctionSchema('Order', SCHEMA as never, mode))

describe('a patch does not apply model defaults', () => {

  it('leaves an absent defaulted field absent', () => {
    const out = compiled('update').parse({ trackingCode: 'TRK-1' }) as Record<string, unknown>

    expect(out).toEqual({ trackingCode: 'TRK-1' })
    // The three that used to appear from nowhere.
    expect('status' in out).toBe(false)
    expect('total'  in out).toBe(false)
    expect('active' in out).toBe(false)
  })

  it('the update schema carries no defaults at all', () => {
    const schema = jsonSchemaToJunctionSchema('Order', SCHEMA as never, 'update')
    for (const [field, def] of Object.entries(schema))
      expect([field, def.default]).toEqual([field, undefined])
  })

  it('a stated value still wins, and is still validated', () => {
    const out = compiled('update').parse({ status: 'paid' }) as Record<string, unknown>
    expect(out).toEqual({ status: 'paid' })

    expect(() => compiled('update').parse({ status: 'gold' })).toThrow()
  })

  it('an explicit null still clears — presence is the question, not truthiness', () => {
    // Invariant 9. The default branch fired on `undefined` OR `null`, so a
    // deliberate `note: null` on a defaulted column would have been overwritten
    // by the default rather than clearing the value.
    const out = compiled('update').parse({ note: null }) as Record<string, unknown>
    expect(out).toEqual({ note: null })
  })

  it('CREATE still applies them — this is a patch rule, not a general one', () => {
    const out = compiled('create').parse({ reference: 'ORD-1', customerId: 1 }) as Record<string, unknown>

    expect(out.status).toBe('pending')
    expect(out.total).toBe(0)
    expect(out.active).toBe(true)
  })

  it('CREATE still refuses a missing required field', () => {
    expect(() => compiled('create').parse({ reference: 'ORD-1' })).toThrow()
    // …and PATCH still does not, which is what 'update' mode already did.
    expect(compiled('update').parse({ reference: 'ORD-1' })).toEqual({ reference: 'ORD-1' })
  })
})
