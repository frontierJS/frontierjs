// FJS-2032: `@default(auth().x)` is a default, and a value in the payload wins
// it — an explicit null included (Invariant 9). Tested as `== null`, the stamp
// replaced the null, so a data move could not write a row whose author was gone.
// The claim column row tenancy generates is the exception: a null there is a
// row in no tenant, so the stamp still fills it.
import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const schema = `
model User {
  id   String @id
  name String
  @@auth
}

model Note {
  id       Int     @id
  content  String
  authorId String? @default(auth().id)
  author   User?   @relation(fields: [authorId], references: [id])
}

model Task {
  id      Int     @id
  title   String
  ownerId String? @default(auth().id)
  notes   Step[]
}

model Step {
  id      Int     @id
  taskId  Int
  task    Task    @relation(fields: [taskId], references: [id])
  ownerId String? @default(auth().id)
}
`

describe('an explicit null beats @default(auth().x) (FJS-2032)', () => {
  it('every create path writes the null; an omitted or undefined key is still stamped', async () => {
    const db: any = await createClient({ schema, db: ':memory:' })
    await db.asSystem().user.create({ data: { id: 'u1', name: 'a' } })
    const me = db.$setAuth({ id: 'u1' })

    expect((await me.note.create({ data: { id: 1, content: 'x', authorId: null } })).authorId).toBeNull()
    await me.note.createMany({ data: [{ id: 2, content: 'x', authorId: null }] })
    await me.note.upsertMany({ data: [{ id: 3, content: 'x', authorId: null }] })
    await me.note.upsert({ where: { id: 4 }, create: { id: 4, content: 'x', authorId: null }, update: {} })
    await me.task.create({ data: { id: 1, title: 't', notes: { create: [{ id: 1, ownerId: null }] } } })

    const nulls = await db.asSystem().note.findMany({ orderBy: { id: 'asc' } })
    expect(nulls.map((n: any) => n.authorId)).toEqual([null, null, null, null])
    expect((await db.asSystem().step.findUnique({ where: { id: 1 } })).ownerId).toBeNull()
    expect((await db.asSystem().task.findUnique({ where: { id: 1 } })).ownerId).toBe('u1')

    expect((await me.note.create({ data: { id: 5, content: 'x' } })).authorId).toBe('u1')
    expect((await me.note.create({ data: { id: 6, content: 'x', authorId: undefined } })).authorId).toBe('u1')
    db.$close()
  })

  it('a null on a required column is refused by name, not stamped', async () => {
    const db: any = await createClient({ schema: `
      model Lens {
        id      Int    @id
        ownerId String @default(auth().id)
      }
    `, db: ':memory:' })
    await expect(db.$setAuth({ id: 'u1' }).lens.create({ data: { id: 1, ownerId: null } }))
      .rejects.toThrow(/ownerId is required — a null beats its auth\(\)\.id default/)
    db.$close()
  })
})

const tenanted = `
tenancy {
  strategy row
  column   workspaceId
}

model Project {
  id          Int     @id
  workspaceId String?
  name        String
}
`

describe('the tenancy claim column still fills a null (FJS-2032)', () => {
  it('a tenant caller sending workspaceId: null lands in its own tenant', async () => {
    const db: any = await createClient({ schema: tenanted, db: ':memory:' })
    const me = db.$setAuth({ id: 'u1', workspaceId: 'w1' })
    const row = await me.project.create({ data: { id: 1, name: 'p', workspaceId: null } })
    expect(row.workspaceId).toBe('w1')
    await me.project.createMany({ data: [{ id: 2, name: 'p', workspaceId: null }] })
    expect((await db.asSystem().project.findUnique({ where: { id: 2 } })).workspaceId).toBe('w1')
    db.$close()
  })
})
