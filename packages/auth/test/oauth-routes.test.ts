// test/oauth-routes.test.ts
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
import { auth } from '../plugin.ts'
import { defineProvider, OAUTH_STATE_COOKIE } from '../oauth.ts'
import { makeAuth, type Harness } from './harness.ts'
import { totp, TOTP_STEP_SEC } from '../totp.ts'

const PUBLIC_URL = 'https://shop.test'

let h: Harness
let app: any

beforeAll(async () => {
  h = await makeAuth({
    oauthProviders: {
      google: defineProvider({ name: 'google', preset: 'google', clientId: 'cid', clientSecret: 'sec' }),
    },
    oauthReturnToAllow: ['/dashboard'],
  })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(auth({
    auth: h.auth,
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
    const bare = await makeAuth({ oauthProviders: { google: defineProvider({ name: 'google', preset: 'google', clientId: 'c', clientSecret: 's' }) } })
    try {
      const broken = await createTestApp({ auth: bare.auth as any })
      broken.setAuth(bare.auth as any)
      broken.configure(auth({
        auth: bare.auth,
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
    // The CSRF evidence: audit() only warns when the trail refuses, so a row the
    // trail cannot take is lost without failing the request (FJS-2996).
    const refused = await h.sys.auditTrail.findMany({ where: { operation: 'oauth.refused' } })
    expect(refused.some((r: any) => r.model === 'OauthFlow' && r.meta?.reason === 'state-mismatch')).toBe(true)
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

  // ── the mailed oauthLink invitation ──
  //
  // The link is `/auth/oauth/{provider}?link=`, so a click runs the provider
  // again and the callback attaches only the subject the invitation stored.

  function stubProviderAs(sub: string, email: string) {
    globalThis.fetch = (async (input: any) => {
      const body = String(input).includes('token')
        ? { access_token: 'at', expires_in: 3600 }
        : { sub, email, email_verified: true, name: 'L' }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  async function inviteFor(email: string, sub: string) {
    const user = await h.sys.user.create({ data: { email, emailVerified: false } })
    await h.sys.credential.create({ data: { userId: user.id, type: 'password', value: 'own-hash' } })
    const out = await h.auth.oauthResolve('google', { providerId: sub, email, emailVerified: true } as any)
    expect(out.outcome).toBe('proof-required')
    const row = await h.sys.verification.findFirst({ where: { purpose: 'oauthLink', identifier: email } })
    return { user, token: row.value as string }
  }

  async function finishLink(token: string, sub: string, email: string) {
    const start = await request(app).get(`/auth/oauth/google?link=${token}`)
    const state = new URL(String(start.headers['location'])).searchParams.get('state')!
    stubProviderAs(sub, email)
    return request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)
  }

  test('a link click that returns the invited subject attaches it and signs in', async () => {
    const email = 'route-link@shop.test'
    const { user, token } = await inviteFor(email, 'rl-1')

    const res = await finishLink(token, 'rl-1', email)

    expect(String(res.headers['location'])).toBe('/')
    expect(cookieOf(res)).toContain('session=')
    const creds = await h.sys.credential.findMany({ where: { userId: user.id } })
    expect(creds.some((c: any) => c.type === 'oauth:google' && c.value === 'rl-1')).toBe(true)
  })

  test("a link click that returns another subject attaches nothing and signs nobody in (FJS-1819)", async () => {
    const email = 'route-hijack@shop.test'
    const { user, token } = await inviteFor(email, 'attacker-sub')

    const res = await finishLink(token, 'holder-sub', email)

    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=state')
    expect(cookieOf(res)).not.toContain('session=')
    const creds = await h.sys.credential.findMany({ where: { userId: user.id } })
    expect(creds.some((c: any) => c.type === 'password')).toBe(true)
    expect(creds.some((c: any) => String(c.type).startsWith('oauth:'))).toBe(false)
  })

  // ── an account that owes a second factor (FJS-D915) ──
  //
  // A provider click is a first factor like a password. Paired with 'the
  // matching cookie signs the person in' above: the same callback, on an
  // account with no factor, ends at a session.

  async function userWithTotp(email: string) {
    const made = await h.auth.createUser({ email, password: 'correct-horse-1' })
    await h.sys.user.update({ where: { id: made.id }, data: { emailVerified: true } })
    const { secret } = await h.auth.setupTotp!(made.id, 'correct-horse-1')
    await h.auth.confirmTotp!(made.id, totp(secret, new Date()))
    return { userId: made.id, secret }
  }

  async function providerSignIn(sub: string, email: string) {
    const state = await startFlow()
    stubProviderAs(sub, email)
    return request(app)
      .get(`/auth/oauth/google/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)
  }

  const ticketOf = (res: any) => cookieOf(res).match(/login_challenge=([^;,\s]+)/)?.[1] ?? null

  test('a TOTP account answers a challenge and no session, on the link and on every sign-in after it', async () => {
    const email = 'route-totp@shop.test'
    await userWithTotp(email)

    // Branch 4: a verified account, linked on the first provider sign-in.
    const linked = await providerSignIn('totp-sub', email)
    const where  = new URL(String(linked.headers['location']), PUBLIC_URL)
    expect(where.pathname).toBe('/sign-in')
    expect(where.searchParams.get('oauth_error')).toBe('code_required')
    expect(Number.isNaN(Date.parse(String(where.searchParams.get('oauth_expires'))))).toBe(false)
    expect(cookieOf(linked)).not.toContain('session=')
    expect(ticketOf(linked)).toBeTruthy()

    // Branch 1: the same subject, seen before.
    const again = await providerSignIn('totp-sub', email)
    expect(new URL(String(again.headers['location']), PUBLIC_URL).searchParams.get('oauth_error')).toBe('code_required')
    expect(cookieOf(again)).not.toContain('session=')
  })

  test('the code finishes it through the route a password sign-in uses', async () => {
    const email = 'route-totp-finish@shop.test'
    const { secret } = await userWithTotp(email)

    const res    = await providerSignIn('totp-finish-sub', email)
    const ticket = ticketOf(res)
    expect(ticket).toBeTruthy()

    // One step ahead: the confirming code is spent (Credential.totpLastStep).
    const code = totp(secret, new Date(Date.now() + TOTP_STEP_SEC * 1000))
    const done = await request(app)
      .post('/auth/login/challenge')
      .set('cookie', `login_challenge=${ticket}`)
      .send({ code })

    expect(done.status).toBe(200)
    expect(cookieOf(done)).toContain('session=')
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
      plain.configure(auth({ auth: bare.auth }))

      const res = await request(plain).get('/auth/oauth')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ providers: [] })
    } finally { bare.cleanup() }
  })
})
