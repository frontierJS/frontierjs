// test/audit-oauth-cookie-path.test.ts
//
// Audit 2026-10-05 — the callback route writes the RAW `{provider}` segment
// into a Set-Cookie `Path=` attribute before anything has checked the name.
//
// `matchPathDirect` percent-decodes a param, `serializeSetCookie` joins the
// attributes with `; ` and does not encode `Path`, and the callback clears the
// state cookie with `callbackPath(app, prefix, provider)` on every request —
// unknown provider included. So `%3B` in the segment ends the Path attribute
// and starts another one chosen by whoever built the link, and `%0A` puts a
// line break into a response header.
//
// The begin route is not open the same way: it sets its cookie only after
// `oauthBegin` accepted the name.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { defineProvider } from '../oauth.ts'
import { makeAuth, type Harness } from './harness.ts'

let h: Harness
let app: any

beforeAll(async () => {
  h = await makeAuth({
    oauthProviders: { google: defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' }) },
  })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    cookieAuth: true,
    oauth: { publicUrl: 'https://shop.test', errorRedirect: '/sign-in', rateLimit: { max: 10_000, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

const setCookies = (res: any): string[] => {
  const raw = res.headers?.['set-cookie']
  return Array.isArray(raw) ? raw : raw ? [String(raw)] : []
}

describe('GET /auth/oauth/{provider}/callback with a hostile provider segment', () => {

  test('a `;` in the segment does not become a second cookie attribute', async () => {
    const segment = encodeURIComponent('x; Domain=evil.test; Path=/')
    const res = await request(app).get(`/auth/oauth/${segment}/callback?error=access_denied`)

    expect(res.status).toBe(302)
    for (const c of setCookies(res)) {
      expect(c).not.toContain('Domain=evil.test')
      // Every attribute after the name=value pair must be one the plugin wrote.
      const attrs = c.split(';').slice(1).map(s => s.trim().split('=')[0].toLowerCase())
      for (const a of attrs) expect(['path', 'max-age', 'httponly', 'secure', 'samesite']).toContain(a)
    }
  })

  test('a line break in the segment is not a 500', async () => {
    const segment = encodeURIComponent('x\r\nSet-Cookie: session=stolen')
    const res = await request(app).get(`/auth/oauth/${segment}/callback?error=access_denied`)
    expect(res.status).toBe(302)
  })
})
