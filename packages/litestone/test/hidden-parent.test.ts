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
    title     String?
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

  test('an update naming the parent the row already has moves nothing, and is not refused', async () => {
    const { db, sys, alice } = await seeded()
    // Hers, filed under Bob's project by somebody who could.
    const t = await sys.task.create({ data: { ownerId: 'alice', projectId: 1 } })
    // A form posts the whole row back, the hidden key included.
    expect((await alice.task.update({ where: { id: t.id }, data: { title: 'x', projectId: 1 } })).title).toBe('x')
    expect((await alice.task.updateMany({ where: { ownerId: 'alice' }, data: { title: 'y', projectId: 1 } })).count).toBe(1)
    // Paired: a second row of hers that would MOVE makes the bulk write a move.
    await alice.task.create({ data: { ownerId: 'alice', projectId: 2 } })
    expect(await refusal(alice.task.updateMany({ where: { ownerId: 'alice' }, data: { projectId: 1 } })))
      .toBeInstanceOf(ForeignKeyError)
    expect((await sys.task.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.projectId)).toEqual([1, 2])
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

describe('the gate ladder over a parent its levels cannot read', () => {
  // basecamp's shape: a Workspace any USER may create, under an Account only
  // its owner reads. The gate is asked before the parent is, so a create
  // refused as a missing parent is a create the gate admitted.
  test('a ForeignKeyError after the gate is the gate admitting, not a harness error', async () => {
    const { createTestEnv } = await import('../src/testing.js')
    const env = await createTestEnv({ schema: `
      model Account { id Int @id @default(autoincrement())
        workspaces Workspace[]
        @@gate("6.8") }
      model Workspace { id Int @id @default(autoincrement())
        name String
        accountId Int
        account Account @relation(fields: [accountId], references: [id])
        @@gate("1.1.5.5") }
    ` })
    expect((await env.verifyGateLadder()).filter((m: any) => m.model === 'Workspace')).toEqual([])
    env.close()
  })
})

// A create rule that reads a parent's column read the REAL row, so a caller who
// chose the key and the value compared with it read a hidden parent's column a
// guess at a time: ownerId 42 admitted userId 42 to the hidden-parent refusal
// and refused userId 41 by policy, where a missing team refused both (FJS-1712).
describe('a create rule reading a parent the caller cannot read', () => {
  const RULES = (tenancy: string) => `
    ${tenancy}
    model Team {
      id          Int       @id
      workspaceId Int
      ownerId     Int
      private     Boolean   @default(false)
      deletedAt   DateTime?
      members     TeamMember[]
      @@softDelete
      @@allow('all', private == false)
    }
    model TeamMember {
      id     Int  @id
      teamId Int
      team   Team @relation(fields: [teamId], references: [id])
      userId Int
      @@allow('read', true)
      @@allow('create', team.ownerId == userId)
    }
  `
  const seed = async (tenancy = '') => {
    const db: any = await createClient({ db: ':memory:', schema: RULES(tenancy) })
    await db.asSystem().team.createMany({ data: [
      { id: 1, workspaceId: 10, ownerId: 42, private: true },
      { id: 2, workspaceId: 10, ownerId: 42 },
      { id: 3, workspaceId: 10, ownerId: 42 },
      { id: 4, workspaceId: 20, ownerId: 42 },
    ] })
    await db.asSystem().team.delete({ where: { id: 2 } })
    return { db, me: db.$setAuth({ id: 1, workspaceId: 10 }) }
  }
  const answer = (p: Promise<unknown>) => p.then(() => 'created', (e: any) => e.name)

  test('a private team, a removed one and a missing one answer alike, whatever the guess', async () => {
    const { db, me } = await seed()
    for (const teamId of [1, 2, 999])
      for (const userId of [41, 42])
        expect(await answer(me.teamMember.create({ data: { id: 9, teamId, userId } }))).toBe('AccessDeniedError')
    // A team the caller reads is read for real, both ways.
    expect(await answer(me.teamMember.create({ data: { id: 9, teamId: 3, userId: 41 } }))).toBe('AccessDeniedError')
    expect(await answer(me.teamMember.create({ data: { id: 9, teamId: 3, userId: 42 } }))).toBe('created')
    db.$close()
  })

  // A gate is a tier above any compiled predicate, so check() saw a team the
  // caller's level cannot read as found and a missing one as not.
  test('check() across a parent the caller cannot read finds no row, as across a missing one', async () => {
    const GATED = (rule: string) => `
      model Team {
        id     Int   @id
        guests Guest[]
        @@gate("6.6.6.6")
        ${rule}
      }
      model Guest {
        id     Int  @id
        teamId Int
        team   Team @relation(fields: [teamId], references: [id])
        @@allow('read', true)
        @@allow('create', check(team))
      }
    `
    const plugins = [new GatePlugin({ getLevel: (u: any) => u?.level ?? 0 })]
    const answers = async (rule: string) => {
      const db: any = await createClient({ db: ':memory:', schema: GATED(rule), plugins })
      await db.asSystem().team.create({ data: { id: 1 } })
      const out = []
      for (const level of [4, 6])
        for (const teamId of [1, 999])
          out.push(await answer(db.$setAuth({ id: 1, level }).guest.create({ data: { id: 9 + teamId, teamId } })))
      db.$close()
      return out
    }
    expect(await answers(`@@allow('all', true)`)).toEqual(['AccessDeniedError', 'AccessDeniedError', 'created', 'AccessDeniedError'])
    // No row policy: check() admits without a lookup, so both reach the
    // missing-parent answer.
    expect(await answers('')).toEqual(['ForeignKeyError', 'ForeignKeyError', 'created', 'ForeignKeyError'])
  })

  // Every hidden parent of the row is read as missing, not the first alone.
  test('a row naming two hidden parents reads the second as missing too', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      model Team {
        id      Int     @id
        ownerId Int
        private Boolean @default(false)
        a       Pair[]  @relation("a")
        b       Pair[]  @relation("b")
        @@allow('all', private == false)
      }
      model Pair {
        id     Int  @id
        aId    Int
        a      Team @relation("a", fields: [aId], references: [id])
        bId    Int
        b      Team @relation("b", fields: [bId], references: [id])
        userId Int
        @@allow('read', true)
        @@allow('create', b.ownerId == userId)
      }
    ` })
    await db.asSystem().team.createMany({ data: [{ id: 1, ownerId: 42, private: true }, { id: 2, ownerId: 42, private: true }] })
    const me = db.$setAuth({ id: 1 })
    for (const bId of [2, 999])
      for (const userId of [41, 42])
        expect(await answer(me.pair.create({ data: { id: 9, aId: 1, bId, userId } }))).toBe('AccessDeniedError')
    db.$close()
  })

  test('createMany and upsertMany answer alike too', async () => {
    const { db, me } = await seed()
    for (const verb of ['createMany', 'upsertMany'])
      for (const teamId of [1, 2, 999])
        for (const userId of [41, 42]) {
          const err: any = await me.teamMember[verb]({ data: [{ id: 9, teamId, userId }] }).catch((e: any) => e)
          expect(err.cause?.name ?? err.name).toBe('AccessDeniedError')
        }
    db.$close()
  })

  test('under row tenancy, another workspace\'s team is one of them', async () => {
    const { db, me } = await seed('tenancy { strategy row  column workspaceId  claim workspaceId }')
    for (const teamId of [1, 4, 999])
      for (const userId of [41, 42])
        expect(await answer(me.teamMember.create({ data: { id: 9, teamId, userId } }))).toBe('AccessDeniedError')
    expect(await answer(me.teamMember.create({ data: { id: 9, teamId: 3, userId: 42 } }))).toBe('created')
    db.$close()
  })
})

// A key the app names under `system:` is its statement, as a stamp is
// (`FJS-1953`). A hook that copies a parent id onto a row the caller may not
// read the parent of must not be answered as the caller's guess at it.
describe('a foreign key the app names under system:', () => {
  const LIFT = `
    model Project {
      id      Int    @id @default(autoincrement())
      ownerId String
      tasks   Task[] @relation("lifted")
      @@allow('all', ownerId == auth().id)
    }

    model Task {
      id       Int      @id @default(autoincrement())
      ownerId  String
      liftedId Int?     @system
      lifted   Project? @relation("lifted", fields: [liftedId], references: [id])
      @@allow('all', ownerId == auth().id)
    }
  `
  async function lifted() {
    const db: any = await createClient({ db: ':memory:', schema: LIFT })
    const sys = db.asSystem()
    await sys.project.create({ data: { ownerId: 'bob' } })   // 1
    return { db, sys, alice: db.$setAuth({ id: 'alice' }) }
  }

  test('create, createMany, update and upsert take the hidden parent the app names', async () => {
    const { db, alice } = await lifted()
    const t = await alice.task.create({ data: { ownerId: 'alice', liftedId: 1 }, system: ['liftedId'] })
    expect(t.liftedId).toBe(1)
    const many = await alice.task.createMany({ data: [{ ownerId: 'alice', liftedId: 1 }], system: ['liftedId'] })
    expect(many).toBeDefined()
    await alice.task.update({ where: { id: t.id }, data: { liftedId: null }, system: ['liftedId'] })
    expect((await alice.task.update({ where: { id: t.id }, data: { liftedId: 1 }, system: ['liftedId'] })).liftedId).toBe(1)
    expect((await alice.task.upsert({
      where: { id: 77 }, create: { ownerId: 'alice', liftedId: 1 }, update: {}, system: ['liftedId'],
    })).liftedId).toBe(1)
    db.$close()
  })

  test('a parent that does not exist is still SQLite\'s refusal, and an unnamed key is still graded', async () => {
    const { db, alice } = await lifted()
    expect(await refusal(alice.task.create({ data: { ownerId: 'alice', liftedId: 999 }, system: ['liftedId'] })))
      .toBeInstanceOf(ForeignKeyError)
    // Without the statement the write is refused before the key is looked at.
    const e = await refusal(alice.task.create({ data: { ownerId: 'alice', liftedId: 1 } }))
    expect(e.message).not.toContain('created')
    db.$close()
  })
})
