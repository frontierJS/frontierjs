/**
 * field-messages.test.js — the browser says the sentence the schema declared.
 *
 * `@label("Customer")` and `@required("Please select a customer…")` are written
 * once in db/schema.lite and arrive here as JSON Schema `title` and
 * `x-messages`. Both this module and Junction's autoValidate read them from the
 * same document, which is the whole point: one authored string, not one string
 * per realm that drifts.
 *
 * The label matters more than it looks. A relation's local key is emitted as a
 * plain integer, so a form labeled "customer" was reporting `customerId is
 * required` — the column name, under a label that says something else.
 */

import { describe, test, expect, vi } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => null }))

const { buildFieldRules, validateAgainstFields, fieldLabel } =
  await import('../src/junction/field-rules.js')

const ORDER = {
  type: 'object',
  properties: {
    reference:  {
      type: 'string', minLength: 3, maxLength: 20,
      'x-messages': {
        length: 'A reference is 3 to 20 characters',
        minLength: 'A reference is 3 to 20 characters',
        maxLength: 'A reference is 3 to 20 characters',
      },
    },
    email:      { type: 'string', format: 'email', 'x-messages': { email: 'Bad email', format: 'Bad email' } },
    total:      { type: 'number', minimum: 0, 'x-messages': { gte: 'No negatives', minimum: 'No negatives' } },
    plain:      { type: 'number', minimum: 0 },
    status:     { $ref: '#/$defs/OrderStatus' },
    customerId: {
      type: 'integer',
      title: 'Customer',
      'x-messages': { required: 'Please select a customer from the list' },
    },
  },
  required: ['reference', 'customerId', 'status'],
  'x-relations': [
    { field: 'customer', model: 'Customer', type: 'belongsTo',
      fields: ['customerId'], references: ['id'], optional: false },
  ],
}

const DEFS = { Order: ORDER, OrderStatus: { type: 'string', enum: ['pending', 'paid'], title: 'OrderStatus' } }
const resolve = (ref) => DEFS[String(ref).replace(/^#\/\$defs\//, '')] ?? null
const rules = () => buildFieldRules(ORDER, resolve)

describe('fieldLabel', () => {
  test('prefers @label', () => {
    expect(fieldLabel('customerId', rules().customerId)).toBe('Customer')
  })

  test('falls back to the relation name for an unlabelled foreign key', () => {
    const noLabel = structuredClone(ORDER)
    delete noLabel.properties.customerId.title
    // No authoring at all, and it still stops saying `customerId`.
    expect(fieldLabel('customerId', buildFieldRules(noLabel, resolve).customerId)).toBe('customer')
  })

  test('falls back to the field name for everything else', () => {
    expect(fieldLabel('reference', rules().reference)).toBe('reference')
  })

  test('never borrows a $ref target\'s title — that is the TYPE name', () => {
    // Litestone titles every enum $def with the type name, so following the ref
    // would make `status OrderStatus` introduce itself as "OrderStatus".
    expect(rules().status.title).toBeUndefined()
    expect(fieldLabel('status', rules().status)).toBe('status')
  })
})

describe('authored messages win over the generated sentence', () => {
  const messageFor = (data, field) =>
    validateAgainstFields(rules(), data, 'create').find(e => e.field === field)?.message

  const full = { reference: 'ORD-1', email: 'a@b.co', total: 1, plain: 1, status: 'pending', customerId: 1 }

  test('required', () => {
    expect(messageFor({ ...full, customerId: null }, 'customerId'))
      .toBe('Please select a customer from the list')
  })

  test('minLength — looked up by the KEYWORD that failed', () => {
    expect(messageFor({ ...full, reference: 'ab' }, 'reference'))
      .toBe('A reference is 3 to 20 characters')
  })

  test('format', () => {
    expect(messageFor({ ...full, email: 'nope' }, 'email')).toBe('Bad email')
  })

  test('minimum', () => {
    expect(messageFor({ ...full, total: -1 }, 'total')).toBe('No negatives')
  })
})

describe('the generated sentence, when nothing is authored', () => {
  const messageFor = (data, field) =>
    validateAgainstFields(rules(), data, 'create').find(e => e.field === field)?.message
  const full = { reference: 'ORD-1', email: 'a@b.co', total: 1, plain: 1, status: 'pending', customerId: 1 }

  test('uses the label, not the column', () => {
    const noMsg = structuredClone(ORDER)
    delete noMsg.properties.customerId['x-messages']
    const errs = validateAgainstFields(buildFieldRules(noMsg, resolve), { ...full, customerId: null }, 'create')
    expect(errs.find(e => e.field === 'customerId').message).toBe('Customer is required')
  })

  test('is unchanged for a field with neither label nor message', () => {
    expect(messageFor({ ...full, plain: -5 }, 'plain')).toBe('plain must be at least 0')
  })

  test('the error still keys on the real field name, whatever it is called', () => {
    const errs = validateAgainstFields(rules(), { ...full, customerId: null }, 'create')
    expect(errs.find(e => e.field === 'customerId')).toBeTruthy()   // not 'Customer'
  })
})
