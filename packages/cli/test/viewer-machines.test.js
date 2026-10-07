// ─── viewer-machines.test.js — the machines and warden panels' readings ───────
//
// Both panels draw a verdict a reader acts on — *who may make this move*, *what
// does a level-4 caller reach* — and both are computed in the page from the map,
// so a wrong one renders as a confident picture. The pure halves are graded
// here; the drawing is proved by opening the served page.
//
// Every negative is paired with the positive beside it: a `kind` that answered
// 'person' for everything, or a `wardenAt` refusing everything, would satisfy
// the negatives alone.

import { describe, test, expect } from 'bun:test'
import { loadViewer }             from './viewer-page.js'

const { buildMachines, layoutMachine, wardenAt } = loadViewer(['buildMachines', 'layoutMachine', 'wardenAt'])

// The shape `litestone jsonschema` writes: moves under x-transitions, timed
// moves under x-commitments on the model that DECLARES them, which need not be
// the model they move.
const defs = {
  OrderStatus: { type: 'string', enum: ['pending', 'paid', 'shipped', 'refunded', 'cancelled', 'lost'] },
  Order: {
    'x-litestone-kind': 'model',
    description: 'A purchase.  Second paragraph that is not the note.',
    'x-gate': { read: 1, create: 4, update: 4, delete: 5 },
    properties: { status: { $ref: '#/$defs/OrderStatus', default: 'pending' } },
    'x-transitions': { status: {
      pay:     { from: ['pending'],         to: 'paid',      gate: null, system: false },
      ship:    { from: ['paid'],            to: 'shipped',   gate: null, system: false },
      refund:  { from: ['paid'],            to: 'refunded',  gate: 5,    system: false },
      cancel:  { from: ['pending', 'paid'], to: 'cancelled', gate: null, system: false },
      abandon: { from: ['pending'],         to: 'cancelled', gate: null, system: true },
      settle:  { from: ['shipped'],         to: 'shipped',   gate: 3,    system: false },
      // a self-loop with a wide label: drawn as an arc beside its state
      'reopen-for-correction': { from: ['shipped'], to: 'shipped', gate: 5, system: false },
    } },
    'x-commitments': {
      abandon: { via: null, transition: 'abandon', target: 'Order', field: 'status', from: ['pending'],
                 on: 'createdAt', kind: 'instant', offset: { sign: 1, value: 14, unit: 'd' }, while: null },
    },
  },
  Invoice: {
    'x-litestone-kind': 'model',
    'x-gate': { read: 1, create: 8, update: 4, delete: 8 },
    properties: { status: { type: 'string', default: 'issued' } },
    'x-transitions': { status: {
      issue: { from: ['draft'],  to: 'issued', gate: null, system: true },
      pay:   { from: ['issued'], to: 'paid',   gate: null, system: true },
    } },
    'x-commitments': {
      'subscription.lapse': { via: 'subscription', transition: 'lapse', target: 'Subscription', field: 'status',
        from: ['active'], on: 'dueOn', kind: 'day', offset: { sign: 1, field: 'graceDays', unit: 'd' },
        while: { type: 'compare', op: '==', left: { type: 'field', name: 'status' }, right: { type: 'literal', value: 'issued' } } },
    },
  },
  Subscription: {
    'x-litestone-kind': 'model',
    'x-gate': { read: 4, create: 4, update: 4, delete: 5 },
    properties: { status: { type: 'string', default: 'active' } },
    'x-transitions': { status: {
      lapse:   { from: ['active'],  to: 'pastDue', gate: null, system: true },
      recover: { from: ['pastDue'], to: 'active',  gate: null, system: true },
    } },
  },
  Note: { 'x-litestone-kind': 'model', properties: {} },
}

// `orders` is how a service reports its model when it was built off the
// accessor, which the map carries verbatim.
const services = [{ name: 'orders', model: 'orders', customMethods: ['pay', 'refund'], channel: 'orders' }]
const access = { models: [{ name: 'Invoice', transitions: [{ field: 'status', name: 'issue', seals: true }] }] }

const machines = buildMachines(defs, services, access)
const machine  = (model) => machines.find(m => m.model === model)
const move     = (model, name) => machine(model).moves.find(m => m.name === name)

describe('buildMachines', () => {
  test('one machine per @@transitions column, and none for a model without one', () => {
    expect(machines.map(m => m.model).sort()).toEqual(['Invoice', 'Order', 'Subscription'])
  })

  test('a move is drawn by who makes it', () => {
    expect(move('Order', 'pay').kind).toBe('person')
    expect(move('Order', 'refund').kind).toBe('gated')
    expect(move('Order', 'abandon').kind).toBe('timed')
    expect(move('Invoice', 'issue').kind).toBe('app')
  })

  // A move gated at or below the update level is graded by the update level
  // anyway (FJS-D511), so calling it gated would draw a restriction nobody has.
  test('a move gate at or below the update level is not a higher level', () => {
    expect(move('Order', 'settle').kind).toBe('person')
    expect(move('Order', 'refund').kind).toBe('gated')
  })

  // 8 is asSystem() alone, so a move nobody below the app can make is drawn
  // as the app's whether the 8 is the model's update level or the move's own.
  test('a move graded at 8 is the app\'s', () => {
    const m = buildMachines({
      Run: { 'x-litestone-kind': 'model', 'x-gate': { read: 4, create: 8, update: 8, delete: 8 },
             properties: { status: { type: 'string', default: 'pending' } },
             'x-transitions': { status: { start: { from: ['pending'], to: 'running', gate: null, system: false } } } },
      Job: { 'x-litestone-kind': 'model', 'x-gate': { read: 4, create: 4, update: 4, delete: 4 },
             properties: { status: { type: 'string', default: 'open' } },
             'x-transitions': { status: {
               seal:  { from: ['open'], to: 'sealed', gate: 8,    system: false },
               close: { from: ['open'], to: 'closed', gate: null, system: false } } } },
    })
    const kind = (model, name) => m.find(x => x.model === model).moves.find(x => x.name === name).kind
    expect(kind('Run', 'start')).toBe('app')
    expect(kind('Job', 'seal')).toBe('app')
    expect(kind('Job', 'close')).toBe('person')
  })

  test('a timed move declared on another model reaches the machine it moves, from both ends', () => {
    expect(move('Subscription', 'lapse').kind).toBe('timed')
    expect(machine('Subscription').incoming.map(t => t.owner)).toEqual(['Invoice'])
    expect(machine('Invoice').outgoing.map(t => t.transition)).toEqual(['lapse'])
    expect(move('Subscription', 'recover').kind).toBe('app')
  })

  test('the entry, the final states and a state nothing moves into', () => {
    const o = machine('Order')
    expect(o.entry).toBe('pending')
    expect(o.terminal.sort()).toEqual(['cancelled', 'refunded'])
    expect(o.unreached).toEqual(['lost'])
    // shipped has a move out (a self-loop), so it is not final
    expect(o.terminal).not.toContain('shipped')
  })

  test('a model with no enum still lists every state its moves name', () => {
    expect(machine('Invoice').states.sort()).toEqual(['draft', 'issued', 'paid'])
  })

  test('@seals comes from the access reading', () => {
    expect(move('Invoice', 'issue').seals).toBe(true)
    expect(move('Invoice', 'pay').seals).toBe(false)
  })

  test('a service reported by its accessor still binds to its model', () => {
    expect(machine('Order').services).toEqual(['orders'])
    expect(machine('Order').channel).toBe('orders')
    expect(move('Order', 'refund').methods).toEqual(['orders.refund()'])
    expect(move('Order', 'ship').methods).toEqual([])
  })

  test('the note is the first paragraph of the model description', () => {
    expect(machine('Order').note).toBe('A purchase.')
    expect(machine('Invoice').note).toBe('')
  })
})

describe('layoutMachine', () => {
  const boxes = (L) => L.states.map(s => ({ x0: s.cx - s.w / 2, x1: s.cx + s.w / 2, y0: s.cy - s.h / 2, y1: s.cy + s.h / 2, s }))
  const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

  const L = layoutMachine(machine('Order'))

  test('every state is placed once and no two overlap', () => {
    expect(L.states.map(s => s.state).sort()).toEqual(machine('Order').states.slice().sort())
    const b = boxes(L)
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) expect(overlap(b[i], b[j])).toBe(false)
  })

  test('the entry is leftmost and the final states share the last column', () => {
    const x = Object.fromEntries(L.states.map(s => [s.state, s.cx]))
    expect(Math.min(...Object.values(x))).toBe(x.pending)
    expect(x.refunded).toBe(x.cancelled)
    expect(x.refunded).toBeGreaterThan(x.paid)
  })

  // pending -> cancelled spans two columns; its label takes a slot of its own
  // rather than sitting on paid, which is in the column it crosses.
  test('no move label sits on a state', () => {
    const b = boxes(L)
    for (const e of L.edges) {
      const lab = { x0: e.lx - e.lw / 2, x1: e.lx + e.lw / 2, y0: e.ly - L.labelH / 2, y1: e.ly + L.labelH / 2 }
      for (const s of b) expect(overlap(lab, s)).toBe(false)
    }
  })

  test('every move is drawn, with a path', () => {
    expect([...new Set(L.edges.map(e => e.mv.name))].sort()).toEqual(machine('Order').moves.map(m => m.name).sort())
    for (const e of L.edges) expect(e.d.startsWith('M')).toBe(true)
  })

  // cancel leaves pending AND paid: one label both lines run into, not two
  // labels reading as two moves.
  test('a forward move out of several states is one label', () => {
    const cancel = L.edges.filter(e => e.mv.name === 'cancel')
    expect(cancel.length).toBe(1)
    expect(cancel[0].from.sort()).toEqual(['paid', 'pending'])
    expect(cancel[0].d.match(/M/g).length).toBe(3)
    expect(L.edges.filter(e => e.mv.name === 'pay').length).toBe(1)
  })

  test('the viewBox holds every state', () => {
    for (const s of L.states) {
      expect(s.cx - s.w / 2 + L.dx).toBeGreaterThanOrEqual(0)
      expect(s.cx + s.w / 2 + L.dx).toBeLessThanOrEqual(L.width)
      expect(s.cy - s.h / 2 + L.dy).toBeGreaterThanOrEqual(0)
      expect(s.cy + s.h / 2 + L.dy).toBeLessThanOrEqual(L.height)
    }
  })
})

describe('wardenAt', () => {
  // The shape `litestone access --json` writes for one model.
  const invoice = {
    name: 'Invoice', gate: { read: 1, create: 8, update: 4, delete: 9 },
    policies: { read: { allows: [{ expr: 'userId == auth().id' }], denies: [] } },
    transitions: [
      { field: 'status', name: 'void',  gate: 5,    system: false },
      { field: 'status', name: 'issue', gate: null, system: true },
      { field: 'status', name: 'note',  gate: null, system: false },
    ],
  }

  test('a level below the gate is refused, at or above it is let through', () => {
    const v = wardenAt(invoice, 4)
    expect(v.ops.create.ok).toBe(false)
    expect(v.ops.update.ok).toBe(true)
  })

  test('a row policy filters rather than refuses, and lifts for a system call', () => {
    expect(wardenAt(invoice, 4).ops.read).toMatchObject({ ok: true, filtered: true })
    expect(wardenAt(invoice, 8).ops.read).toMatchObject({ ok: true })
    expect(wardenAt(invoice, 8).ops.read.filtered).toBeUndefined()
  })

  test('9 is locked even for a system call', () => {
    expect(wardenAt(invoice, 8).ops.delete.ok).toBe(false)
    expect(wardenAt(invoice, 8).ops.create.ok).toBe(true)
  })

  test("a move's gate floors the update level, and an @system move is the app's alone", () => {
    const at = (L, name) => wardenAt(invoice, L).moves.find(m => m.name === name).ok
    expect(at(4, 'void')).toBe(false)
    expect(at(5, 'void')).toBe(true)
    expect(at(4, 'note')).toBe(true)
    expect(at(3, 'note')).toBe(false)
    expect(at(7, 'issue')).toBe(false)
    expect(at(8, 'issue')).toBe(true)
  })

  test('a model with no gate is open', () => {
    expect(wardenAt({ name: 'Free', gate: null }, 0).ops.delete.ok).toBe(true)
  })
})
