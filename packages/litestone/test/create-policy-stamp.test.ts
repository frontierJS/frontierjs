// FJS-1402: a create policy grades the row the engine will insert, so a column
// stamped by @default(auth().x) satisfies a rule comparing it to auth().x.
import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const schema = `
model Lens {
  id      Int     @id
  name    String
  ownerId String  @default(auth().id)
  @@allow('all', ownerId == auth().id)
}
`

describe('create policy sees the auth-default stamp (FJS-1402)', () => {
  it('create, createMany and upsertMany pass on the stamp; a forged owner is refused', async () => {
    const db: any = await createClient({ schema, db: ':memory:' })
    const me = db.$setAuth({ id: 'u1' })
    const row = await me.lens.create({ data: { name: 'a' } })
    expect(row.ownerId).toBe('u1')
    await me.lens.createMany({ data: [{ name: 'b' }, { name: 'c' }] })
    await me.lens.upsertMany({ data: [{ id: 99, name: 'd' }] })
    expect(await db.asSystem().lens.count()).toBe(4)
    await expect(me.lens.create({ data: { name: 'x', ownerId: 'u2' } })).rejects.toThrow(/denied/)
    await expect(db.lens.create({ data: { name: 'anon' } })).rejects.toThrow()
    db.$close()
  })
})
