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
import { Database } from 'bun:sqlite'
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
  app = await createTestApp({ auth: h.auth as any, config: { publicUrl: PUBLIC_URL } as any })
  app.setAuth(h.auth as any)
  app.configure(auth({
    auth: h.auth,
    cookieAuth: true,
    oauth: {
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
      const broken = await createTestApp({ auth: bare.auth as any, config: { publicUrl: PUBLIC_URL } as any })
      broken.setAuth(bare.auth as any)
      broken.configure(auth({
        auth: bare.auth,
        oauth: { rateLimit: { max: 10_000, window: '15 minutes' } },
      }))
      // The start phases run lazily on the first request, not at
      // createTestApp — configure() may still be called after it returns.
      let err: unknown = null
      try { await request(broken).get('/auth/oauth/google') } catch (e) { err = e }
      expect(String(err)).toContain('cookieAuth')
    } finally { bare.cleanup() }
  })
})

describe('oauth without the API origin', () => {

  // A provider matches the redirect URI as an exact string, so a guessed
  // origin fails every sign-in, visible only on the provider's error page.
  test('is refused at boot, naming FRONTIER_API_URL', async () => {
    const bare = await makeAuth({ oauthProviders: { google: defineProvider({ name: 'google', preset: 'google', clientId: 'c', clientSecret: 's' }) } })
    try {
      const broken = await createTestApp({ auth: bare.auth as any })
      broken.setAuth(bare.auth as any)
      broken.configure(auth({ auth: bare.auth, cookieAuth: true, oauth: {} }))
      let err: unknown = null
      try { await request(broken).get('/auth/oauth/google') } catch (e) { err = e }
      expect(String(err)).toContain('FRONTIER_API_URL')
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

  // FJS-4643: a missing oauth_flow column answered `unavailable` and logged
  // nothing, so it read as an unconfigured provider.
  test('a database fault still redirects, and is logged where an unknown provider is not', async () => {
    const broken = await makeAuth({
      oauthProviders: { google: defineProvider({ name: 'google', preset: 'google', clientId: 'c', clientSecret: 's' }) },
    })
    const dbPath = process.env.MAIN_DB_PATH!
    const logged: unknown[][] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const faulty = await createTestApp({ auth: broken.auth as any, config: { publicUrl: PUBLIC_URL } as any })
      faulty.setAuth(broken.auth as any)
      faulty.configure(auth({ auth: broken.auth, cookieAuth: true, oauth: { errorRedirect: '/sign-in' } }))

      await request(faulty).get('/auth/oauth/faceboook')
      expect(logged).toEqual([])

      const raw = new Database(dbPath)
      raw.run('DROP TABLE oauth_flow')
      raw.close()
      const res = await request(faulty).get('/auth/oauth/google')
      expect(res.status).toBe(302)
      expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=unavailable')
      expect(logged.length).toBe(1)
      expect(String(logged[0][0])).toContain('google')
    } finally {
      console.error = realError
      broken.cleanup()
    }
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
    const user = await h.sys.user.create({ data: { email, isEmailVerified: false } })
    await h.sys.credential.create({ data: { userId: user.id, type: 'password', value: 'own-hash' } })
    const out = await h.auth.oauthResolve('google', { providerId: sub, email, isEmailVerified: true } as any)
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
    await h.sys.user.update({ where: { id: made.id }, data: { isEmailVerified: true } })
    const { secret } = await h.auth.setupTotp!(made.id)
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

// ─── the authorization-server document ──────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {

  test('states the document an MCP connector reads, field for field', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(String(res.headers?.['content-type'])).toContain('application/json')
    expect(res.body).toEqual({
      issuer:                                PUBLIC_URL,
      authorization_endpoint:                `${PUBLIC_URL}/auth/authorize`,
      token_endpoint:                        `${PUBLIC_URL}/auth/token`,
      response_types_supported:              ['code'],
      grant_types_supported:                 ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported:      ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    })
  })

  // RFC 8414 § 3.3: the issuer a client compares against must be the origin it
  // fetched from, and the protected-resource document names the same string.
  test('the issuer is the origin alone, with no path and no trailing slash', async () => {
    const { issuer } = (await request(app).get('/.well-known/oauth-authorization-server')).body as { issuer: string }
    expect(issuer).toBe(new URL(PUBLIC_URL).origin)
    expect(new URL(issuer).pathname).toBe('/')
    expect(issuer.endsWith('/')).toBe(false)
  })

  test('the endpoints sit under apiPrefix and auth\'s prefix, however apiPrefix is spelled', async () => {
    for (const apiPrefix of ['/api', 'api/']) {
      const h2 = await makeAuth()
      try {
        const pre: any = await createTestApp({ auth: h2.auth as any, config: { apiPrefix, publicUrl: PUBLIC_URL } as any })
        pre.setAuth(h2.auth as any)
        pre.configure(auth({ auth: h2.auth }))
        const res = await request(pre).get('/.well-known/oauth-authorization-server')
        const doc = res.body as Record<string, string>
        expect(res.status).toBe(200)
        expect(doc.issuer).toBe(PUBLIC_URL)
        expect(doc.authorization_endpoint).toBe(`${PUBLIC_URL}/api/auth/authorize`)
        expect(doc.token_endpoint).toBe(`${PUBLIC_URL}/api/auth/token`)
      } finally { h2.cleanup() }
    }
  })
})

// ─── A grant provider (FJS-D1313) ───────────────────────────────────────────
//
// Connects a tenant's third-party account to a row of the app's. The tokens go
// to the app's `onGrant` and nobody is signed in, so a provider declared with a
// business scope can never become a login.

describe('a grant provider', () => {
  let g: Harness
  let gapp: any
  const granted: any[] = []
  const CALLBACK = `${PUBLIC_URL}/auth/oauth/google-business/callback`

  beforeAll(async () => {
    g = await makeAuth({
      oauthProviders: {
        google: defineProvider({ name: 'google', preset: 'google', clientId: 'cid', clientSecret: 'sec' }),
        'google-business': defineProvider({
          name: 'google-business', preset: 'google', clientId: 'cid', clientSecret: 'sec',
          scope:   'openid email https://www.googleapis.com/auth/business.manage',
          purpose: 'grant',
          onGrant: (event) => { granted.push(event) },
        }),
      },
      oauthReturnToAllow: ['/settings/'],
    })
    gapp = await createTestApp({ auth: g.auth as any, config: { publicUrl: PUBLIC_URL } as any })
    gapp.setAuth(g.auth as any)
    gapp.configure(auth({ auth: g.auth, cookieAuth: true, oauth: { errorRedirect: '/sign-in', rateLimit: { max: 10_000, window: '15 minutes' } } }))
  })
  afterAll(() => g.cleanup())

  function stubProvider() {
    globalThis.fetch = (async (input: any) => {
      const body = String(input).includes('token')
        ? { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'business.manage' }
        : { sub: 'g-1', email: 'owner@agency.test', email_verified: true, name: 'Owner' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  }

  test('is not a sign-in provider', async () => {
    const res = await request(gapp).get('/auth/oauth')
    expect(res.body).toEqual({ providers: ['google'] })
    expect(g.auth.oauthProviderNames('grant')).toEqual(['google-business'])
  })

  test('the public begin route cannot start it', async () => {
    const res = await request(gapp).get('/auth/oauth/google-business')
    expect(res.status).toBe(302)
    expect(String(res.headers['location'])).toBe('/sign-in?oauth_error=unavailable')
  })

  test('a sign-in provider takes no grant target', async () => {
    await expect(g.auth.oauthBegin('google', { redirectUri: CALLBACK, grant: { model: 'Integration', id: 'i-1' } }))
      .rejects.toThrow(/takes no grant target/)
  })

  test("the callback lands the tokens at onGrant, on the row the service named, and signs nobody in", async () => {
    granted.length = 0
    const { state } = await g.auth.oauthBegin('google-business', {
      redirectUri: CALLBACK,
      returnTo:    '/settings/',
      grant:       { model: 'Integration', id: 'i-1' },
      initiator:   'u-1',
    })
    stubProvider()

    const res = await request(gapp)
      .get(`/auth/oauth/google-business/callback?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)

    expect(res.status).toBe(302)
    expect(String(res.headers['location'])).toBe('/settings/')
    expect(cookieOf(res)).not.toContain('session=')
    expect(granted).toHaveLength(1)
    expect(granted[0]).toMatchObject({
      provider:  'google-business',
      grant:     { model: 'Integration', id: 'i-1' },
      initiator: 'u-1',
      tokens:    { accessToken: 'at', refreshToken: 'rt' },
      identity:  { providerId: 'g-1' },
    })
    expect(await g.sys.credential.count({ where: { type: 'oauth:google-business' } })).toBe(0)
  })

  // A route that rebuilt the callback path by hand scoped the cookie somewhere
  // the browser never sends it once apiPrefix or the plugin's prefix moved,
  // and every connect then failed the state check the way an attack does.
  test('app.oauth.beginGrant starts it on the plugin\'s own callback, under a moved apiPrefix and prefix', async () => {
    granted.length = 0
    const papp: any = await createTestApp({ auth: g.auth as any, config: { publicUrl: PUBLIC_URL, apiPrefix: '/api' } as any })
    papp.setAuth(g.auth as any)
    papp.configure(auth({ auth: g.auth, prefix: '/id', cookieAuth: true, oauth: { errorRedirect: '/sign-in', rateLimit: { max: 10_000, window: '15 minutes' } } }))
    papp.get('/connect/{id}', async (ctx: any) => {
      const { authorizeUrl } = await papp.oauth.beginGrant(ctx, 'google-business', {
        grant:     { model: 'Integration', id: String(ctx.route.id) },
        initiator: 'u-1',
        returnTo:  '/settings/',
      })
      return ctx.redirect(authorizeUrl)
    })

    const begun = await request(papp).get('/api/connect/i-3')
    const uri   = new URL(new URL(String(begun.headers['location'])).searchParams.get('redirect_uri')!)
    const state = new URL(String(begun.headers['location'])).searchParams.get('state')
    expect(uri.href).toBe(`${PUBLIC_URL}/api/id/oauth/google-business/callback`)
    expect(/Path=([^;]+)/.exec(cookieOf(begun))?.[1]).toBe(uri.pathname)
    expect(cookieOf(begun)).toContain(`${OAUTH_STATE_COOKIE}=${state}`)

    stubProvider()
    const res = await request(papp)
      .get(`${uri.pathname}?code=c&state=${state}`)
      .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)
    expect(String(res.headers['location'])).toBe('/settings/')
    expect(granted).toHaveLength(1)
    expect(granted[0]).toMatchObject({ grant: { model: 'Integration', id: 'i-3' }, initiator: 'u-1' })
  })

  test('cannot be resolved into a sign-in', async () => {
    await expect(g.auth.oauthResolve('google-business', { providerId: 'g-1', email: 'owner@agency.test', isEmailVerified: true, name: null }))
      .rejects.toThrow(/signs nobody in/)
  })

  test('is refused at definition without onGrant, and onGrant without the purpose', () => {
    expect(() => defineProvider({ name: 'x', preset: 'google', clientId: 'c', clientSecret: 's', purpose: 'grant' })).toThrow(/needs onGrant/)
    expect(() => defineProvider({ name: 'x', preset: 'google', clientId: 'c', clientSecret: 's', onGrant: () => {} })).toThrow(/purpose: 'grant'/)
  })

  // FJS-4554: Jobber's API is GraphQL only and answers no userinfo URL, so the
  // grant lands with no identity rather than not at all.
  test('with no userinfo endpoint lands with identity null, and only a sign-in provider still needs one', async () => {
    const landed: any[] = []
    const jobber = defineProvider({
      name: 'jobber', preset: 'oidc', clientId: 'c', clientSecret: 's',
      authorizeUrl: 'https://api.getjobber.com/api/oauth/authorize',
      tokenUrl:     'https://api.getjobber.com/api/oauth/token',
      purpose:      'grant',
      onGrant:      (event) => { landed.push(event) },
    })
    expect(() => defineProvider({
      name: 'x', preset: 'oidc', clientId: 'c', clientSecret: 's',
      authorizeUrl: 'https://idp.test/authorize', tokenUrl: 'https://idp.test/token',
    })).toThrow(/needs userinfoUrl/)

    const j = await makeAuth({ oauthProviders: { jobber } })
    try {
      const japp = await createTestApp({ auth: j.auth as any, config: { publicUrl: PUBLIC_URL } as any })
      japp.setAuth(j.auth as any)
      japp.configure(auth({ auth: j.auth, cookieAuth: true, oauth: { errorRedirect: '/sign-in', rateLimit: { max: 10_000, window: '15 minutes' } } }))
      const { state } = await j.auth.oauthBegin('jobber', {
        redirectUri: `${PUBLIC_URL}/auth/oauth/jobber/callback`,
        grant:       { model: 'Integration', id: 'i-2' },
      })
      const fetched: string[] = []
      globalThis.fetch = (async (input: any) => {
        fetched.push(String(input))
        return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch

      const res = await request(japp)
        .get(`/auth/oauth/jobber/callback?code=c&state=${state}`)
        .set('cookie', `${OAUTH_STATE_COOKIE}=${state}`)

      expect(String(res.headers['location'])).not.toContain('oauth_error')
      expect(fetched).toEqual(['https://api.getjobber.com/api/oauth/token'])
      expect(landed).toHaveLength(1)
      expect(landed[0]).toMatchObject({ grant: { model: 'Integration', id: 'i-2' }, tokens: { accessToken: 'at' }, identity: null })
    } finally { j.cleanup() }
  })
})
