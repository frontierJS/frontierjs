// test/audit-oauth-returnto.test.ts
//
// Audit 2026-10-05 — `isAllowedReturnTo` and a prefix allow-list entry.
//
// A prefix entry (`/orders/`) is matched with `startsWith`, and a browser
// resolves a Location header by removing dot segments AFTER that check ran.
// So `/orders/../admin` passes the list and lands on `/admin`, which the list
// never named. The origin is kept — a path-absolute reference inherits the
// authority — so this is not an open redirector; it is the allow-list not
// bounding where a sign-in ends, which is the one thing it exists to do.
//
// WHATWG also treats `%2e%2e` (any case) as a double-dot segment, so a fix
// that looks for the literal `..` alone is still open.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { defineProvider, isAllowedReturnTo, OAUTH_STATE_COOKIE } from '../oauth.ts'
import { makeAuth, type Harness } from './harness.ts'

describe('isAllowedReturnTo — a prefix entry bounds where the browser LANDS', () => {
  const allow = ['/orders/']

  // FJS-1846: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a dot segment under the prefix does not escape it', () => {
    expect(isAllowedReturnTo('/orders/../admin', allow)).toBe(false)
    expect(isAllowedReturnTo('/orders/42/../../admin', allow)).toBe(false)
    expect(isAllowedReturnTo('/orders/./../admin', allow)).toBe(false)
  })

  // FJS-1846: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('nor does a percent-encoded one — WHATWG resolves %2e%2e as ..', () => {
    expect(isAllowedReturnTo('/orders/%2e%2e/admin', allow)).toBe(false)
    expect(isAllowedReturnTo('/orders/%2E%2E/admin', allow)).toBe(false)
    expect(isAllowedReturnTo('/orders/.%2e/admin', allow)).toBe(false)
  })

  test('the control: an ordinary path under the prefix still passes', () => {
    expect(isAllowedReturnTo('/orders/42', allow)).toBe(true)
    expect(isAllowedReturnTo('/orders/42/items', allow)).toBe(true)
  })
})

// ─── through the routes ─────────────────────────────────────────────────────

describe('GET /auth/oauth/{provider}?returnTo= with a prefix entry', () => {
  let h: Harness
  let app: any
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    h = await makeAuth({
      oauthProviders:     { google: defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' }) },
      oauthReturnToAllow: ['/orders/'],
    })
    app = await createTestApp({ auth: h.auth as any })
    app.setAuth(h.auth as any)
    app.configure(createAuthPlugin(h.auth, {
      cookieAuth: true,
      oauth: { publicUrl: 'https://shop.test', errorRedirect: '/sign-in', rateLimit: { max: 10_000, window: '15 minutes' } },
    }))
  })
  afterAll(() => h.cleanup())
  afterEach(() => { globalThis.fetch = realFetch })

  function stubProviderOk() {
    globalThis.fetch = (async (input: any) => {
      const body = String(input).includes('token')
        ? { access_token: 'at', expires_in: 3600 }
        : { sub: 'rt-1', email: 'rt@shop.test', email_verified: true, name: 'R' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  }

  // FJS-1846: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a traversal under the prefix lands at the default, not outside the prefix', async () => {
    const start = await request(app).get('/auth/oauth/google?returnTo=' + encodeURIComponent('/orders/../admin'))
    const state = new URL(String(start.headers['location'])).searchParams.get('state')!
    stubProviderOk()

    const res = await request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)

    expect(res.status).toBe(302)
    // What the browser will resolve this header to must stay under /orders/.
    const landed = new URL(String(res.headers['location']), 'https://shop.test')
    expect(landed.pathname.startsWith('/orders/') || landed.pathname === '/').toBe(true)
  })
})
