// test/audit-routes-session-lifecycle.test.ts
//
// Audit 2026-10-05: cookie hygiene and token reuse across the /auth/* routes,
// at the HTTP layer. Each test asserts the secure behavior; a pass refutes the
// attack it names.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn } from './harness.ts'
import { appWith, json, raw, cookieOf, cookieValue } from './audit-routes-http.ts'

let h: Harness
let cookieApp: any
let bearerApp: any

beforeAll(async () => {
  h = await makeAuth()
  cookieApp = await appWith(h.auth, { cookieAuth: true })
  bearerApp = await appWith(h.auth, { cookieAuth: false })
})
afterAll(() => h.cleanup())

let n = 0
async function person(tag: string) {
  const email = `${tag}-${n++}@example.com`
  await h.auth.createUser({ email, password: 'pw-correct-1', name: tag })
  return { email, password: 'pw-correct-1' }
}

const withCookie = (session: string) => ({ cookie: `session=${session}` })

describe('session fixation', () => {
  test('a login that arrives carrying user A\'s cookie ends up as B, with a fresh token', async () => {
    const a = await person('a'), b = await person('b')
    const la = await json(cookieApp, 'POST', '/auth/login', { email: a.email, password: a.password })
    const sa = cookieValue(la, 'session')!
    expect(sa).toBeTruthy()

    const lb = await json(cookieApp, 'POST', '/auth/login', { email: b.email, password: b.password }, withCookie(sa))
    const sb = cookieValue(lb, 'session')!
    expect(sb).toBeTruthy()
    expect(sb).not.toBe(sa)

    const me = await raw(cookieApp, 'GET', '/account/me', { headers: withCookie(sb) })
    expect(me.status).toBe(200)
    expect(me.body.email).toBe(b.email)
  })
})

describe('cookie attributes', () => {
  test('login sets HttpOnly; SameSite=Lax; Path=/ and logout clears with the same Path', async () => {
    const a = await person('attrs')
    const login = await json(cookieApp, 'POST', '/auth/login', { email: a.email, password: a.password })
    const set   = cookieOf(login, 'session')!
    expect(set).toMatch(/Path=\//)
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/SameSite=Lax/)
    expect(login.body.token).toBeUndefined()

    const session = cookieValue(login, 'session')!
    const out = await json(cookieApp, 'POST', '/auth/logout', {}, withCookie(session))
    expect(out.status).toBe(200)
    const cleared = cookieOf(out, 'session')!
    expect(cleared).toMatch(/^session=;/)
    expect(cleared).toMatch(/Max-Age=0/)
    expect(cleared).toMatch(/Path=\//)
  })

  test('a login that produced a session leaves no login_challenge cookie behind', async () => {
    // A half-finished login's ticket is the password's stand-in; a full login
    // that follows it should not leave the earlier ticket in the jar.
    const a = await person('nochal')
    const login = await json(cookieApp, 'POST', '/auth/login',
      { email: a.email, password: a.password }, { cookie: 'login_challenge=stale-ticket' })
    expect(login.status).toBe(200)
    const chal = cookieOf(login, 'login_challenge')
    // Secure: cleared (Max-Age=0) rather than left as it was.
    expect(chal).not.toBeNull()
    expect(chal!).toMatch(/Max-Age=0/)
  })

  test('a refused challenge that cannot be retried clears the login_challenge cookie', async () => {
    const res = await json(cookieApp, 'POST', '/auth/login/challenge', { code: '000000' },
      { cookie: 'login_challenge=no-such-ticket' })
    expect(res.status).toBe(401)
    expect(res.body.retryable).toBe(false)
    const chal = cookieOf(res, 'login_challenge')
    expect(chal).not.toBeNull()
    expect(chal!).toMatch(/Max-Age=0/)
  })
})

describe('token reuse after a revoking event', () => {
  test('after POST /auth/logout the Bearer token no longer reaches /account/me', async () => {
    const a = await person('logout')
    const { token } = signedIn(await h.auth.login(a.email, a.password))
    expect((await raw(bearerApp, 'GET', '/account/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await json(bearerApp, 'POST', '/auth/logout', {}, { authorization: `Bearer ${token}` })).status).toBe(200)
    expect((await raw(bearerApp, 'GET', '/account/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  test('after POST /auth/logout the cookie no longer reaches /account/me', async () => {
    const a = await person('logout-cookie')
    const login = await json(cookieApp, 'POST', '/auth/login', { email: a.email, password: a.password })
    const s = cookieValue(login, 'session')!
    expect((await raw(cookieApp, 'GET', '/account/me', { headers: withCookie(s) })).status).toBe(200)
    await json(cookieApp, 'POST', '/auth/logout', {}, withCookie(s))
    expect((await raw(cookieApp, 'GET', '/account/me', { headers: withCookie(s) })).status).toBe(401)
  })

  test('after password-reset/confirm every earlier session is gone', async () => {
    const a = await person('reset')
    const { token } = signedIn(await h.auth.login(a.email, a.password))
    await json(bearerApp, 'POST', '/auth/password-reset/request', { email: a.email })
    const confirm = await json(bearerApp, 'POST', '/auth/password-reset/confirm', { token: h.resetToken(), password: 'new-pw-1' })
    expect(confirm.status).toBe(200)
    expect((await raw(bearerApp, 'GET', '/account/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  test('after GET /auth/email/verify earlier sessions survive (documented, not a revocation event)', async () => {
    const a = await person('verify')
    const { token, user } = signedIn(await h.auth.login(a.email, a.password))
    await h.auth.requestEmailVerification!(user.userId)
    const v = await raw(bearerApp, 'GET', `/auth/email/verify?token=${encodeURIComponent(h.verifyToken())}`)
    expect(v.status).toBe(200)
    expect((await raw(bearerApp, 'GET', '/account/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  })
})
