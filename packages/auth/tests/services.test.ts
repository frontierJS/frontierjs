// tests/services.test.ts
//
// The service half of the auth surface — `account`, `sessions`, `api-keys` —
// against a REAL Junction app over a real database.
//
// What these assert is ownership. Every method here is reached with an id the
// CALLER supplied, so the question each test asks is the same one: does naming
// somebody else's row do anything. A revoke keyed on the id alone would pass
// every happy-path test in this file and hand one person's session id the power
// to end another person's session.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { createAuthServices } from '../services.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

let h: Harness
let app: any

// Two people, because half of what is being tested is that one cannot reach
// the other. `bob` never signs in in most tests — his rows are the ones that
// must survive alice naming them.
const ALICE = 'alice@example.com'
const BOB   = 'bob@example.com'
const PW    = 'pw-1'

let aliceToken: string
let bobToken:   string

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { level: () => 4, reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
  }))

  await request(app).post('/auth/register').send({ email: ALICE, password: PW })
  await request(app).post('/auth/register').send({ email: BOB,   password: PW })
  aliceToken = ((await request(app).post('/auth/login').send({ email: ALICE, password: PW })).body as any).token
  bobToken   = ((await request(app).post('/auth/login').send({ email: BOB,   password: PW })).body as any).token
})
afterAll(() => h.cleanup())

// ─── account ──────────────────────────────────────────────────────────────

describe('account', () => {
  test('GET /account/me answers the caller, with the level the app graded', async () => {
    const res = await request(app).get('/account/me').auth(aliceToken)
    expect(res.status).toBe(200)
    expect((res.body as any).email).toBe(ALICE)
    expect((res.body as any).authMethod).toBe('session')
    // Opt-in — the plugin was given `level: () => 4` above. Without it the key
    // is absent, which is the point: a default here would be a second grading.
    expect((res.body as any).level).toBe(4)
  })

  test('the session id travels, so a caller can tell which session is theirs', async () => {
    const me = await request(app).get('/account/me').auth(aliceToken)
    expect(typeof (me.body as any).sessionId).toBe('string')
  })

  test('an id that is not the caller is 404, not somebody else', async () => {
    const bob = await request(app).get('/account/me').auth(bobToken)
    const res = await request(app).get(`/account/${(bob.body as any).userId}`).auth(aliceToken)
    expect(res.status).toBe(404)
  })

  test('the caller may address their own id as well as `me`', async () => {
    const me  = await request(app).get('/account/me').auth(aliceToken)
    const res = await request(app).get(`/account/${(me.body as any).userId}`).auth(aliceToken)
    expect(res.status).toBe(200)
    expect((res.body as any).email).toBe(ALICE)
  })

  test('anonymous is 401', async () => {
    expect((await request(app).get('/account/me')).status).toBe(401)
  })

  test('changePassword verifies the current one, and the old password stops working', async () => {
    const email = 'changer@example.com'
    await request(app).post('/auth/register').send({ email, password: 'old-pw' })
    const token = ((await request(app).post('/auth/login').send({ email, password: 'old-pw' })).body as any).token

    const wrong = await request(app).post('/account/me')
      .set('x-service-method', 'changePassword')
      .auth(token)
      .send({ currentPassword: 'not-it', newPassword: 'new-pw' })
    // 403 and not 401: the session is fine and the typed password is not. A 401
    // here is what a browser client signs the person out on (FJS-1088), so the
    // pair is the same token still answering afterwards.
    expect(wrong.status).toBe(403)
    expect((await request(app).get('/account/me').auth(token)).status).toBe(200)

    const ok = await request(app).post('/account/me')
      .set('x-service-method', 'changePassword')
      .auth(token)
      .send({ currentPassword: 'old-pw', newPassword: 'new-pw' })
    expect(ok.status).toBe(200)

    expect((await request(app).post('/auth/login').send({ email, password: 'old-pw' })).status).toBe(401)
    expect((await request(app).post('/auth/login').send({ email, password: 'new-pw' })).status).toBe(200)
  })

  test('a missing field is 400', async () => {
    const res = await request(app).post('/account/me')
      .set('x-service-method', 'changePassword')
      .auth(aliceToken)
      .send({ newPassword: 'x' })
    expect(res.status).toBe(400)
  })
})

// ─── account: the second factor ────────────────────────────────────────────
//
// The provider's own behavior is `tests/totp-login.test.ts`. What is asked here
// is the crossing: that these reach the provider AT ALL over HTTP with the
// caller's id rather than one the request supplied, and that the fields a raw
// body cannot be trusted to carry are checked.

describe('account — TOTP over HTTP', () => {

  const call = (method: string, token: string, data: unknown = {}) =>
    request(app).post('/account/me').set('x-service-method', method).auth(token).send(data as any)

  test('a stranger reaches none of them', async () => {
    for (const method of ['totpStatus', 'setupTotp', 'confirmTotp', 'disableTotp', 'regenerateRecoveryCodes']) {
      expect((await request(app).post('/account/me').set('x-service-method', method).send({})).status).toBe(401)
    }
  })

  test('the whole cycle, and the id is the CALLER’s and not the body’s', async () => {
    const email = 'totp-http@example.com'
    await request(app).post('/auth/register').send({ email, password: PW })
    const token = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token

    expect((await call('totpStatus', token)).body).toEqual({ enabled: false, recoveryCodesRemaining: 0 })

    // A body naming somebody else changes nothing — every method scopes to the
    // session, so the extra key is not even read.
    const setup = await call('setupTotp', token, { currentPassword: PW, userId: 'bob' })
    expect(setup.status).toBe(200)
    const secret = (setup.body as any).secret
    expect((setup.body as any).qr).toContain('otpauth://totp/')

    // Still off until it is confirmed, asked through the same surface a screen
    // would ask through.
    expect(((await call('totpStatus', token)).body as any).enabled).toBe(false)

    const { totp } = await import('../totp.ts')
    const confirm = await call('confirmTotp', token, { code: totp(secret, new Date()) })
    expect(confirm.status).toBe(200)
    expect((confirm.body as any).recoveryCodes).toHaveLength(10)
    expect((await call('totpStatus', token)).body).toEqual({ enabled: true, recoveryCodesRemaining: 10 })

    // And the login route now answers a challenge rather than a token, which is
    // the only assertion here that crosses back out to the transport.
    const login = await request(app).post('/auth/login').send({ email, password: PW })
    expect(login.status).toBe(200)
    expect((login.body as any).token).toBeUndefined()
    expect((login.body as any).challenge).toBeTruthy()

    const regen = await call('regenerateRecoveryCodes', token, { currentPassword: PW })
    expect((regen.body as any).recoveryCodes).toHaveLength(10)
    expect((regen.body as any).recoveryCodes).not.toEqual((confirm.body as any).recoveryCodes)

    expect((await call('disableTotp', token, { currentPassword: PW })).status).toBe(200)
    expect(((await call('totpStatus', token)).body as any).enabled).toBe(false)
    // Back to one step, which is what says disable reached the provider rather
    // than answering ok.
    expect(((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token).toBeTruthy()
  })

  test('the fields a body cannot be trusted for are 400, by name', async () => {
    expect((await call('setupTotp', aliceToken, {})).status).toBe(400)
    expect((await call('confirmTotp', aliceToken, {})).status).toBe(400)
    expect((await call('disableTotp', aliceToken, {})).status).toBe(400)
    expect((await call('regenerateRecoveryCodes', aliceToken, {})).status).toBe(400)

    // Paired with the reason it is 400 rather than 500: the field is missing,
    // not the method. With the field present this same call reaches the provider
    // and is refused on the password instead.
    expect((await call('setupTotp', aliceToken, { currentPassword: 'wrong' })).status).toBe(403)
  })

  test('a provider without them says so by name rather than 500ing', async () => {
    const scoped = await makeAuth()
    const partial = { ...scoped.auth } as any
    for (const m of ['totpStatus', 'setupTotp', 'confirmTotp', 'disableTotp', 'regenerateRecoveryCodes']) {
      delete partial[m]
    }

    const other = await createTestApp({ auth: partial })
    other.setAuth(partial)
    other.configure(createAuthPlugin(partial, {
      loginRateLimit:    { max: 10_000, window: '15 minutes' },
      registerRateLimit: { max: 10_000, window: '15 minutes' },
    }))
    await request(other).post('/auth/register').send({ email: 'nototp@example.com', password: PW })
    const token = ((await request(other).post('/auth/login').send({ email: 'nototp@example.com', password: PW })).body as any).token

    const res = await request(other).post('/account/me')
      .set('x-service-method', 'totpStatus').auth(token).send({})
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('totpStatus')
    scoped.cleanup()
  })
})

// ─── account: the password, asked again ────────────────────────────────────
//
// Four methods verify the CURRENT password for whoever holds the session, which
// makes each one a guessing oracle for a stolen session. Every row below is a
// refusal beside the answer that separates it from a limiter that refuses
// everything, or one that counts nothing: a second account untouched, a method
// that asks for no password spending nothing, and the session still a session.

describe('account — the password, asked again, is bounded per account', () => {
  test('guesses spread across three methods share one bucket, and the fourth — the right password — is refused', async () => {
    const scoped  = await makeAuth({ encryptionKey: TEST_KEY })
    const bounded = await createTestApp({ auth: scoped.auth as any })
    bounded.setAuth(scoped.auth as any)
    bounded.configure(createAuthPlugin(scoped.auth, {
      loginRateLimit:    { max: 10_000, window: '15 minutes' },
      registerRateLimit: { max: 10_000, window: '15 minutes' },
      services:          { reauthenticationRateLimit: { max: 3, window: '15 minutes' } },
    }))

    const tokenFor = async (email: string) => {
      await request(bounded).post('/auth/register').send({ email, password: PW })
      return ((await request(bounded).post('/auth/login').send({ email, password: PW })).body as any).token as string
    }
    const guesser   = await tokenFor('guesser@example.com')
    const bystander = await tokenFor('bystander@example.com')
    const reader    = await tokenFor('reader@example.com')
    const as = (token: string, method: string, data: Record<string, unknown>) =>
      request(bounded).post('/account/me').set('x-service-method', method).auth(token).send(data as any)

    expect((await as(guesser, 'setupTotp',               { currentPassword: 'guess-1' })).status).toBe(403)
    expect((await as(guesser, 'changePassword',          { currentPassword: 'guess-2', newPassword: 'x' })).status).toBe(403)
    expect((await as(guesser, 'regenerateRecoveryCodes', { currentPassword: 'guess-3' })).status).toBe(403)

    const fourth = await as(guesser, 'setupTotp', { currentPassword: PW })
    expect(fourth.status).toBe(429)
    // A 429 is not a 401: the session that hit the limit is still a session.
    expect((await request(bounded).get('/account/me').auth(guesser)).status).toBe(200)

    // The bucket is the ACCOUNT's. A limiter keyed on anything wider refuses here.
    expect((await as(bystander, 'setupTotp', { currentPassword: PW })).status).toBe(200)

    // And only the password spends it: four reads, then the password, answered.
    for (let i = 0; i < 4; i++) expect((await as(reader, 'totpStatus', {})).status).toBe(200)
    expect((await as(reader, 'setupTotp', { currentPassword: PW })).status).toBe(200)

    scoped.cleanup()
  })
})

// ─── sessions ─────────────────────────────────────────────────────────────

describe('sessions', () => {
  test('lists only the caller\'s, marks the current one, and carries no token', async () => {
    const second = ((await request(app).post('/auth/login').send({ email: ALICE, password: PW })).body as any).token

    const res = await request(app).get('/sessions').auth(second)
    expect(res.status).toBe(200)
    expect((res.body as any).data.length).toBeGreaterThanOrEqual(2)

    const current = (res.body as any).data.filter((s: any) => s.current)
    expect(current).toHaveLength(1)

    // A session row holds the bearer token. A list that carried it would be a
    // list of ways to become this person.
    for (const s of (res.body as any).data) expect(s.token).toBeUndefined()

    // Bob's sessions are not in it.
    const bob = await request(app).get('/sessions').auth(bobToken)
    const mine = new Set((res.body as any).data.map((s: any) => s.id))
    for (const s of (bob.body as any).data) expect(mine.has(s.id)).toBe(false)
  })

  test('revoking somebody else\'s session by id does nothing to it', async () => {
    const bobs = await request(app).get('/sessions').auth(bobToken)
    const victim = (bobs.body as any).data[0].id

    const res = await request(app).delete(`/sessions/${victim}`).auth(aliceToken)
    expect(res.status).toBeGreaterThanOrEqual(400)

    // Bob is still signed in — the whole point.
    expect((await request(app).get('/account/me').auth(bobToken)).status).toBe(200)
  })

  test('revoking your own ends that token and no other', async () => {
    const doomed = ((await request(app).post('/auth/login').send({ email: ALICE, password: PW })).body as any).token
    const keeper = ((await request(app).post('/auth/login').send({ email: ALICE, password: PW })).body as any).token

    const list = await request(app).get('/sessions').auth(doomed)
    const id   = (list.body as any).data.find((s: any) => s.current).id

    expect((await request(app).delete(`/sessions/${id}`).auth(keeper)).status).toBe(200)
    expect((await request(app).get('/account/me').auth(doomed)).status).toBe(401)
    expect((await request(app).get('/account/me').auth(keeper)).status).toBe(200)
  })

  test('revokeOthers keeps the one asking', async () => {
    const email = 'many@example.com'
    await request(app).post('/auth/register').send({ email, password: PW })
    const a = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token
    const b = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token
    const c = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token

    const res = await request(app).post('/sessions').set('x-service-method', 'revokeOthers').auth(c).send({})
    expect(res.status).toBe(200)
    expect((res.body as any).revoked).toBeGreaterThanOrEqual(2)

    expect((await request(app).get('/account/me').auth(c)).status).toBe(200)
    expect((await request(app).get('/account/me').auth(a)).status).toBe(401)
    expect((await request(app).get('/account/me').auth(b)).status).toBe(401)
  })
})

// ─── api-keys ─────────────────────────────────────────────────────────────

describe('api-keys', () => {
  test('the raw key comes back once, works as a Bearer token, and is never listed', async () => {
    const made = await request(app).post('/api-keys').auth(aliceToken).send({ name: 'ci', scopes: ['read'] })
    expect(made.status).toBe(201)
    expect((made.body as any).key).toBeTruthy()

    // The key authenticates as its owner — the transport resolves every Bearer
    // token through verifySession, which routes an API key by its prefix.
    const asKey = await request(app).get('/account/me').auth((made.body as any).key)
    expect(asKey.status).toBe(200)
    expect((asKey.body as any).email).toBe(ALICE)
    expect((asKey.body as any).authMethod).toBe('apiKey')
    expect((asKey.body as any).scopes).toEqual(['read'])

    const list = await request(app).get('/api-keys').auth(aliceToken)
    const row  = (list.body as any).data.find((k: any) => k.id === (made.body as any).id)
    expect(row.name).toBe('ci')
    expect(row.scopes).toEqual(['read'])
    // Neither the key nor the HMAC it is matched against.
    expect(row.key).toBeUndefined()
    expect(row.value).toBeUndefined()
  })

  test('a list is the caller\'s own', async () => {
    await request(app).post('/api-keys').auth(bobToken).send({ name: 'bobs' })
    const list = await request(app).get('/api-keys').auth(aliceToken)
    expect((list.body as any).data.some((k: any) => k.name === 'bobs')).toBe(false)
  })

  test('revoking somebody else\'s key by id leaves it working', async () => {
    const bobs = await request(app).post('/api-keys').auth(bobToken).send({ name: 'bobs-live' })

    const res = await request(app).delete(`/api-keys/${(bobs.body as any).id}`).auth(aliceToken)
    expect(res.status).toBeGreaterThanOrEqual(400)

    expect((await request(app).get('/account/me').auth((bobs.body as any).key)).status).toBe(200)
  })

  test('revoking your own stops the key authenticating', async () => {
    const made = await request(app).post('/api-keys').auth(aliceToken).send({ name: 'doomed' })
    expect((await request(app).delete(`/api-keys/${(made.body as any).id}`).auth(aliceToken)).status).toBe(200)
    expect((await request(app).get('/account/me').auth((made.body as any).key)).status).toBe(401)
  })
})

// ─── registration ─────────────────────────────────────────────────────────

describe('how the three are registered', () => {
  test('a name the app already uses is refused at boot, naming the option', async () => {
    const scoped = await makeAuth()
    const clashing = await createTestApp({ auth: scoped.auth as any })
    clashing.setAuth(scoped.auth as any)
    // The app's own service, registered before the plugin boots.
    clashing.services.register(createAuthServices(scoped.auth, { account: false, apiKeys: false })[0])
    clashing.configure(createAuthPlugin(scoped.auth))

    await expect(clashing._startForTest()).rejects.toThrow(/sessions.*already registered/s)
    scoped.cleanup()
  })

  test('services: false registers none of them', async () => {
    const scoped = await makeAuth()
    const bare = await createTestApp({ auth: scoped.auth as any })
    bare.setAuth(scoped.auth as any)
    bare.configure(createAuthPlugin(scoped.auth, { services: false }))
    await bare._startForTest()

    expect(bare.services.has('account')).toBe(false)
    expect(bare.services.has('sessions')).toBe(false)
    expect(bare.services.has('api-keys')).toBe(false)
    scoped.cleanup()
  })

  test('a name with a slash is refused where the stack points at the caller', () => {
    // Junction routes `{service}` as ONE path segment, so a slash registers
    // fine and then 404s forever with nothing saying why.
    expect(() => createAuthServices({} as any, { sessions: 'auth/sessions' }))
      .toThrow(/single path segment/)
  })
})
