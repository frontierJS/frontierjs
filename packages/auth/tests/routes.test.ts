// tests/routes.test.ts
//
// The /auth/* routes against a REAL Junction app.
//
// plugin.ts typed its app and every ctx as `any` until 2026-08-16, so the
// typechecker verified nothing about this wiring, and until 2026-08-02 nothing
// else did either. That hid a live defect: auth.ts threw plain Errors, Junction's
// toFrameworkError() turned every one into a GeneralError, and so **every** auth
// failure — wrong password, duplicate email, bad reset token — reached the client
// as a 500. The status-code assertions below are the regression barrier for that.
//
// Typing it found a second one the same way (FJS-296): `ctx.body` is `unknown`,
// and reading fields off it under `any` is how a where-operator object reached
// the user lookup. A raw route has no validator in front of it — that is the
// standing difference between these eight and the three services, and it is why
// this file asserts on what a MALFORMED body does as well as a wrong one.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request, createService } from '@frontierjs/junction'
import {
  InvalidCredentialsError, EmailTakenError, InvalidTokenError,
  UserNotFoundError, AuthConfigError,
} from '../errors.ts'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness } from './harness.ts'

let h: Harness
let app: any

beforeAll(async () => {
  h = await makeAuth()
  app = await createTestApp({ auth: h.auth as any })
  // createTestApp installs a stub auth; point the transport at ours so
  // ctx.user is resolved by this package's verifySession.
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    // Generous limits: these tests make far more calls than a real client.
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
  }))
})
afterAll(() => h.cleanup())

const email = (n: string) => `${n}@example.com`

// ─── register ─────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  test('creates the user, returns 201 and a token', async () => {
    const res = await request(app).post('/auth/register')
      .send({ email: email('r-ok'), password: 'pw-1', name: 'R' })

    expect(res.status).toBe(201)
    expect((res.body as any).token).toBeTruthy()
    expect((res.body as any).user.email).toBe(email('r-ok'))
  })

  test('missing email is 400, missing password is 400', async () => {
    expect((await request(app).post('/auth/register').send({ password: 'x' })).status).toBe(400)
    expect((await request(app).post('/auth/register').send({ email: email('r-nop') })).status).toBe(400)
  })

  test('a duplicate email is 409 — it used to be 500', async () => {
    await request(app).post('/auth/register').send({ email: email('r-dupe'), password: 'pw-1' })

    const res = await request(app).post('/auth/register')
      .send({ email: email('r-dupe'), password: 'pw-1' })

    expect(res.status).toBe(409)
    expect((res.body as any).name).toBe('Conflict')
  })
})

// ─── login ────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  beforeAll(async () => {
    await request(app).post('/auth/register').send({ email: email('l-user'), password: 'pw-1' })
  })

  test('valid credentials return 200 with a token', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: email('l-user'), password: 'pw-1' })

    expect(res.status).toBe(200)
    expect((res.body as any).token).toBeTruthy()
  })

  // THE regression test. A wrong password answering 500 meant a client could
  // not tell a typo from an outage, and Sierra's browser client — which keys
  // off 401 to clear a stale token — never got its signal.
  test('a wrong password is 401, NOT 500', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: email('l-user'), password: 'wrong' })

    expect(res.status).toBe(401)
    expect((res.body as any).name).toBe('Unauthorized')
  })

  test('an unknown email is 401 and indistinguishable from a wrong password', async () => {
    const unknown = await request(app).post('/auth/login')
      .send({ email: email('l-ghost'), password: 'wrong' })
    const wrong = await request(app).post('/auth/login')
      .send({ email: email('l-user'), password: 'wrong' })

    expect(unknown.status).toBe(401)
    expect((unknown.body as any).message).toBe((wrong.body as any).message)
  })

  test('no 5xx is produced by any ordinary credential failure', async () => {
    for (const body of [
      { email: email('l-user'), password: 'wrong' },
      { email: email('l-ghost'), password: 'x' },
    ]) {
      const res = await request(app).post('/auth/login').send(body)
      expect(res.status).toBeLessThan(500)
    }
  })

  test('a missing field is still 400', async () => {
    expect((await request(app).post('/auth/login').send({ email: email('l-user') })).status).toBe(400)
  })

  // FJS-296. A raw route has no `autoValidate` in front of it, so whatever a
  // caller posted went into `findFirst({ where: { email } })` unexamined — and
  // Litestone reads an OBJECT there as a where-operator. The address became a
  // filter: `contains` plus a correct password signed the caller in as the first
  // matching row, and `startsWith` walked the user table with no address known.
  // The password was still checked, which is the only reason this was not a
  // straight bypass.
  test('a where-operator in place of an email is 400, not a query', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: { contains: '@' }, password: 'pw-1' })

    expect(res.status).toBe(400)
    expect((res.body as any).message).toBe('email must be a string')
  })

  // The same input used to reach SQLite and come back as a 500 carrying
  // Litestone's own message — the query builder's vocabulary, on a public
  // sign-in route, to an unauthenticated caller.
  test('an unknown where-operator does not surface as a 500', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: { $ne: null }, password: 'x' })

    expect(res.status).toBe(400)
  })

  test('every declared field must be a string, and says which one is not', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ email: 123,        password: 'x' },  'email must be a string'],
      [{ email: ['a@b.co'], password: 'x' },  'email must be a string'],
      [{ email: email('l-user'), password: 9 }, 'password must be a string'],
    ]
    for (const [payload, message] of cases) {
      const res = await request(app).post('/auth/login').send(payload)
      expect(res.status).toBe(400)
      expect((res.body as any).message).toBe(message)
    }
  })

  // Register is the one that WROTE it: an array email created a user whose
  // address was the array coerced to a string by SQLite, 201 and no complaint.
  test('register refuses a non-string field rather than coercing it', async () => {
    const res = await request(app).post('/auth/register')
      .send({ email: [email('l-array')], password: 'pw-1' })

    expect(res.status).toBe(400)
  })
})

// ─── me / logout ──────────────────────────────────────────────────────────

// `/auth/me` was a route and is now `account.get('me')` — a request that can be
// refused for want of a session is a service. What these tests are really
// asserting is that the TRANSPORT resolved the caller, so they address whatever
// authenticated surface exists; the service is the one that does now.
describe('GET /account/me and POST /auth/logout', () => {
  test('anonymous /account/me is 401', async () => {
    expect((await request(app).get('/account/me')).status).toBe(401)
  })

  test('a Bearer token resolves ctx.user, and logout revokes it', async () => {
    await request(app).post('/auth/register').send({ email: email('m-user'), password: 'pw-1' })
    const login = await request(app).post('/auth/login').send({ email: email('m-user'), password: 'pw-1' })
    const token = (login.body as any).token

    const me = await request(app).get('/account/me').auth(token)
    expect(me.status).toBe(200)
    expect((me.body as any).email).toBe(email('m-user'))

    expect((await request(app).post('/auth/logout').auth(token)).status).toBe(200)
    expect((await request(app).get('/account/me').auth(token)).status).toBe(401)
  })
})

// ─── password reset ───────────────────────────────────────────────────────

describe('password reset routes', () => {
  test('request is 200 for both known and unknown emails', async () => {
    await request(app).post('/auth/register').send({ email: email('prr'), password: 'pw-1' })

    expect((await request(app).post('/auth/password-reset/request').send({ email: email('prr') })).status).toBe(200)
    expect((await request(app).post('/auth/password-reset/request').send({ email: email('nobody') })).status).toBe(200)
  })

  test('confirm with a valid token is 200 and the new password works', async () => {
    await request(app).post('/auth/register').send({ email: email('prc'), password: 'pw-1' })
    await request(app).post('/auth/password-reset/request').send({ email: email('prc') })

    const res = await request(app).post('/auth/password-reset/confirm')
      .send({ token: h.resetToken(), password: 'pw-2' })
    expect(res.status).toBe(200)

    expect((await request(app).post('/auth/login').send({ email: email('prc'), password: 'pw-2' })).status).toBe(200)
  })

  test('a bad token is 400, NOT 500', async () => {
    const res = await request(app).post('/auth/password-reset/confirm')
      .send({ token: 'garbage', password: 'pw-x' })

    expect(res.status).toBe(400)
    expect((res.body as any).name).toBe('BadRequest')
  })

  test('a missing token or password is 400', async () => {
    expect((await request(app).post('/auth/password-reset/confirm').send({ password: 'x' })).status).toBe(400)
    expect((await request(app).post('/auth/password-reset/confirm').send({ token: 'x' })).status).toBe(400)
  })
})

// ─── email verification ───────────────────────────────────────────────────

describe('email verification routes', () => {
  test('requesting verification anonymously is 401', async () => {
    expect((await request(app).post('/auth/email/verify/request')).status).toBe(401)
  })

  test('an authenticated request is 200 and the emitted token verifies', async () => {
    await request(app).post('/auth/register').send({ email: email('ev-route'), password: 'pw-1' })
    const login = await request(app).post('/auth/login').send({ email: email('ev-route'), password: 'pw-1' })

    const req = await request(app).post('/auth/email/verify/request').auth((login.body as any).token)
    expect(req.status).toBe(200)

    const res = await request(app).get('/auth/email/verify').query({ token: h.verifyToken() })
    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(true)
  })

  test('a missing token is 400 and a bad token is 400, NOT 500', async () => {
    expect((await request(app).get('/auth/email/verify')).status).toBe(400)

    const bad = await request(app).get('/auth/email/verify').query({ token: 'garbage' })
    expect(bad.status).toBe(400)
    expect((bad.body as any).name).toBe('BadRequest')
  })
})

// ─── rate limiting ────────────────────────────────────────────────────────

describe('rate limiting', () => {
  test('register beyond the window limit returns 429', async () => {
    const scoped = await makeAuth()
    const limited = await createTestApp({ auth: scoped.auth as any })
    limited.setAuth(scoped.auth as any)
    limited.configure(createAuthPlugin(scoped.auth, {
      registerRateLimit: { max: 3, window: '15 minutes' },
    }))

    const codes: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await request(limited).post('/auth/register')
        .send({ email: `rl${i}@example.com`, password: 'pw-1' })
      codes.push(r.status)
    }

    expect(codes.slice(0, 3)).toEqual([201, 201, 201])
    expect(codes.slice(3)).toEqual([429, 429])
    scoped.cleanup()
  })
})

// ─── cookie mode ──────────────────────────────────────────────────────────

describe('cookieAuth mode', () => {
  let cookieApp: any
  let scoped: Harness

  beforeAll(async () => {
    scoped = await makeAuth()
    cookieApp = await createTestApp({ auth: scoped.auth as any })
    cookieApp.setAuth(scoped.auth as any)
    cookieApp.configure(createAuthPlugin(scoped.auth, { cookieAuth: true }) as any)
    await request(cookieApp).post('/auth/register').send({ email: email('cookie'), password: 'pw-1' })
  })
  afterAll(() => scoped.cleanup())

  test('sets an httpOnly session cookie whose Max-Age tracks sessionTtl', async () => {
    const res = await request(cookieApp).post('/auth/login')
      .send({ email: email('cookie'), password: 'pw-1' })

    expect(res.status).toBe(200)
    const cookie = res.headers['set-cookie']
    expect(cookie).toContain('session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`)   // default '30 days'
  })

  // The point of httpOnly is that page JavaScript cannot read the token.
  // Returning it in the body as well handed it straight back — which is
  // exactly what this mode opts out of. AuthPluginOptions documents the
  // cookie as going out "instead of returning it in the response body".
  test('does NOT also return the token in the response body', async () => {
    const res = await request(cookieApp).post('/auth/login')
      .send({ email: email('cookie'), password: 'pw-1' })

    expect((res.body as any).token).toBeUndefined()
    expect(res.text).not.toContain('"token"')
    // the user is still returned, so the client knows who it is
    expect((res.body as any).user.email).toBe(email('cookie'))
  })

  test('register in cookie mode also withholds the token from the body', async () => {
    const res = await request(cookieApp).post('/auth/register')
      .send({ email: email('cookie2'), password: 'pw-1' })

    expect(res.status).toBe(201)
    expect((res.body as any).token).toBeUndefined()
    expect(res.headers['set-cookie']).toContain('session=')
  })

  // Was a KNOWN GAP asserting 401, closed 2026-08-06 (FJS-002). Junction's
  // extractToken() read only `authorization` and `x-api-key`, so ctx.user was
  // never resolved from the cookie and `cookieAuth: true` handed you a session
  // you could not use. The plugin now calls http.setAuthCookie('session') from
  // its register(), so cookie mode is one switch rather than two.
  test('a cookie alone authenticates a request', async () => {
    const login = await request(cookieApp).post('/auth/login')
      .send({ email: email('cookie'), password: 'pw-1' })
    const value = login.headers['set-cookie'].split(';')[0].split('=')[1]

    const me = await request(cookieApp).get('/account/me').set('cookie', `session=${value}`)
    expect(me.status).toBe(200)
    expect((me.body as any).email).toBe(email('cookie'))
  })

  test('no cookie is still 401', async () => {
    // The other half: turning cookies on must not authenticate a request that
    // carries no credential at all.
    expect((await request(cookieApp).get('/account/me')).status).toBe(401)
  })

  test('a garbage cookie is 401, not a crash', async () => {
    const me = await request(cookieApp).get('/account/me').set('cookie', 'session=not-a-token')
    expect(me.status).toBe(401)
  })

  test('an emptied cookie does not authenticate — this is what logout leaves', async () => {
    // clearCookie() sets `session=` with Max-Age=0. If '' counted as a token
    // every post-logout request would carry a guaranteed-failing verifySession.
    const me = await request(cookieApp).get('/account/me').set('cookie', 'session=')
    expect(me.status).toBe(401)
  })

  test('a Bearer token still wins over the cookie', async () => {
    // Explicit beats ambient, so "act as someone else for this one call" stays
    // possible from a browser that is also holding a session cookie.
    const a = await request(cookieApp).post('/auth/login')
      .send({ email: email('cookie'), password: 'pw-1' })
    const cookieValue = a.headers['set-cookie'].split(';')[0].split('=')[1]

    await request(cookieApp).post('/auth/register').send({ email: email('bearer-wins'), password: 'pw-1' })
    const other = await scoped.auth.login(email('bearer-wins'), 'pw-1')

    const me = await request(cookieApp).get('/account/me')
      .set('cookie', `session=${cookieValue}`)
      .set('authorization', `Bearer ${other.token}`)
    expect(me.status).toBe(200)
    expect((me.body as any).email).toBe(email('bearer-wins'))
  })

  test('logout accepts the session cookie', async () => {
    const login = await request(cookieApp).post('/auth/login')
      .send({ email: email('cookie'), password: 'pw-1' })
    const value = login.headers['set-cookie'].split(';')[0].split('=')[1]

    const out = await request(cookieApp).post('/auth/logout').set('cookie', `session=${value}`)
    expect(out.status).toBe(200)
    expect(await scoped.auth.verifySession(value)).toBeNull()
  })
})

// ─── the error boundary, beyond /auth/* ───────────────────────────────────

describe('auth errors map correctly outside the auth routes', () => {
  // The mapping used to live in plugin.ts, wrapping the 8 /auth/* handlers.
  // That covered those routes and nothing else: the same error raised from an
  // ordinary service reached the client as a 500. The errors now carry a
  // numeric `status` (errors.ts) and Junction's error boundary reads it — so
  // this package still imports nothing from Junction for its statuses, and the
  // mapping applies everywhere.
  const serviceThrowing = async (err: Error) => {
    const app: any = await createTestApp()
    app.services.register(createService({ name: 'thing', async create() { throw err } }))
    return request(app).post('/thing').send({})
  }

  test('InvalidCredentialsError from a service is 401', async () => {
    expect((await serviceThrowing(new InvalidCredentialsError())).status).toBe(401)
  })

  test('EmailTakenError from a service is 409', async () => {
    expect((await serviceThrowing(new EmailTakenError())).status).toBe(409)
  })

  test('InvalidTokenError from a service is 400', async () => {
    expect((await serviceThrowing(new InvalidTokenError())).status).toBe(400)
  })

  test('UserNotFoundError from a service is 404', async () => {
    expect((await serviceThrowing(new UserNotFoundError())).status).toBe(404)
  })

  // A missing encryptionKey is the server's fault, and must stay a 500 —
  // never reported to a caller as though they did something wrong.
  test('AuthConfigError from a service stays 500', async () => {
    expect((await serviceThrowing(new AuthConfigError('no key'))).status).toBe(500)
  })

  test('every auth error declares the status it means', () => {
    expect(new InvalidCredentialsError().status).toBe(401)
    expect(new EmailTakenError().status).toBe(409)
    expect(new InvalidTokenError().status).toBe(400)
    expect(new UserNotFoundError().status).toBe(404)
    expect(new AuthConfigError('x').status).toBe(500)
  })
})
