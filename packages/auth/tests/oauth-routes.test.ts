// tests/oauth-routes.test.ts
//
// The OAuth pair against a REAL Junction app.
//
// These two routes differ from the other seven in one way that governs
// everything here: they are BROWSER NAVIGATIONS. Every other route in the
// plugin answers JSON to a `fetch()`; a person meets these in their address
// bar. So the assertions are about statuses, `location` headers and cookie
// attributes — and a JSON body anywhere in here would be the defect.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { defineProvider, OAUTH_STATE_COOKIE } from '../oauth.ts'
import { makeAuth, type Harness } from './harness.ts'

const PUBLIC_URL = 'https://shop.test'

let h: Harness
let app: any

beforeAll(async () => {
  h = await makeAuth({
    oauthProviders: {
      google: defineProvider('google', 'google', { clientId: 'cid', clientSecret: 'sec' }),
    },
    oauthReturnToAllow: ['/dashboard'],
  })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    cookieAuth: true,
    oauth: {
      publicUrl:     PUBLIC_URL,
      errorRedirect: '/sign-in',
      rateLimit:     { max: 10_000, window: '15 minutes' },
    },
  }))
  // No app.boot() here: createTestApp does not expose one, and the start
  // phases — plugin boot() included — run lazily on the first request().
})
afterAll(() => h.cleanup())

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const cookieOf = (res: any) => String(res.headers?.['set-cookie'] ?? '')

// ─── configuration that cannot work ─────────────────────────────────────────

describe('oauth without cookie mode', () => {

  test('is refused at boot rather than discovered as a sign-in that does nothing', async () => {
    // The callback is a browser redirect: it can hand back a cookie and has
    // nowhere to put a bearer token. Without cookieAuth the flow would run
    // perfectly, set nothing, and redirect somebody who is not signed in to a
    // page that will not say why.
    const bare = await makeAuth({ oauthProviders: { google: defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' }) } })
    try {
      const broken = await createTestApp({ auth: bare.auth as any })
      broken.setAuth(bare.auth as any)
      broken.configure(createAuthPlugin(bare.auth, {
        oauth: { publicUrl: PUBLIC_URL, rateLimit: { max: 10_000, window: '15 minutes' } },
      }))
      // The start phases run lazily on the first request, not at
      // createTestApp — configure() may still be called after it returns.
      let err: unknown = null
      try { await request(broken).get('/auth/oauth/google') } catch (e) { err = e }
      expect(String(err)).toContain('cookieAuth')
    } finally { bare.cleanup() }
  })
})

// ─── starting a flow ────────────────────────────────────────────────────────

describe('GET /auth/oauth/{provider}', () => {

  test('redirects to the provider and does not answer JSON', async () => {
    const res = await request(app).get('/auth/oauth/google')

    expect(res.status).toBe(302)
    const location = String(res.headers['location'])
    expect(location).toContain('accounts.google.com')
    expect(location).toContain('code_challenge_method=S256')
  })

  test('sets the state cookie httpOnly and SameSite=Lax', async () => {
    // Lax and NEVER Strict: the callback is a cross-site top-level GET
    // navigation from the provider, and Strict withholds the cookie on exactly
    // that — the flow would fail every single time.
    const res    = await request(app).get('/auth/oauth/google')
    const cookie = cookieOf(res)

    expect(cookie).toContain(OAUTH_STATE_COOKIE)
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('samesite=lax')
    expect(cookie.toLowerCase()).not.toContain('samesite=strict')
  })

  test('the cookie Path is where the callback ACTUALLY is, apiPrefix included', async () => {
    // Found by running it: the path was built from the plugin's own prefix, so
    // an app with apiPrefix scoped the cookie to `/auth/...` while the callback
    // lived at `/api/auth/...`. The browser then never sends it, the state
    // check refuses, and it refuses exactly the way a real attack does.
    const res  = await request(app).get('/auth/oauth/google')
    const path = /Path=([^;]+)/.exec(cookieOf(res))?.[1]
    const uri  = new URL(String(res.headers['location'])).searchParams.get('redirect_uri')!

    expect(path).toBe(new URL(uri).pathname)
  })

  test('the cookie carries the same state the provider is given', async () => {
    const res      = await request(app).get('/auth/oauth/google')
    const urlState = new URL(String(res.headers['location'])).searchParams.get('state')
    expect(cookieOf(res)).toContain(`${OAUTH_STATE_COOKIE}=${urlState}`)
  })

  test('the redirect URI is the public origin, not the test host', async () => {
    // A provider matches it as an exact string, and the server cannot see its
    // own external address behind a proxy.
    const res = await request(app).get('/auth/oauth/google')
    const uri = new URL(String(res.headers['location'])).searchParams.get('redirect_uri')
    expect(uri).toBe(`${PUBLIC_URL}/auth/oauth/google/callback`)
  })

  test('an unknown provider redirects to the error page rather than 500ing', async () => {
    const res = await request(app).get('/auth/oauth/faceboook')
    expect(res.status).toBe(302)
    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=unavailable')
  })

  test('a `{provider}` route really is dynamic', async () => {
    // `:provider` would register as a literal segment and 404 forever, which is
    // the shape that is silent until somebody clicks the button.
    expect((await request(app).get('/auth/oauth/google')).status).toBe(302)
  })
})

// ─── coming back ────────────────────────────────────────────────────────────

describe('GET /auth/oauth/{provider}/callback', () => {

  test('a denial redirects with a code and never a JSON body', async () => {
    // The most common non-happy path there is: somebody clicks Deny.
    const res = await request(app).get('/auth/oauth/google/callback?error=access_denied')

    expect(res.status).toBe(302)
    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=denied')
    expect(String(res.headers['content-type'] ?? '')).not.toContain('json')
  })

  // A provider that would happily complete the flow, so the ONLY thing that can
  // refuse below is the cookie check. Without this the exchange died on a real
  // network call and the test passed for a reason it was not asserting — which
  // is exactly what it looks like when a security check has been removed.
  function stubProviderOk() {
    globalThis.fetch = (async (input: any) => {
      const body = String(input).includes('token')
        ? { access_token: 'at', expires_in: 3600 }
        : { sub: '1', email: 'ada@shop.test', email_verified: true, name: 'Ada' }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  async function startFlow() {
    const start = await request(app).get('/auth/oauth/google')
    const state = new URL(String(start.headers['location'])).searchParams.get('state')!
    return state
  }

  test('a callback with no cookie is refused — the login-CSRF case', async () => {
    const state = await startFlow()
    stubProviderOk()

    // No cookie header: this browser never started the flow. Everything else
    // about the request is valid, and the provider would answer.
    const res = await request(app).get(`/auth/oauth/google/callback?code=c&state=${state}`)

    expect(res.status).toBe(302)
    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=state')
  })

  test('the matching cookie signs the person in', async () => {
    // The other half of the case above: without this, removing the cookie
    // comparison entirely would leave every assertion in this file green.
    const state = await startFlow()
    stubProviderOk()

    const res = await request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)

    expect(res.status).toBe(302)
    expect(String(res.headers['location'])).toBe('/')
    // A browser navigation ends at a page, never at a JSON token.
    expect(String(res.headers['content-type'] ?? '')).not.toContain('json')
  })

  test('a returnTo that passed the allow-list at START is honored at the end', async () => {
    const start = await request(app).get('/auth/oauth/google?returnTo=/dashboard')
    const state = new URL(String(start.headers['location'])).searchParams.get('state')!
    stubProviderOk()

    const res = await request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)

    expect(String(res.headers['location'])).toBe('/dashboard')
  })

  test('a returnTo rejected at START lands at the default, not at the attacker', async () => {
    const start = await request(app).get('/auth/oauth/google?returnTo=//evil.test')
    const state = new URL(String(start.headers['location'])).searchParams.get('state')!
    stubProviderOk()

    const res = await request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)

    expect(String(res.headers['location'])).toBe('/')
  })

  test("another browser's cookie does not corroborate this state", async () => {
    const mine   = await startFlow()
    const theirs = await startFlow()
    stubProviderOk()

    const res = await request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${mine}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${theirs}`)

    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=state')
  })

  test('missing code or state is refused without reaching the provider', async () => {
    globalThis.fetch = (async () => { throw new Error('should not have been called') }) as unknown as typeof fetch
    const res = await request(app).get('/auth/oauth/google/callback?state=abc')
    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=state')
  })

  test('every refusal answers the SAME code', async () => {
    // Telling the browser whether a state existed, or whether an exchange
    // failed, is an oracle handed to whoever can reach the URL.
    const noFlow  = await request(app).get('/auth/oauth/google/callback?code=c&state=nonexistent')
    const noState = await request(app).get('/auth/oauth/google/callback?code=c')
    expect(String(noFlow.headers['location'])).toBe(String(noState.headers['location']))
  })

  test('the state cookie is cleared on the way through', async () => {
    const res = await request(app).get('/auth/oauth/google/callback?error=access_denied')
    const cookie = cookieOf(res)
    expect(cookie).toContain(OAUTH_STATE_COOKIE)
    expect(cookie).toMatch(/Max-Age=0|Expires=/i)
  })
})

// ─── what a sign-in screen can find out ─────────────────────────────────────
//
// The route exists because the alternative is a hardcoded list. A sign-in page
// is a separate build from the API, so the buttons it draws are a second copy
// of `oauthProviders` — and nothing fails when the two disagree: a provider
// dropped from the server leaves a button that redirects into
// `oauth_error=unavailable`, and one added appears nowhere at all.

describe('GET /auth/oauth', () => {

  test('names the configured providers', async () => {
    const res = await request(app).get('/auth/oauth')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ providers: ['google'] })
  })

  test('takes no session — the page that asks has none yet', async () => {
    // Sent with no Authorization header at all, which is the only state a
    // sign-in screen is ever in.
    const res = await request(app).get('/auth/oauth')
    expect(res.status).toBe(200)
  })

  // A 404 would be indistinguishable from a wrong prefix, so a client could
  // not tell "this app has no OAuth" from "I am asking the wrong URL" — and
  // every screen would have to treat a network-level failure as "none".
  test('an app with no oauth block answers an empty list, not 404', async () => {
    const bare = await makeAuth()
    try {
      const plain = await createTestApp({ auth: bare.auth as any })
      plain.setAuth(bare.auth as any)
      plain.configure(createAuthPlugin(bare.auth))

      const res = await request(plain).get('/auth/oauth')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ providers: [] })
    } finally { bare.cleanup() }
  })
})
