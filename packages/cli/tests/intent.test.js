// tests/intent.test.js — the resolver against `example`'s REAL seed and snapshots.
//
// Every case is a row of `IDEAS/intent-recognizer-run-1.md`, written as the
// candidate a translator would emit, and asserted against the verdict run 1
// reached BY HAND. A fixture schema would let the resolver agree with whatever
// the fixture happened to say; the committed artefacts are what it will read in
// use, and CI already fails them stale.
//
// The rows that matter most are the negative ones: A24, the one run 1 got wrong
// from the seed alone; the identifier refusal; ambiguity resolving to nothing
// rather than to the likelier match; and dark mode, where two requests that read
// alike must NOT share an identity.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFile } from '../../litestone/src/core/parser.js'
import { buildIndex, recognize, checkCandidate, resolve, menu, parseSurface, parseRoutes, parseNotifications } from '../core/intent.js'

const EXAMPLE = join(import.meta.dir, '..', '..', '..', 'example')
const read = (p) => readFileSync(join(EXAMPLE, p), 'utf8')

const parsed = parseFile(join(EXAMPLE, 'db', 'schema.lite'))
const index  = buildIndex({
  schema:        parsed.schema,
  surface:       read('api/surface.snapshot.md'),
  routes:        read('web/routes.snapshot.md'),
  notifications: read('api/notifications.snapshot.md'),
})

const ask = (claim, ...facts) => recognize(index, { claim, facts })

describe('the index is the committed artefacts', () => {
  test('the snapshots parse into what they state', () => {
    const invoices = parseSurface(read('api/surface.snapshot.md')).find(s => s.name === 'invoices')
    expect(invoices).toMatchObject({ model: 'Invoice', custom: ['settle', 'void'] })
    expect(parseRoutes(read('web/routes.snapshot.md')).some(r => r.path === '/invoices/')).toBe(true)
    expect(parseNotifications(read('api/notifications.snapshot.md')).map(n => n.type)).toContain('OrderPaid')
  })

  test('a parse that read nothing would pass every verdict below vacuously, so the counts are asserted', () => {
    expect(index.entries.filter(e => e.type === 'model').length).toBeGreaterThan(30)
    expect(index.entries.filter(e => e.type === 'move').length).toBeGreaterThan(10)
    expect(index.entries.filter(e => e.type === 'method').length).toBeGreaterThan(10)
  })
})

describe('a candidate names nothing', () => {
  test('an identifier in any word is refused, and the same fact in plain words is accepted', () => {
    for (const words of ['Customer.notes', 'preferredContactTime', 'contact_time']) {
      expect(checkCandidate({ claim: 'question', facts: [{ kind: 'attribute', about: 'customer', words }] }).join(' '))
        .toMatch(/names something/)
    }
    expect(checkCandidate({ claim: 'question', facts: [{ kind: 'attribute', about: 'customer', words: 'preferred contact time' }] })).toEqual([])
    expect(recognize(index, { claim: 'question', facts: [{ kind: 'attribute', about: 'customer', words: 'Customer.notes' }] }).refused).toBeTruthy()
  })
})

describe('run 1, row by row', () => {
  test('A1 — a private note on a customer: exists, and not every caller reads it', () => {
    const r = ask('question', { kind: 'attribute', about: 'customer', words: 'note' })
    expect(r.verdict).toBe('exists')
    expect(r.facts[0].target).toBe('Customer.notes')
    expect(r.facts[0].notes).toContain('not every caller may read it')
  })

  test('A1 and B1 dedupe by the resolved target, not the words', () => {
    const a1 = ask('question', { kind: 'attribute', about: 'customer', words: 'note' })
    const b1 = ask('question', { kind: 'attribute', about: 'customers', words: 'notes' })
    expect(a1.identity).toBe(b1.identity)
  })

  test('A7 — correct only the payslip: declined by design, because the figures are immutable', () => {
    const r = ask('change', { kind: 'edit', about: 'payslip', words: 'net' })
    expect(r.verdict).toBe('declined by design')
    expect(r.facts[0].why).toMatch(/@immutable/)
  })

  test('A17 — every invoice as a file: one declaration, no migration', () => {
    const r = ask('change', { kind: 'export', about: 'invoice' })
    expect(r).toMatchObject({ verdict: 'needs us', depth: 'data-declaration' })
  })

  test('A22 — undo a mistaken ship: one missing edge', () => {
    const r = ask('change', { kind: 'move', about: 'order', from: 'shipped', to: 'paid' })
    expect(r).toMatchObject({ verdict: 'needs us', depth: 'data-declaration' })
    expect(r.facts[0].why).toMatch(/one edge/)
  })

  test('A22 and B17 are one target', () => {
    const a22 = ask('change', { kind: 'move', about: 'order', from: 'shipped', to: 'paid' })
    const b17 = ask('change', { kind: 'move', about: 'orders', from: 'shipped', to: 'paid' })
    expect(a22.identity).toBe(b17.identity)
  })

  test('A24 — mark invoices paid: the seed alone says no, and the surface says a person can', () => {
    const r = ask('question', { kind: 'move', about: 'invoice', to: 'paid' })
    expect(r.verdict).toBe('you can do this')
    expect(r.facts[0].target).toBe('invoices.settle')
  })

  test('the same @system move with no method beside it is declined — the control for A24', () => {
    const r = ask('question', { kind: 'move', about: 'invoice', words: 'issue' })
    expect(r.verdict).toBe('declined by design')
  })

  test('A29 — change the size on an order line: declined, only the system writes it', () => {
    const r = ask('change', { kind: 'edit', about: 'order line', words: 'quantity' })
    expect(r.verdict).toBe('declined by design')
  })

  test('A14 — a photo per variant: the data is there, only a screen is missing', () => {
    const r = ask('change', { kind: 'display', about: 'product image', words: 'variant' })
    expect(r).toMatchObject({ verdict: 'needs us', depth: 'ui' })
    expect(r.facts[0].unverified).toEqual(['screen'])
  })

  test('B21 — tag customers: the words miss, so unhomed, and the pool is said rather than promised', () => {
    const r = ask('change', { kind: 'attribute', about: 'customer', words: 'tag' })
    expect(r.verdict).toBe('unhomed')
    expect(r.facts[0].notes.join(' ')).toMatch(/pool of custom fields/)
  })

  test('B29 — rewards points: no model matches, which is not proof none holds it', () => {
    const r = ask('change', { kind: 'entity', words: 'reward point' })
    expect(r.verdict).toBe('unhomed')
  })

  test('B2 — a count disagrees with the shelf: an incident, routed, with where the truth is kept', () => {
    const r = ask('broken', { kind: 'attribute', about: 'stock reservation', words: 'quantity' })
    expect(r.verdict).toBe('incident')
    expect(r.facts[0].target).toBe('StockReservation')
  })

  test('A20 — "the whole store in one second": nothing matches, and it says so', () => {
    const r = ask('change', { kind: 'display', about: 'whole store', words: 'speed' })
    expect(r.verdict).toBe('unhomed')
  })

  test('A28 / B5 — dark mode on two surfaces must not share an identity', () => {
    // Neither surface is in the seed, so both are unhomed today — and an unhomed
    // candidate has NO identity, which is what keeps them apart rather than
    // grouping every miss together as one.
    const web  = ask('change', { kind: 'display', about: 'console', words: 'dark mode' })
    const site = ask('change', { kind: 'display', about: 'storefront', words: 'dark mode' })
    expect(web.identity).toBeNull()
    expect(site.identity).toBeNull()
  })
})

describe('a miss is not an absence', () => {
  // Run 2: "private note" and "due date" name fields that exist, and the resolver
  // answered "you can do this" and "needs us" off the model alone.
  test('words that miss a field that exists come back unhomed — paired with the words that hit it', () => {
    expect(ask('question', { kind: 'attribute', about: 'customer', words: 'private note' }).verdict).toBe('unhomed')
    expect(ask('question', { kind: 'attribute', about: 'customer', words: 'note' }).verdict).toBe('exists')
    expect(ask('question', { kind: 'attribute', about: 'invoice', words: 'due date' }).verdict).toBe('unhomed')
    expect(ask('question', { kind: 'attribute', about: 'invoice', words: 'due' }).verdict).toBe('exists')
  })

  test('a method, a notification, a view and an action that miss claim nothing', () => {
    for (const f of [
      { kind: 'method', about: 'order', words: 'teleport' },
      { kind: 'notification', about: 'order', words: 'carrier pigeon' },
      { kind: 'view', about: 'order', words: 'horoscope' },
      { kind: 'action', about: 'order', words: 'print labels' },
    ]) expect(ask('change', f).verdict).toBe('unhomed')
  })

  test('a broken report about nothing the seed names is unhomed; about a model, still an incident', () => {
    expect(ask('broken', { kind: 'display', about: 'checkout page', words: 'slow' }).verdict).toBe('unhomed')
    expect(ask('broken', { kind: 'attribute', about: 'order', words: 'shipping' }).verdict).toBe('incident')
  })
})

describe('ambiguity resolves to nothing', () => {
  test('words that match more than one thing come back unhomed naming them all', () => {
    const hit = resolve(index, 'status', e => e.type === 'field')
    expect(hit.status).toBe('ambiguous')
    const r = ask('question', { kind: 'attribute', about: 'thing', words: 'status' })
    expect(r.verdict).toBe('unhomed')
  })
})

describe('a pick off the menu', () => {
  test('a pick answers where the words missed — paired with the same words unpicked', () => {
    expect(ask('question', { kind: 'attribute', about: 'invoice', words: 'due date' }).verdict).toBe('unhomed')
    const r = ask('question', { kind: 'attribute', about: 'invoice', words: 'due date', pick: 'Invoice.dueAt' })
    expect(r.verdict).toBe('exists')
    expect(r.facts[0]).toMatchObject({ target: 'Invoice.dueAt', tier: 'pick' })
  })

  test('the verdict is still the resolver’s: a picked @immutable field is declined for an edit', () => {
    const r = ask('change', { kind: 'edit', words: 'the amount', pick: 'Payslip.net' })
    expect(r.verdict).toBe('declined by design')
  })

  test('a pick not on the menu is refused, and every menu id is one the index holds', () => {
    expect(ask('question', { kind: 'attribute', words: 'x', pick: 'Invoice.madeUp' }).verdict).toBe('unhomed')
    const ids = new Set(index.entries.map(e => e.id))
    const m = menu(index)
    expect(m.length).toBe(index.entries.length)
    expect(m.every(e => ids.has(e.id))).toBe(true)
  })
})
