/**
 * test/resource-commitments.test.js
 *
 * `x-commitments` — what the system owes a row and when — read back as the
 * date a screen shows. The counterpart of resource-transitions.test.js for the
 * moves no button makes: a `@system` move is left off a screen's buttons, and
 * this is where it comes back.
 *
 * The date is `@frontierjs/toolbelt/datetime`'s `dueAt`, the function
 * litestone's `due()` answers with, so WHEN cannot disagree. What this file
 * pins is the other half — whether it is still owed — graded off the row the
 * screen holds, permissive where the row does not say.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({ find: async () => ({ data: [] }), on: () => {} }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource, buildCommitments, commitmentsAt } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

// By relative path, for resource-transitions.test.js's reason: a package-name
// import resolves a stale copy under node_modules/.bun.
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const LITE = `
  enum OrderStatus { pending paid cancelled }
  enum SubStatus   { active pastDue cancelled }
  enum BillStatus  { issued paid }

  model Order {
    id        Int         @id
    status    OrderStatus @default(pending)
    createdAt DateTime    @default(now())
    @@transitions(status,
      pay:     pending -> paid,
      abandon: pending -> cancelled @system)
    @@commitment(abandon, on: createdAt + 14d)
  }

  model Subscription {
    id       Int       @id
    status   SubStatus @default(active)
    invoices Invoice[]
    @@transitions(status,
      lapse:  active -> pastDue @system,
      cancel: [active, pastDue] -> cancelled @system)
  }

  model Invoice {
    id             Int           @id
    status         BillStatus    @default(issued)
    subscription   Subscription? @relation(fields: [subscriptionId], references: [id])
    subscriptionId Int?
    dueOn          String        @date
    graceDays      Int           @unit(d) @immutable
    dunningDays    Int           @unit(d) @immutable
    @@transitions(status, settle: issued -> paid)
    @@commitment(subscription.lapse,  on: dueOn + graceDays,   while: status == 'issued')
    @@commitment(subscription.cancel, on: dueOn + dunningDays, while: status == 'issued')
  }

  model Note { id Int @id  body String }
`

const { schema, valid, errors } = parse(LITE)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema).$defs

beforeEach(() => registerSchemas(DEFS, ['Order', 'Subscription', 'Invoice', 'Note']))

const bill = (over = {}) => ({ id: 1, status: 'issued', subscriptionId: 7, dueOn: '2026-01-09', graceDays: 3, dunningDays: 21, ...over })

describe('commitmentsAt — on the row itself', () => {
  const spec = () => buildCommitments(DEFS.Order)

  test('the date the abandon falls due, off the row', () => {
    expect(commitmentsAt(spec(), { status: 'pending', createdAt: '2026-09-21T10:00:00.000Z' })).toEqual([
      { name: 'abandon', transition: 'abandon', via: null, target: 'Order', dueAt: '2026-10-05T10:00:00.000Z', kind: 'instant' },
    ])
  })

  test('a row that has already moved owes nothing', () => {
    expect(commitmentsAt(spec(), { status: 'paid', createdAt: '2026-09-21T10:00:00.000Z' })).toEqual([])
  })

  test('a null anchor is not owed yet', () => {
    expect(commitmentsAt(spec(), { status: 'pending', createdAt: null })).toEqual([])
  })

  test('a model declaring none has none', () => {
    expect(buildCommitments(DEFS.Note)).toBeNull()
    expect(commitmentsAt(null, { id: 1 })).toEqual([])
  })
})

describe('commitmentsAt — across a relation (FJS-D362)', () => {
  const spec = () => buildCommitments(DEFS.Invoice)
  const names = (list) => list.map(c => `${c.name} ${c.dueAt}`)

  test('both dates, off the invoice’s own terms', () => {
    expect(names(commitmentsAt(spec(), bill(), { target: { status: 'active' } })))
      .toEqual(['subscription.lapse 2026-01-12', 'subscription.cancel 2026-01-30'])
  })

  test('the target’s from-state decides — a pastDue subscription owes the cancel and not the lapse', () => {
    expect(names(commitmentsAt(spec(), bill(), { target: { status: 'pastDue' } })))
      .toEqual(['subscription.cancel 2026-01-30'])
    expect(commitmentsAt(spec(), bill(), { target: { status: 'cancelled' } })).toEqual([])
  })

  test('the relation as the row carries it, when no target is passed', () => {
    expect(names(commitmentsAt(spec(), bill({ subscription: { status: 'pastDue' } }))))
      .toEqual(['subscription.cancel 2026-01-30'])
  })

  test('target: null is *there is none*, which owes nothing — due() answers a null relation the same', () => {
    expect(commitmentsAt(spec(), bill({ subscriptionId: null }), { target: null })).toEqual([])
    expect(commitmentsAt(spec(), bill({ subscription: null }))).toEqual([])
  })

  test('a target nobody read is not graded — permissive, both dates', () => {
    expect(commitmentsAt(spec(), bill())).toHaveLength(2)
  })

  test('while: — a paid invoice holds both', () => {
    expect(commitmentsAt(spec(), bill({ status: 'paid' }), { target: { status: 'active' } })).toEqual([])
  })
})

describe('createResource', () => {
  test('commitments() sits beside transitions() and reads the same schema', () => {
    const orders = createResource('orders')
    const row = { status: 'pending', createdAt: '2026-09-21T10:00:00.000Z' }
    // The move is @system, so no button — and the date is what comes back.
    expect(orders.transitions(row, 9).find(t => t.name === 'abandon').allowed).toBe(false)
    expect(orders.commitments(row).map(c => c.dueAt)).toEqual(['2026-10-05T10:00:00.000Z'])
  })

  test('a resource passes { target } through', () => {
    const invoices = createResource('invoices')
    expect(invoices.commitments(bill(), { target: { status: 'pastDue' } }).map(c => c.name))
      .toEqual(['subscription.cancel'])
  })

  test('a model declaring none answers [] rather than pretending', () => {
    expect(createResource('notes').commitments({ id: 1 })).toEqual([])
  })
})
