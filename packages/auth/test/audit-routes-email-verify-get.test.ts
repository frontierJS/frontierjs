// test/audit-routes-email-verify-get.test.ts
//
// Audit 2026-10-05: GET /auth/email/verify?token= mutates state and answers the
// whole SessionContext to whoever fetched the link. A mail-link scanner fetches
// it first; the person who clicks later gets `Invalid or expired`.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness } from './harness.ts'
import { appWith, raw } from './audit-routes-http.ts'

let h: Harness
let app: any

beforeAll(async () => {
  h   = await makeAuth()
  app = await appWith(h.auth)
})
afterAll(() => h.cleanup())

describe('GET /auth/email/verify', () => {
  test('answers no account fields to the holder of the link', async () => {
    const u = await h.auth.createUser({ email: 'scanme@example.com', password: 's-pw-1', name: 'Scan Me' })
    await h.auth.requestEmailVerification!(u.userId)

    const res = await raw(app, 'GET', `/auth/email/verify?token=${encodeURIComponent(h.verifyToken())}`)
    expect(res.status).toBe(200)
    // Secure: `{ ok: true }` and nothing about the account. What it answers
    // today is in the failure message.
    expect(res.body.user).toBeUndefined()
  })

  test('a scanner\'s GET does not consume the link for the person who clicks it', async () => {
    const u = await h.auth.createUser({ email: 'scanned@example.com', password: 's-pw-1', name: 'Scanned' })
    await h.auth.requestEmailVerification!(u.userId)
    const link = `/auth/email/verify?token=${encodeURIComponent(h.verifyToken())}`

    expect((await raw(app, 'GET', link)).status).toBe(200)   // the scanner
    expect((await raw(app, 'GET', link)).status).toBe(200)   // the person
  })
})
