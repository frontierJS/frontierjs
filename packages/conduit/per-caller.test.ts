// ============================================================
// Conduit — a credential per caller (FJS-D848, FJS-2232)
//
// One declared target, one ref, a credential per tenant: a vendor every
// account connects its own login to. The resolver is asked getFor(ref, who),
// withCache keys on who, a 401 forgets the refused caller's and nobody
// else's, and under junction `who` is the call in progress, never an
// argument. Every send leaves the process for a real Bun.serve vendor that
// reads the bearer and answers whose it was.
// ============================================================

import { afterAll, describe, expect, it } from 'bun:test'
import { createTestApp } from '@frontierjs/junction'
import { createConduit } from './src/conduit.ts'
import { createStaticResolver, withCache } from './src/credentials.ts'
import { conduit as conduitPlugin } from './src/plugin.ts'
import type { CredentialCaller, CredentialResolver, TargetDescriptor } from './src/types.ts'

// The vendor: answers the token it was sent, and 401 for any token on its
// revoked list — one tenant's login, revoked at the vendor's end.
const revoked = new Set<string>()
const vendor  = Bun.serve({
  port: 0,
  fetch(req) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
    if (!token || revoked.has(token)) return Response.json({ message: 'Access token expired' }, { status: 401 })
    return Response.json({ token })
  },
})
afterAll(() => vendor.stop(true))

const target = (auth: TargetDescriptor['auth'] = { type: 'bearer', ref: 'VENDOR', per_caller: true }): TargetDescriptor => ({
  id:            'provider:vendor',
  kind:          'provider',
  protocol:      'http',
  address:       `http://127.0.0.1:${vendor.port}`,
  auth,
  registered_at: 1_000,
  last_seen_at:  null,
})

const who = (tenant: string | null, principal: string | null = null): CredentialCaller => ({ tenant, principal, grant: null })

/** Each tenant's current token, minted afresh on a refresh — a vendor that
 *  rotates, the way an OAuth refresh does. Counts every mint per tenant. */
function tenantLogins() {
  const minted  = new Map<string, number>()
  const current = new Map<string, string>()
  const mint    = (tenant: string) => {
    const n = (minted.get(tenant) ?? 0) + 1
    minted.set(tenant, n)
    current.set(tenant, `${tenant}-token-${n}`)
  }
  const resolver: CredentialResolver = {
    async get() { return 'the-machine-token' },
    async getFor(_ref, w) {
      if (!w.tenant) return null
      if (!current.has(w.tenant)) mint(w.tenant)
      return current.get(w.tenant)!
    },
    invalidateFor(_ref, value, w) {
      if (w.tenant && current.get(w.tenant) === value) mint(w.tenant)
    },
  }
  return { resolver, minted }
}

const tokenOf = (r: { data: unknown }) => (r.data as { token: string }).token

describe('a per-caller target', () => {
  it('is refused at put() when the resolver has no getFor, by name', async () => {
    const c = createConduit({ credentials: createStaticResolver({ VENDOR: 'x' }) })
    await expect(c.register(target())).rejects.toThrow(/per_caller.*getFor/)
    // The control: the same resolver takes the same target without the flag.
    await c.register(target({ type: 'bearer', ref: 'VENDOR' }))
  })

  it('is refused on a websocket target, which authenticates one connection for everyone', async () => {
    const { resolver } = tenantLogins()
    const c = createConduit({ credentials: resolver })
    await expect(c.register({ ...target(), protocol: 'websocket', address: 'ws://127.0.0.1:1' })).rejects.toThrow(/per_caller.*websocket/)
  })

  it('sends each caller its own credential, and never asks get()', async () => {
    const { resolver } = tenantLogins()
    const c = createConduit({ credentials: resolver })
    await c.register(target())
    const a = await c.send({ target: 'provider:vendor', method: 'GET', path: '/me', who: who('A') })
    const b = await c.send({ target: 'provider:vendor', method: 'GET', path: '/me', who: who('B') })
    expect(tokenOf(a)).toBe('A-token-1')
    expect(tokenOf(b)).toBe('B-token-1')
  })

  it('fails closed when the send names no caller', async () => {
    const { resolver } = tenantLogins()
    const c = createConduit({ credentials: resolver })
    await c.register(target())
    const r = await c.send({ target: 'provider:vendor', method: 'GET', path: '/me' })
    expect(r.error?.kind).toBe('auth_failed')
    expect(r.error?.message).toMatch(/names no caller/)
  })
})

describe('withCache over a per-caller resolver — FJS-2232', () => {
  it('keys on who: tenant A then tenant B is B\'s login, not A\'s cached one', async () => {
    const { resolver, minted } = tenantLogins()
    const c = createConduit({ credentials: withCache(resolver) })
    await c.register(target())
    expect(tokenOf(await c.send({ target: 'provider:vendor', method: 'GET', who: who('A') }))).toBe('A-token-1')
    expect(tokenOf(await c.send({ target: 'provider:vendor', method: 'GET', who: who('B') }))).toBe('B-token-1')
    // And it still caches: A again is A's held token, not a second mint.
    expect(tokenOf(await c.send({ target: 'provider:vendor', method: 'GET', who: who('A') }))).toBe('A-token-1')
    expect(minted.get('A')).toBe(1)
  })

  it('offers no getFor over a resolver without one, so put() still refuses', async () => {
    const cached = withCache(createStaticResolver({ VENDOR: 'x' }))
    expect(cached.getFor).toBeUndefined()
  })

  it('a 401 for A re-mints A\'s alone and replays; B\'s held login is untouched', async () => {
    const { resolver, minted } = tenantLogins()
    const c = createConduit({ credentials: withCache(resolver) })
    await c.register(target())
    await c.send({ target: 'provider:vendor', method: 'GET', who: who('A') })
    await c.send({ target: 'provider:vendor', method: 'GET', who: who('B') })

    revoked.add('A-token-1')
    const a = await c.send({ target: 'provider:vendor', method: 'GET', who: who('A') })
    expect(a.error).toBeNull()
    expect(tokenOf(a)).toBe('A-token-2')
    const b = await c.send({ target: 'provider:vendor', method: 'GET', who: who('B') })
    expect(tokenOf(b)).toBe('B-token-1')
    expect(minted.get('A')).toBe(2)
    expect(minted.get('B')).toBe(1)
  })
})

describe('under junction, who is the call in progress', () => {
  const SYSTEM = { id: 'system', userType: 'service', authMethod: 'created' } as never

  async function boot() {
    revoked.clear()
    const { resolver } = tenantLogins()
    const app = await createTestApp({ system: SYSTEM })
    app.configure(conduitPlugin({ credentials: withCache(resolver), targets: [target()] }))
    await app._startForTest()
    return app
  }

  it('reads the tenant the work runs in, so two tenants spend two logins through one target', async () => {
    const app  = await boot()
    const send = () => app.conduit.send({ target: 'provider:vendor', method: 'GET' })
    const a = await app.runAs(null, { tenant: 'A' }, send)
    const b = await app.runAs(null, { tenant: 'B' }, send)
    expect(tokenOf(a)).toBe('A-token-1')
    expect(tokenOf(b)).toBe('B-token-1')
  })

  it('refuses a send that states its own who', async () => {
    const app = await boot()
    expect(() => app.conduit.send({ target: 'provider:vendor', method: 'GET', who: who('B') })).toThrow(/states `who`/)
  })

  it('outside any tenant the resolver is asked for nobody\'s, and the send fails closed', async () => {
    const app = await boot()
    const r = await app.conduit.send({ target: 'provider:vendor', method: 'GET' })
    expect(r.error?.kind).toBe('auth_failed')
  })
})
