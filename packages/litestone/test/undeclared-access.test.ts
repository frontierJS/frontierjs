// A model declaring no @@gate and no row policy refuses every operation below
// the system principal (`FJS-D1206`, `FJS-3193`). Open, it took anonymous
// creates, updates and deletes, and `access.snapshot.md` listing it
// Unrestricted was the only place that said so.
import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const schema = `
model Note {
  id   String @id
  body String
}
model Post {
  id   String @id
  body String
  @@gate(0)
}
model Draft {
  id      String @id
  ownerId String
  @@allow('all', ownerId == auth().id)
}
`

async function seeded() {
  const db = await createClient({ schema, db: ':memory:' })
  await db.asSystem().note.create({ data: { id: 'n1', body: 'x' } })
  return db
}

describe('a model with no access declaration', () => {
  it('refuses a stranger every operation, naming the declaration that opens it', async () => {
    const db = await seeded()
    const anon = db.$setAuth(null)
    await expect(anon.note.findMany()).rejects.toThrow(/Note declares no @@gate/)
    await expect(anon.note.create({ data: { id: 'n2', body: 'y' } })).rejects.toThrow(/@@gate\(0\) makes it public/)
    await expect(anon.note.update({ where: { id: 'n1' }, data: { body: 'z' } })).rejects.toThrow(/requires SYSTEM/)
    await expect(anon.note.delete({ where: { id: 'n1' } })).rejects.toThrow(/requires SYSTEM/)
  })

  it('refuses a signed-in caller too, and admits the system', async () => {
    const db = await seeded()
    await expect(db.$setAuth({ id: 'u1', isSystemAdmin: true }).note.findMany()).rejects.toThrow(/requires SYSTEM/)
    expect(await db.asSystem().note.findMany()).toHaveLength(1)
  })

  it('a written @@gate(0) is public and a row policy is a declaration', async () => {
    const db = await seeded()
    const anon = db.$setAuth(null)
    await anon.post.create({ data: { id: 'p1', body: 'hello' } })
    expect(await anon.post.findMany()).toHaveLength(1)
    const u1 = db.$setAuth({ id: 'u1' })
    await u1.draft.create({ data: { id: 'd1', ownerId: 'u1' } })
    expect(await u1.draft.findMany()).toHaveLength(1)
  })
})
