/**
 * test/immutable.test.ts — `@immutable` (`FJS-D162`).
 *
 * A column written once, at create, and never again by anybody. Two things
 * separate it from every other protection in this package and both are asserted
 * below, because a test that only checks the happy refusal would pass against a
 * rule with either of them missing:
 *
 *   1. It refuses the KEY, not the value — the same number sent back is still
 *      refused. Nothing here can see the stored row beside the incoming one, so
 *      a rule that compared would be a rule that could not be written.
 *   2. `asSystem()` does not drop it. The gate, the row policies and `@guarded`
 *      all fall away there; a renewal job runs as system, so a rule it can drop
 *      is absent from the caller that actually writes invoices.
 */

import { describe, test, expect } from 'bun:test'
import { parse, createClient, generateJsonSchema } from '../src/index.js'

const DOC = `
database main { path ":memory:" }
model Doc {
  id     Int    @id @default(autoincrement())
  number String @immutable
  total  Int    @immutable
  status String @default("draft")
}
`
const client = () => createClient({ schema: DOC, resolveFrom: import.meta.dir })
const errsOf = (src: string) => parse(src).errors.join(' · ')

describe('what parses', () => {
  test('it takes no arguments, and the refusal points at the row-level shape', () => {
    expect(parse(`model D { id Int @id  n String @immutable }`).valid).toBe(true)
    expect(errsOf(`model D { id Int @id  n String @immutable(all) }`)).toMatch(/takes no arguments/)
  })

  test('it is refused on the columns the ENGINE writes on every update', () => {
    expect(errsOf(`model D { id Int @id  v Int @version @immutable }`)).toMatch(/@version/)
    expect(errsOf(`model D { id Int @id  u DateTime @updatedAt @immutable }`)).toMatch(/@updatedAt/)
  })

  test('it is refused where there is no column to freeze', () => {
    expect(errsOf(`model D { id Int @id  c String @computed @immutable }`)).toMatch(/nothing to freeze/)
    expect(errsOf(`model D { id Int @id  t String @transient @immutable }`)).toMatch(/nothing to freeze/)
  })
})

describe('the write half', () => {
  test('create writes it, and the row keeps the value', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-1', total: 1000 } })
    expect(row.number).toBe('INV-1')
    expect(row.total).toBe(1000)
  })

  test('a column the freeze does not name still moves', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-2', total: 1000 } })
    await db.doc.update({ where: { id: row.id }, data: { status: 'issued' } })
    expect((await db.doc.findFirst({ where: { id: row.id } })).status).toBe('issued')
  })

  test('an update naming it is refused, and the refusal names the column', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-3', total: 1000 } })
    await expect(db.doc.update({ where: { id: row.id }, data: { total: 5 } }))
      .rejects.toThrow(/total is @immutable/)
    expect((await db.doc.findFirst({ where: { id: row.id } })).total).toBe(1000)
  })

  test('THE SAME VALUE is refused too — it grades the key, not the value', async () => {
    // The negative control for the whole design. A rule that compared would let
    // this through, and a form round-tripping a frozen column would then be
    // fine right up until somebody changed the box.
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-4', total: 1000 } })
    await expect(db.doc.update({ where: { id: row.id }, data: { total: 1000 } }))
      .rejects.toThrow(/total is @immutable/)
  })

  test('asSystem() does not drop it', async () => {
    const db  = await client()
    const row = await db.doc.create({ data: { number: 'INV-5', total: 1000 } })
    await expect(db.asSystem().doc.update({ where: { id: row.id }, data: { total: 5 } }))
      .rejects.toThrow(/total is @immutable/)
    expect((await db.asSystem().doc.findFirst({ where: { id: row.id } })).total).toBe(1000)
  })

  test('updateMany and upsert refuse it on the same terms', async () => {
    const db = await client()
    await db.doc.create({ data: { number: 'INV-6', total: 1000 } })
    await expect(db.doc.updateMany({ where: {}, data: { number: 'X' } }))
      .rejects.toThrow(/number is @immutable/)
    // The insert branch of an upsert is a create and writes it; the update
    // branch is an update and does not.
    await expect(db.doc.upsert({
      where:  { number: 'INV-6' },
      create: { number: 'INV-6', total: 1 },
      update: { total: 7 },
    })).rejects.toThrow(/total is @immutable/)
  })

  test('a bulk create writes it, which is the path `creating` had to be threaded through', async () => {
    const db = await client()
    const r  = await db.doc.createMany({ data: [
      { number: 'INV-7', total: 1 },
      { number: 'INV-8', total: 2 },
    ] })
    expect(r.count).toBe(2)
  })
})

describe('what the client is told', () => {
  test('readOnly in the update schema and writable in create — the one kind that differs by mode', async () => {
    const parsed = parse(DOC)
    const create = generateJsonSchema(parsed.schema ?? parsed, { mode: 'create' })
    const update = generateJsonSchema(parsed.schema ?? parsed, { mode: 'update' })

    expect(create.$defs.Doc.properties.total.readOnly).toBeUndefined()
    expect(update.$defs.Doc.properties.total.readOnly).toBe(true)
    expect(update.$defs.Doc.properties.total['x-litestone-kind']).toBe('immutable')
    // A create form must still offer the box, or the model is uncreatable
    // through anything generated.
    expect(create.$defs.Doc.properties.number.readOnly).toBeUndefined()
  })
})

// The harness writes a no-op patch to grade an update, and it took the first
// scalar the row held — which on a model leading with an `@immutable` column
// is refused by name at every level, and read as the gate or the policy
// throwing on a model that is correctly declared.
describe('the verifiers do not touch a frozen column', () => {
  const LEADS_FROZEN = `
model Ledger {
  id      Int    @id @default(autoincrement())
  ownerId Int    @immutable
  code    String @immutable
  note    String
  @@gate("0")
  @@allow('update', ownerId == auth().id)
  @@allow('read', true)
  @@allow('create', true)
  @@allow('delete', true)
}
`

  test('the gate ladder is clean', async () => {
    const { createTestEnv } = await import('../src/testing.js')
    const env = await createTestEnv({ schema: LEADS_FROZEN })
    expect(await env.verifyGateLadder()).toEqual([])
  })

  test('the row-policy check grades rather than throwing', async () => {
    const { createTestEnv } = await import('../src/testing.js')
    const env = await createTestEnv({ schema: LEADS_FROZEN })
    const rows = (await env.verifyRowPolicies()) as any[]
    expect(rows.filter(r => /threw/.test(r.message ?? ''))).toEqual([])
  })
})

// FJS-1988. A `@sequence` value is the counter's, not the caller's: one agent
// renumbering ticket #1 to #2 made every later create in the org a 409, the
// system's included, because a failed insert rolls the counter back to the
// number now taken. So the column is frozen after create without anyone
// writing `@immutable` beside it, and the update schema says so to a form.
describe('@sequence is frozen after create', () => {
  const TICKETS = `
database main { path ":memory:" }
enum TicketState {
  draft
  issued
}
model Ticket {
  id     Int @id @default(autoincrement())
  orgId  Int
  number Int @sequence(scope: orgId)
  title  String
  @@unique([orgId, number])
}
model Invoice {
  id     Int @id @default(autoincrement())
  orgId  Int
  number Int @sequence(scope: orgId)
  state  TicketState @default(draft)
  total  Int @immutable
  @@transitions(state, issue: draft -> issued @seals)
}
`
  const tickets = () => createClient({ schema: TICKETS, resolveFrom: import.meta.dir })

  test('an update naming it is refused, for the system too, and the counter keeps counting', async () => {
    const db = await tickets()
    const one = await db.ticket.create({ data: { orgId: 1, title: 'a' } })
    expect(one.number).toBe(1)
    await expect(db.ticket.update({ where: { id: one.id }, data: { number: 2 } }))
      .rejects.toThrow(/number is a @sequence/)
    await expect(db.asSystem().ticket.update({ where: { id: one.id }, data: { number: 2 } }))
      .rejects.toThrow(/number is a @sequence/)
    await expect(db.ticket.updateMany({ where: {}, data: { number: 9 } }))
      .rejects.toThrow(/number is a @sequence/)
    const two = await db.asSystem().ticket.create({ data: { orgId: 1, title: 'b' } })
    expect(two.number).toBe(2)
  })

  test('a create may still state it, and the rest of the row still moves', async () => {
    const db = await tickets()
    const row = await db.ticket.create({ data: { orgId: 1, number: 10, title: 'a' } })
    expect(row.number).toBe(10)
    await db.ticket.update({ where: { id: row.id }, data: { title: 'b' } })
    expect((await db.ticket.findFirst({ where: { id: row.id } })).title).toBe('b')
  })

  test('a sealing model freezes it at create, not at the seal — a draft renumbered breaks the counter all the same', async () => {
    const db = await tickets()
    const draft = await db.invoice.create({ data: { orgId: 1, total: 5 } })
    await expect(db.invoice.update({ where: { id: draft.id }, data: { number: 4 } }))
      .rejects.toThrow(/number is a @sequence/)
  })

  test('readOnly in the update schema, so no generated edit form draws it', () => {
    const parsed = parse(TICKETS)
    const create = generateJsonSchema(parsed.schema ?? parsed, { mode: 'create' })
    const update = generateJsonSchema(parsed.schema ?? parsed, { mode: 'update' })
    expect(create.$defs.Ticket.properties.number.readOnly).toBeUndefined()
    expect(update.$defs.Ticket.properties.number.readOnly).toBe(true)
    expect(update.$defs.Ticket.properties.number['x-litestone-kind']).toBe('sequence')
    expect(update.$defs.Invoice.properties.number.readOnly).toBe(true)
  })
})
