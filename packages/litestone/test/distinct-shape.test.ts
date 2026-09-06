// `distinct` is a boolean, and everything else was accepted and ignored (FJS-935).
//
// SQLite has no DISTINCT ON. `buildSQL` reads `distinct === true` and nothing
// else, so `distinct: ['title']` emitted no DISTINCT at all and three rows over
// two titles came back as three — while `checkSelect` validated the array's
// ELEMENTS by name, so the API refused `distinct: ['nosuchcol']` and answered as
// though it had understood the argument. A string and a number were not even
// name-checked. Inside an INCLUDE nothing read `distinct` at all, `true`
// included, and nothing checked its names either.
//
// Refused rather than implemented, because both things a caller could mean
// already have a spelling: the distinct VALUES of a column are `select` plus
// `distinct: true`, and one whole row per value is `groupBy`, where WHICH row
// survives is a question the caller answers instead of an arbitrary partition
// answering it for them.
//
// Every refusal below sits beside the accepting shape one character away. A fix
// that refused `distinct` outright would satisfy any test that only asked about
// the refusal, and would break the one spelling that has always worked.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const ROOT = new URL('..', import.meta.url).pathname

const SCHEMA = `
database main { path ":memory:" }
model Author { id Int @id  name String  posts Post[] }
model Post   { id Int @id @default(autoincrement())  title String  authorId Int
               author Author @relation(fields: [authorId], references: [id]) }
`

async function seeded() {
  const db = await createClient({ schema: SCHEMA, resolveFrom: ROOT })
  await db.author.create({ data: { id: 1, name: 'ada' } })
  for (const title of ['a', 'a', 'b']) await db.post.create({ data: { title, authorId: 1 } })
  return db
}

describe('distinct is a boolean', () => {

  it('the documented spelling still dedupes — the control', async () => {
    const db   = await seeded()
    const rows = await db.post.findMany({ select: { title: true }, distinct: true })
    expect(rows.map((r: any) => r.title).sort()).toEqual(['a', 'b'])
  })

  it('a bare distinct: true is a whole-row DISTINCT, so three distinct rows stay three', async () => {
    const db = await seeded()
    expect((await db.post.findMany({ distinct: true })).length).toBe(3)
  })

  it('no distinct at all is untouched', async () => {
    const db = await seeded()
    expect((await db.post.findMany({})).length).toBe(3)
  })

  it('refuses a column list, naming both spellings that work', async () => {
    const db = await seeded()
    const err = await db.post.findMany({ distinct: ['title'] } as any).catch((e: any) => e)
    expect(err.message).toMatch(/'distinct' on Post\.findMany is a boolean/)
    expect(err.message).toMatch(/DISTINCT ON/)
    expect(err.message).toMatch(/groupBy/)
  })

  it('refuses a string and a number — neither was name-checked before', async () => {
    const db = await seeded()
    await expect(db.post.findMany({ distinct: 'title' } as any)).rejects.toThrow(/is a boolean — got string/)
    await expect(db.post.findMany({ distinct: 1 } as any)).rejects.toThrow(/is a boolean — got number/)
  })

  it('a wrong column name in a list is the SHAPE refusal, not Unknown field', async () => {
    // The old message named the column, which made a list read as understood.
    const db  = await seeded()
    const err = await db.post.findMany({ distinct: ['nosuchcol'] } as any).catch((e: any) => e)
    expect(err.message).toMatch(/is a boolean/)
    expect(err.message).not.toMatch(/Unknown field/)
  })

  it('applies on findManyCursor too — the second reader of the same arg', async () => {
    const db = await seeded()
    await expect(db.post.findManyCursor({ distinct: ['title'], limit: 2 } as any))
      .rejects.toThrow(/'distinct' on Post\.findManyCursor is a boolean/)
  })

  it('refuses distinct inside an include, true included, and leaves the include alone', async () => {
    const db = await seeded()
    // The include itself is the control: without the key it answers every post.
    expect((await db.author.findMany({ include: { posts: true } }))[0].posts.length).toBe(3)
    await expect(db.author.findMany({ include: { posts: { distinct: true } } } as any))
      .rejects.toThrow(/'distinct' inside an include on Author\.findMany/)
    await expect(db.author.findMany({ include: { posts: { distinct: ['title'] } } } as any))
      .rejects.toThrow(/inside an include/)
  })

  it('reaches a nested include, where nothing name-checked it either', async () => {
    const db = await seeded()
    await expect(db.author.findMany({
      include: { posts: { include: { author: { distinct: true } } } },
    } as any)).rejects.toThrow(/inside an include/)
  })

  it('an include that names where and orderBy is still honoured', async () => {
    const db   = await seeded()
    const rows = await db.author.findMany({
      include: { posts: { where: { title: 'a' }, orderBy: { id: 'desc' } } },
    })
    expect(rows[0].posts.map((p: any) => p.title)).toEqual(['a', 'a'])
  })
})
