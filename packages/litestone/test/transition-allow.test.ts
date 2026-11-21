// test/transition-allow.test.ts
//
// A move's `@allow` (`FJS-D1025`): `finalize: open -> final @allow(…)` is a row
// predicate over the PRE-state row, graded beside the move's `@gate` and
// refused the same way, with TransitionGateError. It limits the move and no
// other write, which `@@allow(update, …)` cannot say.
//
// Each refusal is paired with the same move admitted for the caller it names.
// Expected verdicts are written by hand from the seed below (`FJS-597`).

import { describe, test, expect } from 'bun:test'
import { createClient, parse, GatePlugin, TransitionGateError, BulkTransitionError } from '../src/index.js'

const FINANCE = `organization.memberships.some(userId == auth().id && role == 'finance')`

const SCHEMA = `
enum InvoiceState { open  final  void }
enum PaymentState { pending  approved }
model User { id String @id  @@auth }
model Organization {
  id          String       @id
  memberships Membership[]
  invoices    Invoice[]
}
model Membership {
  id             String       @id
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  userId         String
  role           String
  @@index([organizationId])
}
model Invoice {
  id             String       @id
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  note           String?
  state          InvoiceState @default(open)
  payments       Payment[]
  @@index([organizationId])
  @@transitions(state,
    finalize: open -> final @allow(${FINANCE}),
    void:     [open, final] -> void @gate(2) @allow(${FINANCE})
  )
}
model Payment {
  id        String       @id
  invoiceId String
  invoice   Invoice      @relation(fields: [invoiceId], references: [id])
  state     PaymentState @default(pending)
  @@index([invoiceId])
  @@transitions(state,
    approve: pending -> approved @allow(invoice.organization.memberships.some(userId == auth().id && role == 'finance'))
  )
}`

// Ann is finance in ACME; Bob is support in ACME and finance in GLOBEX, the
// person a per-request role claim would grade by the wrong org.
async function env() {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  const sys = db.asSystem()
  await sys.organization.create({ data: { id: 'ACME' } })
  await sys.organization.create({ data: { id: 'GLOBEX' } })
  await sys.membership.create({ data: { id: 'm1', organizationId: 'ACME',   userId: 'ann', role: 'finance' } })
  await sys.membership.create({ data: { id: 'm2', organizationId: 'ACME',   userId: 'bob', role: 'support' } })
  await sys.membership.create({ data: { id: 'm3', organizationId: 'GLOBEX', userId: 'bob', role: 'finance' } })
  await sys.invoice.create({ data: { id: 'i1', organizationId: 'ACME' } })
  await sys.invoice.create({ data: { id: 'i2', organizationId: 'ACME' } })
  await sys.payment.create({ data: { id: 'p1', invoiceId: 'i1' } })
  const as = (id: string, level = 0) => db.$setAuth({ id, level })
  return { db, sys, as }
}

async function refusal(p: Promise<unknown>) {
  try { await p; return null } catch (e) { return e as any }
}

describe('parse', () => {
  test('@allow is a move attribute holding its predicate, beside @gate', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const t = r.schema.models.find((m: { name: string }) => m.name === 'Invoice')
      .attributes.find((a: { kind: string }) => a.kind === 'transitions').transitions
    expect(t.finalize.gate).toBe(null)
    expect(t.finalize.allow.type).toBe('some')
    expect(t.void.gate).toBe(2)
    expect(t.void.allow.type).toBe('some')
  })

  test('@allow stated twice, or with no predicate, is a parse error', () => {
    expect(parse(SCHEMA.replace(`@allow(${FINANCE}),`, `@allow(note == 'a') @allow(note == 'b'),`)).errors.join('\n'))
      .toMatch(/@allow stated twice/)
    expect(parse(SCHEMA.replace(`@allow(${FINANCE}),`, `@allow,`)).errors.join('\n'))
      .toMatch(/@allow takes a predicate/)
  })

  test('an @allow naming no field is refused at createClient', async () => {
    await expect(createClient({ schema: SCHEMA.replace(`@allow(${FINANCE}),`, `@allow(nite == 'a'),`), db: ':memory:' }))
      .rejects.toThrow(/'nite' is not a field.*@@transitions\(state\) 'finalize' @allow/)
  })
})

describe('@allow grades the move on the row before it', () => {
  test('a finance member of the row\'s org makes the move, through transition() and update()', async () => {
    const { as } = await env()
    expect((await as('ann').invoice.transition('i1', 'finalize')).state).toBe('final')
    expect((await as('ann').invoice.update({ where: { id: 'i2' }, data: { state: 'final' } })).state).toBe('final')
  })

  test('a support member of the same org is refused by name, and the row does not move', async () => {
    const { sys, as } = await env()
    const e = await refusal(as('bob').invoice.transition('i1', 'finalize'))
    expect(e).toBeInstanceOf(TransitionGateError)
    expect(e.transition).toBe('finalize')
    expect(e.allow).toBe(true)
    expect(e.required).toBe(null)
    expect(e.status).toBe(403)
    expect(e.message).toBe(`Transition 'finalize' on invoice.state is refused by its @allow on this row`)
    expect(await refusal(as('bob').invoice.update({ where: { id: 'i1' }, data: { state: 'final' } })))
      .toBeInstanceOf(TransitionGateError)
    expect((await sys.invoice.findUnique({ where: { id: 'i1' } })).state).toBe('open')
  })

  // The case a per-request role claim gets wrong: Bob IS finance, in GLOBEX.
  test('finance in another org is not finance in this one', async () => {
    const { db, sys, as } = await env()
    const g = await sys.invoice.create({ data: { id: 'g1', organizationId: 'GLOBEX' } })
    expect((await as('bob').invoice.transition(g.id, 'finalize')).state).toBe('final')
    expect(await refusal(as('bob').invoice.transition('i1', 'finalize'))).toBeInstanceOf(TransitionGateError)
    void db
  })

  test('no auth() is UNKNOWN, and @allow holds only on TRUE', async () => {
    const { db } = await env()
    expect(await refusal(db.invoice.transition('i1', 'finalize'))).toBeInstanceOf(TransitionGateError)
  })

  test('asSystem() lifts @allow as it lifts @gate', async () => {
    const { sys } = await env()
    expect((await sys.invoice.transition('i1', 'finalize')).state).toBe('final')
  })

  test('it limits the move and no other write: support still edits an open invoice', async () => {
    const { as } = await env()
    expect((await as('bob').invoice.update({ where: { id: 'i1' }, data: { note: 'called them' } })).note).toBe('called them')
  })

  test('two to-one hops, then .some: a payment approved by finance of its invoice\'s org', async () => {
    const { as } = await env()
    expect(await refusal(as('bob').payment.transition('p1', 'approve'))).toBeInstanceOf(TransitionGateError)
    expect((await as('ann').payment.transition('p1', 'approve')).state).toBe('approved')
  })
})

describe('@allow composes with @gate', () => {
  test('both have to pass: the level is asked first, then the row', async () => {
    const { as } = await env()
    const low = await refusal(as('ann', 1).invoice.transition('i1', 'void'))
    expect(low).toBeInstanceOf(TransitionGateError)
    expect(low.allow).toBe(false)
    expect(low.required).toBe(2)
    const wrongRole = await refusal(as('bob', 5).invoice.transition('i1', 'void'))
    expect(wrongRole).toBeInstanceOf(TransitionGateError)
    expect(wrongRole.allow).toBe(true)
    expect((await as('ann', 2).invoice.transition('i1', 'void')).state).toBe('void')
  })
})

describe('transitions(row) offers only the moves @allow admits', () => {
  test('graded on the stored row, refused as a row policy refuses', async () => {
    const { sys, as } = await env()
    const row = await sys.invoice.findUnique({ where: { id: 'i1' } })
    const pick = (ms: any[]) => Object.fromEntries(ms.map(m => [m.name, [m.allowed, m.refusedBy]]))
    expect(pick(await as('ann', 2).invoice.transitions(row))).toEqual({ finalize: [true, null], void: [true, null] })
    expect(pick(await as('bob', 2).invoice.transitions(row))).toEqual({ finalize: [false, 'policy'], void: [false, 'policy'] })
    expect(pick(await as('ann', 0).invoice.transitions(row))).toEqual({ finalize: [true, null], void: [false, 'gate'] })
    expect(pick(await sys.invoice.transitions(row))).toEqual({ finalize: [true, null], void: [true, null] })
  })
})

// FJS-D182: a bulk write never names a transitions field, so @allow has no
// path around it there.
describe('a bulk write cannot route around @allow', () => {
  test('updateMany naming the column is refused for the caller @allow admits and for the one it refuses', async () => {
    const { sys, as } = await env()
    expect(await refusal(as('ann').invoice.updateMany({ where: { organizationId: 'ACME' }, data: { state: 'final' } })))
      .toBeInstanceOf(BulkTransitionError)
    expect(await refusal(as('bob').invoice.updateMany({ where: { organizationId: 'ACME' }, data: { state: 'final' } })))
      .toBeInstanceOf(BulkTransitionError)
    expect((await sys.invoice.findMany({ where: { state: 'open' } })).length).toBe(2)
  })
})
