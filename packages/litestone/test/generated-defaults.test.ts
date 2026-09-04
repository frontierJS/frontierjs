// `@default(cuid())`, `@default(ulid())` and `@default(nanoid())` on a column
// that is not the id.
//
// The gap this closes (FJS-423): only `uuid()` has a SQL DEFAULT ddl.js can
// emit, and the client generated the other three for the `@id` field alone. So
// a required `String @default(cuid())` parsed, emitted a plausible table, and
// then failed `NOT NULL constraint failed: <table>.<column>` at the first
// create() — the column simply was not in the insert.
//
// Two rules this suite holds. **Every write path fills it** — create,
// createMany, upsert (both the fast path and the findFirst one) and upsertMany
// each massage the payload themselves, so a fix in one is not a fix in the
// others. And **key presence decides**: a stated `null` on a nullable column
// stays null, which is what a SQL DEFAULT does, so `@default(cuid())` and
// `@default(uuid())` answer alike either way.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { generateCuid, generateUlid, generateNanoid } from '../src/core/ids.js'

const SCHEMA = `
model Token {
  id     Int     @id @default(autoincrement())
  slug   String  @unique
  cuid   String  @default(cuid())
  ulid   String  @default(ulid())
  nano   String  @default(nanoid())
  uuid   String  @default(uuid())
  opt    String? @default(cuid())
}
`

const client = () => createClient({ schema: SCHEMA, db: ':memory:' })

describe('generated defaults on a non-id column', () => {
  it('create() fills all four kinds', async () => {
    const db  = await client()
    const row = await db.token.create({ data: { slug: 'a' } })
    expect(row.cuid).toMatch(/^c[0-9a-z]{24}$/)
    expect(row.ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(row.nano).toHaveLength(21)
    expect(row.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a supplied value wins', async () => {
    const db  = await client()
    const row = await db.token.create({ data: { slug: 'a', cuid: 'mine' } })
    expect(row.cuid).toBe('mine')
  })

  it('an explicit null on a nullable column stays null', async () => {
    const db = await client()
    expect((await db.token.create({ data: { slug: 'a' } })).opt).toMatch(/^c/)
    expect((await db.token.create({ data: { slug: 'b', opt: null } })).opt).toBeNull()
  })

  it('every value is distinct', async () => {
    const db   = await client()
    const rows = await Promise.all(
      ['a', 'b', 'c'].map(slug => db.token.create({ data: { slug } })))
    expect(new Set(rows.map(r => r.cuid)).size).toBe(3)
    expect(new Set(rows.map(r => r.ulid)).size).toBe(3)
    expect(new Set(rows.map(r => r.nano)).size).toBe(3)
  })

  it('createMany fills them per row', async () => {
    const db = await client()
    await db.token.createMany({ data: [{ slug: 'a' }, { slug: 'b', cuid: 'given' }] })
    const rows = await db.token.findMany({ orderBy: { slug: 'asc' } })
    expect(rows[0].cuid).toMatch(/^c/)
    expect(rows[1].cuid).toBe('given')
    expect(rows[0].ulid).not.toBe(rows[1].ulid)
  })

  it('upsert fills them on the insert branch', async () => {
    const db = await client()
    await db.token.upsert({ where: { slug: 'a' }, create: { slug: 'a' }, update: { slug: 'a' } })
    const row = await db.token.findFirst({ where: { slug: 'a' } })
    expect(row.cuid).toMatch(/^c/)
    expect(row.nano).toHaveLength(21)
  })

  it('upsertMany fills them on the insert branch', async () => {
    const db = await client()
    await db.token.upsertMany({ data: [{ slug: 'a' }], conflictTarget: ['slug'] })
    const row = await db.token.findFirst({ where: { slug: 'a' } })
    expect(row.cuid).toMatch(/^c/)
    expect(row.ulid).toHaveLength(26)
  })
})

describe('the generators themselves', () => {
  it('cuid is 25 chars of the declared alphabet', () => {
    for (let i = 0; i < 200; i++) expect(generateCuid()).toMatch(/^c[0-9a-z]{24}$/)
  })

  it('ulid sorts by creation order', async () => {
    const first = generateUlid()
    await new Promise(r => setTimeout(r, 2))
    expect(generateUlid() > first).toBe(true)
  })

  it('nanoid honors a requested size', () => {
    expect(generateNanoid(8)).toHaveLength(8)
  })
})
