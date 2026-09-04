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

import { describe, it, expect } from 'bun:test'
import { createApp, createService } from '../index.ts'
import { createClient } from '../../litestone/src/index.js'

const SCHEMA = `model Membership {
  userId Int
  teamId Int
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
  a.services.register(createService({ name: 'memberships', model: 'Membership', methods: ['find', 'get', 'create'] }))
  a.services.register(createService({ name: 'posts', model: 'Post', methods: ['find', 'get', 'create'] }))
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

  it('a model with a tuple key can still be created through the service', async () => {
    // `FJS-608`, still true — and the reason the read gap was worth closing.
    const { a } = await app()
    const made: any = await a.service('memberships').create({ userId: 3, teamId: 4 })
    expect(made.userId).toBe(3)
    expect(made.teamId).toBe(4)
  })
})
