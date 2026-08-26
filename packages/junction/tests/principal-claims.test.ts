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
import { createApp, createService, membershipClaim, applyClaims, MEMBERSHIP, sessionGateLevel } from '../index.ts'
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

  test('RUNS for an anonymous caller — a guest may hold a claim', async () => {
    // A bearer token is a claim the REQUEST proves, and the population it
    // serves is exactly the one with no `auth().id`: a guest cart, an
    // invitation, an unsubscribe link. Without this the only way to scope
    // those rows is a hook reading them through `asSystem()`, which is the
    // thing Invariant 6 exists to forbid.
    const db = await seeded()
    let saw: unknown = 'never ran'
    const { app } = await appWith(db, async (_ctx, user) => { saw = user; return {} })

    await app.service('docs').find({}, { auth: { user: null } })
    expect(saw).toBeNull()
  })

  test("a guest's claim scopes the SQL and grants no identity", async () => {
    const db = await seeded()
    const { app } = await appWith(db, async () => ({ workspaceId: 2 }))

    const rows = rowsOf(await app.service('docs').find({}, { auth: { user: null } }))
    expect(rows.map((r: any) => r.title)).toEqual(['ws two'])
  })

  test('a guest principal does NOT become ctx.auth.user', async () => {
    // The whole of the care this path needs. `sessionGateLevel` grades any
    // object it is handed, and a claims-only principal sets none of
    // isSystemAdmin/isOwner/isAdmin while leaving verifiedAt and activatedAt
    // UNDEFINED — silence, not null — so it falls through to LEVELS.USER.
    // Promoting a guest to a session object would therefore grade every
    // anonymous caller 4, in every app that adopted a resolver, silently.
    const db = await seeded()
    const { app, seen } = await appWith(db, async () => ({ workspaceId: 2 }))

    await app.service('docs').find({}, { auth: { user: null } })
    expect(seen.user).toBeNull()
    expect(sessionGateLevel(seen.user as never)).toBe(0)
  })

  test('a resolver that claims nothing grants a guest nothing', async () => {
    // `{}` must not re-scope the client to an empty principal — that would be a
    // claim nobody made. The client therefore stays the ROOT one, which is not
    // the same as an unfiltered one: this schema declares row tenancy, so the
    // desugared `@@deny` compares `workspaceId` against a null claim and no row
    // matches. Nothing is the right answer and it is reached honestly.
    const db = await seeded()
    const { app } = await appWith(db, async () => ({}))

    const rows = rowsOf(await app.service('docs').find({}, { auth: { user: null } }))
    expect(rows.length).toBe(0)
  })

  test('membershipClaim refuses a guest rather than querying for one', async () => {
    // It reads `userId` off the user; with a guest that would become
    // `where: { userId: undefined }`, which matches the first row holding a
    // null column and hands a stranger someone else's standing.
    const db = await seeded()
    const resolver = membershipClaim({
      tenantFrom: () => '1',
      model:      'doc',
      tenant:     'workspaceId',
      subject:    'userId',
      standing:   'title',
    })
    const app = createApp({ db, principal: resolver })
    let claims: unknown
    app.services.register(createService({
      name: 'probe',
      async find(ctx: ServiceContext) { claims = ctx.auth.user; return [] },
    }))

    await app.service('probe').find({}, { auth: { user: null } })
    expect(claims).toBeNull()
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

  test('no tenant NAMED is a different refusal from not belonging to one', async () => {
    // Collapsing the two produces a sentence that names nothing: *you do not
    // belong to the workspaceId this request names*, to a request that named
    // none. And the status differs — an incomplete request, not a refused one.
    const db = await seeded()
    const { app } = await appWith(db, resolver(null))

    const err: any = await app.service('docs').find({}, AS_U1).then(() => null, (e: unknown) => e)
    expect(err.message).toMatch(/names no 'workspaceId'/)
    expect(err.code).toBe(400)
  })

  test('…and it quotes how one IS named, which only the resolver knows', async () => {
    const db = await seeded()
    const { app } = await appWith(db, membershipClaim({
      tenantFrom: () => null,
      model:      'member',
      subject:    'userId',
      tenant:     'workspaceId',
      namedBy:    'the X-Workspace-Id header',
    }))

    await expect(app.service('docs').find({}, AS_U1))
      .rejects.toThrow(/name one with the X-Workspace-Id header/)
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
