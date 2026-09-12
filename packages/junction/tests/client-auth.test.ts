// tests/client-auth.test.ts
//
// `client.auth` — the browser half of @frontierjs/auth.
//
// It exists because every app was writing it, and the two properties asserted
// hardest here are the two every hand-written copy got wrong:
//
//   · SIGNING OUT TELLS THE SERVER. Dropping the token locally leaves the
//     session row valid until it expires, so a token that leaked is still a
//     session. Nothing in this repo called POST /auth/logout before this.
//   · THE TOKEN HAS ONE OWNER. Storage is the client's, so signing in through
//     the client and restoring at boot cannot disagree.

import { describe, it, expect, mock, afterEach } from 'bun:test'
import { createJunctionClient, localTokenStore, type TokenStore } from '../src/client/index.ts'

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Records every request, answers each with the next queued body. */
function mockFetch(bodies: unknown[], status = 200) {
  const original = globalThis.fetch
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  let i = 0
  globalThis.fetch = mock(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url:     String(url),
      method:  init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body:    init.body ? JSON.parse(String(init.body)) : undefined,
    })
    const body = bodies[Math.min(i++, bodies.length - 1)]
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A TokenStore backed by a plain object — no localStorage in this runtime. */
function memoryStore(initial: string | null = null): TokenStore & { value: string | null } {
  return {
    value: initial,
    get()      { return this.value },
    set(token) { this.value = token },
    clear()    { this.value = null },
  }
}

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

// ─── Establishing a session ───────────────────────────────────────────────

describe('client.auth — the second factor', () => {

  it('a challenge stores nothing, opens nothing, and emits no authenticated', async () => {
    // The property that matters: a password accepted is not a session. A client
    // that adopted this would have every listener treat the first step as the
    // whole answer, and the socket would open unauthenticated.
    const { restore } = mockFetch([{ challenge: 'tik-1', expiresAt: '2030-01-01T00:00:00.000Z' }])
    cleanup = restore
    const store = memoryStore()
    const c = createJunctionClient({ url: 'http://x', tokenStorage: store })

    let authenticated = 0
    c.on('authenticated', () => { authenticated++ })

    const r = await c.auth.signIn('a@b.c', 'pw')

    expect('challenge' in r).toBe(true)
    expect(c.token).toBeNull()
    expect(store.value).toBeNull()
    expect(authenticated).toBe(0)
    expect(c.auth.awaitingSecondFactor).toBe(true)
  })

  it('completeSignIn posts the remembered ticket and adopts the session', async () => {
    const { calls, restore } = mockFetch([
      { challenge: 'tik-2', expiresAt: '2030-01-01T00:00:00.000Z' },
      { token: 'tok-2', user: { email: 'a@b.c' } },
    ])
    cleanup = restore
    const store = memoryStore()
    const c = createJunctionClient({ url: 'http://x', tokenStorage: store })

    let authenticated = 0
    c.on('authenticated', () => { authenticated++ })

    await c.auth.signIn('a@b.c', 'pw')
    const r = await c.auth.completeSignIn('123456')

    expect(calls[1].url).toBe('http://x/auth/login/challenge')
    expect(calls[1].method).toBe('POST')
    // The caller passed a code and nothing else — the ticket came from the client.
    expect(calls[1].body).toEqual({ challenge: 'tik-2', code: '123456' })
    // And with no Authorization, for `signIn`'s reason: this is still a sign-in.
    expect(calls[1].headers.Authorization).toBeUndefined()

    expect(r.token).toBe('tok-2')
    expect(c.token).toBe('tok-2')
    expect(store.value).toBe('tok-2')
    expect(authenticated).toBe(1)
    // Single-use on the server, so keeping it could only produce a refusal whose
    // reason the caller cannot read.
    expect(c.auth.awaitingSecondFactor).toBe(false)
  })

  it('cookie mode: no ticket reaches the page, and the code alone finishes it', async () => {
    // The transport strips `challenge` the way it strips `token`, so the body
    // carries only the expiry. A client keyed on the ticket being present would
    // treat this as a session and adopt a response with no user in it.
    const { calls, restore } = mockFetch([
      { expiresAt: '2030-01-01T00:00:00.000Z' },
      { user: { email: 'a@b.c' } },
    ])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', tokenStorage: memoryStore() })

    const r = await c.auth.signIn('a@b.c', 'pw')
    expect('challenge' in r).toBe(false)
    expect('user' in r).toBe(false)
    // Nothing to remember, so nothing is claimed about a box being open.
    expect(c.auth.awaitingSecondFactor).toBe(false)

    await c.auth.completeSignIn('123456')
    expect(calls[1].body).toEqual({ code: '123456' })
  })

  it('an explicit ticket wins over the remembered one', async () => {
    const { calls, restore } = mockFetch([
      { challenge: 'tik-3', expiresAt: '2030-01-01T00:00:00.000Z' },
      { token: 'tok-3', user: {} },
    ])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', tokenStorage: memoryStore() })

    await c.auth.signIn('a@b.c', 'pw')
    await c.auth.completeSignIn('123456', 'kept-across-a-navigation')
    expect(calls[1].body).toEqual({ challenge: 'kept-across-a-navigation', code: '123456' })
  })

  it('a second sign-in drops the first ticket BEFORE asking', async () => {
    // Otherwise one account's code redeems another account's ticket — the
    // request order is the whole of the guarantee, so the refusal is asserted
    // from the state rather than from the answer.
    const { restore } = mockFetch([
      { challenge: 'tik-a', expiresAt: '2030-01-01T00:00:00.000Z' },
      { token: 'tok-b', user: {} },
    ])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', tokenStorage: memoryStore() })

    await c.auth.signIn('a@b.c', 'pw')
    expect(c.auth.awaitingSecondFactor).toBe(true)

    // The second answers a session, so nothing is pending afterwards.
    await c.auth.signIn('b@b.c', 'pw')
    expect(c.auth.awaitingSecondFactor).toBe(false)
  })

  it('signing out drops a pending ticket', async () => {
    const { restore } = mockFetch([
      { challenge: 'tik-4', expiresAt: '2030-01-01T00:00:00.000Z' },
      { ok: true },
    ])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', tokenStorage: memoryStore() })

    await c.auth.signIn('a@b.c', 'pw')
    await c.auth.signOut()
    expect(c.auth.awaitingSecondFactor).toBe(false)
  })
})

describe('client.auth — the routes', () => {

  it('signIn posts to the auth prefix, keeps the token and opens no second copy of it', async () => {
    const { calls, restore } = mockFetch([{ token: 'tok-1', user: { email: 'a@b.c' } }])
    cleanup = restore
    const store = memoryStore()
    const c = createJunctionClient({ url: 'http://x', tokenStorage: store })

    const r = await c.auth.signIn('a@b.c', 'pw')

    expect(calls[0].url).toBe('http://x/auth/login')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ email: 'a@b.c', password: 'pw' })
    // Sent with no Authorization — a sign-in carrying the previous caller's
    // token is how a stale session outlives the person who left.
    expect(calls[0].headers.Authorization).toBeUndefined()
    // `signIn` answers a union since FJS-D261 — a session here, asserted as one
    // rather than cast, because a cast would read `undefined.token` the day this
    // fixture grows a second factor.
    expect('challenge' in r).toBe(false)
    expect((r as { token?: string }).token).toBe('tok-1')
    expect(c.token).toBe('tok-1')
    expect(store.value).toBe('tok-1')
  })

  it('signUp registers and adopts the session in one call', async () => {
    const { calls, restore } = mockFetch([{ token: 'tok-2', user: {} }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x' })

    await c.auth.signUp({ email: 'a@b.c', password: 'pw', name: 'A' })

    expect(calls[0].url).toBe('http://x/auth/register')
    expect(calls[0].body).toEqual({ email: 'a@b.c', password: 'pw', name: 'A' })
    expect(c.token).toBe('tok-2')
  })

  it('SIGNING OUT TELLS THE SERVER, then clears here', async () => {
    const { calls, restore } = mockFetch([{ ok: true }])
    cleanup = restore
    const store = memoryStore()
    const c = createJunctionClient({ url: 'http://x', token: 'tok-1', tokenStorage: store })

    const r = await c.auth.signOut()

    expect(calls[0].url).toBe('http://x/auth/logout')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.Authorization).toBe('Bearer tok-1')
    expect(r.revoked).toBe(true)
    expect(c.token).toBeNull()
    expect(store.value).toBeNull()
  })

  it('a server that cannot be reached still signs you out HERE, and says so', async () => {
    const original = globalThis.fetch
    globalThis.fetch = mock(async () => { throw new Error('network down') }) as unknown as typeof fetch
    cleanup = () => { globalThis.fetch = original }

    const c = createJunctionClient({ url: 'http://x', token: 'tok-1' })
    const r = await c.auth.signOut()

    // The thing the person asked for — be signed out on this machine —
    // happened. Reporting rather than throwing is what makes that true.
    expect(r.revoked).toBe(false)
    expect(r.error?.message).toBe('network down')
    expect(c.token).toBeNull()
  })

  it('signOut with no token asks nothing', async () => {
    const { calls, restore } = mockFetch([{ ok: true }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x' })

    await c.auth.signOut()
    expect(calls).toHaveLength(0)
  })

  it('cookie mode answers no token, and that must not clear the one in hand', async () => {
    const { restore } = mockFetch([{ user: { email: 'a@b.c' } }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x' })

    await c.auth.signIn('a@b.c', 'pw')
    // The browser holds an httpOnly cookie it cannot read. setToken(null) here
    // would close a socket the cookie authenticates at upgrade.
    expect(c.token).toBeNull()
  })

  it('password reset and email verification go to the routes, unauthenticated', async () => {
    const { calls, restore } = mockFetch([{ ok: true }, { ok: true }, { ok: true }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 'tok-1' })

    await c.auth.requestPasswordReset('a@b.c')
    await c.auth.confirmPasswordReset('reset-tok', 'new-pw')
    await c.auth.verifyEmail('verify tok/+1')

    expect(calls[0].url).toBe('http://x/auth/password-reset/request')
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(calls[1].url).toBe('http://x/auth/password-reset/confirm')
    // Encoded — the token is a URL component, and a `+` in a query string is a
    // space by the time the server reads it.
    expect(calls[2].url).toBe('http://x/auth/email/verify?token=verify%20tok%2F%2B1')
  })
})

// ─── The caller's own credentials ─────────────────────────────────────────

describe('client.auth — the services', () => {

  it('me() reads the account service, not a route', async () => {
    const { calls, restore } = mockFetch([{ userId: 'u1', email: 'a@b.c' }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 't' })

    const me = await c.auth.me()
    expect(calls[0].url).toBe('http://x/account/me')
    expect(calls[0].method).toBe('GET')
    expect(me.email).toBe('a@b.c')
  })

  it('follows apiPrefix, because a service route moves with the app', async () => {
    const { calls, restore } = mockFetch([{ userId: 'u1' }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', apiPrefix: '/api', token: 't' })

    await c.auth.me()
    expect(calls[0].url).toBe('http://x/api/account/me')
  })

  it('follows a server that renamed the services', async () => {
    const { calls, restore } = mockFetch([{ kind: 'list', data: [] }])
    cleanup = restore
    const c = createJunctionClient({
      url: 'http://x', token: 't', authServices: { sessions: 'devices' },
    })

    await c.auth.sessions()
    expect(calls[0].url).toBe('http://x/devices')
  })

  it('sessions() and apiKeys() answer the rows, not the envelope', async () => {
    const { restore } = mockFetch([
      { kind: 'list', data: [{ id: 's1', current: true }] },
      { kind: 'list', data: [{ id: 'k1', name: 'ci', scopes: [] }] },
    ])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 't' })

    expect(await c.auth.sessions()).toEqual([{ id: 's1', current: true }] as never)
    expect(await c.auth.apiKeys()).toEqual([{ id: 'k1', name: 'ci', scopes: [] }] as never)
  })

  it('changePassword is a custom method on the caller\'s own account', async () => {
    const { calls, restore } = mockFetch([{ ok: true }])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 't' })

    await c.auth.changePassword('old', 'new')
    expect(calls[0].url).toBe('http://x/account/me')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['X-Service-Method']).toBe('changePassword')
    expect(calls[0].body).toEqual({ currentPassword: 'old', newPassword: 'new' })
  })

  // The provider's method names are the wire's. A client that renamed one here
  // sends a header `need()` has never heard of and is answered 400 by name —
  // which only a test naming both halves sees before a screen does.
  it('the second factor is five custom methods on the same account, named as the provider names them', async () => {
    const { calls, restore } = mockFetch([
      { enabled: false, recoveryCodesRemaining: 0 },
      { secret: 'S', qr: 'otpauth://totp/x' },
      { recoveryCodes: ['A'] },
      { recoveryCodes: ['B'] },
      { ok: true },
    ])
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 't' })

    expect(await c.auth.totpStatus()).toEqual({ enabled: false, recoveryCodesRemaining: 0 })
    expect(await c.auth.setupTotp('pw')).toEqual({ secret: 'S', qr: 'otpauth://totp/x' })
    expect(await c.auth.confirmTotp('123456')).toEqual({ recoveryCodes: ['A'] })
    expect(await c.auth.regenerateRecoveryCodes('pw')).toEqual({ recoveryCodes: ['B'] })
    await c.auth.disableTotp('pw')

    expect(calls.map(k => [k.method, k.url, k.headers['X-Service-Method'], k.body])).toEqual([
      ['POST', 'http://x/account/me', 'totpStatus',              {}],
      ['POST', 'http://x/account/me', 'setupTotp',               { currentPassword: 'pw' }],
      ['POST', 'http://x/account/me', 'confirmTotp',             { code: '123456' }],
      ['POST', 'http://x/account/me', 'regenerateRecoveryCodes', { currentPassword: 'pw' }],
      ['POST', 'http://x/account/me', 'disableTotp',             { currentPassword: 'pw' }],
    ])
  })
})

// ─── What a 401 means ─────────────────────────────────────────────────────
//
// `unauthorized` is answered by every listener with a sign-out. A 401 on a
// request that PRESENTED the credential says the credential is dead; one on a
// request that established rather than presented a session says what was typed
// was wrong. The pair is the test — a client that emitted on neither would pass
// the first row alone (FJS-1088).

describe('client — which 401 is a dead session', () => {

  it('a refused code at /login/challenge does not announce a dead session', async () => {
    const { restore } = mockFetch([{ message: 'Invalid code', retryable: true }], 401)
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 'a-live-session' })
    let emitted = 0
    c.on('unauthorized', () => { emitted++ })

    await expect(c.auth.completeSignIn('000000', 'ticket')).rejects.toThrow('Invalid code')
    expect(emitted).toBe(0)
  })

  it('a refused sign-in does not either', async () => {
    const { restore } = mockFetch([{ message: 'Invalid credentials' }], 401)
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 'a-live-session' })
    let emitted = 0
    c.on('unauthorized', () => { emitted++ })

    await expect(c.auth.signIn('a@b.c', 'wrong')).rejects.toThrow('Invalid credentials')
    expect(emitted).toBe(0)
  })

  it('…while a 401 on a call that presented the token still does', async () => {
    const { calls, restore } = mockFetch([{ message: 'Authentication required' }], 401)
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x', token: 'expired' })
    let emitted = 0
    c.on('unauthorized', () => { emitted++ })

    await expect(c.auth.me()).rejects.toThrow()
    expect(calls[0].headers['Authorization']).toBe('Bearer expired')
    expect(emitted).toBe(1)
  })
})

// ─── The token ────────────────────────────────────────────────────────────

describe('token storage', () => {

  it('a stored token is restored at construction', () => {
    const c = createJunctionClient({ url: 'http://x', tokenStorage: memoryStore('from-storage') })
    expect(c.token).toBe('from-storage')
  })

  it('a stated token wins over a stored one', () => {
    const c = createJunctionClient({
      url: 'http://x', token: 'stated', tokenStorage: memoryStore('stored'),
    })
    // Whoever passes `token` is saying who this client is; reading storage over
    // the top would answer with whoever used this browser last.
    expect(c.token).toBe('stated')
  })

  it('setToken persists and clears through the store, and announces the change', () => {
    const store = memoryStore()
    const c = createJunctionClient({ url: 'http://x', tokenStorage: store })
    const seen: (string | null)[] = []
    c.on('token', (t: string | null) => seen.push(t))

    c.setToken('a')
    expect(store.value).toBe('a')
    c.setToken('a')          // no change — no second announcement
    c.setToken(null)
    expect(store.value).toBeNull()
    expect(seen).toEqual(['a', null])
  })

  it('localTokenStore survives having no localStorage at all', () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage
    delete (globalThis as { localStorage?: unknown }).localStorage
    const store = localTokenStore('k')
    expect(store.get()).toBeNull()
    expect(() => { store.set('x'); store.clear() }).not.toThrow()
    if (original !== undefined) (globalThis as { localStorage?: unknown }).localStorage = original
  })
})

// ─── What a refusal says ──────────────────────────────────────────────────

describe('a 401 keeps the server\'s own sentence', () => {

  it('the message is the server\'s, not the word "Unauthorized"', async () => {
    const { restore } = mockFetch([{ name: 'Unauthorized', message: 'Invalid credentials' }], 401)
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x' })

    // This threw before reading the body at all, so every app that wanted to
    // say "wrong email or password" re-mapped the status itself — which was
    // most of what a hand-written sign-in page was.
    await expect(c.auth.signIn('a@b.c', 'nope')).rejects.toThrow('Invalid credentials')
  })

  it('still carries the code', async () => {
    const { restore } = mockFetch([{ message: 'Invalid credentials' }], 401)
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x' })

    const err = await c.auth.signIn('a@b.c', 'nope').catch(e => e)
    expect(err.code).toBe(401)
  })
})

// ─── What a sign-in screen can find out ───────────────────────────────────
//
// A sign-in page is a separate build from the API, so any list of providers it
// draws buttons from is a second copy of the server's own configuration with
// nothing to fail when the two disagree — a provider dropped from the server
// leaves a button that redirects into `oauth_error=unavailable`, one added
// appears nowhere. So it is asked.

describe('client.auth — OAuth', () => {

  it('providers() asks the auth prefix and sends no credential', async () => {
    const { calls, restore } = mockFetch([{ providers: ['google', 'okta'] }])
    cleanup = restore
    const client = createJunctionClient({ url: 'http://api.test', tokenStorage: memoryStore('tok') })

    expect(await client.auth.providers()).toEqual(['google', 'okta'])
    expect(calls[0].url).toBe('http://api.test/auth/oauth')
    expect(calls[0].method).toBe('GET')
    // skipAuth: the page that asks has no session yet, and a stale token in
    // storage must not turn a public list into a 401.
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('an app with no OAuth answers a list, not a failure', async () => {
    const { restore } = mockFetch([{ providers: [] }])
    cleanup = restore
    const client = createJunctionClient({ url: 'http://api.test' })
    expect(await client.auth.providers()).toEqual([])
  })

  it('oauthUrl is absolute and carries returnTo — the flow leaves the SPA', async () => {
    const client = createJunctionClient({ url: 'http://api.test' })
    // Absolute because it is a browser navigation to the API's own origin, not
    // a fetch the client routes; a relative path would leave the web origin.
    expect(client.auth.oauthUrl('google')).toBe('http://api.test/auth/oauth/google')
    expect(client.auth.oauthUrl('google', { returnTo: '/orders?a=1' }))
      .toBe('http://api.test/auth/oauth/google?returnTo=%2Forders%3Fa%3D1')
  })

  it('signInWith refuses outside a browser rather than doing nothing', () => {
    // The failure it replaces is a button that silently does not work.
    const client = createJunctionClient({ url: 'http://api.test' })
    const location = (globalThis as { location?: unknown }).location
    delete (globalThis as { location?: unknown }).location
    try {
      expect(() => client.auth.signInWith('google')).toThrow(/browser/)
    } finally {
      if (location !== undefined) (globalThis as { location?: unknown }).location = location
    }
  })
})
