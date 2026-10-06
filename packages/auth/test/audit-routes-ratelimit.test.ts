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

  test('scaffold shape — trustProxy absent behind the shipped nginx: one caller\'s failures lock every other caller out', async () => {
    // What `fli new` writes has no trustProxy, and `fli deploy`'s nginx appends
    // X-Forwarded-For. Every request then arrives from the proxy's socket, and
    // with trustProxy unset that socket is the whole key.
    const app = await appWith(h.auth, { loginRateLimit: { max: 3, window: '15 minutes' } })
    for (let i = 0; i < 3; i++) expect((await attempt(app, `203.0.113.7, 127.0.0.1`)).status).toBe(401)
    // A DIFFERENT client, through the same proxy. Secure: graded on its own.
    expect((await attempt(app, `198.51.100.9, 127.0.0.1`)).status).toBe(401)
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
