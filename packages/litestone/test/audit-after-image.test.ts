// audit-after-image.test.ts — the trail's after-image is the row written, not
// the caller's projection of it (FJS-2039).

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
      model Job { id Int @id  name String  state String @default("new")  @@trail(main) }
    `,
    db: ':memory:',
  })
  await autoMigrate(db)
  const trail = async (operation: string) => {
    await tick()
    return (await db.asSystem().auditRow.findMany({ orderBy: { id: 'asc' } })).filter((r: any) => r.operation === operation)
  }
  return { db, sys: db.asSystem(), trail }
}

describe('the after-image of a write', () => {
  test('a create under select holds every column written', async () => {
    const { db, sys, trail } = await setup()
    const made = await sys.job.create({ data: { id: 10, name: 'ten' }, select: { id: true } })
    expect(made).toEqual({ id: 10 })
    const [entry] = await trail('create')
    expect(entry.after).toEqual({ id: 10, name: 'ten', state: 'new' })
    db.$close()
  })

  test('an update under select holds the whole row after', async () => {
    const { db, sys, trail } = await setup()
    await sys.job.create({ data: { id: 1, name: 'one' } })
    await sys.job.update({ where: { id: 1 }, data: { state: 'done' }, select: { id: true } })
    const [entry] = await trail('update')
    expect(entry.after).toEqual({ id: 1, name: 'one', state: 'done' })
    db.$close()
  })
})

describe('a relation read for the caller stays out of the trail', () => {
  async function withOwner() {
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
        model Owner { id Int @id  name String  jobs Job[] }
        model Job { id Int @id  name String  ownerId Int  owner Owner @relation(fields: [ownerId], references: [id])  @@trail(main) }
      `,
      db: ':memory:',
    })
    await autoMigrate(db)
    const sys = db.asSystem()
    await sys.owner.create({ data: { id: 1, name: 'ann' } })
    const trail = async () => {
      await tick()
      return (await sys.auditRow.findMany({ orderBy: { id: 'asc' } })).filter((r: any) => r.operation === 'create' && r.model === 'Job')
    }
    return { db, sys, trail }
  }

  test('a create under select with a relation audits the row written', async () => {
    const { db, sys, trail } = await withOwner()
    const made = await sys.job.create({ data: { id: 10, name: 'ten', ownerId: 1 }, select: { id: true, owner: true } })
    expect(made.owner).toEqual({ id: 1, name: 'ann' })
    const [entry] = await trail()
    expect(entry.after).toEqual({ id: 10, name: 'ten', ownerId: 1 })
    db.$close()
  })
})
