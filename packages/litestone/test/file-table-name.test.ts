// file-table-name.test.ts — a file plugin reads the old row from the model's
// TABLE and COLUMNS, not from names spelled like the model and its fields.
//
// The update hooks read the refs a write replaces with FROM "<model name>" and
// SELECT "<field name>", so a model whose table is derived (WhiteboardItem →
// whiteboard_item, FJS-4316) or whose File column is @map-ped (FJS-4320) threw
// "no such table" or "no such column", a bare catch swallowed it, and the
// replaced object stayed under the root with no row naming it; a File[] update
// carrying a held ref forward was refused as foreign.

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'
import { ExternalRefPlugin } from '../src/plugins/external-ref.js'

// `id` is mapped too: the old-row read's WHERE is built from the update's
// field names, so an unmapped id hides that half.
const CASES = [
  {
    name:  'a derived table name (FJS-4316)',
    table: 'whiteboard_item',
    col:   { file: 'file', photos: 'photos' },
    schema: `
      model WhiteboardItem {
        id     Int    @id
        file   File?
        photos File[]
        @@allow(all, true)
      }
    `,
  },
  {
    name:  'mapped columns (FJS-4320)',
    table: 'whiteboard_item',
    col:   { file: 'file_col', photos: 'photos_col' },
    schema: `
      model WhiteboardItem {
        id     Int    @id @map("item_id")
        file   File?  @map("file_col")
        photos File[] @map("photos_col")
        @@allow(all, true)
      }
    `,
  },
]

for (const c of CASES) {
  async function client() {
    const files = FileStorage({ provider: 'local', bucket: 'test', publicBase: 'https://cdn.test' }) as any
    const db: any = await createClient({ schema: c.schema, db: ':memory:', plugins: [files] })
    await autoMigrate(db)
    const deletes: string[] = []
    files._provider = {
      async put() {},
      async get() { return null },
      async delete(key: string) { deletes.push(key) },
    }
    const ref = (field: 'file' | 'photos') => {
      const col = c.col[field]
      return JSON.parse(db.$db.query(`SELECT "${col}" FROM "${c.table}"`).get()[col])
    }
    return { db, deletes, ref }
  }

  describe(`a file plugin reads the old row through ${c.name}`, () => {

    test('FileStorage: replacing a file deletes the old object', async () => {
      const { db, deletes, ref } = await client()
      await db.asSystem().whiteboardItem.create({ data: { id: 1, file: Buffer.from('a') } })
      const old = ref('file')

      await db.asSystem().whiteboardItem.update({ where: { id: 1 }, data: { file: Buffer.from('b') } })

      expect(deletes).toEqual([old.key])
      db.$close()
    })

    test('FileStorage: a File[] update carrying a held ref forward keeps it', async () => {
      const { db, deletes, ref } = await client()
      await db.asSystem().whiteboardItem.create({ data: { id: 1, photos: [Buffer.from('a')] } })
      const [held] = ref('photos')

      await db.asSystem().whiteboardItem.update({ where: { id: 1 }, data: { photos: [held, Buffer.from('b')] } })

      expect(ref('photos')[0].key).toBe(held.key)
      expect(deletes).toEqual([])
      db.$close()
    })

    test('ExternalRefPlugin: replacing a value cleans up the old ref', async () => {
      class RecordingStore extends ExternalRefPlugin {
        fieldType = 'File'
        cleaned: string[] = []
        n = 0
        async serialize() { return { key: `k${++this.n}` } }
        async cleanup(ref: any) { this.cleaned.push(ref.key) }
      }
      const store = new RecordingStore()
      const db: any = await createClient({ schema: c.schema, db: ':memory:', plugins: [store] })
      await autoMigrate(db)
      await db.asSystem().whiteboardItem.create({ data: { id: 1, file: Buffer.from('a') } })

      await db.asSystem().whiteboardItem.update({ where: { id: 1 }, data: { file: Buffer.from('b') } })

      expect(store.cleaned).toEqual(['k1'])
      db.$close()
    })
  })
}
