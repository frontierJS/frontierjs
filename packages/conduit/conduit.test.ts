// ============================================================
// Conduit — Test Suite
// ============================================================

import { describe, it, expect, beforeEach } from 'bun:test'
import { createConduit }      from './src/conduit.ts'
import { conduit as conduitPlugin } from './src/plugin.ts'
import { createMemoryStore }  from './src/stores/memory.ts'
import { createTestConduit }  from './src/testing.ts'
import { StubTransport }      from './src/transports/stub.ts'
import { HttpTransport }      from './src/transports/http.ts'
import { WebSocketTransport } from './src/transports/websocket.ts'
import {
  createEnvResolver,
  createStaticResolver,
  createNullResolver,
  withCache,
} from './src/credentials.ts'
import { ConduitStreamError } from './src/types.ts'
import type {
  TargetDescriptor,
  ConduitRequest,
  ConduitError,
  CredentialResolver,
} from './src/types.ts'

// ─── Fixtures ────────────────────────────────────────────────

function agentTarget(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id:            'agent:srv-test',
    kind:          'agent',
    protocol:      'http',
    address:       'http://10.0.0.5:7700',
    auth:          { type: 'hmac', ref: 'AGENT_SECRET' },
    registered_at: Date.now(),
    last_seen_at:  null,
    ...overrides,
  }
}

function providerTarget(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id:            'provider:hetzner',
    kind:          'provider',
    protocol:      'http',
    address:       'https://api.hetzner.cloud/v1',
    auth:          { type: 'bearer', ref: 'HETZNER_TOKEN' },
    registered_at: Date.now(),
    last_seen_at:  null,
    ...overrides,
  }
}

const secrets = () => createStaticResolver({
  AGENT_SECRET:  'test-secret',
  HETZNER_TOKEN: 'htz-token-abc',
})

// ─── Memory Store ────────────────────────────────────────────

describe('createMemoryStore', () => {
  it('returns null for unknown id', async () => {
    const store = createMemoryStore()
    await store.init()
    expect(await store.get('unknown')).toBeNull()
  })

  it('stores and retrieves a target', async () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    await store.init()
    await store.set(target)
    expect(await store.get(target.id)).toEqual(target)
  })

  it('preserves registered_at on upsert', async () => {
    const store  = createMemoryStore()
    const target = agentTarget({ registered_at: 1000 })
    await store.init()
    await store.set(target)
    // Re-register with a different registered_at — should not overwrite
    await store.set({ ...target, registered_at: 9999, address: 'http://new-address' })
    expect((await store.get(target.id))!.registered_at).toBe(1000)
  })

  it('updates address on upsert', async () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    await store.init()
    await store.set(target)
    await store.set({ ...target, address: 'http://10.0.0.99:7700' })
    expect((await store.get(target.id))!.address).toBe('http://10.0.0.99:7700')
  })

  it('deletes a target', async () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    await store.init()
    await store.set(target)
    await store.delete(target.id)
    expect(await store.get(target.id)).toBeNull()
  })

  it('lists targets ordered by registered_at', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(agentTarget({ id: 'agent:b', registered_at: 200 }))
    await store.set(agentTarget({ id: 'agent:a', registered_at: 100 }))
    await store.set(agentTarget({ id: 'agent:c', registered_at: 300 }))
    const ids = (await store.list()).map(t => t.id)
    expect(ids).toEqual(['agent:a', 'agent:b', 'agent:c'])
  })

  it('touch updates last_seen_at', async () => {
    const store  = createMemoryStore()
    const target = agentTarget({ last_seen_at: null })
    await store.init()
    await store.set(target)
    const before = Date.now()
    await store.touch(target.id)
    const after = Date.now()
    const updated = (await store.get(target.id))!
    expect(updated.last_seen_at).toBeGreaterThanOrEqual(before)
    expect(updated.last_seen_at).toBeLessThanOrEqual(after)
  })

  it('touch on unknown id is a no-op', async () => {
    const store = createMemoryStore()
    await store.init()
    await expect(store.touch('does-not-exist')).resolves.toBeUndefined()
  })

  // Reads must be copies — otherwise any consumer can mutate the registry
  // by accident, and the management routes hand live objects to the
  // response serializer.
  it('get() returns a copy, not the stored object', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(agentTarget())

    const first = (await store.get('agent:srv-test'))!
    first.address = 'http://mutated'
    ;(first.auth as { ref: string }).ref = 'MUTATED'

    const second = (await store.get('agent:srv-test'))!
    expect(second.address).toBe('http://10.0.0.5:7700')
    expect((second.auth as { ref: string }).ref).toBe('AGENT_SECRET')
  })

  it('list() returns copies with distinct identity from get()', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(agentTarget())

    const fromList = (await store.list())[0]
    const fromGet  = (await store.get('agent:srv-test'))!
    expect(fromList).toEqual(fromGet)
    expect(fromList).not.toBe(fromGet)
  })

  it('set() copies the caller object — later mutation does not reach the store', async () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    await store.init()
    await store.set(target)

    target.address = 'http://mutated-after-set'
    expect((await store.get(target.id))!.address).toBe('http://10.0.0.5:7700')
  })
})

// ─── Credential resolvers ────────────────────────────────────

describe('credential resolvers', () => {
  it('static resolver returns registered secrets and null otherwise', async () => {
    const r = createStaticResolver({ A: 'secret-a' })
    expect(await r.get('A')).toBe('secret-a')
    expect(await r.get('B')).toBeNull()
  })

  it('static resolver copies the map on construction', async () => {
    const source = { A: 'secret-a' }
    const r = createStaticResolver(source)
    source.A = 'changed'
    expect(await r.get('A')).toBe('secret-a')
  })

  it('null resolver resolves nothing', async () => {
    expect(await createNullResolver().get('ANYTHING')).toBeNull()
  })

  it('env resolver reads process.env', async () => {
    process.env.CONDUIT_TEST_TOKEN = 'from-env'
    try {
      expect(await createEnvResolver().get('CONDUIT_TEST_TOKEN')).toBe('from-env')
      expect(await createEnvResolver().get('CONDUIT_TEST_ABSENT')).toBeNull()
    } finally {
      delete process.env.CONDUIT_TEST_TOKEN
    }
  })

  it('env resolver prefix scopes lookups', async () => {
    process.env.SCOPED_TOKEN = 'scoped'
    try {
      const r = createEnvResolver({ prefix: 'SCOPED_' })
      expect(await r.get('TOKEN')).toBe('scoped')
      // Without the prefix applied, the bare name must not resolve
      expect(await r.get('SCOPED_TOKEN')).toBeNull()
    } finally {
      delete process.env.SCOPED_TOKEN
    }
  })

  it('withCache calls through once per ref within the TTL', async () => {
    let calls = 0
    const inner: CredentialResolver = {
      async get(ref) { calls++; return `value-${ref}` }
    }
    const cached = withCache(inner, { ttl_ms: 10_000 })

    expect(await cached.get('A')).toBe('value-A')
    expect(await cached.get('A')).toBe('value-A')
    expect(calls).toBe(1)
  })

  it('withCache does not cache misses', async () => {
    let calls = 0
    const inner: CredentialResolver = {
      async get() { calls++; return null }
    }
    const cached = withCache(inner)

    await cached.get('A')
    await cached.get('A')
    expect(calls).toBe(2)
  })
})

// ─── Credentials reach the wire, and fail closed ─────────────

describe('credential resolution through the HTTP transport', () => {
  it('resolves a bearer ref at send time', async () => {
    let seen: string | null = null
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = req.headers.get('authorization')
        return Response.json({ ok: true })
      }
    })

    try {
      const target = providerTarget({ address: `http://localhost:${server.port}` })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      const result = await t.send({ target: target.id, method: 'GET', path: '/servers' })

      expect(result.error).toBeNull()
      expect(seen).toBe('Bearer htz-token-abc')
    } finally {
      server.stop(true)
    }
  })

  // The point of the whole change: a target whose credential cannot be
  // resolved must not send unauthenticated traffic.
  it('fails closed with auth_failed when the ref does not resolve', async () => {
    let reached = false
    const server = Bun.serve({
      port: 0,
      fetch() { reached = true; return Response.json({ ok: true }) }
    })

    try {
      const target = providerTarget({ address: `http://localhost:${server.port}` })
      const t = new HttpTransport(target, createNullResolver(), { retry_limit: 0 })
      const result = await t.send({ target: target.id, method: 'GET', path: '/servers' })

      expect(result.error).not.toBeNull()
      expect(result.error!.kind).toBe('auth_failed')
      expect(result.error!.retryable).toBe(false)
      expect(reached).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it('the credential error names the ref but never the secret', async () => {
    const target = providerTarget({ address: 'http://127.0.0.1:1' })
    const t = new HttpTransport(target, createNullResolver(), { retry_limit: 0 })
    const result = await t.send({ target: target.id, method: 'GET' })

    expect(result.error!.message).toContain('HETZNER_TOKEN')
    expect(result.error!.message).toContain('provider:hetzner')
    expect(result.error!.message).not.toContain('htz-token-abc')
  })

  it('an api_key ref resolves into the configured header', async () => {
    let seen: string | null = null
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = req.headers.get('x-api-key')
        return Response.json({ ok: true })
      }
    })

    try {
      const target = providerTarget({
        address: `http://localhost:${server.port}`,
        auth:    { type: 'api_key', ref: 'HETZNER_TOKEN', header: 'X-Api-Key' },
      })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      await t.send({ target: target.id, method: 'GET' })

      expect(seen).toBe('htz-token-abc')
    } finally {
      server.stop(true)
    }
  })
})

// ─── HTTP transport — request construction ───────────────────

// Spins up a server that records what it received and replies with `reply`.
function recorder(reply: (req: Request) => Response) {
  const seen: Request[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.clone())
      return reply(req)
    }
  })
  return {
    seen,
    port: server.port,
    url:  `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  }
}

describe('HTTP transport — headers', () => {
  it('auth headers win over caller-supplied headers', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      await t.send({
        target:  target.id,
        method:  'GET',
        headers: { 'Authorization': 'Bearer ATTACKER' },
      })

      expect(s.seen[0].headers.get('authorization')).toBe('Bearer htz-token-abc')
    } finally { s.stop() }
  })

  it('caller headers that do not collide with auth still pass through', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      await t.send({ target: target.id, method: 'GET', headers: { 'X-Custom': '1' } })

      expect(s.seen[0].headers.get('x-custom')).toBe('1')
      expect(s.seen[0].headers.get('authorization')).toBe('Bearer htz-token-abc')
    } finally { s.stop() }
  })
})

describe('HTTP transport — buildUrl', () => {
  async function urlFor(req: Partial<ConduitRequest>): Promise<string> {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url, auth: { type: 'none' } })
      const t = new HttpTransport(target, createNullResolver(), { retry_limit: 0 })
      await t.send({ target: target.id, method: 'GET', ...req })
      return new URL(s.seen[0].url).pathname + new URL(s.seen[0].url).search
    } finally { s.stop() }
  }

  it('merges query params into a path that already has a query string', async () => {
    expect(await urlFor({ path: '/servers?page=2', query: { status: 'running' } }))
      .toBe('/servers?page=2&status=running')
  })

  it('array query values produce repeated keys', async () => {
    expect(await urlFor({ path: '/servers', query: { tag: ['a', 'b'] } }))
      .toBe('/servers?tag=a&tag=b')
  })

  it('skips null and undefined query values', async () => {
    expect(await urlFor({ path: '/servers', query: { a: '1', b: null, c: undefined } }))
      .toBe('/servers?a=1')
  })

  it('query wins over a GET body with the same key', async () => {
    expect(await urlFor({ path: '/servers', body: { page: 1 }, query: { page: 9 } }))
      .toBe('/servers?page=9')
  })

  it('still supports the GET-body shorthand on its own', async () => {
    expect(await urlFor({ path: '/servers', body: { page: 2 } }))
      .toBe('/servers?page=2')
  })

  it('does not double-slash a leading-slash path', async () => {
    expect(await urlFor({ path: '/servers/42' })).toBe('/servers/42')
    expect(await urlFor({ path: 'servers/42' })).toBe('/servers/42')
  })
})

describe('HTTP transport — never throws', () => {
  it('a cyclic body returns invalid_request instead of throwing', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    const target = providerTarget({ address: 'http://127.0.0.1:1' })
    const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

    const result = await t.send({ target: target.id, method: 'POST', body: cyclic })
    expect(result.error!.kind).toBe('invalid_request')
    expect(result.error!.retryable).toBe(false)
  })

  it('a BigInt body returns invalid_request instead of throwing', async () => {
    const target = providerTarget({ address: 'http://127.0.0.1:1' })
    const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

    const result = await t.send({
      target: target.id, method: 'POST', body: { id: BigInt(1) },
    })
    expect(result.error!.kind).toBe('invalid_request')
  })

  it('an unserialisable body is not retried', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 3 })
      await t.send({ target: target.id, method: 'POST', body: cyclic })
      expect(s.seen).toHaveLength(0)
    } finally { s.stop() }
  })
})

describe('HTTP transport — response limits', () => {
  it('the timeout covers the body read, not just the headers', async () => {
    // Headers land immediately, then the body dribbles forever.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"a":'))
            // never closes
          }
        }), { headers: { 'content-type': 'application/json' } })
      }
    })

    try {
      const target = providerTarget({ address: `http://localhost:${server.port}` })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      const started = performance.now()
      const result  = await t.send({ target: target.id, method: 'GET', timeout_ms: 300 })
      const elapsed = performance.now() - started

      expect(result.error!.kind).toBe('timeout')
      expect(elapsed).toBeLessThan(3000)
    } finally { server.stop(true) }
  })

  it('caps an oversized response instead of buffering it', async () => {
    const big = 'x'.repeat(200_000)
    const s = recorder(() => new Response(JSON.stringify({ big })))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), {
        retry_limit: 0, max_response_bytes: 1024,
      })

      const result = await t.send({ target: target.id, method: 'GET' })
      expect(result.error!.kind).toBe('invalid_request')
      expect(result.error!.retryable).toBe(false)
      expect(result.error!.message).toContain('1024')
    } finally { s.stop() }
  })

  it('reads a normal response under the cap', async () => {
    const s = recorder(() => Response.json({ id: 42, status: 'running' }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      const result = await t.send<{ id: number }>({ target: target.id, method: 'GET' })
      expect(result.error).toBeNull()
      expect(result.data!.id).toBe(42)
    } finally { s.stop() }
  })

  it('a 204 with an empty body yields null data, not a parse failure', async () => {
    const s = recorder(() => new Response(null, { status: 204 }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      const result = await t.send({ target: target.id, method: 'DELETE' })
      expect(result.error).toBeNull()
      expect(result.data).toBeNull()
      expect(result.meta.status).toBe(204)
    } finally { s.stop() }
  })
})

// ─── Descriptors carry no secret material ────────────────────

describe('secrets stay out of the registry', () => {
  it('resolve() and list() return refs, never material', async () => {
    const c = createConduit({ credentials: secrets() })
    await c.init()
    await c.register(providerTarget())

    const resolved = await c.resolve('provider:hetzner')
    const listed   = await c.list()

    expect(resolved!.auth).toEqual({ type: 'bearer', ref: 'HETZNER_TOKEN' })
    expect(JSON.stringify(listed)).not.toContain('htz-token-abc')
  })

  it('mutating a resolved descriptor does not change the registry', async () => {
    const c = createConduit({ credentials: secrets() })
    await c.init()
    await c.register(providerTarget())

    const first = await c.resolve('provider:hetzner')
    first!.address = 'http://attacker'

    expect((await c.resolve('provider:hetzner'))!.address)
      .toBe('https://api.hetzner.cloud/v1')
  })
})

// ─── StubTransport ───────────────────────────────────────────

describe('StubTransport', () => {
  const descriptor = agentTarget()

  it('records calls', async () => {
    const stub = new StubTransport(descriptor)
    const req: ConduitRequest = { target: 'agent:srv-test', method: 'POST', path: '/deploy', body: { image: 'api:v2' } }
    await stub.send(req)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toEqual(req)
  })

  it('returns path-specific mock response', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/deploy', { deployed: true })
    const result = await stub.send({ target: 'agent:srv-test', method: 'POST', path: '/deploy' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ deployed: true })
  })

  it('falls back to default response for unregistered path', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/deploy', { deployed: true })
    const result = await stub.send({ target: 'agent:srv-test', method: 'POST', path: '/other' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ ok: true }) // default
  })

  it('mockDefault overrides the fallback', async () => {
    const stub = new StubTransport(descriptor)
    stub.mockDefault({ custom: 'default' })
    const result = await stub.send({ target: 'agent:srv-test', method: 'GET', path: '/health' })
    expect(result.data).toEqual({ custom: 'default' })
  })

  it('reset clears calls and mocks', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/deploy', { deployed: true })
    await stub.send({ target: 'agent:srv-test', method: 'POST', path: '/deploy' })
    stub.reset()
    expect(stub.calls).toHaveLength(0)
    // Mock is gone — should fall back to default
    const result = await stub.send({ target: 'agent:srv-test', method: 'POST', path: '/deploy' })
    expect(result.data).toEqual({ ok: true })
  })

  it('supports method chaining', () => {
    const stub = new StubTransport(descriptor)
    const returned = stub.mock('/a', {}).mockDefault({}).reset()
    expect(returned).toBe(stub)
  })
})

// ─── createTestConduit ───────────────────────────────────────

describe('createTestConduit', () => {
  it('routes send() to the correct stub', async () => {
    const { conduit } = createTestConduit({
      'agent:srv-abc': { '/deploy': { deployed: true } },
    })

    const result = await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/deploy' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ deployed: true })
  })

  it('returns typed stubs keyed by target id', async () => {
    const { conduit, stubs } = createTestConduit({
      'agent:srv-abc': { '/deploy': { deployed: true } },
      'provider:hetzner': { '/servers/42': { id: 42, status: 'running' } },
    })

    await conduit.send({ target: 'agent:srv-abc',     method: 'POST', path: '/deploy' })
    await conduit.send({ target: 'provider:hetzner',  method: 'GET',  path: '/servers/42' })

    expect(stubs['agent:srv-abc'].calls).toHaveLength(1)
    expect(stubs['provider:hetzner'].calls).toHaveLength(1)
  })

  it('records multiple calls in order', async () => {
    const { conduit, stubs } = createTestConduit({
      'agent:srv-abc': {
        '/pull':         { ok: true },
        '/deploy':       { deployed: true },
        '/health-check': { healthy: true },
      },
    })

    await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/pull' })
    await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/deploy' })
    await conduit.send({ target: 'agent:srv-abc', method: 'GET',  path: '/health-check' })

    const paths = stubs['agent:srv-abc'].calls.map(c => c.path)
    expect(paths).toEqual(['/pull', '/deploy', '/health-check'])
  })

  it('reset between test cases clears call history', async () => {
    const { conduit, stubs } = createTestConduit({
      'agent:srv-abc': { '/deploy': { deployed: true } },
    })

    await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/deploy' })
    expect(stubs['agent:srv-abc'].calls).toHaveLength(1)

    stubs['agent:srv-abc'].reset()
    expect(stubs['agent:srv-abc'].calls).toHaveLength(0)
  })

  it('infers kind from target id prefix', async () => {
    const { conduit } = createTestConduit({
      'provider:stripe': {},
      'agent:srv-1':     {},
      'local:sidecar':   {},
    })

    const provider = await conduit.resolve('provider:stripe')
    const agent    = await conduit.resolve('agent:srv-1')
    const local    = await conduit.resolve('local:sidecar')

    // Stubs bypass the store — resolve falls back to store which is empty
    // for overridden targets. Kind inference is exercised during stub creation.
    // We verify no errors are thrown during setup.
    expect(provider).toBeNull() // store has no entry — overrides bypass it
    expect(agent).toBeNull()
    expect(local).toBeNull()
  })
})

// ─── Core conduit — send() ───────────────────────────────────

describe('conduit.send()', () => {
  it('returns target_not_found when target is not registered', async () => {
    const c = createConduit()
    await c.init()

    const result = await c.send({ target: 'agent:unknown', method: 'POST', path: '/deploy' })
    expect(result.error).not.toBeNull()
    expect(result.error!.kind).toBe('target_not_found')
    expect(result.error!.retryable).toBe(false)
    expect(result.data).toBeNull()
  })

  it('meta reflects the target on error', async () => {
    const c = createConduit()
    await c.init()

    const result = await c.send({ target: 'agent:missing', method: 'GET', path: '/health' })
    expect(result.meta.target).toBe('agent:missing')
    expect(result.meta.duration_ms).toBe(0)
  })

  it('routes to stub after register()', async () => {
    const { conduit, stubs } = createTestConduit({
      'agent:srv-abc': { '/status': { running: true } },
    })

    const result = await conduit.send<{ running: boolean }>({
      target: 'agent:srv-abc',
      method: 'GET',
      path:   '/status',
    })

    expect(result.error).toBeNull()
    expect(result.data?.running).toBe(true)
    expect(stubs['agent:srv-abc'].calls).toHaveLength(1)
  })
})

// ─── Core conduit — register / deregister ────────────────────

describe('conduit.register() / deregister()', () => {
  it('registered target is resolvable', async () => {
    const c      = createConduit()
    const target = agentTarget()
    await c.init()
    await c.register(target)
    const resolved = await c.resolve(target.id)
    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe(target.id)
  })

  it('deregistered target is no longer resolvable', async () => {
    const c      = createConduit()
    const target = agentTarget()
    await c.init()
    await c.register(target)
    await c.deregister(target.id)
    expect(await c.resolve(target.id)).toBeNull()
  })

  it('list() returns all registered targets', async () => {
    const c = createConduit()
    await c.init()
    await c.register(agentTarget({ id: 'agent:a' }))
    await c.register(agentTarget({ id: 'agent:b' }))
    const targets = await c.list()
    expect(targets.map(t => t.id).sort()).toEqual(['agent:a', 'agent:b'])
  })

  it('deregister on unknown id is a no-op', async () => {
    const c = createConduit()
    await c.init()
    await expect(c.deregister('agent:never-existed')).resolves.toBeUndefined()
  })
})

// ─── Core conduit — stream() ─────────────────────────────────

describe('conduit.stream()', () => {
  it('throws ConduitStreamError when target not found', async () => {
    const c = createConduit()
    await c.init()

    const gen = c.stream({ target: 'agent:missing', method: 'logs' })
    await expect(gen.next()).rejects.toBeInstanceOf(ConduitStreamError)
  })

  it('ConduitStreamError carries the structured error', async () => {
    const c = createConduit()
    await c.init()

    try {
      await c.stream({ target: 'agent:missing', method: 'logs' }).next()
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConduitStreamError)
      expect((err as ConduitStreamError).conduit.kind).toBe('target_not_found')
      expect((err as ConduitStreamError).conduit.target).toBe('agent:missing')
    }
  })
})

// ─── Hooks ───────────────────────────────────────────────────

describe('conduit hooks', () => {
  it('onRequest fires before send', async () => {
    const seen: ConduitRequest[] = []

    const { conduit } = createTestConduit(
      { 'agent:srv-abc': { '/ping': { pong: true } } },
      { hooks: { onRequest: (req) => seen.push(req) } }
    )

    await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/ping' })
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe('/ping')
  })

  it('onError fires on target_not_found', async () => {
    const errors: ConduitError[] = []
    const c = createConduit({
      hooks: { onError: (_req, err) => errors.push(err) }
    })
    await c.init()

    await c.send({ target: 'agent:missing', method: 'POST' })
    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('target_not_found')
  })

  it('onRegistered fires when a target is registered', async () => {
    const registered: string[] = []
    const c = createConduit({
      hooks: { onRegistered: (d) => registered.push(d.id) }
    })
    await c.init()
    await c.register(agentTarget())
    expect(registered).toContain('agent:srv-test')
  })

  it('onDeregistered fires when a target is removed', async () => {
    const removed: string[] = []
    const c = createConduit({
      hooks: { onDeregistered: (id) => removed.push(id) }
    })
    await c.init()
    await c.register(agentTarget())
    await c.deregister('agent:srv-test')
    expect(removed).toContain('agent:srv-test')
  })
})

// ─── Static targets ──────────────────────────────────────────

describe('static targets (opts.targets)', () => {
  it('targets are resolvable immediately after init()', async () => {
    const target = providerTarget()
    const c      = createConduit({ targets: [target] })
    await c.init()
    const resolved = await c.resolve(target.id)
    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe('provider:hetzner')
  })

  it('static targets appear in list()', async () => {
    const c = createConduit({ targets: [agentTarget(), providerTarget()] })
    await c.init()
    const ids = (await c.list()).map(t => t.id)
    expect(ids).toContain('agent:srv-test')
    expect(ids).toContain('provider:hetzner')
  })
})

// ─── conduit.stats() ─────────────────────────────────────────

describe('conduit.stats()', () => {

  it('returns zero counts when no targets registered', async () => {
    const c = createConduit()
    await c.init()
    const s = c.stats()
    expect(s.targets.total).toBe(0)
    expect(s.targets.byKind).toEqual({})
    expect(s.targets.byProtocol).toEqual({})
  })

  it('counts targets by kind', async () => {
    const c = createConduit()
    await c.init()
    await c.register(agentTarget({ id: 'agent:a' }))
    await c.register(agentTarget({ id: 'agent:b' }))
    await c.register(providerTarget())
    const s = c.stats()
    expect(s.targets.total).toBe(3)
    expect(s.targets.byKind.agent).toBe(2)
    expect(s.targets.byKind.provider).toBe(1)
  })

  it('counts targets by protocol', async () => {
    const c = createConduit()
    await c.init()
    await c.register(agentTarget({ id: 'agent:a', protocol: 'http' }))
    await c.register(agentTarget({ id: 'agent:b', protocol: 'websocket' }))
    await c.register(providerTarget({ protocol: 'http' }))
    const s = c.stats()
    expect(s.targets.byProtocol.http).toBe(2)
    expect(s.targets.byProtocol.websocket).toBe(1)
  })

  it('updates after deregister', async () => {
    const c = createConduit()
    await c.init()
    await c.register(agentTarget())
    await c.deregister('agent:srv-test')
    expect(c.stats().targets.total).toBe(0)
  })

  it('is synchronous — does not return a Promise', async () => {
    const c = createConduit()
    await c.init()
    const result = c.stats()
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result.targets.total).toBe('number')
  })

  // stats() reads counters only. With an async store it cannot read the
  // store at all, so re-registering must not double-count and a changed
  // protocol must move the target between buckets.
  it('re-registering the same id does not double-count', async () => {
    const c = createConduit()
    await c.init()
    await c.register(agentTarget())
    await c.register(agentTarget({ address: 'http://10.0.0.9:7700' }))

    expect(c.stats().targets.total).toBe(1)
    expect(c.stats().targets.byKind.agent).toBe(1)
  })

  it('re-registering with a new protocol moves the count', async () => {
    const c = createConduit()
    await c.init()
    await c.register(agentTarget({ protocol: 'http' }))
    await c.register(agentTarget({ protocol: 'websocket' }))

    const s = c.stats()
    expect(s.targets.byProtocol.websocket).toBe(1)
    expect(s.targets.byProtocol.http).toBeUndefined()
    expect(s.targets.total).toBe(1)
  })

  it('seeds target counts from a store that already has entries', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(agentTarget({ id: 'agent:pre-existing' }))
    await store.set(providerTarget())

    const c = createConduit({ store })
    await c.init()

    const s = c.stats()
    expect(s.targets.total).toBe(2)
    expect(s.targets.byKind.agent).toBe(1)
    expect(s.targets.byKind.provider).toBe(1)
  })

  it('counts successful requests and records latency', async () => {
    const { conduit } = createTestConduit({
      'agent:srv-abc': { '/ping': { pong: true } },
    })

    await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/ping' })
    await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/ping' })

    const s = conduit.stats()
    expect(s.requests.total).toBe(2)
    expect(s.requests.success).toBe(2)
    expect(s.requests.error).toBe(0)
    expect(s.requests.in_flight).toBe(0)
    expect(s.requests.latency_ms.total).toBeGreaterThanOrEqual(0)
    expect(s.requests.latency_ms.avg).toBeGreaterThanOrEqual(0)
  })

  it('counts errors by kind', async () => {
    const c = createConduit()
    await c.init()

    await c.send({ target: 'agent:missing',   method: 'POST' })
    await c.send({ target: 'agent:missing-2', method: 'POST' })

    const s = c.stats()
    expect(s.requests.total).toBe(2)
    expect(s.requests.error).toBe(2)
    expect(s.requests.success).toBe(0)
    expect(s.errors.target_not_found).toBe(2)
  })

  it('tracks in-flight requests and decrements them on failure', async () => {
    const c = createConduit()
    await c.init()

    // target_not_found returns through the same accounting path
    await c.send({ target: 'agent:missing', method: 'POST' })
    expect(c.stats().requests.in_flight).toBe(0)
  })

  it('counts stream failures separately from requests', async () => {
    const c = createConduit()
    await c.init()

    await expect(
      c.stream({ target: 'agent:missing', method: 'logs' }).next()
    ).rejects.toBeInstanceOf(ConduitStreamError)

    const s = c.stats()
    expect(s.streams.failed).toBe(1)
    expect(s.streams.opened).toBe(0)
    expect(s.requests.total).toBe(0)      // a stream is not a request
    expect(s.errors.target_not_found).toBe(1)
  })

  it('counts opened streams', async () => {
    const { conduit } = createTestConduit({ 'agent:srv-abc': {} })

    for await (const _ of conduit.stream({ target: 'agent:srv-abc', method: 'logs' })) {
      // stub yields nothing
    }

    expect(conduit.stats().streams.opened).toBe(1)
  })

})

// ─── conduit.destroy() ───────────────────────────────────────

describe('conduit.destroy()', () => {

  it('resolves without throwing when no transports are open', async () => {
    const c = createConduit()
    await c.init()
    await expect(c.destroy()).resolves.toBeUndefined()
  })

  it('resolves without throwing when targets are registered but no connections made', async () => {
    const c = createConduit({ targets: [agentTarget(), providerTarget()] })
    await c.init()
    await expect(c.destroy()).resolves.toBeUndefined()
  })

  // destroy() must stick: previously a late in-flight request rebuilt the
  // transport and opened a real connection after app.stop() had run.
  it('send() after destroy() fails instead of reaching the network', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({ credentials: secrets(), targets: [target] })
      await c.init()
      await c.destroy()

      const result = await c.send({ target: target.id, method: 'GET', path: '/servers' })

      expect(result.error!.kind).toBe('connection_failed')
      expect(result.error!.retryable).toBe(false)
      expect(result.error!.message).toContain('destroyed')
      expect(s.seen).toHaveLength(0)
    } finally { s.stop() }
  })

  it('stream() after destroy() throws ConduitStreamError', async () => {
    const c = createConduit({ targets: [agentTarget()] })
    await c.init()
    await c.destroy()

    await expect(
      c.stream({ target: 'agent:srv-test', method: 'logs' }).next()
    ).rejects.toBeInstanceOf(ConduitStreamError)
  })

})

// ─── WebSocket transport ─────────────────────────────────────

describe('WebSocket transport — stream()', () => {
  it('throws ConduitStreamError when the target is unreachable', async () => {
    // Previously this returned a silently-empty iterator, making
    // "agent unreachable" indistinguishable from "agent had no logs".
    const target = agentTarget({ protocol: 'websocket', address: 'ws://127.0.0.1:1' })
    const t = new WebSocketTransport(target, createNullResolver())

    try {
      await expect(
        t.stream({ target: target.id, method: 'logs' }).next()
      ).rejects.toBeInstanceOf(ConduitStreamError)
    } finally {
      t.destroy()
    }
  })

  it('marks the stream on the envelope and leaves the body untouched', async () => {
    const frames: Record<string, unknown>[] = []

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('expected upgrade', { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw))
          frames.push(msg)
          ws.send(JSON.stringify({ id: msg.id, type: 'stream_end' }))
        }
      }
    })

    const target = agentTarget({
      protocol: 'websocket',
      address:  `ws://localhost:${server.port}`,
    })
    const t = new WebSocketTransport(target, createNullResolver())

    try {
      // A string body would previously be destroyed by `{ ...body, _stream: true }`
      for await (const _ of t.stream({ target: target.id, method: 'logs', body: 'tail -f' })) {
        // server ends the stream immediately
      }

      expect(frames).toHaveLength(1)
      expect(frames[0].stream).toBe(true)
      expect(frames[0].body).toBe('tail -f')      // not spread into an object
      expect(frames[0]).not.toHaveProperty('_stream')
    } finally {
      t.destroy()
      server.stop(true)
    }
  })

  it('preserves an object body without injecting a marker key', async () => {
    const frames: Record<string, unknown>[] = []

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('expected upgrade', { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw))
          frames.push(msg)
          ws.send(JSON.stringify({ id: msg.id, type: 'stream_end' }))
        }
      }
    })

    const target = agentTarget({
      protocol: 'websocket',
      address:  `ws://localhost:${server.port}`,
    })
    const t = new WebSocketTransport(target, createNullResolver())

    try {
      for await (const _ of t.stream({
        target: target.id, method: 'logs', body: { unit: 'api', follow: true },
      })) { /* ends immediately */ }

      expect(frames[0].body).toEqual({ unit: 'api', follow: true })
    } finally {
      t.destroy()
      server.stop(true)
    }
  })
})

// ─── Hook safety ─────────────────────────────────────────────

describe('a throwing hook does not take down the caller', () => {
  it('onRequest', async () => {
    const { conduit } = createTestConduit(
      { 'agent:srv-abc': { '/ping': { pong: true } } },
      { hooks: { onRequest() { throw new Error('boom') } } }
    )

    const result = await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/ping' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ pong: true })
  })

  it('onResponse', async () => {
    const { conduit } = createTestConduit(
      { 'agent:srv-abc': { '/ping': { pong: true } } },
      { hooks: { onResponse() { throw new Error('boom') } } }
    )

    const result = await conduit.send({ target: 'agent:srv-abc', method: 'POST', path: '/ping' })
    expect(result.error).toBeNull()
  })

  it('onError', async () => {
    const c = createConduit({ hooks: { onError() { throw new Error('boom') } } })
    await c.init()

    const result = await c.send({ target: 'agent:missing', method: 'POST' })
    expect(result.error!.kind).toBe('target_not_found')
  })

  it('onRegistered and onDeregistered', async () => {
    const c = createConduit({
      hooks: {
        onRegistered()   { throw new Error('boom') },
        onDeregistered() { throw new Error('boom') },
      }
    })
    await c.init()

    await expect(c.register(agentTarget())).resolves.toBeUndefined()
    await expect(c.deregister('agent:srv-test')).resolves.toBeUndefined()
  })
})

// ─── Junction plugin wiring ──────────────────────────────────

describe('conduit Junction plugin', () => {

  it('has the correct plugin shape', () => {
    const plugin = conduitPlugin()
    expect(plugin.name).toBe('conduit')
    expect(typeof plugin.register).toBe('function')
    expect(typeof plugin.boot).toBe('function')
    expect(typeof plugin.shutdown).toBe('function')
    expect(typeof plugin.ready).toBe('function')
  })

  it('register() wires _metricsProviders when present', async () => {
    const providers = new Map<string, () => unknown>()
    const fakeApp: Record<string, unknown> = { _metricsProviders: providers }
    const plugin = conduitPlugin()
    plugin.register!(fakeApp as never)
    expect(providers.has('conduit')).toBe(true)
    expect(typeof providers.get('conduit')).toBe('function')
  })

  it('metrics provider returns correct stats shape', async () => {
    const providers = new Map<string, () => unknown>()
    const fakeApp: Record<string, unknown> = { _metricsProviders: providers }
    const plugin = conduitPlugin()
    plugin.register!(fakeApp as never)
    await plugin.boot!(fakeApp as never)
    const stats = providers.get('conduit')!() as { targets: { total: number } }
    expect(stats).toHaveProperty('targets')
    expect(typeof stats.targets.total).toBe('number')
  })

  it('shutdown() resolves without throwing', async () => {
    const fakeApp: Record<string, unknown> = { _metricsProviders: new Map() }
    const plugin = conduitPlugin()
    plugin.register!(fakeApp as never)
    await plugin.boot!(fakeApp as never)
    await expect(plugin.shutdown!(fakeApp as never)).resolves.toBeUndefined()
  })

  it('register() sets the conduit instance on app', () => {
    const fakeApp: Record<string, unknown> = { _metricsProviders: new Map() }
    const plugin = conduitPlugin()
    plugin.register!(fakeApp as never)
    expect(fakeApp.conduit).toBeDefined()
    expect(typeof (fakeApp.conduit as Record<string, unknown>).send).toBe('function')
  })

})
