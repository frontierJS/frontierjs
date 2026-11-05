// file-clear.test.ts — an update that sets a file column to null removes the
// object it held.
//
// The update picked its fields by whether the value was a file, so `null`
// replaced nothing and the cleared object stayed under the root with no row
// naming it, while a replace in the same place deleted the old one (FJS-3995).

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'

async function client() {
  const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
  const db: any = await createClient({
    schema: `
      model P {
        id     Int    @id
        status String @default("a")
        file   File?
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
  const ref = (col: string) => JSON.parse(db.$db.query(`SELECT ${col} FROM "P" WHERE id = 1`).get()[col])
  return { db, deletes, ref }
}

describe('an update clearing a file column removes its object (FJS-3995)', () => {

  test('file: null deletes the stored object', async () => {
    const { db, deletes, ref } = await client()
    await db.asSystem().p.create({ data: { id: 1, file: Buffer.from('a') } })
    const old = ref('file')

    await db.asSystem().p.update({ where: { id: 1 }, data: { file: null } })

    expect(deletes).toEqual([old.key])
    expect(db.$db.query('SELECT file FROM "P" WHERE id = 1').get().file).toBeNull()
    db.$close()
  })

  test('file: null under a where that is not the key deletes it too', async () => {
    const { db, deletes, ref } = await client()
    await db.asSystem().p.create({ data: { id: 1, file: Buffer.from('a') } })
    const old = ref('file')

    await db.asSystem().p.update({ where: { id: 1, status: 'a' }, data: { status: 'b', file: null } })

    expect(deletes).toEqual([old.key])
    db.$close()
  })

  test('an update that leaves the column out deletes nothing', async () => {
    const { db, deletes } = await client()
    await db.asSystem().p.create({ data: { id: 1, file: Buffer.from('a') } })

    await db.asSystem().p.update({ where: { id: 1 }, data: { status: 'b' } })

    expect(deletes).toEqual([])
    db.$close()
  })

  test('a clear inside a transaction that rolls back keeps the object', async () => {
    const { db, deletes } = await client()
    await db.asSystem().p.create({ data: { id: 1, file: Buffer.from('a') } })

    await db.asSystem().$transaction(async (tx: any) => {
      await tx.p.update({ where: { id: 1 }, data: { file: null } })
      throw new Error('roll back')
    }).catch(() => {})

    expect(deletes).toEqual([])
    expect(db.$db.query('SELECT file FROM "P" WHERE id = 1').get().file).not.toBeNull()
    db.$close()
  })
})
