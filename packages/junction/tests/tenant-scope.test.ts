// tests/tenant-scope.test.ts
//
// WHICH TENANT is this call for — one owner, both strategies (`FJS-386`).
//
// `withTenantDb` answers it for a request under `strategy database`, and until
// this seam existed nothing answered it at all under `strategy row`: the tenant
// was a value inside the principal, which a cache key built from a service and
// a query cannot reach, and neither can a relay sweeping a table or a job
// running an hour later. Each of the three answered it themselves and each
// answered it wrong.
//
// Against a real Litestone client, for `principal-claims.test.ts`'s reason: the
// failure this file exists for is a caller being served another tenant's rows,
// which looks exactly like success from anywhere that is not holding both.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { createApp, createService } from '../index.ts'
import type { SessionContext } from '../src/auth/types.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const rowsOf = (r: unknown): any[] => (r as { data: any[] }).data

const SCHEMA = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model Member {
    id          Int    @id @default(autoincrement())
    workspaceId Int
    userId      String
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
  await sys.member.create({ data: { workspaceId: 1, userId: 'u1' } })
  // The same person in two workspaces — the membership shape, and the one the
  // cache leak needs: two callers with different ids key differently already.
  await sys.member.create({ data: { workspaceId: 2, userId: 'u1' } })
  await sys.doc.create({ data: { workspaceId: 1, title: 'ws one' } })
  await sys.doc.create({ data: { workspaceId: 2, title: 'ws two' } })
  return db
}

/** A caller whose session already carries the claim — the `sessionFields`
 *  shape, where no resolver runs at all. */
const as = (userId: string, workspaceId?: number) => ({
  auth: { user: { userId, ...(workspaceId != null ? { workspaceId } : {}) } as unknown as SessionContext },
})

describe('the tenant is on ctx.locals under strategy row', () => {

  test('lifted off the session principal, with no resolver in play', async () => {
    const db  = await seeded()
    const app = createApp({ db })
    let seen: string | undefined

    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) {
        seen = ctx.locals.tenantId
        return (ctx.locals.db as any).doc.findMany({})
      },
    }))

    await app.service('docs').find({}, as('u1', 1))
    expect(seen).toBe('1')
  })

  test('lifted off a resolver claim, which beats the session', async () => {
    const db  = await seeded()
    const app = createApp({ db, principal: async () => ({ workspaceId: 2 }) })
    let seen: string | undefined

    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) {
        seen = ctx.locals.tenantId
        return (ctx.locals.db as any).doc.findMany({})
      },
    }))

    await app.service('docs').find({}, as('u1', 1))
    expect(seen).toBe('2')
  })

  test('a claim that is not the tenancy claim sets nothing — a cart token is not a tenant', async () => {
    const db  = await seeded()
    const app = createApp({ db, principal: async () => ({ cartToken: 'abc' }) })
    let seen: unknown = 'unset'

    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) {
        seen = ctx.locals.tenantId
        return []
      },
    }))

    await app.service('docs').find({}, { auth: { user: null } })
    expect(seen).toBeUndefined()
  })

  test('an app that declares no tenancy has no tenant', async () => {
    const db: any = await createClient({
      db: ':memory:',
      schema: `model Doc { id Int @id @default(autoincrement())  title String }`,
    })
    const app = createApp({ db })
    let seen: unknown = 'unset'

    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) { seen = ctx.locals.tenantId; return [] },
    }))

    await app.service('docs').find({}, as('u1'))
    expect(seen).toBeUndefined()
  })
})

// ─── the cache ────────────────────────────────────────────────────────────────
//
// The cache lives on the APP and not on the client, so this is not a
// `strategy row` defect: one process serving two tenants shares one cache under
// either strategy. The `uid` segment is what made it invisible — a cached list
// is keyed by the caller, so two callers in one tenant shared correctly and two
// callers in two tenants shared as well.

describe('a cached service is partitioned by tenant', () => {

  const cachedApp = (db: unknown, cache: any) => {
    const app = createApp({ db })
    app.services.register(createService({
      name: 'docs',
      cache,
      async find(ctx: ServiceContext) {
        return (ctx.locals.db as any).doc.findMany({})
      },
    }))
    return app
  }

  test('one person in two workspaces is not served the first one\'s rows in the second', async () => {
    const db  = await seeded()
    const app = cachedApp(db, true)

    // Same principal, so the `uid` segment is identical and the default key was
    // the same string for both calls. That is what made the leak invisible: a
    // cached list IS keyed by the caller, and two callers in two tenants share.
    const one = rowsOf(await app.service('docs').find({}, as('u1', 1)))
    const two = rowsOf(await app.service('docs').find({}, as('u1', 2)))

    expect(one.map(r => r.title)).toEqual(['ws one'])
    expect(two.map(r => r.title)).toEqual(['ws two'])
  })

  test('a warm entry is still a hit for the tenant that warmed it', async () => {
    const db  = await seeded()
    const app = cachedApp(db, true)

    await app.service('docs').find({}, as('u1', 1))
    // Written behind the cache's back: a hit answers the rows as they were.
    await (db as any).asSystem().doc.create({ data: { workspaceId: 1, title: 'later' } })

    const again = rowsOf(await app.service('docs').find({}, as('u1', 1)))
    expect(again.map(r => r.title)).toEqual(['ws one'])
  })

  test('a custom keyBy cannot opt out of the partition', async () => {
    const db  = await seeded()
    // A key function written before tenancy existed: one key for every caller.
    const app = cachedApp(db, { keyBy: () => 'docs:all' })

    const one = rowsOf(await app.service('docs').find({}, as('u1', 1)))
    const two = rowsOf(await app.service('docs').find({}, as('u1', 2)))

    expect(one.map(r => r.title)).toEqual(['ws one'])
    expect(two.map(r => r.title)).toEqual(['ws two'])
  })

  test('shared: true is the declared opt-out, and it does share', async () => {
    const db  = await seeded()
    const app = cachedApp(db, { shared: true, keyBy: () => 'docs:all' })

    const one = rowsOf(await app.service('docs').find({}, as('u1', 1)))
    const two = rowsOf(await app.service('docs').find({}, as('u1', 2)))

    expect(one.map(r => r.title)).toEqual(['ws one'])
    expect(two.map(r => r.title)).toEqual(['ws one'])
  })
})

// ─── work with no request behind it ──────────────────────────────────────────
//
// `FJS-384`: WHO crossed the boundary into a job and WHERE did not, so a
// handler that had to touch tenant rows had no legal way to be in a tenant and
// reached for `asSystem()` — the bypass that drops the gate, the row policies
// and the audit actor together to relax exactly one of them.

describe('a job runs IN a tenant', () => {

  const auth = {
    async sessionFor(userId: string) {
      return { userId, userType: 'user', authMethod: 'created' } as unknown as SessionContext
    },
  } as any

  /** The membership app: the tenant is named per call, never on the session. */
  async function membershipApp() {
    const db  = await seeded()
    const { membershipClaim } = await import('../index.ts')
    const app = createApp({
      db,
      auth,
      principal: membershipClaim({
        // A header, which a queue does not have — the whole of the problem.
        tenantFrom: (ctx: ServiceContext) => (ctx.client?.headers?.['x-workspace-id'] as string) ?? null,
        model:      'member',
        subject:    'userId',
        tenant:     'workspaceId',
        namedBy:    'the X-Workspace-Id header',
      }),
    })
    // `tenantClaimGuard` installs itself — createApp probes the client and
    // adds it when the schema declares row tenancy.
    app.services.register(createService({
      name: 'docs',
      async find(ctx: ServiceContext) { return (ctx.locals.db as any).doc.findMany({}) },
    }))
    return app
  }

  test('the tenant runAs names is the one the resolver reads', async () => {
    const app = await membershipApp()

    const rows = await app.runAs('u1', { tenant: '2' }, () =>
      app.service('docs').find({}))

    expect(rowsOf(rows).map(r => r.title)).toEqual(['ws two'])
  })

  test('the membership is re-read at run time, so a tenant the actor left is refused', async () => {
    const app = await membershipApp()

    // u1 is a member of 1 and 2 and of nothing else. A job naming 3 is a job
    // whose enqueuer had a claim this actor cannot be given now.
    await expect(app.runAs('u1', { tenant: '3' }, () =>
      app.service('docs').find({}))).rejects.toThrow(/do not belong/)
  })

  test('a job that names no tenant is refused by name, not served the wrong rows', async () => {
    const app = await membershipApp()

    await expect(app.runAs('u1', () =>
      app.service('docs').find({}))).rejects.toThrow(/names no 'workspaceId'/)
  })
})
