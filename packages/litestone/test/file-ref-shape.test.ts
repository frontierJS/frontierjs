// file-ref-shape.test.ts — a stored File reference is the parsed ref on every
// path that does not resolve it (FJS-2422).
//
// A File[] column is JSON-parsed with the other array columns, while a single
// File was stored as JSON text and handed back as that text by create, update
// and `select: { f: { resolve: false } }`, so `.mime` on it was undefined.

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({
    schema: `
      model P {
        id     Int    @id
        avatar File?
        docs   File[]
        @@allow(all, true)
      }
    `,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  files._provider = { async put() {}, async get() { return null }, async delete() {} }
  return db
}

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('a File reference is an object wherever it is not resolved (FJS-2422)', () => {

  test('create and update answer the parsed ref on resolve: false, as a File[] item does', async () => {
    const db = await client()
    const select = { avatar: { resolve: false }, docs: { resolve: false } }
    const made = await db.p.create({ data: { id: 1, avatar: png(), docs: [png()] }, select })
    expect(made.avatar.mime).toBe('image/png')
    expect(typeof made.avatar.key).toBe('string')
    expect(made.docs[0].mime).toBe('image/png')

    const changed = await db.p.update({ where: { id: 1 }, data: { avatar: png() }, select })
    expect(changed.avatar.mime).toBe('image/png')
    expect(changed.avatar.key).not.toBe(made.avatar.key)
    db.$close()
  })

  test('resolve: false answers the parsed ref on every read verb', async () => {
    const db = await client()
    await db.p.create({ data: { id: 1, avatar: png() } })
    const select = { avatar: { resolve: false } }
    expect((await db.p.findUnique({ where: { id: 1 }, select })).avatar.mime).toBe('image/png')
    expect((await db.p.findFirst({ select })).avatar.mime).toBe('image/png')
    expect((await db.p.findMany({ select }))[0].avatar.mime).toBe('image/png')
    db.$close()
  })

  test('a resolving read still answers the URL, and a null column stays null', async () => {
    const db = await client()
    const made = await db.p.create({ data: { id: 1, avatar: png() }, select: { avatar: { resolve: false } } })
    await db.p.create({ data: { id: 2 } })
    expect((await db.p.findUnique({ where: { id: 1 } })).avatar).toBe(`https://cdn.test/${made.avatar.key}`)
    expect((await db.p.findUnique({ where: { id: 2 } })).avatar).toBeNull()
    db.$close()
  })

  test('replacing the file deletes the old object', async () => {
    const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
    const db: any = await createClient({ schema: `model P { id Int @id\n avatar File?\n @@allow(all, true) }`, db: ':memory:', plugins: [files] })
    await autoMigrate(db)
    const deletes: string[] = []
    files._provider = { async put() {}, async get() { return null }, async delete(k: string) { deletes.push(k) } }
    const first = await db.p.create({ data: { id: 1, avatar: png() }, select: { avatar: { resolve: false } } })
    await db.p.update({ where: { id: 1 }, data: { avatar: png() } })
    expect(deletes).toEqual([first.avatar.key])
    await db.p.delete({ where: { id: 1 } })
    expect(deletes.length).toBe(2)
    db.$close()
  })
})
