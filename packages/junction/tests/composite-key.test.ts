// tests/composite-key.test.ts — a model whose key is a tuple, through a service
//
// `FJS-608` made create work for these models, so a row could be MADE through
// the service and then never read back through it — the worst place for a gap
// to sit, since the schema parses, migrates and snapshots cleanly and the
// failure arrives at the first request (`FJS-694`).
//
// Two different faults, and only one of them is fixable here. The list was
// unreachable because the default ordering named a column called `id` that a
// composite-keyed model does not have — litestone's, and fixed there. Naming
// ONE row is not fixable: a URL segment is one value and the key is several,
// so this asserts that the refusal says so instead of leaking the Data
// boundary's *Unknown field 'id' in where*, which reads as the schema being
// wrong rather than the request being unanswerable.
//
// The second half is `FJS-D238`: a service addresses a row by ONE column, so
// what `idField` names has to identify one. Naming a member of the tuple was
// accepted and is a filter wearing an identity's name — a patch by it answered
// one row and wrote every row sharing the column. Every refusal here is PAIRED
// with the shape one column away that must still work, because a service that
// refused a tuple-keyed model outright would satisfy any test that only asked
// about the refusal.

import { describe, it, expect } from 'bun:test'
import { createApp, createService } from '../index.ts'
import { createClient } from '../../litestone/src/index.js'

const SCHEMA = `model Membership {
  userId Int
  teamId Int
  slug   String? @unique
  role   String @default("member")
  @@id([userId, teamId])
}
model Post {
  id    Int    @id @default(autoincrement())
  title String
}
`

async function app() {
  const db: any = await createClient({ resolveFrom: '/tmp', db: ':memory:', schema: SCHEMA })
  const a: any = createApp({
    db, config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  const all = ['find', 'get', 'create', 'update', 'patch', 'remove']
  a.services.register(createService({ name: 'memberships', model: 'Membership', methods: all, allowBulk: true }))
  a.services.register(createService({ name: 'posts',       model: 'Post',       methods: all, allowBulk: true }))
  // The two ways an app can point a service at a tuple-keyed model: one member
  // of the key, and a unique column outside it. They are one character apart in
  // the service file and they are opposite answers.
  a.services.register(createService({ name: 'byMember', model: 'Membership', idField: 'userId', methods: all }))
  a.services.register(createService({ name: 'bySlug',   model: 'Membership', idField: 'slug',   methods: all }))
  return { a, db }
}

describe('a tuple-keyed model through a derived service (FJS-694)', () => {

  it('the list is reachable, and was a 400 about a column that does not exist', async () => {
    const { a, db } = await app()
    await db.membership.create({ data: { userId: 1, teamId: 2 } })
    const res: any = await a.service('memberships').find()
    expect(res.data.map((r: any) => `${r.userId}/${r.teamId}`)).toEqual(['1/2'])
  })

  it('the list carries a cursor edge built from the WHOLE key', async () => {
    // The edge is what a window is grown from, and one built off half a key
    // names a position several rows share.
    const { a, db } = await app()
    for (const teamId of [1, 2]) await db.membership.create({ data: { userId: 1, teamId } })
    const res: any = await a.service('memberships').find()
    expect(typeof res.endCursor).toBe('string')
    const decoded = JSON.parse(Buffer.from(res.endCursor, 'base64url').toString())
    expect(Object.keys(decoded).sort()).toEqual(['teamId', 'userId'])
  })

  it('naming one row is refused BY NAME, with both ways out', async () => {
    const { a, db } = await app()
    await db.membership.create({ data: { userId: 1, teamId: 2 } })
    try {
      await a.service('memberships').get('1')
      throw new Error('expected a refusal')
    } catch (err: any) {
      expect(err.constructor.name).toBe('BadRequest')
      expect(err.message).toContain('keyed by (userId, teamId)')
      // Points somewhere, or it is a refusal with no way out.
      expect(err.message).toContain('userId=')
      expect(err.message).toContain('custom method')
    }
  })

  it('a single-column key is untouched — the control', async () => {
    // The refusal must fire on the tuple and on nothing else, or every
    // ordinary model pays for it.
    const { a, db } = await app()
    const post = await db.post.create({ data: { title: 'hello' } })
    const got: any = await a.service('posts').get(String(post.id))
    expect(got.title).toBe('hello')
  })


  it('every id-addressed WRITE is refused too, not only the read', async () => {
    // `get` was refused from the day the gap was found; update, patch, remove
    // and restore address a row the same way and were not.
    const { a, db } = await app()
    await db.membership.create({ data: { userId: 1, teamId: 2 } })
    for (const call of [
      () => a.service('memberships').update('1', { role: 'admin' }),
      () => a.service('memberships').patch('1',  { role: 'admin' }),
      () => a.service('memberships').remove('1'),
    ]) {
      try { await call(); throw new Error('expected a refusal') }
      catch (err: any) {
        expect(err.constructor.name).toBe('BadRequest')
        expect(err.message).toContain('keyed by (userId, teamId)')
      }
    }
  })

  it('an idField naming ONE MEMBER of the key is refused — the silent one', async () => {
    // Measured on the shipped code before the guard: `patch('1')` over two rows
    // sharing userId=1 ANSWERED the first row and WROTE both, and `remove('1')`
    // answered one row and deleted both. Nothing in the envelope said so.
    const { a, db } = await app()
    await db.membership.create({ data: { userId: 1, teamId: 1 } })
    await db.membership.create({ data: { userId: 1, teamId: 2 } })

    try { await a.service('byMember').patch('1', { role: 'admin' }); throw new Error('expected a refusal') }
    catch (err: any) { expect(err.constructor.name).toBe('BadRequest') }

    // The rows are the assertion. A refusal that still wrote is not a refusal.
    const rows = await db.membership.findMany({ orderBy: { teamId: 'asc' } })
    expect(rows.map((r: any) => r.role)).toEqual(['member', 'member'])
  })

  it('an idField naming a UNIQUE column OUTSIDE the key still addresses a row — the pair', async () => {
    // One character apart from the case above in the service file, and the
    // opposite answer: the app has said what identifies a row, and it does.
    const { a, db } = await app()
    await db.membership.create({ data: { userId: 1, teamId: 1, slug: 'a' } })
    await db.membership.create({ data: { userId: 1, teamId: 2, slug: 'b' } })

    const got: any = await a.service('bySlug').get('b')
    expect(got.teamId).toBe(2)

    await a.service('bySlug').patch('b', { role: 'admin' })
    const rows = await db.membership.findMany({ orderBy: { teamId: 'asc' } })
    expect(rows.map((r: any) => r.role)).toEqual(['member', 'admin'])
  })

  it('a FILTERED bulk write is refused as well, and the ordinary model still runs one', async () => {
    // A bulk write names no row from outside and still reaches its rows one at
    // a time by `idField`, so on a tuple key each statement writes every
    // sibling and the envelope counts the rows it SELECTED.
    const { a, db } = await app()
    await db.membership.create({ data: { userId: 1, teamId: 1 } })
    try { await a.service('memberships').patch({ userId: 1 }, { role: 'admin' }); throw new Error('expected a refusal') }
    catch (err: any) { expect(err.constructor.name).toBe('BadRequest') }

    await db.post.create({ data: { title: 'a' } })
    const out: any = await a.service('posts').patch({ title: 'a' }, { title: 'b' })
    expect(out.data.map((r: any) => r.title)).toEqual(['b'])
  })

  it('a model with a tuple key can still be created through the service', async () => {
    // `FJS-608`, still true — and the reason the read gap was worth closing.
    const { a } = await app()
    const made: any = await a.service('memberships').create({ userId: 3, teamId: 4 })
    expect(made.userId).toBe(3)
    expect(made.teamId).toBe(4)
  })
})
