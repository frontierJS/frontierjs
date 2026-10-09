// `system: ['@@gate']` — a write the APPLICATION makes on a caller's behalf, at
// a level that caller does not hold (`FJS-D575`).
//
// The gap it closes: a model only the system may create — an invoice, an
// eligibility record — had two exits, `system: ['col']`, which lifts a column
// and not the gate, and `asSystem()`, which lifts the gate and drops the row
// policies, the redaction and the audit actor with it. So the person who caused
// the write vanished from the trail of every such row.
//
// What the suite holds is everything the lift does NOT move: the gate is graded
// SYSTEM for that one call on that one model, and the caller's level everywhere
// else — the next call on the same client, a nested write in the same payload,
// the row the call hands back. Each of those is a silent wrong answer if it
// slips, which is why each has its own test.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createClient, AccessDeniedError } from '../src/index.js'

const SCHEMA = `
model User {
  id   Int     @id
  role String?
  @@auth
}

model Invoice {
  id       Int     @id
  ownerId  Int
  number   String
  token    String  @guarded @default("minted")
  lines    Line[]
  @@gate("1.8.8.9")
  @@allow('read',   true)
  @@allow('create', ownerId == auth().id)
  @@allow('update', ownerId == auth().id)
}

model Line {
  id        Int     @id
  invoice   Invoice @relation(fields: [invoiceId], references: [id])
  invoiceId Int
  amount    Int
  @@gate("1.8.8.9")
}

model Ledger {
  id     Int    @id
  note   String
  @@gate("6.8.8.9")
}

model Shipment {
  id           Int     @id
  reference    String  @unique
  trackingCode String? @system
  note         String?
  @@gate("1.4.4.5")
}

model Plain {
  id    Int    @id
  label String
}
`

const client = () => createClient({ schema: SCHEMA, db: ':memory:' })
const USER   = { id: 1, role: 'member' }                    // grades USER(4)

describe('the lift grades one call SYSTEM against the gate', () => {

  it('refuses without it, and the refusal names the spelling', async () => {
    const db = await client()
    const p  = db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'A-1' } })
    await expect(p).rejects.toThrow(AccessDeniedError)
    await expect(p).rejects.toThrow(`system: ['@@gate']`)
  })

  it('admits create and update with it', async () => {
    const db  = await client()
    const row = await db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'A-1' }, system: ['@@gate'] })
    expect(row.number).toBe('A-1')

    const up = await db.$setAuth(USER).invoice.update({ where: { id: row.id }, data: { number: 'A-2' }, system: ['@@gate'] })
    expect(up.number).toBe('A-2')
  })

  it('keeps the row policy — the lift is the gate and nothing else', async () => {
    const db = await client()
    const err = await db.$setAuth(USER).invoice.create({ data: { ownerId: 2, number: 'B-1' }, system: ['@@gate'] })
      .then(() => null, (e: any) => e)
    expect(err).not.toBeNull()
    expect(err.message).not.toMatch(/requires SYSTEM/)        // the policy refused, not the gate
    expect(await db.asSystem().invoice.count()).toBe(0)
  })

  it('does not open a 9', async () => {
    const db  = await client()
    const row = await db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'C-1' }, system: ['@@gate'] })
    await expect(db.$setAuth(USER).invoice.delete({ where: { id: row.id } })).rejects.toThrow(/LOCKED/)
  })

  it('reaches createMany, updateMany and upsert', async () => {
    const db = await client()
    const me = db.$setAuth(USER)
    expect((await me.invoice.createMany({ data: [{ ownerId: 1, number: 'M-1' }], system: ['@@gate'] })).count).toBe(1)
    expect((await me.invoice.updateMany({ where: { number: 'M-1' }, data: { number: 'M-2' }, system: ['@@gate'] })).count).toBe(1)
    const up = await me.invoice.upsert({
      where: { id: 99 }, create: { id: 99, ownerId: 1, number: 'U-1' }, update: { number: 'U-2' }, system: ['@@gate'],
    })
    expect(up.number).toBe('U-1')
  })
})

describe('what the lift does not move', () => {

  it('the next call on the same client — the level cache is keyed on the flavor', async () => {
    const db = await client()
    const me = db.$setAuth(USER)
    await me.invoice.create({ data: { ownerId: 1, number: 'D-1' }, system: ['@@gate'] })
    await expect(me.invoice.create({ data: { ownerId: 1, number: 'D-2' } })).rejects.toThrow(AccessDeniedError)
  })

  it("the model's read gate, on a later read", async () => {
    const db = await client()
    const me = db.$setAuth(USER)
    await me.ledger.create({ data: { note: 'x' }, system: ['@@gate'] })
    await expect(me.ledger.findMany()).rejects.toThrow(AccessDeniedError)
  })

  it('a nested write in the same payload', async () => {
    const db = await client()
    const p  = db.$setAuth(USER).invoice.create({
      data: { ownerId: 1, number: 'E-1', lines: { create: [{ amount: 5 }] } },
      system: ['@@gate'],
    })
    await expect(p).rejects.toThrow(/Line/)
    expect(await db.asSystem().invoice.count()).toBe(0)
  })

  it('the row handed back — @guarded is still stripped', async () => {
    const db  = await client()
    const row = await db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'F-1' }, system: ['@@gate'] })
    expect(row.token).toBeUndefined()
    expect((await db.asSystem().invoice.findFirst()).token).toBe('minted')
  })
})

describe('the trail names the person, and says the gate was lifted', () => {

  const LOGGED = `
    database main  { path env("MAIN_DB", "./main.db") }
    database audit { path "./audit/" driver trail }
    model Invoice {
      id      Int    @id
      ownerId Int
      number  String
      @@db(main)
      @@trail(audit)
      @@gate("1.8.8.9")
    }
  `

  it('actor stays the caller and meta carries the lift', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-lift-'))
    mkdirSync(join(dir, 'audit'), { recursive: true })
    const seen: any[] = []
    const db = await createClient({
      schema:    LOGGED,
      databases: { main: { path: join(dir, 'main.db') }, audit: { path: join(dir, 'audit') } },
      onLog:     (entry: any) => { seen.push({ ...entry }) },
    })
    await db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'G-1' }, system: ['@@gate'] })
    await db.asSystem().invoice.create({ data: { ownerId: 1, number: 'G-2' } })
    await new Promise(r => setTimeout(r, 20))

    const lifted = seen.find(e => e.after?.includes('G-1'))
    expect(lifted.actorId).toBe(1)
    expect(lifted.actorType).toBe('user')
    expect(JSON.parse(lifted.meta)).toEqual({ lifted: ['@@gate'] })

    const sys = seen.find(e => e.after?.includes('G-2'))
    expect(sys.actorType).toBe('system')
    expect(sys.meta).toBeNull()
    db.$close()
  })
})

describe('an entry that lifts nothing is refused by name', () => {

  it('system: true — the boolean is transition()\'s spelling', async () => {
    const db = await client()
    await expect(db.$setAuth(USER).shipment.create({ data: { reference: 'R' }, system: true as any }))
      .rejects.toThrow(/as a list — got true/)
  })

  it('a guarantee other than the gate', async () => {
    const db = await client()
    await expect(db.$setAuth(USER).shipment.create({ data: { reference: 'R' }, system: ['@guarded'] }))
      .rejects.toThrow(/'@@gate' is the one guarantee/)
  })

  it('a column that is not @system, or not there at all', async () => {
    const db = await client()
    await expect(db.$setAuth(USER).shipment.create({ data: { reference: 'R' }, system: ['note'] }))
      .rejects.toThrow(/"note" is not a @system or @guarded column/)
    await expect(db.$setAuth(USER).shipment.create({ data: { reference: 'R' }, system: ['trackingCod'] }))
      .rejects.toThrow(/"trackingCod" is not a @system or @guarded column/)
  })

  it('a @guarded column is named the same way, and only its write half opens', async () => {
    // A required @guarded digest left a grant model uncreatable below 8, so
    // every app minted it as asSystem() in a second write and lost the create
    // policy that says who may issue a link (FJS-1749, FJS-D819).
    const db = await client()
    await expect(db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'G-1', token: 'by-hand' }, system: ['@@gate'] }))
      .rejects.toThrow(/"token" is @guarded/)
    const row = await db.$setAuth(USER).invoice.create({ data: { ownerId: 1, number: 'G-1', token: 'by-hand' }, system: ['@@gate', 'token'] })
    expect('token' in row).toBe(false)
    expect((await db.asSystem().invoice.findUnique({ where: { id: row.id } })).token).toBe('by-hand')
    // Naming it on one call does not open a read on the next.
    await expect(db.$setAuth(USER).invoice.findMany({ where: { token: 'by-hand' } })).rejects.toThrow()
  })

  it('the gate, on a model with none', async () => {
    const db = await client()
    await expect(db.$setAuth(USER).plain.create({ data: { label: 'x' }, system: ['@@gate'] }))
      .rejects.toThrow(/declares no @@gate/)
  })
})

describe('upsertMany grades its conflict half as an update (FJS-1700)', () => {

  // `@@gate("1.4.8.9")`: a member may add a row and may not change one. The
  // bulk upsert graded the create gate alone, so naming an existing row's key
  // overwrote it at a level update() refused.
  const SETTINGS = `
    model User    { id Int @id  role String?  @@auth }
    model Setting { id Int @id  key String @unique  value String  @@gate("1.4.8.9") }
  `
  const settings = async () => {
    const db = await createClient({ schema: SETTINGS, db: ':memory:' })
    await db.asSystem().setting.create({ data: { key: 'k', value: 'kept' } })
    return db
  }

  it('refuses a caller below the update gate, and the row is untouched', async () => {
    const db = await settings()
    await expect(db.$setAuth(USER).setting.upsertMany({ data: [{ key: 'k', value: 'x' }], conflictTarget: ['key'] }))
      .rejects.toThrow(/Setting\.update/)
    expect((await db.asSystem().setting.findFirst()).value).toBe('kept')
  })

  it('takes the lift', async () => {
    const db = await settings()
    await db.$setAuth(USER).setting.upsertMany({ data: [{ key: 'k', value: 'x' }], conflictTarget: ['key'], system: ['@@gate'] })
    expect((await db.asSystem().setting.findFirst()).value).toBe('x')
  })

  it('an explicit update: [] is insert-only and graded as a create', async () => {
    const db = await settings()
    const r  = await db.$setAuth(USER).setting.upsertMany({
      data: [{ key: 'k', value: 'x' }, { key: 'n', value: 'new' }], conflictTarget: ['key'], update: [],
    })
    expect(r.count).toBeGreaterThanOrEqual(1)
    expect((await db.asSystem().setting.findFirst({ where: { key: 'k' } })).value).toBe('kept')
  })
})

describe('upsert carries the column hatch on every path', () => {

  // A gated model always takes the slow path — findFirst, then create or
  // update — and that path dropped `system`, so a column the call named was
  // refused there and written on the fast path.
  it('both halves', async () => {
    const db = await client()
    const me = db.$setAuth(USER)
    const created = await me.shipment.upsert({
      where: { reference: 'S' }, create: { reference: 'S', trackingCode: 'T-1' }, update: { trackingCode: 'T-2' },
      system: ['trackingCode'],
    })
    expect(created.trackingCode).toBe('T-1')
    const updated = await me.shipment.upsert({
      where: { reference: 'S' }, create: { reference: 'S', trackingCode: 'T-1' }, update: { trackingCode: 'T-2' },
      system: ['trackingCode'],
    })
    expect(updated.trackingCode).toBe('T-2')
  })
})
