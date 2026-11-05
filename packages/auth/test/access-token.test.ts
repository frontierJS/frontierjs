// test/access-token.test.ts
//
// An authorized app's access token (`FJS-D1926`, `FJS-D1950`): signed claims
// that `verifySession` resolves as its third arm with no row read, to the
// person at their own level, and that `refuseDelegated` keeps off every write
// that would outlive the approval. A real app over a real Litestone client: the
// refusal is only worth anything at the door a request comes through.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService } from '@frontierjs/junction'
import { auth } from '../plugin.ts'
import { createLitestoneAuth } from '../auth.ts'
import { ACCESS_TOKEN_PREFIX, API_KEY_PREFIX, signAccessToken, readAccessToken, generateToken } from '../crypto.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

const OTHER_KEY = 'f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1'
const CLIENT    = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const RESOURCE  = 'https://app.example.com/mcp'
const PW        = 'pw-at-1'

let offset = 0
const clock = { now: () => new Date(Date.now() + offset) }

let h: Harness
let app: any
let at = ''
let seq = 0

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY }, clock, {
    schema: '\nmodel Note {\n  id   Int    @id @default(autoincrement())\n  body String\n  @@gate(1.1.1.1)\n}\n',
  })
  app = createApp({ db: h.db, auth: h.auth as any, config: { port: 0 }, logLevel: 'silent' } as never)
  app.configure(auth({
    auth: h.auth,
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { standingLevel: () => 4 },
  }))
  app.services.register(createService({ name: 'notes', model: 'Note' } as never))
  await app.start()
  at = `http://localhost:${app.http.port}`
})
afterAll(async () => { await app?.stop?.(); h.cleanup() })

async function person() {
  const email = `at-${Date.now()}-${seq++}@example.com`
  const { id: userId } = await h.auth.createUser({ email, password: PW })
  return { email, userId: String(userId) }
}
const mint = (userId: string) =>
  h.auth.issueAccessToken!({ userId, clientId: CLIENT, audience: RESOURCE })

const call = (token: string, path: string, body: unknown, method?: string) => fetch(`${at}${path}`, {
  method:  'POST',
  headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    ...(method ? { 'x-service-method': method } : {}),
  },
  body: JSON.stringify(body),
})

describe('the token itself', () => {

  const claims = { sub: 'u1', cid: CLIENT, aud: RESOURCE, iat: 1, exp: 2 }

  test('signs and reads back, under its own prefix', () => {
    const token = signAccessToken(claims, TEST_KEY)
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true)
    expect(token.startsWith(API_KEY_PREFIX)).toBe(false)
    expect(readAccessToken(token, TEST_KEY)).toEqual(claims)
  })

  test('a changed payload, another key, or a missing half reads as nothing', () => {
    const token = signAccessToken(claims, TEST_KEY)
    const [payload, sig] = token.slice(ACCESS_TOKEN_PREFIX.length).split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'u2' })).toString('base64url')
    expect(readAccessToken(`${ACCESS_TOKEN_PREFIX}${forged}.${sig}`, TEST_KEY)).toBeNull()
    expect(readAccessToken(token, OTHER_KEY)).toBeNull()
    expect(readAccessToken(`${ACCESS_TOKEN_PREFIX}${payload}`, TEST_KEY)).toBeNull()
    expect(readAccessToken(`${token}.x`, TEST_KEY)).toBeNull()
  })
})

describe('verifySession, the third arm', () => {

  test('resolves the person, as an authorized app, with no gate claim in the token', async () => {
    const p = await person()
    const { token, expiresAt } = await mint(p.userId)
    expect(new Date(expiresAt).getTime() - clock.now().getTime()).toBeGreaterThan(59 * 60_000)
    const ctx = await h.auth.verifySession(token)
    expect(ctx?.id).toBe(p.userId)
    expect(ctx?.authMethod).toBe('accessToken')
    expect(ctx?.authorizedApp).toEqual({ clientId: CLIENT, audience: RESOURCE })
    expect(ctx?.sessionId).toBeUndefined()
    expect(Object.keys(readAccessToken(token, TEST_KEY)!).sort()).toEqual(['aud', 'cid', 'exp', 'iat', 'sub'])
  })

  test('carries the authorized app row when one is named', async () => {
    const p = await person()
    const { token } = await h.auth.issueAccessToken!({ userId: p.userId, clientId: CLIENT, audience: RESOURCE, sessionId: '42' })
    expect((await h.auth.verifySession(token))?.authorizedApp?.sessionId).toBe('42')
  })

  test('an expired token is anonymous, on the client clock', async () => {
    const p = await person()
    const { token } = await mint(p.userId)
    offset = 61 * 60_000
    try { expect(await h.auth.verifySession(token)).toBeNull() } finally { offset = 0 }
    expect(await h.auth.verifySession(token)).not.toBeNull()
  })

  test('a token for a person since deleted is anonymous', async () => {
    const p = await person()
    const { token } = await mint(p.userId)
    await h.sys.user.delete({ where: { id: p.userId } })
    expect(await h.auth.verifySession(token)).toBeNull()
  })

  test('another App key\'s token, and the same token under fjs_, are anonymous', async () => {
    const p = await person()
    const foreign = signAccessToken({ sub: p.userId, cid: CLIENT, aud: RESOURCE, iat: 0, exp: 4e9 }, OTHER_KEY)
    expect(await h.auth.verifySession(foreign)).toBeNull()
    const { token } = await mint(p.userId)
    expect(await h.auth.verifySession(API_KEY_PREFIX + token.slice(ACCESS_TOKEN_PREFIX.length))).toBeNull()
    expect(await h.auth.verifySession(generateToken())).toBeNull()
  })

  test('a session token and an API key resolve as they did', async () => {
    const p = await person()
    const login = await h.auth.login(p.email, PW) as { token: string }
    const session = await h.auth.verifySession(login.token)
    expect(session?.authMethod).toBe('session')
    expect(session?.authorizedApp).toBeUndefined()
    const { key } = await h.auth.createApiKey(p.userId, { name: 'k' })
    const viaKey = await h.auth.verifySession(key)
    expect(viaKey?.authMethod).toBe('apiKey')
    expect(viaKey?.authorizedApp).toBeUndefined()
  })

  test('an App without a key has no verb to mint one', async () => {
    const bare = createLitestoneAuth(h.db, {})
    expect('issueAccessToken' in bare).toBe(false)
  })
})

describe('an authorized app is refused what outlives the approval', () => {

  test('minting an API key is 403', async () => {
    const p = await person()
    const { token } = await mint(p.userId)
    const res = await call(token, '/api-keys', { name: 'kept' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('from an authorized app')
  })

  test('changing the password is 403', async () => {
    const p = await person()
    const { token } = await mint(p.userId)
    const res = await call(token, '/account/me', { newPassword: 'pw-2' }, 'changePassword')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('from an authorized app')
  })

  test('a data write at the person\'s level goes through, as it does from their session', async () => {
    const p = await person()
    const { token } = await mint(p.userId)
    const login = await h.auth.login(p.email, PW) as { token: string }
    expect((await call(login.token, '/notes', { body: 'from the session' })).status).toBe(201)
    const res = await call(token, '/notes', { body: 'from the app' })
    expect(res.status).toBe(201)
    expect((await h.sys.note.findMany({ where: { body: 'from the app' } })).length).toBe(1)
  })
})
