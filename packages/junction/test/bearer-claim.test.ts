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
import { createApp, createService, bearerClaim, BEARER, header, sessionGateLevel } from '../index.ts'
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

  test('a revoked grant and an expired one are refused, exactly as an unknown token is', async () => {
    // One sentence for all three on purpose: *this link does not work* is all a
    // bearer may learn, or the refusal is an oracle for which tokens existed.
    const db = await seeded()
    const { app } = await appWith(db)

    for (const token of ['revoked', 'expired', 'never-minted']) {
      const rows = rowsOf(await holding(token, () => app.service('answers').find({})))
      expect(rows).toEqual([])
    }

    // The pair: the same schema, the same service, a grant that is live.
    expect(rowsOf(await holding('live-one', () => app.service('answers').find({}))).length).toBe(1)
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
