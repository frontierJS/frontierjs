// FJS-1723 — @@softDelete(cascade) follows a relation back into a model it
// has already reached.
//
// The walk seeded its visited set with the model being removed and dropped any
// hasMany whose target was visited, so Page → Page was gone before the walk
// started: trashing a page stamped the page and its own blocks and left every
// page under it, and their blocks, live and readable. The same skip dropped
// the second edge into a model two parents share. Every case is paired with
// the row that must stay live, or a cascade that stamped everything passes.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Page {
  id        Int       @id @default(autoincrement())
  parent    Page?     @relation("tree", fields: [parentId], references: [id], onDelete: Cascade)
  parentId  Int?
  children  Page[]    @relation("tree")
  blocks    Block[]
  deletedAt DateTime?
  @@softDelete(cascade)
}
model Block {
  id        Int       @id @default(autoincrement())
  page      Page      @relation(fields: [pageId], references: [id])
  pageId    Int
  deletedAt DateTime?
  @@softDelete
}`

async function tree() {
  let t = Date.parse('2026-01-01T00:00:00Z')
  const db = await createClient({ schema: SCHEMA, db: ':memory:', now: () => new Date(t += 1000) })
  const p1 = await db.page.create({ data: {} })
  const p2 = await db.page.create({ data: { parentId: p1.id } })
  const p3 = await db.page.create({ data: { parentId: p2.id } })
  const other = await db.page.create({ data: {} })
  for (const p of [p1, p2, p3, other]) await db.block.create({ data: { pageId: p.id } })
  const state = async (model: 'page' | 'block') =>
    (await db[model].findMany({ withDeleted: true, orderBy: { id: 'asc' } }))
      .map((r: { deletedAt: string | null }) => r.deletedAt ? 'deleted' : 'live').join(' ')
  return { db, p1, p2, p3, other, state }
}

describe('a soft-delete cascade walks a self-relation', () => {
  it('remove() stamps every page under the page, and their blocks', async () => {
    const { db, p1, state } = await tree()
    await db.page.remove({ where: { id: p1.id } })
    expect(await state('page')).toBe('deleted deleted deleted live')
    expect(await state('block')).toBe('deleted deleted deleted live')
    expect((await db.page.findMany()).length).toBe(1)
    db.$close()
  })

  it('removing a middle page leaves the page above it live', async () => {
    const { db, p2, state } = await tree()
    await db.page.remove({ where: { id: p2.id } })
    expect(await state('page')).toBe('live deleted deleted live')
    expect(await state('block')).toBe('live deleted deleted live')
    db.$close()
  })

  it('removeMany() walks the same subtree', async () => {
    const { db, p1, state } = await tree()
    await db.page.removeMany({ where: { id: p1.id } })
    expect(await state('page')).toBe('deleted deleted deleted live')
    expect(await state('block')).toBe('deleted deleted deleted live')
    db.$close()
  })

  it('a bulk write whose roots include their own descendants counts and returns every root', async () => {
    const { db, state } = await tree()
    expect(await db.page.removeMany({ where: {} })).toEqual({ count: 4 })
    expect(await state('block')).toBe('deleted deleted deleted deleted')
    expect((await db.page.restore({ where: {} })).length).toBe(4)
    expect(await state('page')).toBe('live live live live')
    expect(await state('block')).toBe('live live live live')
    db.$close()
  })

  it('restore() brings the subtree back, and a page deleted on its own before stays deleted', async () => {
    const { db, p1, p3, state } = await tree()
    await db.page.remove({ where: { id: p3.id } })
    await db.page.remove({ where: { id: p1.id } })
    expect(await state('page')).toBe('deleted deleted deleted live')

    await db.page.restore({ where: { id: p1.id } })
    expect(await state('page')).toBe('live live deleted live')
    expect(await state('block')).toBe('live live deleted live')
    db.$close()
  })
})

describe('a soft-delete cascade walks every edge into a shared child', () => {
  const DIAMOND = `
model Account {
  id        Int       @id @default(autoincrement())
  projects  Project[]
  tasks     Task[]
  deletedAt DateTime?
  @@softDelete(cascade)
}
model Project {
  id        Int       @id @default(autoincrement())
  account   Account   @relation(fields: [accountId], references: [id])
  accountId Int
  tasks     Task[]
  deletedAt DateTime?
  @@softDelete(cascade)
}
model Task {
  id        Int       @id @default(autoincrement())
  account   Account?  @relation(fields: [accountId], references: [id])
  accountId Int?
  project   Project?  @relation(fields: [projectId], references: [id])
  projectId Int?
  deletedAt DateTime?
  @@softDelete
}`

  it('a task reached only through its project is stamped with the account', async () => {
    const db = await createClient({ schema: DIAMOND, db: ':memory:' })
    const a = await db.account.create({ data: {} })
    const b = await db.account.create({ data: {} })
    const pa = await db.project.create({ data: { accountId: a.id } })
    const pb = await db.project.create({ data: { accountId: b.id } })
    await db.task.create({ data: { projectId: pa.id } })
    await db.task.create({ data: { projectId: pb.id } })
    await db.account.remove({ where: { id: a.id } })
    const tasks = await db.task.findMany({ withDeleted: true, orderBy: { id: 'asc' } })
    expect(tasks.map((t: { deletedAt: string | null }) => t.deletedAt ? 'deleted' : 'live').join(' ')).toBe('deleted live')
    db.$close()
  })
})
