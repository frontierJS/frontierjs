// test/bearer-claim.test.ts
//
// `bearerClaim` — the resolver for a caller who has no session and still owns
// rows, and the one form that ships (`FJS-D343`): the grant row is READ, and
// what reaches a policy is the subject it resolved to, never the token.
//
// Against a real Litestone client, because the claim under test is that a
// schema's own `@@allow` filters on a value this seam put on the principal a
// moment earlier — and the failure that matters, a stranger scoped onto
// somebody else's rows, looks exactly like success from a stub.
//
// Every refusal here is PAIRED with the acceptance one argument away: a live
// grant beside a revoked one, the right token beside a near-miss, a digest made
// for another purpose beside the one made for this column.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { fingerprint } from '@frontierjs/toolbelt/bearer'
import { createApp, createService, bearerClaim, BEARER, header, authorization, cookie, sessionGateLevel } from '../index.ts'
import { enterRequest } from '../src/core/context.ts'
import { declaredCallHeaders } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const KEY = 'test-app-secret'

// A portal: a grant row points at a client, and every row the client owns
// carries that client's id. The policies compare id to id — the token is not
// in this schema at all, which is the property the design turns on.
const SCHEMA = `
  model PortalLink {
    id        Int       @id @default(autoincrement())
    clientId  Int
    scope     String    @default("forms")
    tokenHash String    @unique @guarded
    expiresAt DateTime?
    revokedAt DateTime?
    @@gate("8")
  }

  model FormResponse {
    id       Int    @id @default(autoincrement())
    clientId Int
    answer   String
    @@gate("0")
    @@allow('read',   clientId == auth().portalClientId)
    @@allow('create', clientId == auth().portalClientId)
  }
`

const resolver = bearerClaim({
  from:    header('x-portal-link'),
  model:   'portalLink',
  column:  'tokenHash',
  subject: 'clientId',
  key:     KEY,
  claims:  { portalClientId: 'clientId', portalScope: 'scope' },
  namedBy: 'the x-portal-link header',
})

const digestOf = (token: string) =>
  fingerprint(token, { key: KEY, purpose: 'portalLink.tokenHash' })

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA, claims: ['portalClientId', 'portalScope'] })
  const sys = db.asSystem()

  await sys.portalLink.create({ data: { clientId: 1, tokenHash: await digestOf('live-one'), scope: 'full' } })
  await sys.portalLink.create({ data: { clientId: 2, tokenHash: await digestOf('live-two') } })
  await sys.portalLink.create({ data: { clientId: 1, tokenHash: await digestOf('revoked'), revokedAt: new Date().toISOString() } })
  await sys.portalLink.create({ data: { clientId: 1, tokenHash: await digestOf('expired'), expiresAt: '2001-01-01T00:00:00.000Z' } })

  await sys.formResponse.create({ data: { clientId: 1, answer: 'one' } })
  await sys.formResponse.create({ data: { clientId: 2, answer: 'two' } })
  return db
}

/** An app whose one service answers whatever the caller's client can see, and
 *  reports what the seam put on the call. */
async function appWith(db: unknown) {
  const seen: { user?: unknown; grant?: unknown; level?: number } = {}
  const app = createApp({ db, principal: resolver })
  app.services.register(createService({
    name: 'answers',
    async find(ctx: ServiceContext) {
      seen.user  = ctx.auth.user
      seen.grant = ctx.locals[BEARER]
      seen.level = sessionGateLevel(ctx.auth.user as never)
      return (ctx.locals.db as any).formResponse.findMany({})
    },
    async create(ctx: ServiceContext) {
      return (ctx.locals.db as any).formResponse.create({ data: ctx.data })
    },
  }))
  return { app, seen }
}

// A REQUEST, the way one reaches an in-process call: `CallOptions` carries auth,
// transport, locals and directives and no client at all, so a header travels in
// the request store — which is where the transport puts a real one too.
const holding = <T>(token: string | null, fn: () => Promise<T>): Promise<T> =>
  enterRequest({
    origin:  'http',
    headers: token ? { 'x-portal-link': token } : {},
    caller:  { headers: token ? { 'x-portal-link': token } : {} },
  } as never, fn)
const rowsOf  = (r: unknown): any[] => (r as { data: any[] }).data ?? (r as any[])

describe('bearerClaim', () => {

  test('a live token scopes the caller to the subject it resolved to', async () => {
    const db = await seeded()
    const { app, seen } = await appWith(db)

    const rows = rowsOf(await holding('live-one', () => app.service('answers').find({})))
    expect(rows.map(r => r.answer)).toEqual(['one'])

    // The other client's link over the same service is the pair that proves the
    // scoping is the GRANT's and not the schema answering everything.
    const theirs = rowsOf(await holding('live-two', () => app.service('answers').find({})))
    expect(theirs.map(r => r.answer)).toEqual(['two'])
  })

  test('the caller is still a STRANGER — the claim decides rows, never standing', async () => {
    const db = await seeded()
    const { app, seen } = await appWith(db)

    await holding('live-one', () => app.service('answers').find({}))
    // `ctx.auth.user` stays null: a claims-only object handed to the gate grades
    // CREATOR(3), which would promote every guest in the app silently.
    expect(seen.user).toBeNull()
    expect(seen.level).toBe(0)
  })

  test('the resolved grant is parked for the app, and carries its subject', async () => {
    const db = await seeded()
    const { app, seen } = await appWith(db)

    await holding('live-one', () => app.service('answers').find({}))
    expect((seen.grant as any).subject).toBe(1)
    expect((seen.grant as any).id).toBe(1)
    expect((seen.grant as any).row.scope).toBe('full')
  })

  test('a revoked grant and an expired one are refused 401, exactly as an unknown token is', async () => {
    // One sentence for all three on purpose: *this link does not work* is all a
    // bearer may learn, or the refusal is an oracle for which tokens existed.
    // A refusal and not an empty principal (`FJS-1999`): answered as a stranger,
    // a list is 200 of nothing and a write a 403 from the rule, and a page
    // cannot say the link is dead.
    const db = await seeded()
    const { app } = await appWith(db)

    for (const token of ['revoked', 'expired', 'never-minted']) {
      await expect(holding(token, () => app.service('answers').find({}))).rejects.toMatchObject({ code: 401 })
      await expect(holding(token, () => app.service('answers').create({ clientId: 1, answer: 'x' })))
        .rejects.toMatchObject({ code: 401 })
    }

    // The pair: the same schema, the same service, a grant that is live.
    expect(rowsOf(await holding('live-one', () => app.service('answers').find({}))).length).toBe(1)
  })

  test('the grant\'s deadline is read off the client\'s clock, as every other deadline is', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA, claims: ['portalClientId', 'portalScope'], now: () => new Date('2030-01-01T00:00:00Z') })
    await db.asSystem().portalLink.create({
      data: { clientId: 1, tokenHash: await digestOf('soon'), expiresAt: '2029-06-01T00:00:00.000Z' },
    })
    const { app } = await appWith(db)
    // Live by the wall clock, dead by the database's.
    await expect(holding('soon', () => app.service('answers').find({}))).rejects.toMatchObject({ code: 401 })
  })

  test('a caller carrying no token at all reaches nothing', async () => {
    const db = await seeded()
    const { app } = await appWith(db)
    expect(rowsOf(await holding(null, () => app.service('answers').find({})))).toEqual([])
  })

  test('the token never reaches the Data boundary — the claim is an id', async () => {
    const db = await seeded()
    const { app, seen } = await appWith(db)

    await holding('live-one', () => app.service('answers').find({}))
    // Nothing in the call carries the secret: policies compare ids, so a query,
    // a log line and an error can all be written without redacting anything.
    expect(JSON.stringify(seen.grant)).not.toContain('live-one')
  })

  test('a write is scoped by the same claim', async () => {
    const db = await seeded()
    const { app } = await appWith(db)

    await holding('live-one', () => app.service('answers').create({ clientId: 1, answer: 'mine' }))
    // The create policy admits only the subject's own rows, so the other
    // client's id through the same grant is refused.
    await expect(
      holding('live-one', () => app.service('answers').create({ clientId: 2, answer: 'theirs' })),
    ).rejects.toThrow()
  })

  test('describe() says bearer, and names the model and the claims', async () => {
    const d = (resolver as any).describe()
    expect(d.kind).toBe('bearer')
    expect(d.model).toBe('portalLink')
    expect(d.subject).toBe('clientId')
    expect(d.claims).toEqual(['portalClientId', 'portalScope'])
    expect(d.namedBy).toBe('the x-portal-link header')
  })
})

// The header a declared principal reads is on the source, so the preflight and
// the socket frame allow-list learn it without the app restating it in
// `http.callHeaders` (`FJS-1227`).
describe('the header a principal reads reaches the call-header allow-list', () => {
  test('header() carries its name, and describe() states it', () => {
    expect(header('X-Portal-Link').headerName).toBe('X-Portal-Link')
    expect(resolver.describe().headers).toEqual(['x-portal-link'])
  })

  test('declaredCallHeaders unions the config list with the resolver, once each', async () => {
    const app = createApp({ db: await seeded(), principal: resolver })
    expect(declaredCallHeaders(app, { http: { callHeaders: ['X-Other', 'X-Portal-Link'] } }))
      .toEqual(['X-Other', 'X-Portal-Link'])
    expect(declaredCallHeaders(app, { http: {} })).toEqual(['x-portal-link'])
    expect(declaredCallHeaders(createApp({}), { http: {} })).toEqual([])
  })
})

// A grant whose scope lives on its PARENT: `ShareLink` is `@@tenant(via: page)`,
// the idiomatic child of a scoped model, so the grant row has no workspace
// column of its own. A dotted claim column walks the relation instead of the
// app copying `page.workspaceId` onto every grant (`FJS-1731`).
describe('a claim column may name a relation path', () => {
  const NESTED = `
    model Page {
      id          Int    @id @default(autoincrement())
      workspaceId Int
      title       String
      links       ShareLink[]
      @@gate("0")
    }

    model ShareLink {
      id        Int    @id @default(autoincrement())
      pageId    Int
      page      Page   @relation(fields: [pageId], references: [id])
      tokenHash String @unique @guarded
      @@gate("8")
    }
  `
  const nested = bearerClaim({
    from:    header('x-share-link'),
    model:   'shareLink',
    column:  'tokenHash',
    key:     KEY,
    claims:  { linkPageId: 'pageId', linkWorkspaceId: 'page.workspaceId' },
  })

  test('the claim is read through the relation, and the plain column beside it still is', async () => {
    const db: any = await createClient({ db: ':memory:', schema: NESTED, claims: ['linkPageId', 'linkWorkspaceId'] })
    const sys = db.asSystem()
    await sys.page.create({ data: { workspaceId: 7, title: 'shared' } })
    await sys.shareLink.create({
      data: { pageId: 1, tokenHash: await fingerprint('tok', { key: KEY, purpose: 'shareLink.tokenHash' }) },
    })

    const headers = { 'x-share-link': 'tok' }
    const ctx = { locals: { db }, headers, caller: { headers } }
    const claims = await enterRequest({ origin: 'http', headers, caller: { headers } } as never,
      () => (nested as any)(ctx, null))
    expect(claims).toEqual({ linkPageId: 1, linkWorkspaceId: 7 })

    // A token that resolves to nothing reads no claim through the relation either.
    const none = { locals: { db }, headers: { 'x-share-link': 'nope' }, caller: { headers: { 'x-share-link': 'nope' } } }
    await expect(enterRequest({ origin: 'http', headers: none.headers, caller: none.caller } as never,
      () => (nested as any)(none, null))).rejects.toMatchObject({ code: 401 })
  })
})

// A grant is what DECIDES this caller's access, so which account the holder
// already belongs to cannot decide whether it is found. Under row tenancy the
// scoped client's asSystem() keeps the tenant, and a signed-in member of
// account 2 holding account 1's link read no claim while the same token signed
// out read it (`FJS-2091`).
describe('a grant is found whoever else the holder is', () => {
  const TENANTED = `
    tenancy { strategy row  column accountId  claim accountId }

    model SurveyGrant {
      id        Int    @id @default(autoincrement())
      accountId Int
      surveyId  Int
      tokenHash String @unique(global) @guarded
      @@gate("8")
    }
  `
  const grant = bearerClaim({
    from:   header('x-survey-token'),
    model:  'surveyGrant',
    column: 'tokenHash',
    key:    KEY,
    claims: { grantSurveyId: 'surveyId', grantAccountId: 'accountId' },
  })

  async function open(as: unknown) {
    const db: any = await createClient({ db: ':memory:', schema: TENANTED, claims: ['grantSurveyId', 'grantAccountId'] })
    await db.asSystem().surveyGrant.create({
      data: { accountId: 1, surveyId: 9, tokenHash: await fingerprint('tok', { key: KEY, purpose: 'surveyGrant.tokenHash' }) },
    })
    const headers = { 'x-survey-token': 'tok' }
    const scoped = as ? db.$setAuth(as) : db
    const ctx = { locals: { db: scoped, ...(as ? { tenantId: String((as as any).accountId) } : {}) }, headers, caller: { headers } }
    return enterRequest({ origin: 'http', headers, caller: { headers } } as never, () => (grant as any)(ctx, null))
  }

  test('signed out, the token resolves', async () => {
    expect(await open(null)).toEqual({ grantSurveyId: 9, grantAccountId: 1 })
  })

  test('a member of ANOTHER account holding the token resolves it too', async () => {
    expect(await open({ userId: 'u2', accountId: 2 })).toEqual({ grantSurveyId: 9, grantAccountId: 1 })
  })

  test('a member of the grant\'s own account resolves it', async () => {
    expect(await open({ userId: 'u1', accountId: 1 })).toEqual({ grantSurveyId: 9, grantAccountId: 1 })
  })
})

// `Authorization: Bearer <token>` carries an API key AND a signed-in person's
// session, so a source reading it raw fingerprinted the scheme along with the
// key and refused every session the auth plugin had just accepted (`FJS-2150`).
// Over a real port, because which of the two a header held is decided by the
// transport's session read before the resolver runs.
describe('a grant presented as Authorization: Bearer', () => {
  const running: Array<{ stop: () => Promise<void> }> = []
  const stopAll = async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) }

  async function served(from: ReturnType<typeof header>) {
    const db = await seeded()
    const app: any = createApp({
      db,
      logLevel:  'silent',
      config:    { port: 0, services: { dir: '/nonexistent' } },
      principal: bearerClaim({ from, model: 'portalLink', column: 'tokenHash', key: KEY, claims: { portalClientId: 'clientId' } }),
      auth: {
        verifySession: async (token: string) => {
          if (token !== 'session-ana') throw new Error('bad token')
          return { userId: 'ana', userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
        },
      },
    })
    app.services.register(createService({
      name: 'answers',
      async find(ctx: ServiceContext) {
        const rows = await (ctx.locals.db as any).formResponse.findMany({})
        return [{ user: (ctx.auth.user as any)?.userId ?? null, rows: rows.length }]
      },
    }))
    await app.start()
    running.push(app)
    return (authorization: string) => fetch(`http://localhost:${app.http.port}/answers`, { headers: { authorization } })
  }

  test('the key after the scheme resolves, and a session in the same header passes through', async () => {
    try {
      const get = await served(authorization())

      const asKey = await get('Bearer live-one')
      expect(asKey.status).toBe(200)
      const keyBody: any = await asKey.json()
      expect(keyBody.data[0]).toEqual({ user: null, rows: 1 })

      // The pair: a session token is not a grant, so it is not refused as a dead one.
      const asSession = await get('Bearer session-ana')
      expect(asSession.status).toBe(200)
      const sessionBody: any = await asSession.json()
      expect(sessionBody.data[0]).toEqual({ user: 'ana', rows: 0 })

      // A token that is neither is refused, and in the words of what was sent:
      // a machine holding a key reads nothing about a link it never had (`FJS-2161`).
      const dead = await get('Bearer never-minted')
      expect(dead.status).toBe(401)
      expect(((await dead.json()) as any).message).toBe('This key does not work. It may have expired or been revoked.')
    } finally { await stopAll() }
  })

  test('authorization() names its header for the allow-list', () => {
    expect(authorization().headerName).toBe('authorization')
  })

  test('header(\'authorization\') is refused by name, pointing at authorization()', () => {
    expect(() => header('Authorization')).toThrow(/authorization\(\)/)
    expect(() => header('x-portal-link')).not.toThrow()
  })
})

// A cookie is ambient: the browser sends it on every request to the origin, so
// a seller who once opened a customer's portal link carries that cookie on
// every call of their own session. Once the link is replaced the cookie is
// dead, and a source that read it on a signed-in request refused the seller's
// own session as a dead link for the cookie's whole life (`FJS-2175`).
describe('a grant presented as a cookie', () => {
  const running: Array<{ stop: () => Promise<void> }> = []
  const stopAll = async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) }

  async function served() {
    const db = await seeded()
    const app: any = createApp({
      db,
      logLevel:  'silent',
      config:    { port: 0, services: { dir: '/nonexistent' } },
      principal: bearerClaim({ from: cookie('portal'), model: 'portalLink', column: 'tokenHash', key: KEY, claims: { portalClientId: 'clientId' } }),
      auth: {
        verifySession: async (token: string) => {
          if (token !== 'session-ana') throw new Error('bad token')
          return { userId: 'ana', userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
        },
      },
    })
    app.services.register(createService({
      name: 'answers',
      async find(ctx: ServiceContext) {
        const rows = await (ctx.locals.db as any).formResponse.findMany({})
        return [{ user: (ctx.auth.user as any)?.userId ?? null, rows: rows.length }]
      },
    }))
    await app.start()
    running.push(app)
    return (headers: Record<string, string>) => fetch(`http://localhost:${app.http.port}/answers`, { headers })
  }

  test('a dead cookie on a signed-in request passes; signed out it is refused', async () => {
    try {
      const get = await served()

      const asSession = await get({ authorization: 'Bearer session-ana', cookie: 'portal=revoked' })
      expect(asSession.status).toBe(200)
      expect(((await asSession.json()) as any).data[0]).toEqual({ user: 'ana', rows: 0 })

      // The pair: the same cookie with no session is the refusal a dead link gets,
      // and a live one with no session resolves.
      expect((await get({ cookie: 'portal=revoked' })).status).toBe(401)
      const asLink = await get({ cookie: 'portal=live-one' })
      expect(asLink.status).toBe(200)
      expect(((await asLink.json()) as any).data[0]).toEqual({ user: null, rows: 1 })
    } finally { await stopAll() }
  })
})

// ─── Minting a grant, redeeming a link ────────────────────────────────────────
//
// Nine apps wrote the same two acts by hand: a create that fills a `@guarded`
// digest it is not allowed to write, and a raw route that trades an emailed
// link for an httpOnly cookie (`FJS-D340`). Every copy either created the row
// as asSystem() — losing the create policy that says who may issue a link — or
// left the digest nullable so the caller's create could run (`FJS-1749`).
describe('a grant is minted by the caller and a link redeemed for the cookie', () => {
  const GRANTS = `
    model Customer {
      id   Int    @id @default(autoincrement())
      name String
      @@gate("0")
      @@allow('read', id == auth().portalCustomerId)
    }
    model PortalLink {
      id         Int       @id @default(autoincrement())
      customerId Int
      tokenHash  String    @unique @guarded
      expiresAt  DateTime?
      revokedAt  DateTime?
      lastUsedAt DateTime? @system
      @@gate("4")
      @@allow('create', customerId == auth().customerId)
    }
  `
  const link = bearerClaim({
    from: cookie('portal'), model: 'portalLink', column: 'tokenHash', key: KEY,
    claims: { portalCustomerId: 'customerId' }, subject: 'customerId',
  })
  const SELLER = { id: 7, userId: 'ana', role: 'member', customerId: 1 }

  async function grants() {
    const db: any = await createClient({ db: ':memory:', schema: GRANTS, claims: ['customerId', 'portalCustomerId'] })
    await db.asSystem().customer.create({ data: { name: 'Acme' } })
    await db.asSystem().customer.create({ data: { name: 'Other' } })
    return db
  }
  /** A raw route's context, the three members the redeem touches. */
  function routeCtx(body: unknown) {
    const cookies: Array<[string, string, Record<string, unknown>]> = []
    const ctx = {
      body,
      setCookie: (name: string, value: string, opts: Record<string, unknown> = {}) => { cookies.push([name, value, opts]) },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
    }
    return { ctx, cookies }
  }
  const asCookie = <T>(value: string | null, fn: () => Promise<T>) =>
    enterRequest({ origin: 'http', headers: value ? { cookie: `portal=${value}` } : {}, caller: { headers: value ? { cookie: `portal=${value}` } : {} } } as never, fn)

  test('mint() runs the caller\'s own create — the policy decides who issues, the digest is written by name', async () => {
    const db = await grants()
    const me = db.$setAuth(SELLER)

    const { token, row } = await link.mint(me, { customerId: 1, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    expect(typeof token).toBe('string')
    expect(row.customerId).toBe(1)
    expect('tokenHash' in row).toBe(false)
    // A cookie bearer's token is a LINK token: stored under the link purpose,
    // so presented as the cookie it matches nothing.
    const stored = await db.asSystem().portalLink.findFirst({ where: { tokenHash: await fingerprint(token, { key: KEY, purpose: 'portalLink.tokenHash.link' }) } })
    expect(stored?.id).toBe(row.id)

    // The pair: the same caller may not issue a link to somebody else's customer.
    await expect(link.mint(me, { customerId: 2 })).rejects.toThrow()
    expect(await db.asSystem().portalLink.count()).toBe(1)
  })

  test('redeem() rotates the digest, sets the httpOnly cookie, answers the subject, and the link dies', async () => {
    const db = await grants()
    const { token, row } = await link.mint(db.$setAuth(SELLER), { customerId: 1 })
    const app = createApp({ db, principal: link })
    app.services.register(createService({
      name: 'customers',
      async find(ctx: ServiceContext) { return (ctx.locals.db as any).customer.findMany({}) },
    }))

    // The unredeemed link is not a cookie.
    await expect(asCookie(token, () => app.service('customers').find({}))).rejects.toThrow(/does not work/)

    const redeem = link.redeem(db, { maxAge: 3600 })
    const { ctx, cookies } = routeCtx({ token })
    const res = await redeem(ctx as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subject: 1 })
    expect(cookies).toHaveLength(1)
    const [name, fresh, opts] = cookies[0]
    expect(name).toBe('portal')
    expect(fresh).not.toBe(token)
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 3600 })

    // The cookie's token resolves the grant's claims; the row records the use.
    const rows = rowsOf(await asCookie(fresh, () => app.service('customers').find({})))
    expect(rows.map(r => r.name)).toEqual(['Acme'])
    expect((await db.asSystem().portalLink.findUnique({ where: { id: row.id } })).lastUsedAt).not.toBeNull()

    // A clicked link forwarded on answers as one that never existed (FJS-D696's one sentence).
    const again = await redeem(routeCtx({ token }).ctx as never)
    expect(again.status).toBe(401)
    expect(((await again.json()) as any).message).toBe('This link does not work. It may have expired or been withdrawn.')
    expect((await redeem(routeCtx({}).ctx as never)).status).toBe(400)
  })

  test('redeem() is refused on a bearer that reads no cookie', () => {
    expect(() => resolver.redeem({})).toThrow(/reads the x-portal-link header/)
    expect(cookie('portal').cookieName).toBe('portal')
  })

  test('mintOnCreate(): the create is the mint, the answer carries the token once and the broadcast does not', async () => {
    const db = await grants()
    const app = createApp({ db, principal: link })
    const svc = createService({
      name:  'portalLinks',
      model: 'PortalLink',
      async create(ctx: ServiceContext) {
        return (ctx.locals.db as any).portalLink.create({ data: ctx.data, system: [...ctx.system] })
      },
    })
    svc.hooks(link.mintOnCreate())
    app.services.register(svc)
    let announced: unknown = undefined
    app.events.on('portalLinks:created', (p: unknown) => { announced = p })

    const made: any = await app.service('portalLinks').create({ customerId: 1 }, { auth: { user: SELLER as never } })
    expect(typeof made.token).toBe('string')
    expect(made.customerId).toBe(1)
    expect('tokenHash' in made).toBe(false)
    expect(announced).toMatchObject({ customerId: 1 })
    expect('token' in (announced as object)).toBe(false)
    // The row the create wrote holds the link digest of the token the caller was handed.
    const digest = await fingerprint(made.token, { key: KEY, purpose: 'portalLink.tokenHash.link' })
    expect((await db.asSystem().portalLink.findFirst({ where: { tokenHash: digest } }))?.id).toBe(made.id)
  })
})
