// tests/oauth.test.ts
//
// The flow engine. No server, no database, no session — this is the half of
// OAuth that is decidable offline, which is why it is a separate file from the
// routes that will consume it.
//
// The cases that matter are not the happy path. Three published failures shaped
// oauth.ts and each one is asserted here by its own mechanism rather than by
// the flow appearing to work: state binding (RFC 9700 — bound to the user
// agent), the identity key (nOAuth — the subject and never the address), and
// returnTo (an open redirector is how a code leaves the building).
//
// Network is stubbed by replacing globalThis.fetch. Nothing here reaches out.

import { describe, test, expect, afterEach } from 'bun:test'
import {
  defineProvider, beginFlow, exchangeCode, fetchIdentity,
  challengeFor, generateVerifier, stateMatches, isAllowedReturnTo,
  OAuthError, PROVIDER_PRESETS, OAUTH_STATE_COOKIE,
} from '../oauth.ts'

const CREDS = { clientId: 'cid', clientSecret: 'secret' }
const REDIRECT = 'https://shop.test/auth/oauth/google/callback'

const google = () => defineProvider('google', 'google', CREDS)
const github = () => defineProvider('github', 'github', CREDS)

// ─── fetch stubbing ─────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** routes: url substring → { status?, body }. An unmatched URL fails the test. */
function stubFetch(routes: Array<[string, { status?: number; body: unknown }]>) {
  const seen: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    seen.push(url)
    const hit = routes.find(([frag]) => url.includes(frag))
    if (!hit) throw new Error(`unstubbed fetch: ${url}`)
    const [, { status = 200, body }] = hit
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return seen
}

// ─── defineProvider ─────────────────────────────────────────────────────────

describe('defineProvider', () => {

  test('a preset supplies the endpoints and the app supplies the credentials', () => {
    const p = google()
    expect(p.authorizeUrl).toContain('accounts.google.com')
    expect(p.clientId).toBe('cid')
    expect(p.scope).toBe('openid email profile')
  })

  test('the generic OIDC preset does NOT trust the email claim', () => {
    // nOAuth: the issuer is whatever the app pointed this at, and an attacker
    // who can stand one up can assert any address. Google's is a statement
    // about Google; there is no equivalent statement to make about `oidc`.
    const p = defineProvider('okta', 'oidc', {
      ...CREDS,
      authorizeUrl: 'https://x.test/authorize',
      tokenUrl:     'https://x.test/token',
      userinfoUrl:  'https://x.test/userinfo',
    })
    expect(p.trustEmail).toBe(false)
    expect(google().trustEmail).toBe(true)
  })

  test('one preset can be configured twice under two names', () => {
    const a = defineProvider('entra-prod',    'oidc', { ...CREDS, authorizeUrl: 'https://a/a', tokenUrl: 'https://a/t', userinfoUrl: 'https://a/u' })
    const b = defineProvider('entra-staging', 'oidc', { ...CREDS, authorizeUrl: 'https://b/a', tokenUrl: 'https://b/t', userinfoUrl: 'https://b/u' })
    expect(a.name).not.toBe(b.name)
    expect(a.authorizeUrl).not.toBe(b.authorizeUrl)
  })

  test('an oidc provider missing an endpoint is refused at definition, not at click time', () => {
    expect(() => defineProvider('okta', 'oidc', CREDS)).toThrow(OAuthError)
  })

  test('an unknown preset names the ones that exist', () => {
    try {
      defineProvider('x', 'faceboook', CREDS)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError)
      for (const name of PROVIDER_PRESETS) expect((err as Error).message).toContain(name)
    }
  })

  test('credentials are required', () => {
    expect(() => defineProvider('google', 'google', { clientId: 'a', clientSecret: '' })).toThrow(OAuthError)
  })
})

// ─── beginFlow ──────────────────────────────────────────────────────────────

describe('beginFlow', () => {

  test('carries PKCE S256, and the challenge is the hash of the verifier', () => {
    const { authorizeUrl, verifier } = beginFlow(google(), REDIRECT)
    const q = new URL(authorizeUrl).searchParams

    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toBe(challengeFor(verifier))
    // The verifier itself must never be in the URL — that is `plain` wearing
    // S256's name, and it is the whole of what PKCE prevents.
    expect(authorizeUrl).not.toContain(verifier)
  })

  test('the redirect URI is passed through untouched', () => {
    // Providers match it as an exact string, so anything that rebuilds or
    // normalises it produces a mismatch nobody can debug from the error.
    const { authorizeUrl } = beginFlow(google(), REDIRECT)
    expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(REDIRECT)
  })

  test('two flows share nothing', () => {
    const a = beginFlow(google(), REDIRECT)
    const b = beginFlow(google(), REDIRECT)
    expect(a.state).not.toBe(b.state)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.state.length).toBeGreaterThan(20)
  })

  test('response_type is code — never token', () => {
    // The implicit flow is removed in OAuth 2.1. A token in the fragment is a
    // credential in browser history.
    expect(new URL(beginFlow(google(), REDIRECT).authorizeUrl).searchParams.get('response_type')).toBe('code')
  })
})

// ─── the browser binding ────────────────────────────────────────────────────

describe('state binding', () => {

  test('the cookie is named, so both halves of the flow can agree on it', () => {
    expect(OAUTH_STATE_COOKIE).toBeTruthy()
  })

  test('a state matches only itself', () => {
    const { state } = beginFlow(google(), REDIRECT)
    expect(stateMatches(state, state)).toBe(true)
    expect(stateMatches(state, beginFlow(google(), REDIRECT).state)).toBe(false)
  })

  test('a missing half never matches — which is the login-CSRF case', () => {
    // The attack is a callback URL handed to somebody who never started a flow:
    // their browser carries no cookie, so there is nothing to compare and the
    // answer must be no. `undefined === undefined` would have said yes.
    const { state } = beginFlow(google(), REDIRECT)
    expect(stateMatches(null, state)).toBe(false)
    expect(stateMatches(state, null)).toBe(false)
    expect(stateMatches(null, null)).toBe(false)
    expect(stateMatches(undefined, undefined)).toBe(false)
    expect(stateMatches('', '')).toBe(false)
  })

  test('a length mismatch answers false rather than throwing', () => {
    // timingSafeEqual throws on unequal lengths, and an exception escaping the
    // comparison is a 500 where a refusal was meant.
    expect(stateMatches('short', 'much longer value')).toBe(false)
  })
})

// ─── returnTo ───────────────────────────────────────────────────────────────

describe('isAllowedReturnTo', () => {
  const allow = ['/dashboard', '/orders/']

  test('an exact entry passes and a prefix entry covers what is under it', () => {
    expect(isAllowedReturnTo('/dashboard', allow)).toBe(true)
    expect(isAllowedReturnTo('/orders/42', allow)).toBe(true)
  })

  test('anything absolute is refused', () => {
    expect(isAllowedReturnTo('https://evil.test', allow)).toBe(false)
    expect(isAllowedReturnTo('http://evil.test/dashboard', allow)).toBe(false)
  })

  test('the two shapes that read as a path and parse as an authority', () => {
    // `//evil.test` is protocol-relative and `/\evil.test` is treated as the
    // same by browsers. Both start with '/' and neither is a local path.
    expect(isAllowedReturnTo('//evil.test', allow)).toBe(false)
    expect(isAllowedReturnTo('/\\evil.test', allow)).toBe(false)
    expect(isAllowedReturnTo('//evil.test/dashboard', allow)).toBe(false)
  })

  test('a path not on the list is refused, and absent is refused', () => {
    expect(isAllowedReturnTo('/admin', allow)).toBe(false)
    expect(isAllowedReturnTo(null, allow)).toBe(false)
    expect(isAllowedReturnTo('/dashboard', [])).toBe(false)
  })

  test('a prefix entry does not leak past its own segment boundary', () => {
    // '/orders/' must not admit '/orders-secret' — the trailing slash is the
    // boundary and matching on '/orders' would lose it.
    expect(isAllowedReturnTo('/orders-secret', allow)).toBe(false)
  })
})

// ─── exchangeCode ───────────────────────────────────────────────────────────

describe('exchangeCode', () => {

  test('posts the verifier and the credentials, form-encoded', async () => {
    let body = ''
    globalThis.fetch = (async (_u: any, init: any) => {
      body = String(init.body)
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const tokens = await exchangeCode(google(), { code: 'c', verifier: 'v', redirectUri: REDIRECT })

    expect(body).toContain('code_verifier=v')
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('client_secret=secret')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
  })

  test('a 200 carrying an error is a failure — GitHub answers that way', async () => {
    stubFetch([['github.com/login/oauth/access_token', { body: { error: 'bad_verification_code' } }]])
    await expect(exchangeCode(github(), { code: 'c', verifier: 'v', redirectUri: REDIRECT }))
      .rejects.toThrow(OAuthError)
  })

  test('a 200 with no access token is a failure', async () => {
    stubFetch([['oauth2.googleapis.com/token', { body: { token_type: 'Bearer' } }]])
    await expect(exchangeCode(google(), { code: 'c', verifier: 'v', redirectUri: REDIRECT }))
      .rejects.toThrow(OAuthError)
  })

  test("the provider's own error text does not reach ours", async () => {
    // Attacker-influenced text headed for a screen.
    stubFetch([['token', { status: 400, body: { error: 'x', error_description: '<script>pwn</script>' } }]])
    try {
      await exchangeCode(google(), { code: 'c', verifier: 'v', redirectUri: REDIRECT })
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain('pwn')
    }
  })
})

// ─── fetchIdentity ──────────────────────────────────────────────────────────

const TOKENS = { accessToken: 'at', refreshToken: null, expiresIn: null, scope: null }

describe('fetchIdentity', () => {

  test('google: the subject is the id and the address is not', async () => {
    stubFetch([['openidconnect.googleapis.com', { body: {
      sub: '10992', email: 'ada@shop.test', email_verified: true, name: 'Ada',
    } }]])
    const id = await fetchIdentity(google(), TOKENS)
    expect(id.providerId).toBe('10992')
    expect(id.email).toBe('ada@shop.test')
    expect(id.emailVerified).toBe(true)
  })

  test("email_verified as the string 'false' does not become true", async () => {
    // Boolean('false') is true. Some OIDC implementations send strings, so a
    // coercion here turns every unverified address into a verified one — which
    // is the exact claim the linking rule is about to depend on.
    stubFetch([['openidconnect.googleapis.com', { body: {
      sub: '1', email: 'x@y.z', email_verified: 'false',
    } }]])
    expect((await fetchIdentity(google(), TOKENS)).emailVerified).toBe(false)
  })

  test("email_verified as the string 'true' is honored", async () => {
    stubFetch([['openidconnect.googleapis.com', { body: { sub: '1', email: 'x@y.z', email_verified: 'true' } }]])
    expect((await fetchIdentity(google(), TOKENS)).emailVerified).toBe(true)
  })

  test('an absent claim is not verified', async () => {
    stubFetch([['openidconnect.googleapis.com', { body: { sub: '1', email: 'x@y.z' } }]])
    expect((await fetchIdentity(google(), TOKENS)).emailVerified).toBe(false)
  })

  test('a provider answering no subject is refused', async () => {
    // There is nothing left to key a credential on, and the readable
    // alternative is the address — which is the mistake nOAuth is.
    stubFetch([['openidconnect.googleapis.com', { body: { email: 'x@y.z', email_verified: true } }]])
    await expect(fetchIdentity(google(), TOKENS)).rejects.toThrow(OAuthError)
  })

  test('github: the address comes from /user/emails, primary AND verified', async () => {
    const seen = stubFetch([
      ['api.github.com/user/emails', { body: [
        { email: 'other@x.test',  primary: false, verified: true  },
        { email: 'ada@shop.test', primary: true,  verified: true  },
      ] }],
      ['api.github.com/user', { body: { id: 42, login: 'ada', name: 'Ada', email: 'public@x.test' } }],
    ])

    const id = await fetchIdentity(github(), TOKENS)

    expect(seen.some(u => u.includes('/user/emails'))).toBe(true)
    expect(id.providerId).toBe('42')
    // NOT the profile email, which carries no verification state at all.
    expect(id.email).toBe('ada@shop.test')
    expect(id.emailVerified).toBe(true)
  })

  test('github: a primary address that is not verified is not taken', async () => {
    stubFetch([
      ['api.github.com/user/emails', { body: [{ email: 'ada@shop.test', primary: true, verified: false }] }],
      ['api.github.com/user', { body: { id: 42, login: 'ada' } }],
    ])
    const id = await fetchIdentity(github(), TOKENS)
    expect(id.email).toBeNull()
    expect(id.emailVerified).toBe(false)
  })

  test('github: the sign-in still succeeds when the emails call fails', async () => {
    // No address means the linking rule cannot match anybody, which is a
    // refusal further down — but it must not be a 500 here.
    stubFetch([
      ['api.github.com/user/emails', { status: 403, body: {} }],
      ['api.github.com/user', { body: { id: 42, login: 'ada' } }],
    ])
    const id = await fetchIdentity(github(), TOKENS)
    expect(id.providerId).toBe('42')
    expect(id.email).toBeNull()
  })

  test('a userinfo call that fails is an OAuthError, not a raw fetch throw', async () => {
    stubFetch([['openidconnect.googleapis.com', { status: 401, body: {} }]])
    await expect(fetchIdentity(google(), TOKENS)).rejects.toThrow(OAuthError)
  })
})

// ─── PKCE helpers ───────────────────────────────────────────────────────────

describe('PKCE', () => {

  test('the challenge is base64url with no padding', () => {
    // A '+', '/' or '=' in the challenge is rejected by the provider, and the
    // error says nothing useful about why.
    expect(challengeFor('abc')).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  test('verifiers do not repeat and are long enough to be one', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateVerifier()))
    expect(seen.size).toBe(50)
    // RFC 7636 puts the floor at 43 characters.
    expect(generateVerifier().length).toBeGreaterThanOrEqual(43)
  })
})

// ─── provider-specific authorize params ─────────────────────────────────────

describe('beginFlow extra params', () => {

  test('a caller can add what a provider needs and sign-in needs none', () => {
    // Google returns a refresh token only on FIRST consent unless asked this
    // way — a second sign-in silently yields none. Observed in production code
    // (CLIENTS/elitelawncare), not inferred.
    const plain = beginFlow(google(), REDIRECT)
    expect(new URL(plain.authorizeUrl).searchParams.get('access_type')).toBeNull()

    const offline = beginFlow(google(), REDIRECT, { access_type: 'offline', prompt: 'consent' })
    const q = new URL(offline.authorizeUrl).searchParams
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('consent')
  })

  test('extra cannot disarm the flow', () => {
    // A `state` or `code_challenge` arriving from configuration is the flow
    // being switched off by the thing that configures it.
    const { authorizeUrl, state, verifier } = beginFlow(google(), REDIRECT, {
      state:                 'attacker-chosen',
      code_challenge:        'nope',
      code_challenge_method: 'plain',
      response_type:         'token',
    })
    const q = new URL(authorizeUrl).searchParams
    expect(q.get('state')).toBe(state)
    expect(q.get('state')).not.toBe('attacker-chosen')
    expect(q.get('code_challenge')).toBe(challengeFor(verifier))
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('response_type')).toBe('code')
  })
})
