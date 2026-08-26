// tests/session-verifier.test.ts
//
// FJS-D10 — Junction requires of an auth provider exactly what Junction calls.
//
// `IAuth` declares six required methods. This package invokes two: verifySession
// (transport/http.ts, on the HTTP and the WS path) and sessionFor (core/app.ts,
// behind runAs). login / logout / createUser / deleteUser belong to
// @frontierjs/auth's own /auth/* routes and are called nowhere here — so an app
// authenticating against something it already has had to stub four methods that
// would never run, and a stub that throws cannot be told apart from a provider
// that works until the day something calls it.
//
// These assert the acceptance, not the types: a one-method object must really
// authenticate a request, and the absence of sessionFor must still be a refusal
// by name rather than a silent downgrade to anonymous.

import { describe, it, expect } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import type { SessionVerifier, SessionContext } from '../src/auth/types.ts'

const cfg = {
  ...defaultConfig, port: 0,
  database: { url: '', log: false }, services: { dir: '/nonexistent' },
}

/** One method. No cast. This is the whole provider. */
const minimal: SessionVerifier = {
  async verifySession(t) {
    return t === 'good' ? ({ userId: 'u1', userType: 'user', authMethod: 'session' } as SessionContext) : null
  },
}

function appWith(auth: SessionVerifier) {
  const app = createApp({ config: cfg as never, auth })
  app.get('/whoami', (ctx: any) =>
    ctx.user ? ctx.json({ userId: ctx.user.userId }) : ctx.json({ anon: true }, 401))
  return app
}

describe('a provider is what Junction calls', () => {

  it('{ verifySession } alone authenticates a request', async () => {
    const app = appWith(minimal)
    await app.start()
    const res = await app.http.fetch(new Request('http://localhost/whoami', {
      headers: { authorization: 'Bearer good' },
    }))
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBe('u1')
    await app.stop()
  })

  it('and still refuses a token it does not know', async () => {
    const app = appWith(minimal)
    await app.start()
    const res = await app.http.fetch(new Request('http://localhost/whoami', {
      headers: { authorization: 'Bearer bad' },
    }))
    expect(res.status).toBe(401)
    await app.stop()
  })

  it('setAuth() takes the same narrow provider after construction', async () => {
    const app = createApp({ config: cfg as never })
    app.setAuth(minimal)
    app.get('/whoami', (ctx: any) => ctx.json({ userId: ctx.user?.userId ?? null }))
    await app.start()
    const res = await app.http.fetch(new Request('http://localhost/whoami', {
      headers: { authorization: 'Bearer good' },
    }))
    expect((await res.json()).userId).toBe('u1')
    await app.stop()
  })

  // ── where the credential came from ──────────────────────────────────────
  //
  // One case, and without it that case cannot work at all: `tenancy { strategy
  // database }` puts a tenant's people in the tenant's own file, and this
  // resolution happens at the transport — before any hook, and therefore before
  // `withTenantDb` has resolved a tenant. A provider handed a bare token has no
  // way to know which shop's users it is being asked about.
  it('hands the provider WHERE the credential arrived', async () => {
    let seen: { host?: string | null; headers?: Record<string, unknown> | null } | undefined
    const app = appWith({
      async verifySession(t, from) {
        seen = from
        return t === 'good'
          ? ({ userId: 'u1', userType: 'user', authMethod: 'session' } as SessionContext)
          : null
      },
    })
    await app.start()
    await app.http.fetch(new Request('http://acme.shop.test/whoami', {
      headers: { authorization: 'Bearer good', 'x-tenant-id': 'acme' },
    }))
    await app.stop()

    // The Host is what `resolve subdomain` reads; the headers are what
    // `resolve header(...)` reads. Both, because the schema decides which.
    expect(seen?.host).toBe('acme.shop.test')
    expect((seen?.headers as Record<string, unknown>)['x-tenant-id']).toBe('acme')
  })

  // sessionFor stays optional, and its absence must stay LOUD. Downgrading to
  // STRANGER(0) is the hazard runAs exists to remove; inventing the system
  // principal would be worse.
  it('runAs still throws by name when the provider has no sessionFor', async () => {
    const app = appWith(minimal)
    await app.start()
    await expect(app.runAs('u1', async () => 'never')).rejects.toThrow(/sessionFor/)
    await app.stop()
  })

  it('a provider that DOES implement sessionFor is used by runAs', async () => {
    const withSessionFor: SessionVerifier = {
      ...minimal,
      async sessionFor(userId) {
        return { userId, userType: 'user', authMethod: 'session' } as SessionContext
      },
    }
    const app = appWith(withSessionFor)
    await app.start()
    const seen = await app.runAs('u9', async () => app.principal()?.userId ?? null)
    expect(seen).toBe('u9')
    await app.stop()
  })
})
