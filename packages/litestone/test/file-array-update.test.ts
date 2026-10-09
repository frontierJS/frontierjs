// file-array-update.test.ts — an update giving a File[] column files uploads them.
//
// FileStorage's onBeforeUpdate picked its fields with isFileValue(value), which
// is false for an array, so `photos: [Buffer, Buffer]` uploaded nothing and the
// column stored the Buffers' JSON, `[{"type":"Buffer","data":[…]}, …]` (FJS-2095).

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({
    schema: `
      model P {
        id     Int    @id
        photos File[]
        @@allow('all', true)
      }
    `,
    db: ':memory:', plugins: [files],
  })
  await autoMigrate(db)
  const puts: string[] = []
  const deletes: string[] = []
  files._provider = {
    async put(key: string) { puts.push(key) },
    async get() { return null },
    async delete(key: string) { deletes.push(key) },
  }
  const stored = () => JSON.parse(db.$db.query('SELECT photos FROM "P" WHERE id = 1').get().photos)
  return { db, puts, deletes, stored }
}

describe('an update giving a File[] column files uploads them (FJS-2095)', () => {

  test('two Buffers upload two files and store their refs, and the replaced file is cleaned up', async () => {
    const { db, puts, deletes, stored } = await client()
    await db.asSystem().p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    const [old] = stored()
    puts.length = 0

    await db.asSystem().p.update({ where: { id: 1 }, data: { photos: [Buffer.from('b'), Buffer.from('c')] } })

    expect(puts).toHaveLength(2)
    const refs = stored()
    expect(refs.map((r: any) => r.key)).toEqual(puts)
    expect(refs.some((r: any) => r.type === 'Buffer')).toBe(false)
    expect(deletes).toEqual([old.key])
    db.$close()
  })

  test('a ref the new array keeps is not deleted when a file is appended', async () => {
    const { db, puts, deletes, stored } = await client()
    await db.asSystem().p.create({ data: { id: 1, photos: [Buffer.from('a')] } })
    const [kept] = stored()
    puts.length = 0

    await db.asSystem().p.update({ where: { id: 1 }, data: { photos: [kept, Buffer.from('b')] } })

    expect(puts).toHaveLength(1)
    expect(stored().map((r: any) => r.key)).toEqual([kept.key, puts[0]])
    expect(deletes).toEqual([])
    db.$close()
  })
})
