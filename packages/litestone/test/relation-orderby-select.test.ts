// test/relation-orderby-select.test.ts
//
// A belongsTo orderBy adds a JOIN, and a `select` names columns that exist on
// both tables. The SELECT list has to say which table it means (FJS-2299).

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../src/index.js'

const SCHEMA = `
  model Author { id Int @id  name String  posts Post[] }
  model Post   { id Int @id  title String  authorId Int
                 author Author @relation(fields: [authorId], references: [id]) }
`

async function db() {
  const sys = (await createClient({ db: ':memory:', schema: SCHEMA }) as any).asSystem()
  await sys.author.create({ data: { id: 1, name: 'zed' } })
  await sys.author.create({ data: { id: 2, name: 'amy' } })
  await sys.post.create({ data: { id: 1, title: 'p1', authorId: 1 } })
  await sys.post.create({ data: { id: 2, title: 'p2', authorId: 2 } })
  return sys
}

describe('select under a belongsTo orderBy', () => {
  test('a column both tables have is not ambiguous', async () => {
    const sys = await db()
    const rows = await sys.post.findMany({ select: { id: true }, orderBy: { author: { name: 'asc' } } })
    expect(rows).toEqual([{ id: 2 }, { id: 1 }])
  })

  test('several selected columns, filtered and paged', async () => {
    const sys = await db()
    const rows = await sys.post.findMany({
      select:  { id: true, title: true },
      where:   { id: { gte: 1 } },
      orderBy: { author: { name: 'desc' } },
      limit:   1,
    })
    expect(rows).toEqual([{ id: 1, title: 'p1' }])
  })

  test('a select that names only a relation still works', async () => {
    const sys = await db()
    const rows = await sys.post.findMany({ select: { author: true }, orderBy: { author: { name: 'asc' } } })
    expect(rows.map((r: any) => r.author.name)).toEqual(['amy', 'zed'])
  })
})
