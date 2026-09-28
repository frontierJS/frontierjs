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
