// FJS-1728 — removeMany() on a @@softDelete(cascade) model cascades only from
// the rows it stamped.
//
// The cascade's roots were read from the caller's where and the live filter
// alone, so a row the delete policy refused was left live while its children
// were stamped under it. Each case pairs the refused row with the allowed one,
// or a cascade that stamped nothing would pass.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model User { id Int @id  @@auth }
model Folder {
  id        Int       @id @default(autoincrement())
  ownerId   Int
  docs      Doc[]
  deletedAt DateTime?
  @@allow('read', true)
  @@allow('create', true)
  @@allow('update', true)
  @@allow('delete', ownerId == auth().id)
  @@softDelete(cascade)
}
model Doc {
  id        Int       @id @default(autoincrement())
  folder    Folder    @relation(fields: [folderId], references: [id])
  folderId  Int
  deletedAt DateTime?
  @@allow('all', true)
  @@softDelete
}`

async function env() {
  const db = await createClient({ schema: SCHEMA, db: ':memory:' })
  const sys = db.asSystem()
  for (const ownerId of [1, 2]) {
    const f = await sys.folder.create({ data: { ownerId } })
    await sys.doc.create({ data: { folderId: f.id } })
  }
  const state = async (model: 'folder' | 'doc') =>
    (await sys[model].findMany({ withDeleted: true, orderBy: { id: 'asc' } }))
      .map((r: { deletedAt: string | null }) => r.deletedAt ? 'deleted' : 'live').join(' ')
  return { db, state }
}

describe('removeMany cascades from the rows its policy let it stamp', () => {
  it('a refused folder keeps its doc live, and the allowed folder takes its doc with it', async () => {
    const { db, state } = await env()
    const { count } = await db.$setAuth({ id: 1 }).folder.removeMany({ where: {} })
    expect(count).toBe(1)
    expect(await state('folder')).toBe('deleted live')
    expect(await state('doc')).toBe('deleted live')
  })

  it('a caller who owns nothing stamps nothing, children included', async () => {
    const { db, state } = await env()
    const { count } = await db.$setAuth({ id: 3 }).folder.removeMany({ where: {} })
    expect(count).toBe(0)
    expect(await state('folder')).toBe('live live')
    expect(await state('doc')).toBe('live live')
  })
})
