// A field's write transforms (@lower, @trim, @upper, @slug) reach an equality
// `where` on that field (FJS-1456). A value the write would have changed can
// never be stored, so comparing it raw answers nothing — the person typing
// `Mixed.Case@Example.test` at a login form was never found.

import { describe, test, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { createClient } from '../src/core/client.js'
import { tempDir } from '../src/tmp-dirs.js'

const TMP = tempDir('litestone-where-transforms-')

const SCHEMA = `
  model User {
    id    Int     @id
    email String  @unique @lower
    code  String? @upper @trim
    slug  String? @slug
    posts Post[]
  }
  model Post {
    id     Int  @id
    userId Int
    user   User @relation(fields: [userId], references: [id])
  }
`

let db: any

beforeAll(async () => {
  const path = join(TMP, `wt-${Math.random().toString(36).slice(2)}.db`)
  const parsed = parse(SCHEMA)
  if (!parsed.valid) throw new Error(parsed.errors.join('\n'))
  const raw = new Database(path)
  for (const stmt of splitStatements(generateDDL(parsed.schema)))
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  raw.close()
  db = await createClient({ parsed, db: path })
  await db.user.create({ data: { id: 1, email: 'Mixed.Case@Example.test', code: ' ab1 ', slug: 'Hello World' } })
  await db.user.create({ data: { id: 2, email: 'other@example.test' } })
  await db.post.create({ data: { id: 1, userId: 1 } })
})

describe('an equality where on a transformed field', () => {
  test('matches the spelling the write was handed', async () => {
    expect((await db.user.findFirst({ where: { email: 'Mixed.Case@Example.test' } }))?.id).toBe(1)
    expect((await db.user.findFirst({ where: { email: 'MIXED.CASE@EXAMPLE.TEST' } }))?.id).toBe(1)
    expect((await db.user.findUnique({ where: { email: 'Mixed.Case@Example.test' } }))?.id).toBe(1)
    expect((await db.user.findFirst({ where: { code: '  Ab1' } }))?.id).toBe(1)
    expect((await db.user.findFirst({ where: { slug: 'Hello World' } }))?.id).toBe(1)
  })

  test('every spelling of equality: equals, in, not, notIn, the bare array', async () => {
    expect((await db.user.findFirst({ where: { email: { equals: 'MIXED.case@example.test' } } }))?.id).toBe(1)
    expect((await db.user.findMany({ where: { email: { in: ['MIXED.CASE@EXAMPLE.TEST', 'Other@Example.test'] } } })).length).toBe(2)
    expect((await db.user.findMany({ where: { email: ['MIXED.CASE@EXAMPLE.TEST'] } })).map((r: any) => r.id)).toEqual([1])
    expect((await db.user.findMany({ where: { email: { not: 'MIXED.CASE@EXAMPLE.TEST' } } })).map((r: any) => r.id)).toEqual([2])
    expect((await db.user.findMany({ where: { email: { notIn: ['MIXED.CASE@EXAMPLE.TEST'] } } })).map((r: any) => r.id)).toEqual([2])
  })

  test('inside AND / OR / NOT, and on a write that takes a where', async () => {
    expect((await db.user.findMany({ where: { OR: [{ email: 'MIXED.CASE@EXAMPLE.TEST' }, { id: 99 }] } })).length).toBe(1)
    expect(await db.user.count({ where: { NOT: { email: 'MIXED.CASE@EXAMPLE.TEST' } } })).toBe(1)
    await db.user.update({ where: { email: 'OTHER@example.test' }, data: { code: 'zz' } })
    expect((await db.user.findUnique({ where: { id: 2 } }))?.code).toBe('ZZ')
  })

  test('an operator that is not equality is left as asked', async () => {
    // A range bound is compared as given: `ab2` sorts after both `AB1` and `ZZ`,
    // where an upper-cased `AB2` would have excluded `ZZ`.
    expect((await db.user.findMany({ where: { code: { lt: 'ab2' } }, orderBy: { id: 'asc' } })).map((r: any) => r.id)).toEqual([1, 2])
    expect(await db.user.count({ where: { email: null } })).toBe(0)
  })
})

describe('an equality under a relation filter (FJS-1468)', () => {
  test('goes through the related field\'s transforms', async () => {
    expect((await db.post.findMany({ where: { user: { is: { email: 'MIXED.CASE@EXAMPLE.TEST' } } } })).map((r: any) => r.id)).toEqual([1])
    expect((await db.post.findMany({ where: { user: { isNot: { email: 'MIXED.CASE@EXAMPLE.TEST' } } } })).length).toBe(0)
    expect((await db.user.findMany({ where: { posts: { some: { user: { is: { email: { in: ['Mixed.Case@Example.test'] } } } } } } })).map((r: any) => r.id)).toEqual([1])
  })
})
