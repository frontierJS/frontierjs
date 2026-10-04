// test/hidden-parent.test.ts
//
// A row the caller cannot read answers as missing, and a foreign key is a read.
// Alice could attach a Task to Bob's Project — a project `findUnique` told her
// does not exist — and the difference between that success and the refusal of
// Project 999 told her which ids were real. A refused delete named the hidden
// child that blocked it, by id, from a system lookup.
//
// Every refusal is paired with the legitimate shape beside it (`FJS-351`).

import { describe, test, expect } from 'bun:test'
import { createClient, ForeignKeyError, GatePlugin } from '../src/index.js'

const SCHEMA = `
  model Member {
    id    String @id
    tasks Task[]
    @@allow('read', id == 'nobody')
    @@allow('create', true)
  }

  model Project {
    id        Int       @id @default(autoincrement())
    ownerId   String
    deletedAt DateTime?
    tasks     Task[]
    @@softDelete
    @@allow('all', ownerId == auth().id)
  }

  model Task {
    id        Int      @id @default(autoincrement())
    ownerId   String
    projectId Int?
    project   Project? @relation(fields: [projectId], references: [id], onDelete: Restrict)
    authorId  String?  @default(auth().id)
    author    Member?  @relation(fields: [authorId], references: [id])
    @@allow('all', ownerId == auth().id)
  }
`

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  for (const id of ['alice', 'bob', 'carol']) await sys.member.create({ data: { id } })
  await sys.project.create({ data: { ownerId: 'bob' } })     // 1
  await sys.project.create({ data: { ownerId: 'alice' } })   // 2
  const alice = db.$setAuth({ id: 'alice' })
  return { db, sys, alice }
}

const refusal = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e as any }
  throw new Error('expected a refusal')
}

// The two refusals must be the same answer, so nothing but the value differs.
const shape = (e: any) => ({
  name: e.name, status: e.status, relation: e.relation, field: e.field, target: e.target,
  message: e.message.replace(/\d+/g, 'N'),
  errors: e.errors.map((x: any) => ({ ...x, message: x.message.replace(/\d+/g, 'N') })),
})

describe('a foreign key naming a parent the caller cannot read', () => {
  test('create: a hidden parent and a missing one are the same refusal', async () => {
    const { db, alice } = await seeded()
    const hidden  = await refusal(alice.task.create({ data: { ownerId: 'alice', projectId: 1 } }))
    const missing = await refusal(alice.task.create({ data: { ownerId: 'alice', projectId: 999 } }))
    expect(hidden).toBeInstanceOf(ForeignKeyError)
    expect(shape(hidden)).toEqual(shape(missing))
    expect(await db.asSystem().task.count()).toBe(0)
    // Paired: her own project is a parent.
    expect((await alice.task.create({ data: { ownerId: 'alice', projectId: 2 } })).projectId).toBe(2)
    db.$close()
  })

  test('update: moving a row onto a hidden parent is refused, moving it onto her own is not', async () => {
    const { db, alice } = await seeded()
    const t = await alice.task.create({ data: { ownerId: 'alice', projectId: 2 } })
    const hidden = await refusal(alice.task.update({ where: { id: t.id }, data: { projectId: 1 } }))
    expect(hidden).toBeInstanceOf(ForeignKeyError)
    expect(hidden.field).toBe('projectId')
    expect((await db.asSystem().task.findUnique({ where: { id: t.id } })).projectId).toBe(2)
    expect((await alice.task.update({ where: { id: t.id }, data: { projectId: null } })).projectId).toBe(null)
    db.$close()
  })

  test('updateMany, createMany and upsert grade the same key', async () => {
    const { db, alice } = await seeded()
    await alice.task.create({ data: { ownerId: 'alice', projectId: 2 } })
    expect(await refusal(alice.task.updateMany({ where: { ownerId: 'alice' }, data: { projectId: 1 } })))
      .toBeInstanceOf(ForeignKeyError)
    expect(await refusal(alice.task.createMany({ data: [
      { ownerId: 'alice', projectId: 2 }, { ownerId: 'alice', projectId: 1 },
    ] }))).toBeInstanceOf(ForeignKeyError)
    expect(await refusal(alice.task.upsert({
      where: { id: 77 }, create: { ownerId: 'alice', projectId: 1 }, update: {},
    }))).toBeInstanceOf(ForeignKeyError)
    expect(await db.asSystem().task.count()).toBe(1)
    db.$close()
  })

  test('a nested connect to a hidden parent is the same ForeignKeyError', async () => {
    const { db, alice } = await seeded()
    const e = await refusal(alice.task.create({ data: { ownerId: 'alice', project: { connect: { id: 1 } } } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.relation).toBe('project')
    db.$close()
  })

  test('a soft-deleted parent is a missing parent', async () => {
    const { db, alice } = await seeded()
    await alice.project.remove({ where: { id: 2 } })
    expect(await refusal(alice.task.create({ data: { ownerId: 'alice', projectId: 2 } })))
      .toBeInstanceOf(ForeignKeyError)
    db.$close()
  })

  test('asSystem() is the blind reference, and a key the engine stamps is not graded', async () => {
    const { db, sys, alice } = await seeded()
    expect((await sys.task.create({ data: { ownerId: 'alice', projectId: 1 } })).projectId).toBe(1)
    // authorId is @default(auth().id) and Member is readable by nobody: the
    // stamp is the engine's statement, not the caller's choice of parent.
    expect((await alice.task.create({ data: { ownerId: 'alice' } })).authorId).toBe('alice')
    // Named by the caller, the same key is graded.
    expect(await refusal(alice.task.create({ data: { ownerId: 'alice', authorId: 'alice' } })))
      .toBeInstanceOf(ForeignKeyError)
    db.$close()
  })
})

describe('the parent read is the caller\'s whole read', () => {
  test('a parent model the gate will not let her read at all is missing', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      model Plan { id Int @id
        subs Sub[]
        @@gate("8.8.8.8") }
      model Sub { id Int @id @default(autoincrement())
        planId Int
        plan Plan @relation(fields: [planId], references: [id])
        @@gate("1.1.1.1") }
    `, plugins: [new GatePlugin({ getLevel: (u: any) => (u ? 1 : 0) })] })
    await db.asSystem().plan.create({ data: { id: 1 } })
    const user = db.$setAuth({ id: 'u' })
    const hidden  = await refusal(user.sub.create({ data: { planId: 1 } }))
    const missing = await refusal(user.sub.create({ data: { planId: 9 } }))
    expect(hidden).toBeInstanceOf(ForeignKeyError)
    expect(shape(hidden)).toEqual(shape(missing))
    db.$close()
  })

  test('a parent she created earlier in the same transaction is hers to name', async () => {
    const { db, alice } = await seeded()
    await alice.$transaction(async (tx: any) => {
      const p = await tx.project.create({ data: { ownerId: 'alice' } })
      await tx.task.create({ data: { ownerId: 'alice', projectId: p.id } })
    })
    expect(await db.asSystem().task.count()).toBe(1)
    db.$close()
  })
})

describe('a delete refused by a child the caller cannot read', () => {
  test('names no hidden child id, only its model', async () => {
    const { db, sys, alice } = await seeded()
    await sys.task.create({ data: { ownerId: 'carol', projectId: 2 } })
    const e = await refusal(alice.project.delete({ where: { id: 2 } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.child).toEqual({ model: 'Task' })
    expect(e.message).not.toMatch(/\d/)
    expect(JSON.stringify(e.errors)).not.toMatch(/\d/)
    db.$close()
  })

  test('names a child the caller CAN read, ahead of a hidden one', async () => {
    const { db, sys, alice } = await seeded()
    await sys.task.create({ data: { ownerId: 'carol', projectId: 2 } })   // 1, hidden
    await sys.task.create({ data: { ownerId: 'alice', projectId: 2 } })   // 2, hers
    const e = await refusal(alice.project.delete({ where: { id: 2 } }))
    expect(e.child).toEqual({ model: 'Task', id: 2 })
    db.$close()
  })

  test('asSystem() is told the id it can read', async () => {
    const { db, sys } = await seeded()
    await sys.task.create({ data: { ownerId: 'carol', projectId: 2 } })
    const e = await refusal(sys.project.delete({ where: { id: 2 } }))
    expect(e.child).toEqual({ model: 'Task', id: 1 })
    db.$close()
  })
})
