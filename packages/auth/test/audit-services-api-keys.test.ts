// test/audit-services-api-keys.test.ts
//
// AUDIT 2026-10-05 — `api-keys.create` takes `expiresAt` and `scopes` from the
// caller unvalidated, and an UNSCOPED key carries its owner's whole standing
// into the credential services. Each row asserts the secure behavior; a row
// that passes on current code is a refutation and is labeled as one.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

let h: Harness
let app: any
let seq = 0

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { level: () => 4, reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

const PW = 'pw-keys-1'
async function person() {
  const email = `ak-${Date.now()}-${seq++}@example.com`
  await request(app).post('/auth/register').send({ email, password: PW })
  const user  = await h.sys.user.findFirst({ where: { email } })
  const login = async () => ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token as string
  return { email, userId: String(user.id), login }
}

const mint = (token: string, data: unknown) => request(app).post('/api-keys').auth(token).send(data as any)
const me   = (token: string) => request(app).get('/account/me').auth(token)
const keysOf = (userId: string) => h.sys.credential.findMany({ where: { userId, type: 'apiKey' } })

describe('expiresAt from the caller', () => {

  // FJS-1849: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing("'never' is refused rather than stored as a key with an unreadable expiry", async () => {
    const u = await person()
    const t = await u.login()
    const res = await mint(t, { name: 'never', expiresAt: 'never' })
    // Either a 400, or — if it was minted — a key whose expiry nobody can read
    // must not be live. Observed: `new Date('never')` is an Invalid Date and
    // litestone refuses it with a 500 (`GeneralError: Invalid Date`), so no
    // key is minted — the never-expiring hypothesis is refuted and what is
    // left is a 500 any session can trigger.
    if (res.status === 201) {
      const key = (res.body as any).key as string
      expect(await h.auth.verifySession(key)).toBeNull()
    } else {
      expect(res.status).toBe(400)
    }
    const stored = (await keysOf(u.userId)).find((r: any) => r.label === 'never')
    if (stored) expect(Number.isNaN(new Date(stored.tokenExpiresAt).getTime())).toBe(false)
  })

  test('what listApiKeys reports for such a key is the expiry that is enforced', async () => {
    const u = await person()
    const t = await u.login()
    const res = await mint(t, { name: 'nan', expiresAt: 'not-a-date' })
    if (res.status !== 201) return   // refused — nothing to compare
    const key  = (res.body as any).key as string
    const list = (await request(app).get('/api-keys').auth(t)).body as any
    const row  = (Array.isArray(list) ? list : list.data).find((k: any) => k.name === 'nan')
    const reported = row?.expiresAt
    const live = await h.auth.verifySession(key)
    // A reported expiry must either be a real instant, or the key must be dead.
    if (reported != null) {
      const asDate = new Date(reported)
      if (Number.isNaN(asDate.getTime())) expect(live).toBeNull()
      else if (asDate < h.sys.$now()) expect(live).toBeNull()
    }
  })

  // FJS-1849: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a past expiresAt is refused rather than minting a key that is born dead', async () => {
    const u = await person()
    const t = await u.login()
    const res = await mint(t, { name: 'dead', expiresAt: '2000-01-01T00:00:00Z' })
    expect(res.status).toBe(400)
  })

  // FJS-1849: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a numeric expiresAt is not silently read as epoch milliseconds', async () => {
    const u = await person()
    const t = await u.login()
    const res = await mint(t, { name: 'num', expiresAt: 4102444800000 })
    expect(res.status).toBe(400)
  })
})

describe('scopes from the caller', () => {

  test('a scope that is not a string is refused', async () => {
    const u = await person()
    const t = await u.login()
    const res = await mint(t, { name: 'objscope', scopes: [{ admin: true }, 42] })
    expect(res.status).toBe(400)
  })

  test("scopes: [''] does not mint an unscoped key", async () => {
    // A caller that ASKED for a scope list and gave an empty name got a key
    // with the owner's whole standing — `['']` joins to '' which is stored as
    // null, and `[' ']` splits back to [] which `caller()` reads as unscoped.
    const u = await person()
    const t = await u.login()
    for (const scopes of [[''], [' ']]) {
      const res = await mint(t, { name: 'blank', scopes })
      if (res.status !== 201) { expect(res.status).toBe(400); continue }
      const key = (res.body as any).key as string
      const asKey = await request(app).post('/api-keys').auth(key).send({ name: 'minted-by-blank' })
      expect(asKey.status).toBe(403)
    }
  })
})

describe('an UNSCOPED key holds its owner’s whole standing at the credential services', () => {

  test('an unscoped key cannot mint another key', async () => {
    const u = await person()
    const t = await u.login()
    const key = ((await mint(t, { name: 'root' })).body as any).key as string
    const res = await request(app).post('/api-keys').auth(key).send({ name: 'child' })
    expect(res.status).toBe(403)
  })

  test('an unscoped key cannot sign its owner out of every session', async () => {
    const u = await person()
    const t = await u.login()
    const key = ((await mint(t, { name: 'root' })).body as any).key as string
    const res = await request(app).post('/sessions').set('x-service-method', 'revokeOthers').auth(key).send({})
    expect(res.status).toBe(403)
    expect((await me(t)).status).toBe(200)
  })

  test('an unscoped key cannot change the password', async () => {
    const u = await person()
    const t = await u.login()
    const key = ((await mint(t, { name: 'root' })).body as any).key as string
    const res = await request(app).post('/account/me').set('x-service-method', 'changePassword').auth(key)
      .send({ currentPassword: PW, newPassword: 'pw-keys-2' })
    expect(res.status).toBe(403)
  })

  test('an unscoped key cannot revoke the other keys', async () => {
    const u = await person()
    const t = await u.login()
    const a = (await mint(t, { name: 'a' })).body as any
    const b = (await mint(t, { name: 'b' })).body as any
    const res = await request(app).delete(`/api-keys/${b.id}`).auth(a.key)
    expect(res.status).toBe(403)
    expect(await h.auth.verifySession(b.key)).not.toBeNull()
  })
})

describe('refutation rows — expected to pass on current code', () => {

  test('revocation is immediate', async () => {
    const u = await person()
    const t = await u.login()
    const k = (await mint(t, { name: 'r' })).body as any
    expect((await me(k.key)).status).toBe(200)
    expect((await request(app).delete(`/api-keys/${k.id}`).auth(t)).status).toBe(200)
    expect((await me(k.key)).status).toBe(401)
    expect(await h.auth.verifySession(k.key)).toBeNull()
  })

  test('x-api-key routes the same as Bearer', async () => {
    const u = await person()
    const t = await u.login()
    const k = (await mint(t, { name: 'hdr' })).body as any
    const res = await request(app).get('/account/me').set('x-api-key', k.key)
    expect(res.status).toBe(200)
    expect((res.body as any).authMethod).toBe('apiKey')
  })

  test('deleteUser kills the keys', async () => {
    const u = await person()
    const t = await u.login()
    const k = (await mint(t, { name: 'doomed' })).body as any
    await h.auth.deleteUser(u.userId)
    expect(await h.auth.verifySession(k.key)).toBeNull()
  })

  test('a scoped key is refused at every credential service, reads included', async () => {
    const u = await person()
    const t = await u.login()
    const k = (await mint(t, { name: 's', scopes: ['search'] })).body as any
    expect((await request(app).get('/sessions').auth(k.key)).status).toBe(403)
    expect((await request(app).get('/api-keys').auth(k.key)).status).toBe(403)
    expect((await request(app).post('/api-keys').auth(k.key).send({ name: 'x' })).status).toBe(403)
    expect((await me(k.key)).status).toBe(200)
  })
})
