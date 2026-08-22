// tests/principal-claims.test.ts
//
// `createApp({ principal })` — claims resolved per REQUEST and put on the
// principal before the Data boundary scopes the client from it (`FJS-D113`).
//
// Against a real Litestone client, and it has to be: the whole claim is that a
// tenancy predicate compiled from the schema filters on a value this seam put
// on the principal a moment earlier. A stub would agree with whatever it was
// written to agree with, and the one failure that matters here — a caller
// scoped into a tenant they do not belong to — looks exactly like success.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { createApp, createService, membershipClaim, applyClaims, MEMBERSHIP } from '../index.ts'
import type { PrincipalResolver } from '../index.ts'
import type { SessionContext } from '../src/auth/types.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

/** find() answers the list envelope; the rows are `.data`. */
const rowsOf = (r: unknown): any[] => (r as { data: any[] }).data

// Row tenancy, and a membership model that is deliberately NOT scoped by the
// claim it produces — the read that decides the claim cannot be filtered by it.
const SCHEMA = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model Member {
    id          Int    @id @default(autoincrement())
    workspaceId Int
    userId      String
    role        String
    @@tenant(none)
  }

  model Doc {
    id          Int    @id @default(autoincrement())
    workspaceId Int
    title       String
  }
`

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.member.create({ data: { workspaceId: 1, userId: 'u1', role: 'admin' } })
  await sys.doc.create({ data: { workspaceId: 1, title: 'ws one' } })
  await sys.doc.create({ data: { workspaceId: 2, title: 'ws two' } })
  return db
}

/** An app whose one service answers whatever the caller's client can see. */
async function appWith(db: unknown, principal: PrincipalResolver) {
  const seen: { user?: unknown } = {}
  const app = createApp({ db, principal })
  app.services.register(createService({
    name: 'docs',
    async find(ctx: ServiceContext) {
      seen.user = ctx.auth.user
      return (ctx.locals.db as any).doc.findMany({})
    },
  }))
  return { app, seen }
}

const AS_U1 = { auth: { user: { userId: 'u1', role: 'user' } as unknown as SessionContext } }

describe('createApp({ principal })', () => {

  test('the claim reaches the SQL — a member sees their tenant and nothing else', async () => {
    const db = await seeded()
    const { app } = await appWith(db, async () => ({ workspaceId: 1 }))

    const rows = await rowsOf(await app.service('docs').find({}, AS_U1))
    expect(rows.map(r => r.title)).toEqual(['ws one'])
  })

  test('no claim is a REFUSAL, not an empty list', async () => {
    // `tenantClaimGuard` is installed whenever the schema declares row tenancy,
    // and this is the case it exists for: a signed-in caller carrying no claim
    // matches no row, which is a 200 with nothing in it on every screen and is
    // indistinguishable from a tenant that genuinely has no data. Better than
    // the empty answer this test was first written to expect.
    const db = await seeded()
    const { app } = await appWith(db, async () => ({}))

    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow(/do not belong to the 'workspaceId'/)
  })

  test('…and the refusal is 403, because the caller DID prove who they are', async () => {
    // A 401 is what a client is built to answer by discarding the token and
    // bouncing to sign-in, so naming a tenant you do not belong to would sign
    // you out of the one you do.
    const db = await seeded()
    const { app } = await appWith(db, async () => ({}))

    const err: any = await app.service('docs').find({}, AS_U1).then(() => null, (e: unknown) => e)
    expect(err.code).toBe(403)
  })

  test('with NO resolver at all the sentence is the app\'s, not the caller\'s', async () => {
    // Two refusals wear the same empty principal and they are not the same
    // sentence: nothing here emits the claim, versus this caller does not hold
    // it. Only the second is about the caller.
    const db = await seeded()
    const app = createApp({ db })
    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) { return (ctx.locals.db as any).doc.findMany({}) },
    }))

    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow(/carries no 'workspaceId'/)
  })

  test('the claims are on the PRINCIPAL, not only on the client', async () => {
    // `getTable()` re-derives its own scoped copy from ctx.auth.user, so a
    // standing that lived only on ctx.locals.db is dropped the moment a service
    // touches a model.
    const db = await seeded()
    const { app, seen } = await appWith(db, async () => ({ workspaceId: 1, memberRole: 'admin' }))

    rowsOf(await app.service('docs').find({}, AS_U1))
    expect(seen.user).toMatchObject({ userId: 'u1', workspaceId: 1, memberRole: 'admin' })
  })

  test('a FRESH principal — the session handed in is never mutated', async () => {
    // Over WebSocket one session object is resolved at upgrade and handed to
    // every frame. Mutating it leaks one call's tenant into the next call on
    // that socket.
    const db = await seeded()
    const { app } = await appWith(db, async () => ({ workspaceId: 1 }))

    const session = { userId: 'u1', role: 'user' }
    await app.service('docs').find({}, { auth: { user: session as unknown as SessionContext } })
    expect(session).toEqual({ userId: 'u1', role: 'user' })
  })

  test('a resolver may not change WHO is calling — refused by name', async () => {
    const db = await seeded()
    const { app } = await appWith(db, async () => ({ userId: 'someone-else' }))

    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow(/may not set 'userId'/)
  })

  test('does not run for an anonymous caller', async () => {
    // Minting a principal out of claims alone turns *anonymous* into *someone*
    // — an object satisfying `auth() != null` while carrying no identity.
    const db = await seeded()
    let ran = false
    const { app } = await appWith(db, async () => { ran = true; return {} })

    await app.service('docs').find({}, { auth: { user: null } })
    expect(ran).toBe(false)
  })

  test('a throw travels — the resolver is Hook tier', async () => {
    const db = await seeded()
    const { app } = await appWith(db, async () => { throw new Error('lookup failed') })

    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow('lookup failed')
  })
})

describe('membershipClaim()', () => {

  const resolver = (tenant: string | null) => membershipClaim({
    tenantFrom: () => tenant,
    model:      'member',
    subject:    'userId',
    tenant:     'workspaceId',
    standing:   'role',
    standingAs: 'memberRole',
  })

  test('a member gets the claim and the standing', async () => {
    const db = await seeded()
    const { app, seen } = await appWith(db, resolver('1'))

    const rows = await rowsOf(await app.service('docs').find({}, AS_U1))
    expect(rows.map(r => r.title)).toEqual(['ws one'])
    expect(seen.user).toMatchObject({ workspaceId: '1', memberRole: 'admin' })
  })

  test('a NON-member naming a tenant gets no claim, so no rows', async () => {
    // The whole safety of the battery. Hand-written, the version that forgets
    // the membership check emits the claim anyway and every read answers 200
    // over somebody else's rows.
    const db = await seeded()
    const { app, seen } = await appWith(db, resolver('2'))

    // Refused, loudly, rather than answering workspace 2's rows — which is what
    // the hand-written version that forgets the membership check would do.
    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow(/do not belong to the 'workspaceId'/)
    expect(seen.user).toBeUndefined()
  })

  test('no tenant named is no claim and no query', async () => {
    const db = await seeded()
    const { app } = await appWith(db, resolver(null))
    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow(/do not belong to the 'workspaceId'/)
  })

  test('parks the membership row, so the rest of it costs no second query', async () => {
    const db = await seeded()
    let row: unknown
    const app = createApp({ db, principal: resolver('1') })
    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) { row = ctx.locals[MEMBERSHIP]; return [] },
    }))
    rowsOf(await app.service('docs').find({}, AS_U1))
    expect(row).toMatchObject({ userId: 'u1', role: 'admin' })
  })

  test('an accessor that does not exist is refused by name', async () => {
    const db = await seeded()
    const { app } = await appWith(db, membershipClaim({
      tenantFrom: () => '1', model: 'membr', subject: 'userId', tenant: 'workspaceId',
    }))
    // Litestone's own refusal travels: reading an unknown accessor off its
    // client throws, and its message names the model and the schema.
    await expect(app.service('docs').find({}, AS_U1)).rejects.toThrow(/not a table in this schema/)
  })
})

describe('applyClaims()', () => {

  test('re-resolves for a service addressing a different tenant', async () => {
    // A caller who is admin of A must not carry that standing into a request
    // against B — the service whose subject IS the tenant is the usual case.
    const db = await seeded()
    const sys: any = db.asSystem()
    await sys.member.create({ data: { workspaceId: 2, userId: 'u1', role: 'viewer' } })
    await sys.doc.create({ data: { workspaceId: 2, title: 'ws two b' } })

    const app = createApp({ db, principal: async () => ({ workspaceId: 1 }) })
    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) {
        applyClaims(ctx, db, { workspaceId: 2 })
        return (ctx.locals.db as any).doc.findMany({})
      },
    }))

    const rows = await rowsOf(await app.service('docs').find({}, AS_U1))
    expect(rows.map(r => r.title).sort()).toEqual(['ws two', 'ws two b'])
  })
})
