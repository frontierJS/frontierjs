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

// FJS-1641: a literal @default is written by the DDL, never by the engine, so
// it is not in the payload either. The policy grades the row as it will land.
const literal = `
enum Channel { email slack }
model Sub {
  id       Int     @id
  ownerId  String  @default(auth().id)
  channel  Channel @default(email)
  public   Boolean @default(false)
  @@allow('create', ownerId == auth().id && channel == 'email' && public == false)
  @@allow('read', true)
}
`

describe('create policy sees a literal default (FJS-1641)', () => {
  it('create, createMany and upsertMany pass on the default; a value the caller sends is graded as sent', async () => {
    const db: any = await createClient({ schema: literal, db: ':memory:' })
    const me = db.$setAuth({ id: 'u1' })
    const row = await me.sub.create({ data: {} })
    expect(row.channel).toBe('email')
    expect(row.public).toBe(false)
    await me.sub.createMany({ data: [{}, {}] })
    await me.sub.upsertMany({ data: [{ id: 99 }] })
    expect(await db.asSystem().sub.count()).toBe(4)
    await expect(me.sub.create({ data: { channel: 'slack' } })).rejects.toThrow(/denied/)
    await expect(me.sub.create({ data: { public: true } })).rejects.toThrow(/denied/)
    db.$close()
  })
})

// FJS-1793: with no principal the stamp has nothing to write, and a required
// column reached the INSERT as NULL — SQLite's NOT NULL, a 500.
const open = `
model Invitee {
  id      Int     @id
  email   String
  ownerId String  @default(auth().id)
  noteBy  String? @default(auth().id)
  @@gate("0.0.0.0")
}
`

describe('a required auth default with no principal is refused by name (FJS-1793)', () => {
  it('an anonymous create is a 401 naming the column, on every create path', async () => {
    const db: any = await createClient({ schema: open, db: ':memory:' })
    const calls = [
      () => db.invitee.create({ data: { email: 'a' } }),
      () => db.invitee.createMany({ data: [{ email: 'a' }] }),
      () => db.invitee.upsertMany({ data: [{ id: 9, email: 'a' }] }),
      () => db.invitee.upsert({ where: { id: 8 }, create: { email: 'a' }, update: {} }),
    ]
    for (const call of calls) {
      const err: any = await call().then(() => null, (e: any) => e)
      expect(err?.name).toBe('AccessDeniedError')
      expect(err?.status).toBe(401)
      expect(err?.message).toContain('ownerId defaults to auth().id')
    }
    expect(await db.asSystem().invitee.count()).toBe(0)
    db.$close()
  })

  it('a caller naming the column, a signed-in caller, and an optional column all write', async () => {
    const db: any = await createClient({ schema: open, db: ':memory:' })
    const named = await db.invitee.create({ data: { email: 'a', ownerId: 'u1' } })
    expect([named.ownerId, named.noteBy]).toEqual(['u1', null])
    const mine = await db.$setAuth({ id: 'u2' }).invitee.create({ data: { email: 'b' } })
    expect([mine.ownerId, mine.noteBy]).toEqual(['u2', 'u2'])
    db.$close()
  })

  it('a system create or a principal without the claim is a ValidationError naming the column', async () => {
    const db: any = await createClient({ schema: open, db: ':memory:' })
    for (const scoped of [db.asSystem(), db.$setAuth({ email: 'no-id' })]) {
      const err: any = await scoped.invitee.create({ data: { email: 'a' } }).then(() => null, (e: any) => e)
      expect(err?.name).toBe('ValidationError')
      expect(err?.errors?.[0]?.path).toEqual(['ownerId'])
      expect(err?.errors?.[0]?.message).toMatch(/ownerId defaults to auth\(\)\.id .* name ownerId on the call/)
    }
    db.$close()
  })
})
