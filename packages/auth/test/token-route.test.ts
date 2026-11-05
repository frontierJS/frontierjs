// test/token-route.test.ts
//
// `POST /token` over real HTTP (`FJS-D1927`, `FJS-D1931`): a code from the real
// `/authorize` flow traded for tokens, the refresh rotation and its 30-second
// grace, and every RFC 6749 § 5.2 refusal. The client document is Claude
// Code's fixture, served by a stub `fetch` on the auth's `clients`. The clock
// is the client's, so the grace window and the row's expiry move with
// `offset` rather than with real time. The connector itself is `connector.ts`,
// shared with `authorized-apps.test.ts` and `conformance.test.ts`.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { makeAuth, TEST_KEY, type Harness } from './harness.ts'
import { raw } from './audit-routes-http.ts'
import { connector, refusedWith, CODE_ID, OTHER_ID, LOOPBACK, RESOURCE, PASSWORD, type Connector } from './connector.ts'

let offset = 0
const clock = { now: () => new Date(Date.now() + offset) }

let c: Connector
let h: Harness
let app: any

beforeAll(async () => {
  c   = await connector(clock)
  h   = c.h
  app = c.app
})
afterAll(() => h.cleanup())

const approve  = () => c.approve()
const token    = (fields: Record<string, string>) => c.token(fields)
const exchange = (a: { code: string, verifier: string }, over: Record<string, string> = {}) => c.exchange(a, over)
const refresh  = (refreshToken: string, over: Record<string, string> = {}) => c.refresh(refreshToken, over)

describe('authorization_code', () => {
  test('a code from /authorize trades for an access token naming a new authorized app', async () => {
    const a   = await approve()
    const res = await exchange(a)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['content-type']).toStartWith('application/json')
    expect(Object.keys(res.body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'token_type'])
    expect(res.body.token_type).toBe('Bearer')
    expect(res.body.expires_in).toBeGreaterThan(59 * 60)
    expect(res.body.refresh_token).toStartWith('fjr_')

    const row = await h.sys.session.findFirst({ where: { userId: a.userId, clientId: CODE_ID } })
    expect(row.token).toBeNull()
    expect(row.refreshToken).not.toBe(res.body.refresh_token)

    const principal: any = await h.auth.verifySession(res.body.access_token)
    expect(principal.id).toBe(a.userId)
    expect(principal.authorizedApp).toEqual({ clientId: CODE_ID, audience: RESOURCE, sessionId: String(row.id) })
  })

  test('the refresh token presented as a Bearer is anonymous, and an empty token reads no row', async () => {
    const res = await exchange(await approve())
    expect(await h.auth.verifySession(res.body.refresh_token)).toBeNull()
    expect(await h.auth.verifySession('')).toBeNull()
    expect(await h.auth.verifySession('fjr_')).toBeNull()
  })

  test('the authorized app and its audit entries are in the trail, the refresh columns redacted', async () => {
    const a   = await approve()
    const res = await exchange(a)
    const row = await h.sys.session.findFirst({ where: { userId: a.userId, clientId: CODE_ID } })
    await new Promise((r) => setImmediate(r))
    const entries = await h.sys.auditTrail.findMany({ where: { model: 'Session' } })
    const mine    = entries.filter((e: any) => JSON.stringify(e.records).includes(String(row.id)))
    const event   = mine.find((e: any) => e.operation === 'app.authorized')
    expect(event.actorId).toBe(a.userId)
    expect(event.meta.clientId).toBe(CODE_ID)
    const write = mine.find((e: any) => e.operation === 'create')
    expect(write.after.refreshToken).toBe('[redacted]')
    expect(write.after.clientId).toBe(CODE_ID)
    expect(JSON.stringify(entries)).not.toContain(res.body.refresh_token)
    expect(JSON.stringify(entries)).not.toContain(row.refreshToken)
  })

  test('a reused code is invalid_grant', async () => {
    const a = await approve()
    expect((await exchange(a)).status).toBe(200)
    refusedWith(await exchange(a), 'invalid_grant')
  })

  test('a wrong verifier, client_id or redirect_uri is invalid_grant', async () => {
    refusedWith(await exchange(await approve(), { code_verifier: randomBytes(32).toString('base64url') }), 'invalid_grant')
    refusedWith(await exchange(await approve(), { client_id: OTHER_ID }), 'invalid_grant')
    refusedWith(await exchange(await approve(), { redirect_uri: 'http://localhost:9/other' }), 'invalid_grant')
  })

  test('an absent resource is invalid_request and a different one invalid_target', async () => {
    const a = await approve()
    const { resource: _, ...noResource } = { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, client_id: CODE_ID, redirect_uri: LOOPBACK, resource: RESOURCE }
    refusedWith(await token(noResource), 'invalid_request')
    refusedWith(await exchange(a, { resource: 'https://other.example/mcp' }), 'invalid_target')
    // Neither spent the code.
    expect((await exchange(a)).status).toBe(200)
  })

  test('a JSON body and a repeated parameter are invalid_request', async () => {
    const a = await approve()
    const json = await raw(app, 'POST', '/auth/token', {
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, client_id: CODE_ID, redirect_uri: LOOPBACK, resource: RESOURCE }),
    })
    refusedWith(json, 'invalid_request')
    const twice = await raw(app, 'POST', '/auth/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:    `grant_type=authorization_code&code=${a.code}&code=${a.code}&code_verifier=${a.verifier}&client_id=${encodeURIComponent(CODE_ID)}&redirect_uri=${encodeURIComponent(LOOPBACK)}&resource=${encodeURIComponent(RESOURCE)}`,
    })
    refusedWith(twice, 'invalid_request')
    expect(twice.body.error_description).toContain('code')
  })

  test('another grant type is unsupported_grant_type, and none is invalid_request', async () => {
    refusedWith(await token({ grant_type: 'client_credentials', client_id: CODE_ID }), 'unsupported_grant_type')
    refusedWith(await token({ client_id: CODE_ID }), 'invalid_request')
  })
})

describe('refresh_token', () => {
  test('a refresh rotates: a new refresh token, a new access token on the same row, and an app.refreshed entry', async () => {
    const a     = await approve()
    const first = (await exchange(a)).body
    const res   = await refresh(first.refresh_token, { resource: RESOURCE })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.refresh_token).not.toBe(first.refresh_token)
    const before: any = await h.auth.verifySession(first.access_token)
    const after: any  = await h.auth.verifySession(res.body.access_token)
    expect(after.authorizedApp.sessionId).toBe(before.authorizedApp.sessionId)
    await new Promise((r) => setImmediate(r))
    const entries = (await h.sys.auditTrail.findMany({ where: { model: 'Session' } }))
      .filter((e: any) => JSON.stringify(e.records).includes(after.authorizedApp.sessionId))
    expect(entries.map((e: any) => e.operation)).toContain('app.refreshed')
    // A rotation is an `updateMany`, whose entry carries no image; neither the
    // token nor either hash may reach the trail by any entry.
    const row = await h.sys.session.findFirst({ where: { id: after.authorizedApp.sessionId } })
    const text = JSON.stringify(entries)
    for (const secret of [first.refresh_token, res.body.refresh_token, row.refreshToken, row.previousRefreshToken])
      expect(text).not.toContain(secret)
  })

  test('a resource other than the MCP URL is invalid_target, and a missing client_id invalid_client', async () => {
    const first = (await exchange(await approve())).body
    refusedWith(await refresh(first.refresh_token, { resource: 'https://other.example/mcp' }), 'invalid_target')
    refusedWith(await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token }), 'invalid_client')
  })

  test('the previous token inside 30 s answers again and does not revoke; at 31 s it deletes the row', async () => {
    const a     = await approve()
    const first = (await exchange(a)).body
    const second = (await refresh(first.refresh_token)).body
    const sid    = ((await h.auth.verifySession(second.access_token)) as any).authorizedApp.sessionId

    offset += 20_000
    const retry = await refresh(first.refresh_token)
    expect(retry.status).toBe(200)
    expect(((await h.auth.verifySession(retry.body.access_token)) as any).authorizedApp.sessionId).toBe(sid)
    // The retry's token is the one that now refreshes.
    const third = await refresh(retry.body.refresh_token)
    expect(third.status).toBe(200)

    offset += 31_000
    refusedWith(await refresh(retry.body.refresh_token), 'invalid_grant')
    expect(await h.sys.session.findFirst({ where: { id: sid } })).toBeNull()
    refusedWith(await refresh(third.body.refresh_token), 'invalid_grant')
    const refused = await h.sys.auditTrail.findMany({ where: { operation: 'app.reuse-refused' } })
    expect(refused.some((e: any) => JSON.stringify(e.records).includes(sid))).toBe(true)
  })

  test('an unknown token, another client\'s id, a revoked row and an expired row are invalid_grant', async () => {
    refusedWith(await refresh('fjr_not-a-token'), 'invalid_grant')
    refusedWith(await refresh('not-even-prefixed'), 'invalid_grant')

    const one = (await exchange(await approve())).body
    refusedWith(await refresh(one.refresh_token, { client_id: OTHER_ID }), 'invalid_grant')

    const a   = await approve()
    const two = (await exchange(a)).body
    const sid = ((await h.auth.verifySession(two.access_token)) as any).authorizedApp.sessionId
    await h.auth.revokeSession!(a.userId, sid)
    refusedWith(await refresh(two.refresh_token), 'invalid_grant')

    const three = (await exchange(await approve())).body
    offset += 31 * 24 * 60 * 60_000
    refusedWith(await refresh(three.refresh_token), 'invalid_grant')
  })

  test('a password change ends the authorized app: its next refresh is invalid_grant', async () => {
    const a     = await approve()
    const first = (await exchange(a)).body
    await h.auth.changePassword!(a.userId, 'pw-token-2')
    refusedWith(await refresh(first.refresh_token), 'invalid_grant')
  })
})

describe('the app veto', () => {
  test('onLogin refuses an approval the way it refuses a sign-in, and no authorized app is written', async () => {
    const h2 = await makeAuth({ encryptionKey: TEST_KEY, onLogin: () => { throw new Error('locked out') } }, clock)
    try {
      const u: any = await h2.auth.createUser({ email: 'veto@example.com', password: PASSWORD })
      await expect((h2.auth as any).authorizeApp({ userId: String(u.id), clientId: CODE_ID, audience: RESOURCE }))
        .rejects.toThrow('locked out')
      expect(await h2.sys.session.findFirst({ where: { userId: String(u.id) } })).toBeNull()
      await new Promise((r) => setImmediate(r))
      const failed = await h2.sys.auditTrail.findMany({ where: { operation: 'login.failed' } })
      expect(failed.some((e: any) => e.meta?.reason === 'refused-by-app' && e.meta?.clientId === CODE_ID)).toBe(true)
    } finally { await h2.cleanup() }
  })
})

describe('expiry (FJS-D1963)', () => {
  test('a refresh does not move expiresAt: day 29 refreshes, day 31 is invalid_grant', async () => {
    const a     = await approve()
    const first = (await exchange(a)).body
    const sid   = ((await h.auth.verifySession(first.access_token)) as any).authorizedApp.sessionId
    const was   = (await h.sys.session.findFirst({ where: { id: sid } })).expiresAt
    const start = offset
    offset = start + 29 * 86_400_000
    const late = await refresh(first.refresh_token)
    expect(late.status).toBe(200)
    expect(String((await h.sys.session.findFirst({ where: { id: sid } })).expiresAt)).toBe(String(was))
    offset = start + 31 * 86_400_000
    refusedWith(await refresh(late.body.refresh_token), 'invalid_grant')
    offset = start
  })
})
