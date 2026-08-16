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
    expect(r.token).toBe('tok-1')
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

  it('still carries the code and still emits unauthorized', async () => {
    const { restore } = mockFetch([{ message: 'Invalid credentials' }], 401)
    cleanup = restore
    const c = createJunctionClient({ url: 'http://x' })
    let fired = false
    c.on('unauthorized', () => { fired = true })

    const err = await c.auth.signIn('a@b.c', 'nope').catch(e => e)
    expect(err.code).toBe(401)
    expect(fired).toBe(true)
  })
})
