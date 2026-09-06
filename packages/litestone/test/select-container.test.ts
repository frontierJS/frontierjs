// FJS-828 — a `select` that is not an object projected no columns and said so
// nowhere.
//
// `parseSelectArg` walks the value's own entries looking for field names. Given
// `['id', 'title']` it finds the keys `0` and `1`, matches neither, and emits
// `SELECT "_no_cols_"` — so the read succeeded, answered `{}`, and every reader
// downstream saw a row that exists and is empty. The object form has refused an
// unknown column BY NAME since FJS-601; the wrong CONTAINER walked past that
// check entirely, and so did every `create`, which is in neither wrapper list.
//
// The list is not a second spelling to be accepted here. It is the WIRE form —
// `$select=id,title` — and junction's `parseSelect` turns one into the object
// before a read, which is the one owner of that translation (Invariant 4).
//
// Every refusal below is asserted BESIDE the object one character away that
// still answers, because a check that refused both containers is
// indistinguishable from one that works when only the refusal is asked about
// (FJS-351).

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Note {
  id    Int    @id @default(autoincrement())
  title String
  body  String
  @@fts([title, body])
}
`

const open = async () => {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  await db.note.create({ data: { title: 'alpha', body: 'x' } })
  await db.note.create({ data: { title: 'beta',  body: 'y' } })
  return db
}

const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null }
  catch (e: any) { return String(e.message) }
}

describe('FJS-828 — the select container', () => {
  it('an object still projects the columns it names', async () => {
    const db = await open()
    expect(await db.note.findFirst({ select: { id: true, title: true } }))
      .toEqual({ id: 1, title: 'alpha' })
    db.$close()
  })

  it('an absent select still answers the whole row', async () => {
    const db = await open()
    expect(await db.note.findFirst()).toEqual({ id: 1, title: 'alpha', body: 'x' })
    db.$close()
  })

  it('a list is refused by name, and says the object is the spelling', async () => {
    const db = await open()
    const msg = await refusal(() => db.note.findFirst({ select: ['id', 'title'] }))
    expect(msg).toContain('must be an object')
    expect(msg).toContain('an array')
    expect(msg).toContain('$select=a,b')
    db.$close()
  })

  it('a string, a number and `true` are refused the same way', async () => {
    const db = await open()
    for (const bad of ['id', 5, true]) {
      expect(await refusal(() => db.note.findFirst({ select: bad }))).toContain('must be an object')
    }
    db.$close()
  })

  // The verbs are wrapped in three different places — the read list, the write
  // list, and `create`'s own wrapper — so one covered verb says nothing about
  // the next.
  it('every verb that shapes a row refuses it, not just findFirst', async () => {
    const db = await open()
    const bad: Record<string, () => Promise<unknown>> = {
      findMany:   () => db.note.findMany({ select: ['id'] }),
      findUnique: () => db.note.findUnique({ where: { id: 1 }, select: ['id'] }),
      search:     () => db.note.search('alpha', { select: ['id'] }),
      create:     () => db.note.create({ data: { title: 'c', body: 'z' }, select: ['id'] }),
      update:     () => db.note.update({ where: { id: 1 }, data: { title: 'd' }, select: ['id'] }),
    }
    for (const [verb, run] of Object.entries(bad)) {
      expect(await refusal(run), verb).toContain('must be an object')
    }
    db.$close()
  })

  // `search` reached none of this: it validated neither the container nor the
  // keys, so FJS-601's refusal covered every read but that one.
  it('search refuses an unknown column by name too', async () => {
    const db = await open()
    expect(await refusal(() => db.note.search('alpha', { select: { nope: true } })))
      .toContain(`Unknown field 'nope'`)
    expect(await db.note.search('alpha', { select: { id: true } })).toEqual([{ id: 1 }])
    db.$close()
  })

  // create is in neither wrapper list, so it had never had either half.
  it('create refuses an unknown column by name too', async () => {
    const db = await open()
    expect(await refusal(() => db.note.create({ data: { title: 'c', body: 'z' }, select: { nope: true } })))
      .toContain(`Unknown field 'nope'`)
    expect(await db.note.create({ data: { title: 'd', body: 'z' }, select: { id: true } }))
      .toEqual({ id: 3 })   // 3, not 4 — the refused create above never wrote
    db.$close()
  })

  // `select: false` is the documented write spelling for *do not hand me the
  // row*, and it is the one non-object that stays legal. On a READ it means
  // nothing — it answered the whole row through the `!select` fast path, which
  // is the same silent wrong answer one value over.
  it('select: false is a write spelling and is refused on a read', async () => {
    const db = await open()
    expect(await db.note.create({ data: { title: 'e', body: 'z' }, select: false })).toBe(null)
    expect(await db.note.update({ where: { id: 1 }, data: { title: 'f' }, select: false })).toBe(null)
    const msg = await refusal(() => db.note.findFirst({ select: false }))
    expect(msg).toContain('must be an object')
    db.$close()
  })

  it('the write refusal names select: false and the read refusal does not', async () => {
    const db = await open()
    expect(await refusal(() => db.note.update({ where: { id: 1 }, data: {}, select: ['id'] })))
      .toContain('select: false')
    expect(await refusal(() => db.note.findMany({ select: ['id'] })))
      .not.toContain('select: false')
    db.$close()
  })
})
