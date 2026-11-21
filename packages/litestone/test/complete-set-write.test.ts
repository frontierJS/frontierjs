// test/complete-set-write.test.ts
//
// A write that must cover a COMPLETE set has no schema spelling (`FJS-D1284`,
// `FJS-3066`): rotating an account key replaces `User.key` and every Cipher
// and Folder of that user in one write, refused if any row is missing. Nothing
// in `.lite` reaches across rows that way (`@@check` sees one row,
// `@@transitions` one column), so the engine commits a partial rotation and
// the spelling is `$transaction` plus a count in the service. These tests pin
// both halves, so a reader of the `data-hazards` entry can trust that the
// count's throw rolls the key back too.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model User {
    id      Int      @id
    key     String
    ciphers Cipher[]
    folders Folder[]
  }

  model Cipher {
    id     Int    @id
    user   User   @relation(fields: [userId], references: [id])
    userId Int
    data   String
  }

  model Folder {
    id     Int    @id
    user   User   @relation(fields: [userId], references: [id])
    userId Int
    name   String
  }
`

let db: any

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
  await db.user.create({ data: { key: 'old' } })
  await db.cipher.createMany({ data: [
    { userId: 1, data: 'a@old' }, { userId: 1, data: 'b@old' }, { userId: 1, data: 'c@old' },
  ] })
  await db.folder.create({ data: { userId: 1, name: 'f@old' } })
})

// The service's whole rule: every row of each set the key seals is in the
// request, or the rotation is refused before anything is read as rotated.
async function rotateKey(tx: any, userId: number, request: {
  key: string, ciphers: { id: number, data: string }[], folders: { id: number, name: string }[]
}) {
  await tx.user.update({ where: { id: userId }, data: { key: request.key } })
  const sets = [
    ['cipher', request.ciphers, (r: any) => ({ data: r.data })],
    ['folder', request.folders, (r: any) => ({ name: r.name })],
  ] as const
  for (const [model, rows, data] of sets) {
    const owned = await tx[model].count({ where: { userId } })
    const ids = new Set(rows.map(r => r.id))
    if (ids.size !== owned) throw new Error(`All existing ${model} rows must be included in the rotation`)
    for (const row of rows) {
      const { count } = await tx[model].updateMany({ where: { id: row.id, userId }, data: data(row) })
      if (count !== 1) throw new Error(`${model} ${row.id} is not this user's`)
    }
  }
}

describe('a write that must cover a complete set', () => {
  test('the engine alone commits a partial rotation', async () => {
    await db.$transaction(async (tx: any) => {
      await tx.user.update({ where: { id: 1 }, data: { key: 'new' } })
      await tx.cipher.update({ where: { id: 1 }, data: { data: 'a@new' } })
      await tx.cipher.update({ where: { id: 2 }, data: { data: 'b@new' } })
    })
    expect((await db.user.findUnique({ where: { id: 1 } })).key).toBe('new')
    expect((await db.cipher.findUnique({ where: { id: 3 } })).data).toBe('c@old')
  })

  test('$transaction plus a count refuses a short set and rolls the key back', async () => {
    await expect(db.$transaction((tx: any) => rotateKey(tx, 1, {
      key:     'new',
      ciphers: [{ id: 1, data: 'a@new' }, { id: 2, data: 'b@new' }],
      folders: [{ id: 1, name: 'f@new' }],
    }))).rejects.toThrow('All existing cipher rows must be included in the rotation')

    expect((await db.user.findUnique({ where: { id: 1 } })).key).toBe('old')
    expect((await db.cipher.findMany({ orderBy: { id: 'asc' } })).map((c: any) => c.data))
      .toEqual(['a@old', 'b@old', 'c@old'])
  })

  test('a row of another user does not make up the count', async () => {
    await db.user.create({ data: { key: 'theirs' } })
    await db.cipher.create({ data: { userId: 2, data: 'x@theirs' } })

    await expect(db.$transaction((tx: any) => rotateKey(tx, 1, {
      key:     'new',
      ciphers: [{ id: 1, data: 'a@new' }, { id: 2, data: 'b@new' }, { id: 4, data: 'x@new' }],
      folders: [{ id: 1, name: 'f@new' }],
    }))).rejects.toThrow('cipher 4 is not this user\'s')

    expect((await db.user.findUnique({ where: { id: 1 } })).key).toBe('old')
    expect((await db.cipher.findUnique({ where: { id: 4 } })).data).toBe('x@theirs')
  })

  test('a complete set commits every row with the key', async () => {
    await db.$transaction((tx: any) => rotateKey(tx, 1, {
      key:     'new',
      ciphers: [{ id: 1, data: 'a@new' }, { id: 2, data: 'b@new' }, { id: 3, data: 'c@new' }],
      folders: [{ id: 1, name: 'f@new' }],
    }))
    expect((await db.user.findUnique({ where: { id: 1 } })).key).toBe('new')
    expect((await db.cipher.findMany({})).every((c: any) => c.data.endsWith('@new'))).toBe(true)
    expect((await db.folder.findUnique({ where: { id: 1 } })).name).toBe('f@new')
  })
})
