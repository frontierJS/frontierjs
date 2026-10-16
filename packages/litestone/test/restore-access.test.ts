// FJS-1096 — restore() is an update, and was graded as nothing.
//
// It built its UPDATE from the caller's where and the soft-delete clause alone:
// no `beforeUpdate` (so no `@@gate`), no update policy (so no `@@allow`, no
// `@@deny`, no row tenancy). Measured on basecamp, a viewer at READER(2) brought
// back a project behind an update gate of 4, and a member of ANOTHER workspace
// brought it back too. The cascade walked the same unscoped where, so a refused
// parent's children would have come back without it.
//
// verbs-rules.test.ts names `restore` as needing a fixture of its own, which is
// how it stayed outside the grid. This is that fixture. Every refusal is PAIRED
// with a caller one rung or one tenant over who DOES restore, and every answer
// is checked against the rows afterwards — a restore that refused everybody
// satisfies any test that only asks about the refusal.

import { describe, it, expect } from 'bun:test'
import { createClient, GatePlugin } from '../src/index.js'

const SCHEMA = `
model User { id Int @id  ws String?  @@auth }
model Folder {
  id        Int       @id @default(autoincrement())
  ws        String
  docs      Doc[]
  deletedAt DateTime?
  @@gate(2.4.4.5)
  @@deny('all', ws != auth().ws)
  @@softDelete(cascade)
}
model Doc {
  id        Int       @id @default(autoincrement())
  folder    Folder    @relation(fields: [folderId], references: [id])
  folderId  Int
  deletedAt DateTime?
  @@gate(2)
  @@softDelete
}`

async function env() {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  const sys = db.asSystem()
  const folder = await sys.folder.create({ data: { ws: 'A' } })
  await sys.doc.create({ data: { folderId: folder.id } })
  await sys.doc.create({ data: { folderId: folder.id } })
  await sys.folder.remove({ where: { id: folder.id } })

  const state = async () => ({
    folder: (await sys.folder.findFirst({ where: { id: folder.id }, withDeleted: true })).deletedAt ? 'deleted' : 'live',
    docs:   (await sys.doc.findMany({ where: { folderId: folder.id }, withDeleted: true }))
              .map((d: { deletedAt: string | null }) => d.deletedAt ? 'deleted' : 'live').join(' '),
  })
  const as = (level: number, ws: string) => db.$setAuth({ id: 1, level, ws })
  return { db, folder, state, as }
}

describe('restore is graded as the update it is', () => {
  it('the update GATE refuses one rung down, and the rung it names restores', async () => {
    const { db, folder, state, as } = await env()
    await expect(as(2, 'A').folder.restore({ where: { id: folder.id } })).rejects.toThrow(/level 4/)
    expect(await state()).toEqual({ folder: 'deleted', docs: 'deleted deleted' })

    const rows = await as(4, 'A').folder.restore({ where: { id: folder.id } })
    expect(rows.map((r: { id: number }) => r.id)).toEqual([folder.id])
    expect(await state()).toEqual({ folder: 'live', docs: 'live live' })
    db.$close()
  })

  it('a row the update POLICY excludes is not restored and not reported, and neither are its children', async () => {
    const { db, folder, state, as } = await env()
    // Another tenant, at a rung that clears the gate — so only the policy is asked.
    expect(await as(5, 'B').folder.restore({ where: { id: folder.id } })).toEqual([])
    expect(await state()).toEqual({ folder: 'deleted', docs: 'deleted deleted' })

    // The same call from inside the tenant is the control.
    await as(5, 'A').folder.restore({ where: { id: folder.id } })
    expect(await state()).toEqual({ folder: 'live', docs: 'live live' })
    db.$close()
  })

  it('a where matching nothing the caller may update answers [] rather than a refusal naming a row', async () => {
    const { db, as } = await env()
    const hidden = await as(5, 'B').folder.restore({ where: { id: 1 } })
    const absent = await as(5, 'B').folder.restore({ where: { id: 999 } })
    expect(hidden).toEqual(absent)
    db.$close()
  })
})

// FJS-2578 — the other half of the pair. `update({ data: { deletedAt } })` was
// remove() graded at the UPDATE gate: at level 4 under a delete gate of 5,
// remove() refused and update() stamped the row anyway, with no cascade. The
// column is refused by name on every update-family verb, `asSystem()` included,
// and every refusal is paired with the verb that does the removal and a write
// of another column that still lands.
describe('a soft-delete column is written only by remove() and restore()', () => {
  async function live() {
    const db = await createClient({
      schema: SCHEMA, db: ':memory:',
      plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
    })
    const sys = db.asSystem()
    const folder = await sys.folder.create({ data: { ws: 'A' } })
    await sys.doc.create({ data: { folderId: folder.id } })
    const state = async () => ({
      folder: (await sys.folder.findFirst({ where: { id: folder.id }, withDeleted: true })).deletedAt ? 'deleted' : 'live',
      docs:   (await sys.doc.findMany({ where: { folderId: folder.id }, withDeleted: true }))
                .map((d: { deletedAt: string | null }) => d.deletedAt ? 'deleted' : 'live').join(' '),
    })
    const as = (level: number) => db.$setAuth({ id: 1, level, ws: 'A' })
    return { db, sys, folder, state, as }
  }
  const stamp = () => new Date().toISOString()

  it('below the delete gate, every update verb naming deletedAt is refused and the row stays', async () => {
    const { db, folder, state, as } = await live()
    const f = as(4).folder
    await expect(f.remove({ where: { id: folder.id } })).rejects.toThrow(/level 5/)
    for (const call of [
      () => f.update({ where: { id: folder.id }, data: { deletedAt: stamp() } }),
      () => f.updateMany({ where: { id: folder.id }, data: { deletedAt: stamp() } }),
      () => f.upsert({ where: { id: folder.id }, create: { ws: 'A' }, update: { deletedAt: stamp() } }),
      () => f.upsertMany({ data: [{ id: folder.id, ws: 'A', deletedAt: stamp() }], conflictTarget: ['id'] }),
      () => f.upsertMany({ data: [{ id: folder.id, ws: 'A' }], conflictTarget: ['id'], update: ['deletedAt'] }),
    ]) {
      const err = await call().catch((e: Error) => e) as Error & { status?: number }
      expect(err.name).toBe('SoftDeleteWriteError')
      expect(err.status).toBe(400)
    }
    expect(await state()).toEqual({ folder: 'live', docs: 'live' })

    // Another column at the same level still lands.
    await f.update({ where: { id: folder.id }, data: { ws: 'A' } })
    db.$close()
  })

  it('asSystem() is refused the patch too, and its remove() cascades', async () => {
    const { db, sys, folder, state } = await live()
    await expect(sys.folder.update({ where: { id: folder.id }, data: { deletedAt: stamp() } }))
      .rejects.toThrow(/remove\(\)/)
    await expect(sys.folder.update({ where: { id: folder.id }, data: { deletedAt: null } }))
      .rejects.toThrow(/restore\(\)/)
    expect(await state()).toEqual({ folder: 'live', docs: 'live' })

    await sys.folder.remove({ where: { id: folder.id } })
    expect(await state()).toEqual({ folder: 'deleted', docs: 'deleted' })
    db.$close()
  })

  it('an omitted key is not a write, and a create may still state the column', async () => {
    const { db, sys, folder, state, as } = await live()
    await as(4).folder.update({ where: { id: folder.id }, data: { ws: 'A', deletedAt: undefined } })
    expect(await state()).toEqual({ folder: 'live', docs: 'live' })

    const gone = await sys.folder.create({ data: { ws: 'A', deletedAt: stamp() } })
    expect(await sys.folder.findFirst({ where: { id: gone.id } })).toBeNull()
    db.$close()
  })
})
