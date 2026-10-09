// test/audit-routes-ratelimit.test.ts
//
// Audit 2026-10-05: how the /auth/* limiters are keyed, and which routes have
// none. Every test asserts the secure behavior.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn } from './harness.ts'
import { appWith, json, raw } from './audit-routes-http.ts'

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

describe('routes with no limiter', () => {

  // FJS-1853: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('POST /auth/email/verify/request is bounded — it sends a mail per call', async () => {
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
