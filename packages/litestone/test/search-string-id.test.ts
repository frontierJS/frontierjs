// FJS-1289 — `@@fts` on a model whose id is not an INTEGER.
//
// The index was keyed on `id`, and an FTS5 rowid is an integer, so every
// INSERT into a uuid/ulid-keyed model — the ids `@@sync` needs — failed with
// `datatype mismatch`. The index is keyed on the source row's real rowid now,
// and `search()` rejoins on it. The Int twin keeps the common case honest.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const schema = (id: string) => `
model Issue {
  id    ${id}
  title String
  body  String
  @@fts([title, body])
}
`

for (const [label, id] of [
  ['String id', 'String @id @default(ulid())'],
  ['Int id',    'Int @id @default(autoincrement())'],
]) {
  describe(`@@fts over a ${label}`, () => {
    it('inserts, updates, deletes and searches', async () => {
      const db: any = await createClient({ schema: schema(id), db: ':memory:' })
      const a = await db.issue.create({ data: { title: 'crash on save', body: 'widget' } })
      const b = await db.issue.create({ data: { title: 'slow load', body: 'widget widget' } })
      await db.issue.create({ data: { title: 'typo', body: 'copy' } })

      const hits = await db.issue.search('widget', { withRank: true })
      expect(hits.map((r: any) => r.id).sort()).toEqual([a.id, b.id].sort())
      expect(hits.every((r: any) => typeof r._rank === 'number' && !('__fts_rowid' in r))).toBe(true)

      const sorted = await db.issue.search('widget', { orderBy: { title: 'asc' }, select: { title: true } })
      expect(sorted).toEqual([{ title: 'crash on save' }, { title: 'slow load' }])

      await db.issue.update({ where: { id: a.id }, data: { body: 'gadget' } })
      expect((await db.issue.search('widget')).map((r: any) => r.id)).toEqual([b.id])
      await db.issue.delete({ where: { id: b.id } })
      expect(await db.issue.search('widget')).toEqual([])
      expect((await db.issue.search('gadget', { where: { title: { contains: 'crash' } } })).map((r: any) => r.id)).toEqual([a.id])
    })
  })
}
