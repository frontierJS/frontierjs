// test/audit-routes-email-verify-get.test.ts
//
// FJS-1839: a mail-link scanner fetches the link before the person clicks it.
// The token is single-use, so a GET that spends it burns the link for the
// person, and answering the SessionContext hands the account to whoever
// fetched. The link lands on a web page and the page POSTs the token
// (`FJS-D616`); a GET to the API route changes nothing.

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

const post = (token: string) => raw(app, 'POST', '/auth/email/verify', {
  headers: { 'content-type': 'application/json' },
  body:    JSON.stringify({ token }),
})

describe('/auth/email/verify', () => {
  test('POST answers no account fields to the holder of the link', async () => {
    const u = await h.auth.createUser({ email: 'scanme@example.com', password: 's-pw-1', name: 'Scan Me' })
    await h.auth.requestEmailVerification!(u.userId)

    const res = await post(h.verifyToken())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test('a scanner\'s GET does not consume the link for the person who clicks it', async () => {
    const u = await h.auth.createUser({ email: 'scanned@example.com', password: 's-pw-1', name: 'Scanned' })
    await h.auth.requestEmailVerification!(u.userId)
    const token = h.verifyToken()

    const scanner = await raw(app, 'GET', `/auth/email/verify?token=${encodeURIComponent(token)}`)
    expect(scanner.status).toBe(405)
    expect(scanner.body?.user).toBeUndefined()

    expect((await post(token)).status).toBe(200)   // the person
    expect((await post(token)).status).toBe(400)   // single-use, spent by the POST
  })
})
