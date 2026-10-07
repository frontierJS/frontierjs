// test/audit-routes-login-csrf.test.ts
//
// Audit 2026-10-05: cross-site form POSTs against the raw /auth/* routes in
// cookie mode. Every test asserts the SECURE behavior — a request a browser
// marks as cross-site is refused and sets no session — so a test that fails
// here is a finding on current code.
//
// The attack request carries NO cookie, so SameSite=Lax has nothing to
// withhold: a `<form method=POST action=https://app/auth/login>` posts
// `application/x-www-form-urlencoded`, junction's parseBody turns it into
// `ctx.body`, and the route's `body()` reader only asks that fields be strings.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness } from './harness.ts'
import { appWith, form, multipart, raw, CROSS_SITE, cookieOf, cookieValue } from './audit-routes-http.ts'

let h: Harness
let app: any
let resets = 0

beforeAll(async () => {
  h = await makeAuth({ onPasswordResetRequested: async () => { resets++ } })
  app = await appWith(h.auth, { cookieAuth: true })
  await h.auth.createUser({ email: 'attacker@example.com', password: 'attacker-pw-1', name: 'Mallory' })
})
afterAll(() => h.cleanup())

describe('POST /auth/login in cookie mode', () => {

  test('a cross-site urlencoded form POST does not sign the browser in', async () => {
    const res = await form(app, '/auth/login',
      { email: 'attacker@example.com', password: 'attacker-pw-1' }, CROSS_SITE)

    // Secure: refused, and no session cookie minted for the victim's jar.
    expect(res.status).toBe(403)
    expect(cookieOf(res, 'session')).toBeNull()
  })

  test('a cross-site multipart form POST does not sign the browser in', async () => {
    const res = await multipart(app, '/auth/login',
      { email: 'attacker@example.com', password: 'attacker-pw-1' }, CROSS_SITE)

    expect(res.status).toBe(403)
    expect(cookieOf(res, 'session')).toBeNull()
  })

  // Refused by csrf before body() could refuse it for not being an object.
  test('a cross-site text/plain POST is refused', async () => {
    const res = await raw(app, 'POST', '/auth/login', {
      headers: { 'content-type': 'text/plain', ...CROSS_SITE },
      body:    'email=attacker@example.com&password=attacker-pw-1',
    })
    expect(res.status).toBe(403)
    expect(cookieOf(res, 'session')).toBeNull()
  })

  test('the minted cookie is a usable session for the attacker account (what the victim would hold)', async () => {
    const res = await form(app, '/auth/login',
      { email: 'attacker@example.com', password: 'attacker-pw-1' }, CROSS_SITE)
    const session = cookieValue(res, 'session')
    if (!session) return   // already refused above — nothing to prove

    const me = await raw(app, 'GET', '/account/me', { headers: { cookie: `session=${session}` } })
    // Secure: a cookie minted by a cross-site POST must not resolve to a user.
    expect(me.status).not.toBe(200)
    expect(me.body?.email).not.toBe('attacker@example.com')
  })
})

describe('POST /auth/register in cookie mode', () => {
  test('a cross-site urlencoded form POST does not create an account and sign the browser in', async () => {
    const res = await form(app, '/auth/register',
      { email: 'planted@example.com', password: 'planted-pw-1', name: 'Planted' }, CROSS_SITE)

    expect(res.status).toBe(403)
    expect(cookieOf(res, 'session')).toBeNull()
    expect(await h.sys.user.findFirst({ where: { email: 'planted@example.com' } })).toBeNull()
  })
})

describe('POST /auth/password-reset/request', () => {
  test('a cross-site urlencoded form POST does not send reset mail from the victim\'s IP', async () => {
    await h.auth.createUser({ email: 'victim-of-reset@example.com', password: 'v-pw-1', name: 'V' })
    const before = resets
    const res = await form(app, '/auth/password-reset/request',
      { email: 'victim-of-reset@example.com' }, CROSS_SITE)

    expect(res.status).toBe(403)
    expect(resets).toBe(before)
  })
})

describe('what the transport knows about the request', () => {
  test('a request that says Sec-Fetch-Site: cross-site is refused even with no Origin', async () => {
    const res = await form(app, '/auth/login',
      { email: 'attacker@example.com', password: 'attacker-pw-1' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })

    expect(res.status).toBe(403)
    expect(cookieOf(res, 'session')).toBeNull()
  })
})

describe('an app that also declares http.csrf', () => {
  test('gets one guard, and the same cross-site form POST is 403', async () => {
    const guarded = await appWith(h.auth, { cookieAuth: true },
      { http: { csrf: { origins: ['https://app.example'] } } })
    const res = await form(guarded, '/auth/login',
      { email: 'attacker@example.com', password: 'attacker-pw-1' }, CROSS_SITE)
    expect(res.status).toBe(403)
    expect(cookieOf(res, 'session')).toBeNull()
  })
})
