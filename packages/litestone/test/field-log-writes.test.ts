// field-log-writes.test.ts — a field @log records a write OF that field.
//
// `emitLogs` looped over every field log on any write, so creating an Account
// with no secret, or updating its timeZone, put `create · account · saPassword`
// in the trail — a credential-access trail that is false on every row, and in
// which a real secret write cannot be told from any other (FJS-2048).

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

async function setup() {
  const db: any = await createClient({
    schema: `
      database main { path ":memory:" model AuditRow }
      model AuditRow {
        id Int @id @default(autoincrement())
        operation String
        model String
        field String?
        records Json
        before Json?
        after Json?
        actorId String?
        actorType String?
        correlationId String?
        source String?
        origin String?
        ip String?
        userAgent String?
        tenant String?
        meta Json?
        createdAt DateTime @default(now())
      }
      model Account {
        id Int @id
        timeZone String?
        saPassword String? @encrypted @trail(main)
      }
      model Vault {
        id Int @id
        label String?
        secret String? @encrypted @trail(main)
        deletedAt DateTime?
        @@softDelete
      }
    `,
    db: ':memory:',
    encryptionKey: 'a'.repeat(64),
  })
  await autoMigrate(db)
  const trail = async () => {
    await tick()
    return (await db.asSystem().auditRow.findMany({ orderBy: { id: 'asc' } })).filter((r: any) => r.field)
  }
  return { db, sys: db.asSystem(), trail }
}

describe('a field log records a write of that field', () => {
  test('a create that leaves the field null logs nothing for it', async () => {
    const { db, sys, trail } = await setup()
    await sys.account.create({ data: { id: 1, timeZone: 'UTC' } })
    expect(await trail()).toEqual([])
    db.$close()
  })

  test('createMany logs the field for the rows that gave it', async () => {
    const { db, sys, trail } = await setup()
    await sys.account.createMany({ data: [{ id: 1 }, { id: 2, saPassword: 'x' }, { id: 3, saPassword: 'y' }] })
    const rows = await trail()
    expect(rows.map((r: any) => [r.operation, r.field, r.records])).toEqual([['create', 'saPassword', [2, 3]]])
    db.$close()
  })

  test('an update of another field logs nothing for the secret', async () => {
    const { db, sys, trail } = await setup()
    await sys.account.create({ data: { id: 1, saPassword: 'x' } })
    const before = (await trail()).length
    await sys.account.update({ where: { id: 1 }, data: { timeZone: 'UTC' } })
    expect((await trail()).length).toBe(before)
    db.$close()
  })

  test('an update that writes the secret is logged, redacted', async () => {
    const { db, sys, trail } = await setup()
    await sys.account.create({ data: { id: 1, saPassword: 'x' } })
    await sys.account.update({ where: { id: 1 }, data: { saPassword: 'y' } })
    const rows = await trail()
    const upd = rows.filter((r: any) => r.operation === 'update' && r.field === 'saPassword')
    expect(upd).toHaveLength(1)
    expect(upd[0].after).toBe('[redacted]')
    db.$close()
  })

  test('updateMany logs the field only when the data names it', async () => {
    const { db, sys, trail } = await setup()
    await sys.account.createMany({ data: [{ id: 1 }, { id: 2 }] })
    await sys.account.updateMany({ where: {}, data: { timeZone: 'UTC' } })
    expect(await trail()).toEqual([])
    await sys.account.updateMany({ where: {}, data: { saPassword: 'z' } })
    expect((await trail()).map((r: any) => [r.operation, r.records])).toEqual([['update', [1, 2]]])
    db.$close()
  })

  // FJS-2134 — the bulk paths hand emitLogs no `written`.
  test('upsertMany logs the field for the rows that gave it, by what each did', async () => {
    const { db, sys, trail } = await setup()
    await sys.account.createMany({ data: [{ id: 1, saPassword: 'x' }, { id: 2 }] })
    const before = (await trail()).length
    // 1 conflicts and names only timeZone; 2 conflicts and names the secret;
    // 3 inserts without it; 4 inserts with it.
    await sys.account.upsertMany({
      data: [{ id: 1, timeZone: 'UTC' }, { id: 2, saPassword: 'z' }],
      conflictTarget: ['id'],
    })
    await sys.account.upsertMany({
      data: [{ id: 3, timeZone: 'UTC' }],
      conflictTarget: ['id'],
    })
    await sys.account.upsertMany({
      data: [{ id: 4, saPassword: 'w' }],
      conflictTarget: ['id'],
    })
    const rows = (await trail()).slice(before)
    expect(rows.map((r: any) => [r.operation, r.records])).toEqual([['update', [2]], ['create', [4]]])
    db.$close()
  })

  test('restore does not log a secret it did not write', async () => {
    const { db, sys, trail } = await setup()
    await sys.vault.create({ data: { id: 1, secret: 's' } })
    await sys.vault.remove({ where: { id: 1 } })
    const before = (await trail()).length
    await sys.vault.restore({ where: { id: 1 } })
    expect((await trail()).length).toBe(before)
    db.$close()
  })
})
