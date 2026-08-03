// tests/routes.test.ts
//
// The /auth/* routes against a REAL Junction app.
//
// plugin.ts types its app and every ctx as `any`, so the typechecker verifies
// nothing about this wiring. Until 2026-08-02 nothing else did either, and it
// hid a live defect: auth.ts threw plain Errors, Junction's toFrameworkError()
// turned every one into a GeneralError, and so **every** auth failure — wrong
// password, duplicate email, bad reset token — reached the client as a 500.
//
// The status-code assertions below are the regression barrier for that.

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
  }) as any)
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
})

// ─── me / logout ──────────────────────────────────────────────────────────

describe('GET /auth/me and POST /auth/logout', () => {
  test('anonymous /auth/me is 401', async () => {
    expect((await request(app).get('/auth/me')).status).toBe(401)
  })

  test('a Bearer token resolves ctx.user, and logout revokes it', async () => {
    await request(app).post('/auth/register').send({ email: email('m-user'), password: 'pw-1' })
    const login = await request(app).post('/auth/login').send({ email: email('m-user'), password: 'pw-1' })
    const token = (login.body as any).token

    const me = await request(app).get('/auth/me').auth(token)
    expect(me.status).toBe(200)
    expect((me.body as any).email).toBe(email('m-user'))

    expect((await request(app).post('/auth/logout').auth(token)).status).toBe(200)
    expect((await request(app).get('/auth/me').auth(token)).status).toBe(401)
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
    }) as any)

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

  // Known gap, asserted so it is not mistaken for working: Junction's
  // extractToken() (transport/http.ts) reads only `authorization` and
  // `x-api-key`, never cookies — so ctx.user is never resolved from the
  // cookie and cookie-only auth cannot reach a protected route. Fixing that
  // is a Junction change. See PROJECT_STATE.md finding 2.
  test('KNOWN GAP: a cookie alone does not authenticate a request', async () => {
    const login = await request(cookieApp).post('/auth/login')
      .send({ email: email('cookie'), password: 'pw-1' })
    const value = login.headers['set-cookie'].split(';')[0].split('=')[1]

    const me = await request(cookieApp).get('/auth/me').set('cookie', `session=${value}`)
    expect(me.status).toBe(401)   // ← flip to 200 when Junction learns cookies
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
