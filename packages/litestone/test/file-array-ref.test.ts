// file-array-ref.test.ts — a File[] never takes another row's stored ref.
//
// FileStorage passed a File[] item that was an object with a key through as a
// ref, so a create could store another row's key; replacing or deleting that
// row then had the provider delete the other row's file (FJS-2308). A single
// File column already refuses a ref (FJS-D666).

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({
    schema: `
      model P {
        id     Int    @id
        tag    String?
        photos File[]
        @@allow(all, true)
      }
    `,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  const deletes: string[] = []
  files._provider = {
    async put() {},
    async get() { return null },
    async delete(key: string) { deletes.push(key) },
  }
  const stored = (id: number) => JSON.parse(db.$db.query('SELECT photos FROM "P" WHERE id = ?').get(id).photos ?? 'null')
  return { db, deletes, stored }
}

describe('a File[] never takes another row\'s stored ref (FJS-2308)', () => {

  test('a create carrying another row\'s ref is refused', async () => {
    const { db, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    const [victim] = stored(1)

    await expect(db.p.create({ data: { id: 2, photos: [victim] } })).rejects.toThrow(/photos/)
    await expect(db.p.create({ data: { id: 2, photos: [JSON.stringify(victim)] } })).rejects.toThrow(/photos/)
    await expect(db.p.create({ data: { id: 2, photos: [Buffer.from('b'), victim] } })).rejects.toThrow(/photos/)
    await expect(db.p.create({ data: { id: 2, photos: JSON.stringify(victim) } })).rejects.toThrow(/photos/)
    await expect(db.p.upsert({ where: { id: 2 }, create: { id: 2, photos: [victim] }, update: {} })).rejects.toThrow(/photos/)
    expect(db.$db.query('SELECT id FROM "P" WHERE id = 2').get()).toBeNull()
    db.$close()
  })

  test('createMany carrying another row\'s ref is refused', async () => {
    const { db, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    const [victim] = stored(1)

    await expect(db.p.createMany({ data: [{ id: 2, photos: [victim] }] })).rejects.toThrow(/photos/)
    db.$close()
  })

  test('an update carrying a ref this row does not hold is refused, and the other row\'s file survives', async () => {
    const { db, deletes, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    await db.p.create({ data: { id: 2, photos: [Buffer.from('b')] } })
    const [victim] = stored(1)

    await expect(db.p.update({ where: { id: 2 }, data: { photos: [victim] } })).rejects.toThrow(/photos/)
    await expect(db.p.update({ where: { id: 2 }, data: { photos: [victim, Buffer.from('c')] } })).rejects.toThrow(/photos/)
    await expect(db.p.upsert({ where: { id: 2 }, create: { id: 2 }, update: { photos: [victim] } })).rejects.toThrow(/photos/)
    await db.p.delete({ where: { id: 2 } })
    expect(deletes).not.toContain(victim.key)
    db.$close()
  })

  test('updateMany carrying a ref one matched row does not hold is refused', async () => {
    const { db, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    await db.p.create({ data: { id: 2, photos: [Buffer.from('b')] } })
    const [victim] = stored(1)

    await expect(db.p.updateMany({ where: { id: { in: [1, 2] } }, data: { photos: [victim] } })).rejects.toThrow(/photos/)
    db.$close()
  })

  test('a kept ref is the stored one, not the caller\'s copy of it', async () => {
    const { db, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    const [kept] = stored(1)

    await db.p.update({ where: { id: 1 }, data: { photos: [{ ...kept, publicBase: 'https://evil.test' }] } })
    expect(stored(1)).toEqual([kept])
    db.$close()
  })

  test('an update dropping a ref without adding a file deletes the dropped file (FJS-2315)', async () => {
    const { db, deletes, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a'), Buffer.from('b')] } })
    const [a, b] = stored(1)

    await db.p.update({ where: { id: 1 }, data: { photos: [a] } })
    expect(stored(1)).toEqual([a])
    expect(deletes).toEqual([b.key])

    await db.p.update({ where: { id: 1 }, data: { photos: [] } })
    expect(stored(1)).toEqual([])
    expect(deletes).toEqual([b.key, a.key])
    db.$close()
  })

  test('an update not touching the File[] column is untouched', async () => {
    const { db, stored } = await client()
    await db.p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    const before = stored(1)
    await db.p.update({ where: { id: 1 }, data: { tag: 'x' } })
    expect(stored(1)).toEqual(before)
    db.$close()
  })
})
