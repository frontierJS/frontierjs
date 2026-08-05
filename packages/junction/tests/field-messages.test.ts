// field-messages.test.ts — the server says the sentence the schema declared.
//
// Junction's autoValidate and Sierra's client-side rules derive from the SAME
// JSON Schema document. `@label("Customer")` arrives as `title` and
// `@required("…")` / `@length(3, 20, "…")` arrive as `x-messages`, so one
// string authored in db/schema.lite is what both realms say. If these two
// disagree the user gets one message before the request and a different one
// after it, which is worse than either alone.
//
// The sibling suite is packages/sierra/tests/field-messages.test.js — same
// fixtures, same expectations, deliberately.

import { describe, it, expect } from 'bun:test'
import { jsonSchemaToJunctionSchema } from '../src/core/litestone.ts'
import { createSchema } from '../src/core/schema.ts'

const FULL_SCHEMA = {
  $defs: {
    OrderStatus: { type: 'string', enum: ['pending', 'paid'], title: 'OrderStatus' },
    Order: {
      type: 'object',
      properties: {
        reference: {
          type: 'string', minLength: 3, maxLength: 20,
          'x-messages': {
            length: 'A reference is 3 to 20 characters',
            minLength: 'A reference is 3 to 20 characters',
            maxLength: 'A reference is 3 to 20 characters',
          },
        },
        email: { type: 'string', format: 'email', 'x-messages': { email: 'Bad email', format: 'Bad email' } },
        total: { type: 'number', minimum: 0, 'x-messages': { gte: 'No negatives', minimum: 'No negatives' } },
        plain: { type: 'number', minimum: 0 },
        status: { $ref: '#/$defs/OrderStatus' },
        customerId: {
          type: 'integer',
          title: 'Customer',
          'x-messages': { required: 'Please select a customer from the list' },
        },
      },
      required: ['reference', 'customerId', 'status'],
    },
  },
}

const schema = () => createSchema(jsonSchemaToJunctionSchema('Order', FULL_SCHEMA as never))
const FULL = { reference: 'ORD-1', email: 'a@b.co', total: 1, plain: 1, status: 'pending', customerId: 1 }

const messageFor = (data: Record<string, unknown>, field: string) => {
  const result = schema().validate({ ...data })
  return result.errors.find(e => e.field === field)?.message
}

describe('authored messages win over the generated sentence', () => {
  it('required', () => {
    expect(messageFor({ ...FULL, customerId: undefined }, 'customerId'))
      .toBe('Please select a customer from the list')
  })

  it('required, sent explicitly as null', () => {
    expect(messageFor({ ...FULL, customerId: null }, 'customerId'))
      .toBe('Please select a customer from the list')
  })

  it('minLength — looked up by the KEYWORD that failed', () => {
    expect(messageFor({ ...FULL, reference: 'ab' }, 'reference'))
      .toBe('A reference is 3 to 20 characters')
  })

  it('format', () => {
    expect(messageFor({ ...FULL, email: 'nope' }, 'email')).toBe('Bad email')
  })

  it('minimum', () => {
    expect(messageFor({ ...FULL, total: -1 }, 'total')).toBe('No negatives')
  })
})

describe('the generated sentence, when nothing is authored', () => {
  it('uses @label rather than the column name', () => {
    const noMsg = structuredClone(FULL_SCHEMA)
    delete (noMsg.$defs.Order.properties.customerId as Record<string, unknown>)['x-messages']
    const result = createSchema(jsonSchemaToJunctionSchema('Order', noMsg as never))
      .validate({ ...FULL, customerId: undefined })
    expect(result.errors.find(e => e.field === 'customerId')?.message).toBe('Customer is required')
  })

  it('is unchanged for a field with neither label nor message', () => {
    expect(messageFor({ ...FULL, plain: -5 }, 'plain')).toBe('plain must be at least 0')
  })
})

describe('the label never comes from a $ref target', () => {
  it('an enum field is not named after its type', () => {
    // Litestone titles every enum $def with the type name, so a deref'd title
    // would make `status OrderStatus` report itself as "OrderStatus".
    expect(messageFor({ ...FULL, status: 'gold' }, 'status')).toContain('status must be one of')
    expect(messageFor({ ...FULL, status: 'gold' }, 'status')).not.toContain('OrderStatus must be')
  })
})

describe('the error still keys on the real field name', () => {
  it('so a form can find the control, whatever the field is called', () => {
    const result = schema().validate({ ...FULL, customerId: undefined })
    expect(result.errors.map(e => e.field)).toContain('customerId')
    expect(result.errors.map(e => e.field)).not.toContain('Customer')
  })
})
