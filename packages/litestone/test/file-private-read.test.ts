// file-private-read.test.ts — a File on a local store with no publicBase (FJS-1504).
//
// No publicBase and no endpoint means the ref has no address, so a read answers
// null for every client, asSystem() included. `select: { f: { resolve: false } }`
// is how a route serving a private file reads the ref, on a File[] too.

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test' }) as any
  const db: any = await createClient({
    schema: `
      model Doc {
        id    Int    @id
        file  File?
        pics  File[]
        @@allow(all, true)
      }
    `,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  files._provider = { async put() {}, async get() { return null }, async delete() {} }
  return db
}

describe('a File with no public address (FJS-1504)', () => {
  test('a read answers null, the system\'s included', async () => {
    const db = await client()
    await db.doc.create({ data: { id: 1, file: Buffer.from('a') } })
    expect((await db.doc.findUnique({ where: { id: 1 } })).file).toBeNull()
    expect((await db.asSystem().doc.findUnique({ where: { id: 1 } })).file).toBeNull()
    expect((await db.asSystem().doc.findUnique({ where: { id: 1 }, select: { file: true } })).file).toBeNull()
    db.$close()
  })

  test('resolve:false reads the ref, a File[] too', async () => {
    const db = await client()
    await db.doc.create({ data: { id: 1, file: Buffer.from('a'), pics: [Buffer.from('b'), Buffer.from('c')] } })
    const select = { file: { resolve: false }, pics: { resolve: false } }
    for (const client of [db, db.asSystem()]) {
      const row = await client.doc.findUnique({ where: { id: 1 }, select })
      expect(row.file.key).toMatch(/^Doc\/file\//)
      expect(row.pics.map((p: any) => p.key)).toHaveLength(2)
    }
    db.$close()
  })
})

describe('a write answers its row like a read (FJS-1504, FJS-D1324)', () => {
  test('create and update answer null where the store has no address, the ref on resolve:false', async () => {
    const db = await client()
    const made = await db.doc.create({ data: { id: 1, file: Buffer.from('a'), pics: [Buffer.from('b')] } })
    expect(made.file).toBeNull()
    expect(made.pics).toEqual([null])
    const kept = await db.doc.create({ data: { id: 2, file: Buffer.from('a') }, select: { file: { resolve: false } } })
    expect(kept.file.key).toMatch(/^Doc\/file\//)
    const changed = await db.doc.update({ where: { id: 1 }, data: { file: Buffer.from('c') } })
    expect(changed.file).toBeNull()
    const asked = await db.doc.update({ where: { id: 1 }, data: { file: Buffer.from('d') }, select: { file: { resolve: false } } })
    expect(asked.file.key).toMatch(/^Doc\/file\//)
    db.$close()
  })
})
