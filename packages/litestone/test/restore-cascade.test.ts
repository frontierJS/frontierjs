// FJS-1583 — a cascade restore brings back only what the cascade removed.
//
// remove() stamps a parent and every LIVE child with one timestamp, and leaves
// a child that was already deleted holding its own. restore() un-stamped every
// child of the parent whatever its stamp, so a doc deleted on its own a week
// before its folder came back when the folder did — a delete somebody decided
// on, undone by a restore of something else. Every case is paired: the
// cascaded child DOES come back, or a restore that brought back nothing passes.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Folder {
  id        Int       @id @default(autoincrement())
  docs      Doc[]
  deletedAt DateTime?
  @@softDelete(cascade)
}
model Doc {
  id        Int       @id @default(autoincrement())
  folder    Folder    @relation(fields: [folderId], references: [id])
  folderId  Int
  notes     Note[]
  deletedAt DateTime?
  @@softDelete(cascade)
}
model Note {
  id        Int       @id @default(autoincrement())
  doc       Doc       @relation(fields: [docId], references: [id])
  docId     Int
  deletedAt DateTime?
  @@softDelete
}`

// Distinct stamps without a sleep: the client's clock is `ctx.now`.
async function env() {
  let t = Date.parse('2026-01-01T00:00:00Z')
  const db = await createClient({ schema: SCHEMA, db: ':memory:', now: () => new Date(t += 1000) })
  const folder = await db.folder.create({ data: {} })
  const kept   = await db.doc.create({ data: { folderId: folder.id } })
  const gone   = await db.doc.create({ data: { folderId: folder.id } })
  await db.note.create({ data: { docId: kept.id } })
  const loneNote = await db.note.create({ data: { docId: kept.id } })
  await db.note.create({ data: { docId: gone.id } })
  const live = async (model: 'doc' | 'note', where: Record<string, unknown>) =>
    (await db[model].findMany({ where, withDeleted: true, orderBy: { id: 'asc' } }))
      .map((r: { deletedAt: string | null }) => r.deletedAt ? 'deleted' : 'live').join(' ')
  return { db, folder, kept, gone, loneNote, live }
}

describe('a cascade restore reverses that cascade and nothing older', () => {
  it('a child deleted before its parent stays deleted when the parent comes back', async () => {
    const { db, folder, kept, gone, live } = await env()
    await db.doc.remove({ where: { id: gone.id } })
    await db.folder.remove({ where: { id: folder.id } })
    expect(await live('doc', { folderId: folder.id })).toBe('deleted deleted')

    await db.folder.restore({ where: { id: folder.id } })
    expect(await live('doc', { folderId: folder.id })).toBe('live deleted')
    // The earlier delete's own subtree stays with it, and the cascaded one returns.
    expect(await live('note', { docId: gone.id })).toBe('deleted')
    expect(await live('note', { docId: kept.id })).toBe('live live')
    db.$close()
  })

  it('a grandchild deleted before the cascade stays deleted two levels down', async () => {
    const { db, folder, kept, loneNote, live } = await env()
    await db.note.remove({ where: { id: loneNote.id } })
    await db.folder.remove({ where: { id: folder.id } })

    await db.folder.restore({ where: { id: folder.id } })
    expect(await live('doc', { id: kept.id })).toBe('live')
    expect(await live('note', { docId: kept.id })).toBe('live deleted')
    db.$close()
  })

  it('a restore matching parents removed at different times brings back each one\'s own cascade', async () => {
    const { db, folder, live } = await env()
    const other = await db.folder.create({ data: {} })
    await db.doc.create({ data: { folderId: other.id } })
    await db.folder.remove({ where: { id: folder.id } })
    await db.folder.remove({ where: { id: other.id } })

    const rows = await db.folder.restore({ where: { id: { in: [folder.id, other.id] } } })
    expect(rows.length).toBe(2)
    expect(await live('doc', { folderId: folder.id })).toBe('live live')
    expect(await live('doc', { folderId: other.id })).toBe('live')
    db.$close()
  })
})
