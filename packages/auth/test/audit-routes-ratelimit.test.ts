// test/audit-routes-ratelimit.test.ts
//
// Audit 2026-10-05: how the /auth/* limiters are keyed, and which routes have
// none. Every test asserts the secure behavior.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn } from './harness.ts'
import { appWith, json } from './audit-routes-http.ts'

let h: Harness
let verifyMails = 0

beforeAll(async () => {
  h = await makeAuth({ onEmailVerificationRequested: async () => { verifyMails++ } })
  await h.auth.createUser({ email: 'target@example.com', password: 'target-pw-1', name: 'T' })
})
afterAll(() => h.cleanup())

const attempt = (app: any, xff: string) =>
  json(app, 'POST', '/auth/login', { email: 'target@example.com', password: 'wrong' },
    { 'x-forwarded-for': xff })

describe('login limiter keying', () => {

  test('default trustProxy: rotating X-Forwarded-For does not buy more attempts', async () => {
    const app = await appWith(h.auth, { loginRateLimit: { max: 3, window: '15 minutes' } })
    for (let i = 0; i < 3; i++) expect((await attempt(app, `10.0.0.${i}`)).status).toBe(401)
    expect((await attempt(app, '10.0.0.99')).status).toBe(429)
  })

  test('deployed shape — FJS_TRUST_PROXY from the deploy, Caddy in front: one caller\'s failures do not lock out another (FJS-1841)', async () => {
    // `fli new` writes no trustProxy, and the deploy that puts Caddy in front
    // passes FJS_TRUST_PROXY=1 instead (FJS-D617). Caddy's X-Forwarded-For is
    // the address it observed and nothing a caller sent.
    const before = process.env.FJS_TRUST_PROXY
    process.env.FJS_TRUST_PROXY = '1'
    let app: any
    try { app = await appWith(h.auth, { loginRateLimit: { max: 3, window: '15 minutes' } }) }
    finally {
      if (before === undefined) delete process.env.FJS_TRUST_PROXY
      else process.env.FJS_TRUST_PROXY = before
    }
    for (let i = 0; i < 3; i++) expect((await attempt(app, '203.0.113.7')).status).toBe(401)
    expect((await attempt(app, '203.0.113.7')).status).toBe(429)
    // A DIFFERENT client, through the same proxy, graded on its own.
    expect((await attempt(app, '198.51.100.9')).status).toBe(401)
  })
})

describe('login limiter — a room behind one address (FJS-3128, FJS-D1200)', () => {

  const login = (app: any, email: string, ip = '203.0.113.7') =>
    json(app, 'POST', '/auth/login', { email, password: 'wrong' }, { 'x-forwarded-for': ip })

  test('the per-address default admits a class of fifty distinct accounts', async () => {
    const app = await appWith(h.auth, { loginRateLimit: undefined })
    for (let i = 0; i < 50; i++) expect((await login(app, `student${i}@example.com`)).status).toBe(401)
  }, 60_000)

  test('one account from one address is still bounded at ten', async () => {
    const app = await appWith(h.auth, { loginRateLimit: undefined })
    for (let i = 0; i < 10; i++) expect((await login(app, 'target@example.com')).status).toBe(401)
    expect((await login(app, 'target@example.com')).status).toBe(429)
    // Another account behind the spent address still gets its own bucket.
    expect((await login(app, 'other@example.com')).status).toBe(401)
  }, 30_000)

  test('the key is the (account, address) pair: a stranger\'s failures do not lock the account out', async () => {
    const before = process.env.FJS_TRUST_PROXY
    process.env.FJS_TRUST_PROXY = '1'
    let app: any
    try { app = await appWith(h.auth, { loginRateLimit: undefined }) }
    finally {
      if (before === undefined) delete process.env.FJS_TRUST_PROXY
      else process.env.FJS_TRUST_PROXY = before
    }
    for (let i = 0; i < 10; i++) expect((await login(app, 'target@example.com', '198.51.100.9')).status).toBe(401)
    expect((await login(app, 'target@example.com', '198.51.100.9')).status).toBe(429)
    expect((await login(app, 'target@example.com', '203.0.113.7')).status).toBe(401)
  })

  test('the account bucket is its own option', async () => {
    const app = await appWith(h.auth, { loginAccountRateLimit: { max: 2, window: '15 minutes' } })
    for (let i = 0; i < 2; i++) expect((await login(app, 'target@example.com')).status).toBe(401)
    expect((await login(app, 'Target@Example.com')).status).toBe(429)
  })
})

describe('routes with no limiter', () => {

  test('POST /auth/email/verify/request is bounded — it sends a mail per call', async () => {
    const app = await appWith(h.auth)
    await h.auth.createUser({ email: 'mailme@example.com', password: 'm-pw-1', name: 'M' })
    const { token } = signedIn(await h.auth.login('mailme@example.com', 'm-pw-1'))
    const before = verifyMails
    let limited = false
    for (let i = 0; i < 40; i++) {
      const res = await json(app, 'POST', '/auth/email/verify/request', {}, { authorization: `Bearer ${token}` })
      if (res.status === 429) { limited = true; break }
      expect(res.status).toBe(200)
    }
    // Secure: something stops the fortieth mail.
    expect(limited).toBe(true)
    expect(verifyMails - before).toBeLessThan(40)
  })
})
