// test/unique-redaction.test.ts
//
// A @unique refusal on a protected column names the field, never its stored
// value (FJS-1250). A @hashed digest is the value every read path refuses to
// hand back, and a 409 is the widest exit of all: logged, and rendered verbatim
// in a form, so provoking collisions would tell a caller whose PIN matches whose.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const KEY = 'a'.repeat(64)

const SCHEMA = `
  model Employee {
    id      Int     @id @default(autoincrement())
    siteId  String
    pin     String? @hashed
    code    String? @encrypted(deterministic: true) @unique
    @@unique([siteId, pin], nullsDistinct: true)
  }

  model Soft {
    id        Int       @id @default(autoincrement())
    pin       String    @hashed @unique
    deletedAt DateTime?
    @@softDelete
  }
`

const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)
const open = () => createClient({ db: ':memory:', schema: SCHEMA, encryptionKey: KEY })

describe('a @unique refusal redacts a protected value (FJS-1250)', () => {
  test('@hashed in a composite', async () => {
    const db: any = await open()
    await db.employee.create({ data: { siteId: 's1', pin: '1234' } })
    const e = await thrown(db.employee.create({ data: { siteId: 's1', pin: '1234' } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.message).toContain('pin "[redacted]"')
    expect(e.message).not.toMatch(/v\d\w*\./)
    expect(JSON.stringify(e.values)).not.toMatch(/v\d\w*\./)
    expect(e.message).toContain('siteId "s1"')
  })

  test('@encrypted(deterministic: true)', async () => {
    const db: any = await open()
    await db.employee.create({ data: { siteId: 's1', code: 'X' } })
    const e = await thrown(db.employee.create({ data: { siteId: 's2', code: 'X' } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.message).toContain('[redacted]')
    expect(e.message).not.toMatch(/v\d\w*\./)
  })

  test('@hashed held by a soft-deleted row', async () => {
    const db: any = await open()
    const r = await db.soft.create({ data: { pin: '1234' } })
    await db.soft.remove({ where: { id: r.id } })
    const e = await thrown(db.soft.create({ data: { pin: '1234' } }))
    expect(e?.name).toBe('SoftDeletedUniqueError')
    expect(e.message).toContain('[redacted]')
    expect(e.message).not.toMatch(/v\d\w*\./)
  })
})

// FJS-2691: an update names only the columns it changes, so a partial unique
// index over columns it leaves alone refused with `values: [undefined, ...]`.
describe('a conflict on columns an update did not write names the row\'s values (FJS-2691)', () => {
  const PARTIAL = `
    model Template {
      id        Int       @id @default(autoincrement())
      accountId Int
      audience  String
      isDefault Boolean   @default(false)
      pin       String    @hashed @default("")
      @@unique([accountId, audience], where: isDefault == true)
      @@unique([accountId, pin], where: isDefault == true)
    }
  `
  const seed = async () => {
    const db: any = await createClient({ db: ':memory:', schema: PARTIAL, encryptionKey: KEY })
    await db.template.create({ data: { accountId: 1, audience: 'staff', pin: 'p1', isDefault: true } })
    const second = await db.template.create({ data: { accountId: 1, audience: 'staff', pin: 'p2' } })
    return { db, second }
  }

  test('update', async () => {
    const { db, second } = await seed()
    const e = await thrown(db.template.update({ where: { id: second.id }, data: { isDefault: true } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.values).toEqual([1, 'staff'])
    expect(e.message).toContain('audience "staff"')
  })

  test('updateMany', async () => {
    const { db, second } = await seed()
    const e = await thrown(db.template.updateMany({ where: { id: second.id }, data: { isDefault: true } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.values).toEqual([1, 'staff'])
  })

  test('a protected column the update did not write stays redacted', async () => {
    const db: any = await createClient({ db: ':memory:', schema: PARTIAL, encryptionKey: KEY })
    await db.template.create({ data: { accountId: 1, audience: 'a', pin: '1234', isDefault: true } })
    const second = await db.template.create({ data: { accountId: 1, audience: 'b', pin: '1234' } })
    const e = await thrown(db.template.update({ where: { id: second.id }, data: { isDefault: true } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.message).toContain('pin "[redacted]"')
    expect(JSON.stringify(e.values)).not.toMatch(/v\d\w*\./)
  })
})

describe('a conflict over a relation key does not print the id (FJS-2820)', () => {
  const REL = `
    model Shift  { id String @id  assignments Assignment[] }
    model Person { id String @id  assignments Assignment[] }
    model Assignment {
      id       String @id
      shiftId  String
      personId String
      note     String? @unique
      shift    Shift  @relation(fields: [shiftId], references: [id])
      person   Person @relation(fields: [personId], references: [id])
      @@unique([shiftId, personId])
    }
  `
  const ULID = '01M4ZZZZZZZZZZZZZZZZZZZZZZ'
  const seed = async () => {
    const db: any = await createClient({ db: ':memory:', schema: REL })
    await db.shift.create({ data: { id: ULID } })
    await db.person.create({ data: { id: ULID.replace('M4', 'M5') } })
    return db
  }

  test('a composite over two keys names the columns, not the ids', async () => {
    const db = await seed()
    const data = { shiftId: ULID, personId: ULID.replace('M4', 'M5') }
    await db.assignment.create({ data: { id: 'a1', ...data } })
    const e = await thrown(db.assignment.create({ data: { id: 'a2', ...data } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.message).toBe('Assignment: shiftId + personId is already taken — those values must be unique together.')
    expect(e.fields).toEqual(['shiftId', 'personId'])
    expect(e.values).toEqual([data.shiftId, data.personId])
  })

  test('a plain column beside a key still names its value', async () => {
    const db = await seed()
    await db.person.create({ data: { id: 'p2' } })
    await db.assignment.create({ data: { id: 'a1', shiftId: ULID, personId: ULID.replace('M4', 'M5'), note: 'x' } })
    const e = await thrown(db.assignment.create({ data: { id: 'a2', shiftId: ULID, personId: 'p2', note: 'x' } }))
    expect(e.fields).toEqual(['note'])
    expect(e.message).toContain('note "x"')
  })
})
