/**
 * test/history.test.ts — `@history(into: Model)` (`FJS-D1294`, `FJS-3036`).
 *
 * Every value a column ever held is a row of the model it names — every slug a
 * post ever had, which the router reads to redirect an old address. The append
 * runs in the write's own unit at the system grade, so a seed, an `asSystem()`
 * tinker and a caller whose gate refuses the target all record, and a write
 * that rolls back leaves no row behind. The target's key on the value is what
 * keeps a former slug reserved: another post taking it is refused 409, the same
 * post may take it back.
 */

import { describe, test, expect } from 'bun:test'
import { parse, createClient, UniqueConflictError } from '../src/index.js'

const SCHEMA = `
database main { path ":memory:" }
model Post {
  id    Int    @id @default(autoincrement())
  slug  String @unique @history(into: Slug)
  title String @default("")
  @@allow(all, true)
}
model Slug {
  value     String   @id
  postId    Int
  post      Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  @@allow(read, true)
}
`
const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })
const errsOf = (src: string) => parse(src).errors.join(' · ')
const slugsOf = async (db: any, postId?: number) =>
  (await db.asSystem().slug.findMany({ where: postId == null ? {} : { postId }, orderBy: { value: 'asc' } }))
    .map((r: any) => `${r.value}>${r.postId}`)

async function refusal(p: Promise<unknown>) {
  try { await p } catch (e) { return e as any }
  throw new Error('expected the write to be refused')
}

describe('what parses', () => {
  const TARGET = `model H { value String @id  dId Int  d D @relation(fields: [dId], references: [id]) }`

  test('a column naming a model with one relation back and a keyed value field', () => {
    expect(parse(`model D { id Int @id  s String @history(into: H) }\n${TARGET}`).errors).toEqual([])
  })

  test('the target must exist, point back once, and key a value of the column\'s type', () => {
    expect(errsOf(`model D { id Int @id  s String @history(into: Nope) }`)).toMatch(/@history.*Nope/)
    expect(errsOf(`model D { id Int @id  s String @history(into: H) }\nmodel H { value String @id }`)).toMatch(/@history.*relation/)
    expect(errsOf(`model D { id Int @id  s String @history(into: H) }\nmodel H { id Int @id  value String  dId Int  d D @relation(fields: [dId], references: [id]) }`))
      .toMatch(/@history.*@id or @unique/)
    expect(errsOf(`model D { id Int @id  s String @history }\n${TARGET}`)).toMatch(/into/)
  })

  test('a column whose stored value is not its value is refused', () => {
    expect(errsOf(`model D { id Int @id  s Boolean @history(into: H) }\n${TARGET}`)).toMatch(/@history/)
    expect(errsOf(`model D { id Int @id  s String @encrypted @history(into: H) }\n${TARGET}`)).toMatch(/@history.*@encrypted/)
  })
})

describe('the write half', () => {
  test('create records the first value; each change records the new one; returning to one records nothing', async () => {
    const db = await client()
    const p  = await db.post.create({ data: { slug: 'a' } })
    for (const s of ['b', 'c', 'd', 'a']) await db.post.update({ where: { id: p.id }, data: { slug: s } })
    await db.post.update({ where: { id: p.id }, data: { title: 'no slug named' } })
    expect(await slugsOf(db)).toEqual(['a>1', 'b>1', 'c>1', 'd>1'])
  })

  test('another row taking a former value is refused 409 and nothing it wrote lands', async () => {
    const db = await client()
    const p  = await db.post.create({ data: { slug: 'a' } })
    await db.post.update({ where: { id: p.id }, data: { slug: 'b' } })
    const q  = await db.post.create({ data: { slug: 'z' } })
    const e  = await refusal(db.post.update({ where: { id: q.id }, data: { slug: 'a' } }))
    expect(e).toBeInstanceOf(UniqueConflictError)
    expect(e.status).toBe(409)
    expect(e.model).toBe('Post')
    expect(e.fields).toEqual(['slug'])
    expect((await db.post.findUnique({ where: { id: q.id } })).slug).toBe('z')
    expect(await slugsOf(db)).toEqual(['a>1', 'b>1', 'z>2'])
    expect(await refusal(db.post.create({ data: { slug: 'b' } }))).toBeInstanceOf(UniqueConflictError)
    expect(await db.post.count()).toBe(2)
  })

  test('asSystem(), a caller the target refuses, and select: false all record', async () => {
    const db = await client()
    const p  = await db.asSystem().post.create({ data: { slug: 'a' }, select: false })
    const id = (await db.post.findFirst()).id
    await db.asSystem().post.update({ where: { id }, data: { slug: 'b' } })
    await db.$setAuth({ id: 9 }).post.update({ where: { id }, data: { slug: 'c' }, select: false })
    expect(p).toBeNull()
    expect(await slugsOf(db)).toEqual(['a>1', 'b>1', 'c>1'])
  })

  test('createMany, updateMany and both halves of an upsert record', async () => {
    const db = await client()
    await db.post.createMany({ data: [{ slug: 'a' }, { slug: 'b' }] })
    await db.post.updateMany({ where: { slug: 'a' }, data: { slug: 'a2' } })
    await db.post.upsert({ where: { slug: 'c' }, create: { slug: 'c' }, update: {} })
    await db.post.upsert({ where: { slug: 'c' }, create: { slug: 'c' }, update: { slug: 'c2' } })
    expect(await slugsOf(db)).toEqual(['a>1', 'a2>1', 'b>2', 'c>3', 'c2>3'])
  })

  test('upsertMany, whose statements skip the append, is refused by name', async () => {
    const db = await client()
    const e  = await refusal(db.post.upsertMany({ data: [{ slug: 'a' }], conflictTarget: ['slug'] }))
    expect(e.message).toMatch(/@history\(into: Slug\)/)
    expect(await slugsOf(db)).toEqual([])
  })

  test('mapped columns on either side append to the right ones', async () => {
    const db = await createClient({ schema: `
database main { path ":memory:" }
model Page {
  id   Int    @id @default(autoincrement())
  path String @unique @map("url_path") @history(into: OldPath)
}
model OldPath {
  id     Int    @id @default(autoincrement())
  value  String @unique @map("old_value")
  pageId Int    @map("page_ref")
  page   Page   @relation(fields: [pageId], references: [id])
}`, resolveFrom: import.meta.dir })
    const p = await db.page.create({ data: { path: '/a' } })
    await db.page.update({ where: { id: p.id }, data: { path: '/b' } })
    expect((await db.oldPath.findMany({ orderBy: { id: 'asc' } })).map((r: any) => `${r.value}>${r.pageId}`)).toEqual(['/a>1', '/b>1'])
  })

  test('a transaction that rolls back takes its history rows with it', async () => {
    const db = await client()
    const p  = await db.post.create({ data: { slug: 'a' } })
    await refusal(db.$transaction(async (t: any) => {
      await t.post.update({ where: { id: p.id }, data: { slug: 'b' } })
      throw new Error('rolled back')
    }))
    expect(await slugsOf(db)).toEqual(['a>1'])
  })
})
