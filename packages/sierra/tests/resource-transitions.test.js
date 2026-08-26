/**
 * tests/resource-transitions.test.js
 *
 * The third thing the schema carries to the browser: `x-transitions`, a model's
 * declared state machines.
 *
 * A status column's rules normally live in whatever handler was written first,
 * which is why records end up in states nobody meant. Declared on the model, the
 * rules reach the client as data, and the UI renders exactly the legal buttons
 * without a line of its own logic.
 *
 * Like x-gate, the `gate` on a transition is an AFFORDANCE, never a boundary.
 * Litestone re-checks every move at the Data boundary and throws
 * TransitionViolationError / TransitionGateError no matter what the client drew.
 * The assertions below pin the permissive behaviour that follows.
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

const { createResource, buildTransitions, transitionsAt } =
  await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

// Litestone is imported by relative path, not by package name: `bun install`
// resolves workspace:* to a copy under node_modules/.bun, so a package-name
// import would test a stale snapshot of the compiler that produced these defs.
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const LITE = `
  enum OrderStatus { pending  paid  shipped  refunded  cancelled }

  model Order {
    id     Int @id
    status OrderStatus @default(pending)
    note   String?

    @@gate("2.4.4.6")
    @@transitions(status,
      pay:    pending         -> paid,
      ship:   paid            -> shipped,
      refund: paid            -> refunded @gate(5),
      cancel: [pending, paid] -> cancelled)
  }

  model Note { id Int @id  body String }
`

// Generated, not hand-written: the point of this file is that what litestone
// emits is what the browser can act on, so a drift between the two should fail
// here rather than in someone's app.
const { schema, valid, errors } = parse(LITE)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema).$defs

beforeEach(() => registerSchemas(DEFS, ['Order', 'Note']))

describe('the schema actually carries the machine', () => {

  test('generateJsonSchema puts x-transitions on the model, keyed by field', () => {
    expect(DEFS.Order['x-transitions'].status.pay)
      .toEqual({ from: ['pending'], to: 'paid', gate: null })
    expect(DEFS.Order['x-transitions'].status.refund)
      .toEqual({ from: ['paid'], to: 'refunded', gate: 5 })
  })

  test('the enum $def carries none — the model is the only source', () => {
    expect(DEFS.OrderStatus['x-litestone-transitions']).toBeUndefined()
    expect(DEFS.OrderStatus.enum).toContain('refunded')
  })

  test('buildTransitions reads it back', () => {
    expect(Object.keys(buildTransitions(DEFS.Order).status).sort())
      .toEqual(['cancel', 'pay', 'refund', 'ship'])
  })

  test('a model with no machine has none', () => {
    expect(buildTransitions(DEFS.Note)).toBeNull()
    expect(buildTransitions(undefined)).toBeNull()
  })
})

describe('transitionsAt — the button list', () => {
  const spec = () => buildTransitions(DEFS.Order)

  test('only the moves legal from the current state', () => {
    expect(transitionsAt(spec(), { status: 'pending' }, 4).map(t => t.name).sort())
      .toEqual(['cancel', 'pay'])
  })

  test('carries where it came from and where it goes', () => {
    const pay = transitionsAt(spec(), { status: 'pending' }, 4).find(t => t.name === 'pay')
    expect(pay).toEqual({ name: 'pay', field: 'status', from: 'pending', to: 'paid', gate: null, allowed: true, refusedBy: null })
  })

  test("refusedBy is 'gate' or nothing — this half cannot see a policy", () => {
    // The server's answer to the same question may say `'policy'`; a browser
    // holds no policy engine, so a move an @@allow refuses reads as allowed
    // here and is refused at the boundary (`FJS-495`). Asserted so the two
    // shapes cannot quietly diverge again.
    const moves = transitionsAt(spec(), { status: 'paid' }, 4)
    expect(moves.every(t => t.refusedBy === (t.allowed ? null : 'gate'))).toBe(true)
  })

  test('a gated move below the level is reported disabled, not dropped', () => {
    const refund = transitionsAt(spec(), { status: 'paid' }, 4).find(t => t.name === 'refund')
    expect(refund.gate).toBe(5)
    expect(refund.allowed).toBe(false)
  })

  test('the same record reads differently one level up', () => {
    const refund = transitionsAt(spec(), { status: 'paid' }, 5).find(t => t.name === 'refund')
    expect(refund.allowed).toBe(true)
  })

  test('a terminal state offers nothing', () => {
    expect(transitionsAt(spec(), { status: 'refunded' }, 5)).toEqual([])
  })

  test('no level known → permissive, same as canAtLevel', () => {
    // The server is what actually says no; a missing button is the quieter bug.
    expect(transitionsAt(spec(), { status: 'paid' }, undefined).find(t => t.name === 'refund').allowed).toBe(true)
    expect(transitionsAt(spec(), { status: 'paid' }, null).find(t => t.name === 'refund').allowed).toBe(true)
  })

  test('no spec, no row, or a null status → []', () => {
    expect(transitionsAt(null, { status: 'paid' }, 4)).toEqual([])
    expect(transitionsAt(spec(), null, 4)).toEqual([])
    expect(transitionsAt(spec(), { status: null }, 4)).toEqual([])
  })

  test('a state the machine does not mention → []', () => {
    expect(transitionsAt(spec(), { status: 'wat' }, 4)).toEqual([])
  })

  test('each state field on a model is evaluated independently', () => {
    const two = {
      stage: { promote: { from: ['a'], to: 'b', gate: null } },
      phase: { close:   { from: ['open'], to: 'closed', gate: 7 } },
    }
    expect(transitionsAt(two, { stage: 'a', phase: 'open' }, 4).map(t => `${t.field}:${t.name}`))
      .toEqual(['stage:promote', 'phase:close'])
  })
})

describe('on the resource', () => {

  test('createResource derives the button list straight off the schema', () => {
    const orders = createResource('orders')
    expect(orders.transitions({ status: 'paid' }, 4).map(t => t.name).sort())
      .toEqual(['cancel', 'refund', 'ship'])
  })

  test('refund is offered but disabled at USER, enabled at ADMINISTRATOR', () => {
    const orders = createResource('orders')
    expect(orders.transitions({ status: 'paid' }, 4).find(t => t.name === 'refund').allowed).toBe(false)
    expect(orders.transitions({ status: 'paid' }, 5).find(t => t.name === 'refund').allowed).toBe(true)
  })

  test('it sits beside can() and answers about the record, not the operation', () => {
    const orders = createResource('orders')
    expect(orders.can('update', 4)).toBe(true)     // @@gate lets an update through…
    expect(orders.transitions({ status: 'paid' }, 4).find(t => t.name === 'refund').allowed)
      .toBe(false)                                  // …but not this particular one
  })

  test('a model with no machine reports none rather than pretending', () => {
    expect(createResource('notes').transitions({ id: 1 }, 4)).toEqual([])
  })
})
