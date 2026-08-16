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
    services:          { level: () => 4 },
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
    expect(wrong.status).toBe(401)

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
