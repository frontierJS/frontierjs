// FJS-1093 — a named move may not tell a caller that a row they cannot read exists.
//
// `checkTransitions` reads the row's current state before grading the move, and
// it read it UNSCOPED. Every refusal it then raises is a sentence about a row —
// the policy refused *this* move, the move's gate is 5, the move is `@system` —
// so on a row the caller's read policy hides it threw, while on an id that does
// not exist it answered null. Measured over HTTP on `example`: 403 against 204,
// which enumerates every invoice number in a shop.
//
// Every hidden-row assertion is PAIRED with the same call against a row the same
// caller CAN read, which must still refuse by name. A fix that swallowed every
// refusal would answer null for both and pass any test asking only about the
// hidden row. And every null is checked against the row's state afterwards,
// because a write that happened and then answered null reads identically.

import { describe, it, expect } from 'bun:test'
import { createClient, GatePlugin } from '../src/index.js'

const SCHEMA = `
enum S { issued paid void }
model User { id Int @id  isStaff Boolean @default(false)  @@auth }
model Inv {
  id      Int     @id @default(autoincrement())
  ownerId Int
  shop    String  @default("a")
  status  S       @default(issued)
  @@gate("1.8.4.8")
  @@allow('read',   auth().isStaff || ownerId == auth().id)
  @@allow('update', auth().isStaff)
  @@transitions(status,
    settle: issued -> paid,
    void:   issued -> void @gate(5),
    seize:  issued -> paid @system
  )
}`

const HIDDEN = 1   // owned by somebody else
const OWN    = 2   // owned by the caller, so readable
const ABSENT = 999

async function env(options: Record<string, unknown> = {}) {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
    ...options,
  })
  const sys = db.asSystem()
  await sys.inv.create({ data: { ownerId: 99 } })
  await sys.inv.create({ data: { ownerId: 1 } })
  const status = async (id: number) => (await sys.inv.findFirst({ where: { id } }))?.status
  return { db, sys, status, shopper: db.$setAuth({ id: 1, level: 4, isStaff: false }) }
}

const outcome = async (p: Promise<unknown>) => {
  try { return { value: await p } } catch (e) { return { error: (e as Error).constructor.name } }
}

describe('a move on a row the caller cannot read answers as a row that is not there', () => {
  const cases: [string, string][] = [
    ['settle', 'AccessDeniedError'],      // refused by the update policy
    ['void',   'TransitionGateError'],    // refused by the move's own gate
    ['seize',  'TransitionSystemError'],  // refused because the application makes it
  ]

  for (const [move, refusal] of cases) {
    it(`${move}: hidden and absent are one answer, and a readable row still names ${refusal}`, async () => {
      const { db, shopper, status } = await env()
      const hidden = await outcome(shopper.inv.transition(HIDDEN, move))
      const absent = await outcome(shopper.inv.transition(ABSENT, move))
      expect(hidden).toEqual(absent)
      expect(hidden).toEqual({ value: null })
      expect(await status(HIDDEN)).toBe('issued')

      expect(await outcome(shopper.inv.transition(OWN, move))).toEqual({ error: refusal })
      expect(await status(OWN)).toBe('issued')
      db.$close()
    })
  }

  it('the same holds for an update that carries the column rather than naming the move', async () => {
    const { db, shopper, status } = await env()
    const hidden = await outcome(shopper.inv.update({ where: { id: HIDDEN }, data: { status: 'paid' } }))
    const absent = await outcome(shopper.inv.update({ where: { id: ABSENT }, data: { status: 'paid' } }))
    expect(hidden).toEqual(absent)
    expect(await status(HIDDEN)).toBe('issued')
    expect(await outcome(shopper.inv.update({ where: { id: OWN }, data: { status: 'paid' } })))
      .toEqual({ error: 'AccessDeniedError' })
    db.$close()
  })
})

describe('the scope narrows who is told, never who may move', () => {
  it('a caller the policies admit still makes the move on a row they can read', async () => {
    const { db, status } = await env()
    const staff = db.$setAuth({ id: 7, level: 4, isStaff: true })
    await staff.inv.transition(HIDDEN, 'settle')
    expect(await status(HIDDEN)).toBe('paid')
    db.$close()
  })

  it('asSystem() moves a row no principal could see', async () => {
    const { db, sys, status } = await env()
    await sys.inv.transition(HIDDEN, 'seize')
    expect(await status(HIDDEN)).toBe('paid')
    db.$close()
  })

  it('a column that is not the state machine is untouched by the scope', async () => {
    // The lookup only runs for a transitions field, so a hidden row written
    // through another column goes on answering what the update policy says.
    const { db, shopper } = await env()
    expect(await outcome(shopper.inv.update({ where: { id: HIDDEN }, data: { shop: 'b' } })))
      .toEqual({ value: null })
    db.$close()
  })
})

describe('the read scope is the whole read composition, not the policy alone', () => {
  it('a global filter hides a row from a move exactly as a policy does', async () => {
    const { db } = await env({ filters: { inv: { shop: 'a' } } })
    const staff = db.$setAuth({ id: 7, level: 4, isStaff: true })
    // A global filter narrows the system client too, so the row is moved out of
    // it and read back underneath the client, off the connection.
    const raw = db.$rawDbs.main
    raw.run(`UPDATE inv SET shop = 'z' WHERE id = ${HIDDEN}`)
    const status = async (id: number) => (raw.query('SELECT status FROM inv WHERE id = ?').get(id) as { status: string })?.status

    const hidden = await outcome(staff.inv.transition(HIDDEN, 'void'))
    const absent = await outcome(staff.inv.transition(ABSENT, 'void'))
    expect(hidden).toEqual(absent)
    expect(await status(HIDDEN)).toBe('issued')
    // …and the row still inside the filter is refused by the move's gate.
    expect(await outcome(staff.inv.transition(OWN, 'void'))).toEqual({ error: 'TransitionGateError' })
    db.$close()
  })
})
