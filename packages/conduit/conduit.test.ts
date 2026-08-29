// ============================================================
// Conduit — Test Suite
// ============================================================

import { describe, it, expect } from 'bun:test'
import { createConduit }      from './src/conduit.ts'
import { conduit as conduitPlugin } from './src/plugin.ts'
import { createMemoryStore }  from './src/stores/memory.ts'
import { createSQLiteStore }  from './src/stores/sqlite.ts'
import { Database }           from 'bun:sqlite'
import { createTestConduit }  from './src/testing.ts'
import { StubTransport }      from './src/transports/stub.ts'
import { HttpTransport }      from './src/transports/http.ts'
import { encodeBody }         from './src/transports/encode.ts'
import { verifyRequest }      from '@frontierjs/toolbelt/signature'
import { WebSocketTransport } from './src/transports/websocket.ts'
import { UnixTransport }      from './src/transports/unix.ts'
import {
  createEnvResolver,
  createStaticResolver,
  createNullResolver,
  withCache,
} from './src/credentials.ts'
import { createTraceContext } from './src/trace.ts'
import { ConduitStreamError } from './src/types.ts'
import type {
  TargetDescriptor,
  ConduitRequest,
  ConduitError,
  CredentialResolver,
} from './src/types.ts'

// ─── Fixtures ────────────────────────────────────────────────

function outpostTarget(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id:            'outpost:srv-test',
    kind:          'outpost',
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
    const target = outpostTarget()
    await store.init()
    await store.set(target)
    expect(await store.get(target.id)).toEqual(target)
  })

  it('preserves registered_at on upsert', async () => {
    const store  = createMemoryStore()
    const target = outpostTarget({ registered_at: 1000 })
    await store.init()
    await store.set(target)
    // Re-register with a different registered_at — should not overwrite
    await store.set({ ...target, registered_at: 9999, address: 'http://new-address' })
    expect((await store.get(target.id))!.registered_at).toBe(1000)
  })

  it('updates address on upsert', async () => {
    const store  = createMemoryStore()
    const target = outpostTarget()
    await store.init()
    await store.set(target)
    await store.set({ ...target, address: 'http://10.0.0.99:7700' })
    expect((await store.get(target.id))!.address).toBe('http://10.0.0.99:7700')
  })

  it('deletes a target', async () => {
    const store  = createMemoryStore()
    const target = outpostTarget()
    await store.init()
    await store.set(target)
    await store.delete(target.id)
    expect(await store.get(target.id)).toBeNull()
  })

  it('lists targets ordered by registered_at', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(outpostTarget({ id: 'outpost:b', registered_at: 200 }))
    await store.set(outpostTarget({ id: 'outpost:a', registered_at: 100 }))
    await store.set(outpostTarget({ id: 'outpost:c', registered_at: 300 }))
    const ids = (await store.list()).map(t => t.id)
    expect(ids).toEqual(['outpost:a', 'outpost:b', 'outpost:c'])
  })

  it('touch updates last_seen_at', async () => {
    const store  = createMemoryStore()
    const target = outpostTarget({ last_seen_at: null })
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
    await store.set(outpostTarget())

    const first = (await store.get('outpost:srv-test'))!
    first.address = 'http://mutated'
    ;(first.auth as { ref: string }).ref = 'MUTATED'

    const second = (await store.get('outpost:srv-test'))!
    expect(second.address).toBe('http://10.0.0.5:7700')
    expect((second.auth as { ref: string }).ref).toBe('AGENT_SECRET')
  })

  it('list() returns copies with distinct identity from get()', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(outpostTarget())

    const fromList = (await store.list())[0]
    const fromGet  = (await store.get('outpost:srv-test'))!
    expect(fromList).toEqual(fromGet)
    expect(fromList).not.toBe(fromGet)
  })

  it('set() copies the caller object — later mutation does not reach the store', async () => {
    const store  = createMemoryStore()
    const target = outpostTarget()
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
    const seen: (string | null)[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get('authorization'))
        return Response.json({ ok: true })
      }
    })

    try {
      const target = providerTarget({ address: `http://localhost:${server.port}` })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      const result = await t.send({ target: target.id, method: 'GET', path: '/servers' })

      expect(result.error).toBeNull()
      expect(seen[0]).toBe('Bearer htz-token-abc')
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
    const seen: (string | null)[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get('x-api-key'))
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

      expect(seen[0]).toBe('htz-token-abc')
    } finally {
      server.stop(true)
    }
  })
})

// ─── HTTP transport — request construction ───────────────────

// Spins up a server that records what it received and replies with `reply`.
function recorder(reply: (req: Request) => Response | Promise<Response>) {
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
  const descriptor = outpostTarget()

  it('records calls', async () => {
    const stub = new StubTransport(descriptor)
    const req: ConduitRequest = { target: 'outpost:srv-test', method: 'POST', path: '/deploy', body: { image: 'api:v2' } }
    await stub.send(req)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toEqual(req)
  })

  it('returns path-specific mock response', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/deploy', { deployed: true })
    const result = await stub.send({ target: 'outpost:srv-test', method: 'POST', path: '/deploy' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ deployed: true })
  })

  it('falls back to default response for unregistered path', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/deploy', { deployed: true })
    const result = await stub.send({ target: 'outpost:srv-test', method: 'POST', path: '/other' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ ok: true }) // default
  })

  it('mockDefault overrides the fallback', async () => {
    const stub = new StubTransport(descriptor)
    stub.mockDefault({ custom: 'default' })
    const result = await stub.send({ target: 'outpost:srv-test', method: 'GET', path: '/health' })
    expect(result.data).toEqual({ custom: 'default' })
  })

  it('reset clears calls and mocks', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/deploy', { deployed: true })
    await stub.send({ target: 'outpost:srv-test', method: 'POST', path: '/deploy' })
    stub.reset()
    expect(stub.calls).toHaveLength(0)
    // Mock is gone — should fall back to default
    const result = await stub.send({ target: 'outpost:srv-test', method: 'POST', path: '/deploy' })
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
    const { conduit } = await createTestConduit({
      'outpost:srv-abc': { '/deploy': { deployed: true } },
    })

    const result = await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/deploy' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ deployed: true })
  })

  it('returns typed stubs keyed by target id', async () => {
    const { conduit, stubs } = await createTestConduit({
      'outpost:srv-abc': { '/deploy': { deployed: true } },
      'provider:hetzner': { '/servers/42': { id: 42, status: 'running' } },
    })

    await conduit.send({ target: 'outpost:srv-abc',     method: 'POST', path: '/deploy' })
    await conduit.send({ target: 'provider:hetzner',  method: 'GET',  path: '/servers/42' })

    expect(stubs['outpost:srv-abc'].calls).toHaveLength(1)
    expect(stubs['provider:hetzner'].calls).toHaveLength(1)
  })

  it('records multiple calls in order', async () => {
    const { conduit, stubs } = await createTestConduit({
      'outpost:srv-abc': {
        '/pull':         { ok: true },
        '/deploy':       { deployed: true },
        '/health-check': { healthy: true },
      },
    })

    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/pull' })
    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/deploy' })
    await conduit.send({ target: 'outpost:srv-abc', method: 'GET',  path: '/health-check' })

    const paths = stubs['outpost:srv-abc'].calls.map(c => c.path)
    expect(paths).toEqual(['/pull', '/deploy', '/health-check'])
  })

  it('reset between test cases clears call history', async () => {
    const { conduit, stubs } = await createTestConduit({
      'outpost:srv-abc': { '/deploy': { deployed: true } },
    })

    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/deploy' })
    expect(stubs['outpost:srv-abc'].calls).toHaveLength(1)

    stubs['outpost:srv-abc'].reset()
    expect(stubs['outpost:srv-abc'].calls).toHaveLength(0)
  })

  // Stubs used to bypass the store entirely, so resolve()/list()/stats()
  // returned nothing for a stubbed target — and a test asserted that as
  // correct, which made it impossible to integration-test any code calling
  // send() alongside resolve().
  it('stubbed targets are resolvable, with kind inferred from the id prefix', async () => {
    const { conduit } = await createTestConduit({
      'provider:stripe': {},
      'outpost:srv-1':     {},
      'local:sidecar':   {},
    })

    expect((await conduit.resolve('provider:stripe'))!.kind).toBe('provider')
    expect((await conduit.resolve('outpost:srv-1'))!.kind).toBe('outpost')
    expect((await conduit.resolve('local:sidecar'))!.kind).toBe('local')
  })

  it('stubbed targets appear in list() and stats()', async () => {
    const { conduit } = await createTestConduit({
      'provider:stripe': {},
      'outpost:srv-1':     {},
    })

    expect((await conduit.list()).map(t => t.id).sort())
      .toEqual(['outpost:srv-1', 'provider:stripe'])
    expect(conduit.stats().targets.total).toBe(2)
    expect(conduit.stats().targets.byKind.provider).toBe(1)
  })

  it('mixes stubbed targets with plain registered ones', async () => {
    const { conduit, stubs } = await createTestConduit(
      { 'outpost:stubbed': { '/ping': { pong: true } } },
      { targets: [providerTarget()] },
    )

    // The real descriptor resolves...
    expect((await conduit.resolve('provider:hetzner'))!.address)
      .toBe('https://api.hetzner.cloud/v1')
    // ...and the stub still intercepts send()
    const result = await conduit.send({ target: 'outpost:stubbed', method: 'POST', path: '/ping' })
    expect(result.data).toEqual({ pong: true })
    expect(stubs['outpost:stubbed'].calls).toHaveLength(1)
  })
})

// ─── StubTransport can simulate failure ──────────────────────

describe('StubTransport failure simulation', () => {
  const descriptor = outpostTarget()

  it('mockError returns a typed conduit error', async () => {
    const stub = new StubTransport(descriptor)
    stub.mockError('/deploy', 'timeout', { retryable: true })

    const result = await stub.send({ target: descriptor.id, method: 'POST', path: '/deploy' })

    expect(result.data).toBeNull()
    expect(result.error!.kind).toBe('timeout')
    expect(result.error!.retryable).toBe(true)
  })

  it('mocks are keyed on method + path when qualified', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('GET /servers/42', { id: 42 })
    stub.mockError('DELETE /servers/42', 'auth_failed')

    const read = await stub.send({ target: descriptor.id, method: 'GET', path: '/servers/42' })
    const del  = await stub.send({ target: descriptor.id, method: 'DELETE', path: '/servers/42' })

    // Previously indistinguishable — both matched the same path key
    expect(read.data).toEqual({ id: 42 })
    expect(del.error!.kind).toBe('auth_failed')
  })

  it('a bare path still matches any method', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/health', { ok: true })

    for (const method of ['GET', 'POST', 'DELETE']) {
      const r = await stub.send({ target: descriptor.id, method, path: '/health' })
      expect(r.data).toEqual({ ok: true })
    }
  })

  it('a method-qualified mock wins over a bare one', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/servers', { all: true })
    stub.mock('POST /servers', { created: true })

    expect((await stub.send({ target: descriptor.id, method: 'GET',  path: '/servers' })).data)
      .toEqual({ all: true })
    expect((await stub.send({ target: descriptor.id, method: 'POST', path: '/servers' })).data)
      .toEqual({ created: true })
  })

  it('delays a response so timeout behaviour is testable', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/slow', { ok: true }, { delay_ms: 120 })

    const started = performance.now()
    await stub.send({ target: descriptor.id, method: 'GET', path: '/slow' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('mockDefaultError makes unexpected calls fail loudly', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/expected', { ok: true })
    stub.mockDefaultError('target_not_found', { message: 'unexpected call' })

    expect((await stub.send({ target: descriptor.id, method: 'GET', path: '/expected' })).error)
      .toBeNull()
    expect((await stub.send({ target: descriptor.id, method: 'GET', path: '/other' })).error!.message)
      .toBe('unexpected call')
  })

  it('mockStream yields chunks with sequence numbers', async () => {
    const stub = new StubTransport(descriptor, 'websocket')
    stub.mockStream('/logs', ['line-1', 'line-2', 'line-3'])

    const chunks: unknown[] = []
    for await (const chunk of stub.stream({ target: descriptor.id, method: 'logs', path: '/logs' })) {
      chunks.push([chunk.sequence, chunk.data])
    }

    expect(chunks).toEqual([[0, 'line-1'], [1, 'line-2'], [2, 'line-3']])
  })

  it('a mocked stream error throws ConduitStreamError', async () => {
    const stub = new StubTransport(descriptor, 'websocket')
    stub.mockError('/logs', 'stream_error', { message: 'outpost vanished' })

    await expect(
      stub.stream({ target: descriptor.id, method: 'logs', path: '/logs' })[Symbol.asyncIterator]().next()
    ).rejects.toBeInstanceOf(ConduitStreamError)
  })

  it('status is reported on the result meta', async () => {
    const stub = new StubTransport(descriptor)
    stub.mock('/created', { id: 1 }, { status: 201 })

    const result = await stub.send({ target: descriptor.id, method: 'POST', path: '/created' })
    expect(result.meta.status).toBe(201)
  })

  it('reset clears mocked errors too', async () => {
    const stub = new StubTransport(descriptor)
    stub.mockError('/deploy', 'timeout')
    stub.reset()

    const result = await stub.send({ target: descriptor.id, method: 'POST', path: '/deploy' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ ok: true })
  })
})

// ─── SQLite store ────────────────────────────────────────────

// This backend was never imported by any test — it could have been broken
// in any way and the suite would have stayed green.
describe('createSQLiteStore', () => {
  function store() {
    const db = new Database(':memory:')
    return { db, store: createSQLiteStore(db) }
  }

  it('creates its table on init and returns null for unknown ids', async () => {
    const { store: s } = store()
    await s.init()
    expect(await s.get('unknown')).toBeNull()
  })

  it('round-trips a descriptor including the auth ref', async () => {
    const { store: s } = store()
    await s.init()
    await s.set(outpostTarget())

    const found = (await s.get('outpost:srv-test'))!
    expect(found.address).toBe('http://10.0.0.5:7700')
    expect(found.auth).toEqual({ type: 'hmac', ref: 'AGENT_SECRET' })
    expect(found.kind).toBe('outpost')
  })

  it('preserves registered_at on upsert but updates the rest', async () => {
    const { store: s } = store()
    await s.init()
    await s.set(outpostTarget({ registered_at: 1000 }))
    await s.set(outpostTarget({ registered_at: 9999, address: 'http://new' }))

    const found = (await s.get('outpost:srv-test'))!
    expect(found.registered_at).toBe(1000)
    expect(found.address).toBe('http://new')
  })

  it('lists ordered by registered_at', async () => {
    const { store: s } = store()
    await s.init()
    await s.set(outpostTarget({ id: 'outpost:b', registered_at: 200 }))
    await s.set(outpostTarget({ id: 'outpost:a', registered_at: 100 }))

    expect((await s.list()).map(t => t.id)).toEqual(['outpost:a', 'outpost:b'])
  })

  it('deletes', async () => {
    const { store: s } = store()
    await s.init()
    await s.set(outpostTarget())
    await s.delete('outpost:srv-test')
    expect(await s.get('outpost:srv-test')).toBeNull()
  })

  it('touch updates last_seen_at', async () => {
    const { store: s } = store()
    await s.init()
    await s.set(outpostTarget({ last_seen_at: null }))

    const before = Date.now()
    await s.touch('outpost:srv-test')
    expect((await s.get('outpost:srv-test'))!.last_seen_at).toBeGreaterThanOrEqual(before)
  })

  it('init is idempotent across restarts against the same file', async () => {
    const db = new Database(':memory:')
    const a  = createSQLiteStore(db)
    await a.init()
    await a.set(outpostTarget())

    // A second store over the same handle — as happens on a process restart
    const b = createSQLiteStore(db)
    await b.init()
    expect((await b.get('outpost:srv-test'))!.id).toBe('outpost:srv-test')
  })

  it('survives a conduit restart with counters seeded', async () => {
    const db = new Database(':memory:')

    const first = createConduit({ store: createSQLiteStore(db), credentials: secrets() })
    await first.init()
    await first.register(providerTarget())

    const second = createConduit({ store: createSQLiteStore(db), credentials: secrets() })
    await second.init()

    expect(second.stats().targets.total).toBe(1)
    expect((await second.resolve('provider:hetzner'))!.id).toBe('provider:hetzner')
  })
})

// ─── Core conduit — send() ───────────────────────────────────

describe('conduit.send()', () => {
  it('returns target_not_found when target is not registered', async () => {
    const c = createConduit()
    await c.init()

    const result = await c.send({ target: 'outpost:unknown', method: 'POST', path: '/deploy' })
    expect(result.error).not.toBeNull()
    expect(result.error!.kind).toBe('target_not_found')
    expect(result.error!.retryable).toBe(false)
    expect(result.data).toBeNull()
  })

  it('meta reflects the target on error', async () => {
    const c = createConduit()
    await c.init()

    const result = await c.send({ target: 'outpost:missing', method: 'GET', path: '/health' })
    expect(result.meta.target).toBe('outpost:missing')
    expect(result.meta.duration_ms).toBe(0)
  })

  it('routes to stub after register()', async () => {
    const { conduit, stubs } = await createTestConduit({
      'outpost:srv-abc': { '/status': { running: true } },
    })

    const result = await conduit.send<{ running: boolean }>({
      target: 'outpost:srv-abc',
      method: 'GET',
      path:   '/status',
    })

    expect(result.error).toBeNull()
    expect(result.data?.running).toBe(true)
    expect(stubs['outpost:srv-abc'].calls).toHaveLength(1)
  })
})

// ─── Core conduit — register / deregister ────────────────────

describe('conduit.register() / deregister()', () => {
  it('registered target is resolvable', async () => {
    const c      = createConduit()
    const target = outpostTarget()
    await c.init()
    await c.register(target)
    const resolved = await c.resolve(target.id)
    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe(target.id)
  })

  it('deregistered target is no longer resolvable', async () => {
    const c      = createConduit()
    const target = outpostTarget()
    await c.init()
    await c.register(target)
    await c.deregister(target.id)
    expect(await c.resolve(target.id)).toBeNull()
  })

  it('list() returns all registered targets', async () => {
    const c = createConduit()
    await c.init()
    await c.register(outpostTarget({ id: 'outpost:a' }))
    await c.register(outpostTarget({ id: 'outpost:b' }))
    const targets = await c.list()
    expect(targets.map(t => t.id).sort()).toEqual(['outpost:a', 'outpost:b'])
  })

  it('deregister on unknown id is a no-op', async () => {
    const c = createConduit()
    await c.init()
    await expect(c.deregister('outpost:never-existed')).resolves.toBeUndefined()
  })
})

// ─── Core conduit — stream() ─────────────────────────────────

describe('conduit.stream()', () => {
  it('throws ConduitStreamError when target not found', async () => {
    const c = createConduit()
    await c.init()

    const gen = c.stream({ target: 'outpost:missing', method: 'logs' })[Symbol.asyncIterator]()
    await expect(gen.next()).rejects.toBeInstanceOf(ConduitStreamError)
  })

  it('ConduitStreamError carries the structured error', async () => {
    const c = createConduit()
    await c.init()

    try {
      await c.stream({ target: 'outpost:missing', method: 'logs' })[Symbol.asyncIterator]().next()
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConduitStreamError)
      expect((err as ConduitStreamError).conduit.kind).toBe('target_not_found')
      expect((err as ConduitStreamError).conduit.target).toBe('outpost:missing')
    }
  })
})

// ─── Hooks ───────────────────────────────────────────────────

describe('conduit observers', () => {
  it('onRequest fires before send', async () => {
    const seen: ConduitRequest[] = []

    const { conduit } = await createTestConduit(
      { 'outpost:srv-abc': { '/ping': { pong: true } } },
      { observers: { onRequest: (req) => seen.push(req) } }
    )

    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })
    expect(seen).toHaveLength(1)
    expect(seen[0].path).toBe('/ping')
  })

  it('onError fires on target_not_found', async () => {
    const errors: ConduitError[] = []
    const c = createConduit({
      observers: { onError: (_req, err) => errors.push(err) }
    })
    await c.init()

    await c.send({ target: 'outpost:missing', method: 'POST' })
    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('target_not_found')
  })

  it('onRegistered fires when a target is registered', async () => {
    const registered: string[] = []
    const c = createConduit({
      observers: { onRegistered: (d) => registered.push(d.id) }
    })
    await c.init()
    await c.register(outpostTarget())
    expect(registered).toContain('outpost:srv-test')
  })

  it('onDeregistered fires when a target is removed', async () => {
    const removed: string[] = []
    const c = createConduit({
      observers: { onDeregistered: (id) => removed.push(id) }
    })
    await c.init()
    await c.register(outpostTarget())
    await c.deregister('outpost:srv-test')
    expect(removed).toContain('outpost:srv-test')
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
    const c = createConduit({ targets: [outpostTarget(), providerTarget()] })
    await c.init()
    const ids = (await c.list()).map(t => t.id)
    expect(ids).toContain('outpost:srv-test')
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
    await c.register(outpostTarget({ id: 'outpost:a' }))
    await c.register(outpostTarget({ id: 'outpost:b' }))
    await c.register(providerTarget())
    const s = c.stats()
    expect(s.targets.total).toBe(3)
    expect(s.targets.byKind.outpost).toBe(2)
    expect(s.targets.byKind.provider).toBe(1)
  })

  it('counts targets by protocol', async () => {
    const c = createConduit()
    await c.init()
    await c.register(outpostTarget({ id: 'outpost:a', protocol: 'http' }))
    await c.register(outpostTarget({ id: 'outpost:b', protocol: 'websocket' }))
    await c.register(providerTarget({ protocol: 'http' }))
    const s = c.stats()
    expect(s.targets.byProtocol.http).toBe(2)
    expect(s.targets.byProtocol.websocket).toBe(1)
  })

  it('updates after deregister', async () => {
    const c = createConduit()
    await c.init()
    await c.register(outpostTarget())
    await c.deregister('outpost:srv-test')
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
    await c.register(outpostTarget())
    await c.register(outpostTarget({ address: 'http://10.0.0.9:7700' }))

    expect(c.stats().targets.total).toBe(1)
    expect(c.stats().targets.byKind.outpost).toBe(1)
  })

  it('re-registering with a new protocol moves the count', async () => {
    const c = createConduit()
    await c.init()
    await c.register(outpostTarget({ protocol: 'http' }))
    await c.register(outpostTarget({ protocol: 'websocket' }))

    const s = c.stats()
    expect(s.targets.byProtocol.websocket).toBe(1)
    expect(s.targets.byProtocol.http).toBeUndefined()
    expect(s.targets.total).toBe(1)
  })

  it('seeds target counts from a store that already has entries', async () => {
    const store = createMemoryStore()
    await store.init()
    await store.set(outpostTarget({ id: 'outpost:pre-existing' }))
    await store.set(providerTarget())

    const c = createConduit({ store })
    await c.init()

    const s = c.stats()
    expect(s.targets.total).toBe(2)
    expect(s.targets.byKind.outpost).toBe(1)
    expect(s.targets.byKind.provider).toBe(1)
  })

  it('counts successful requests and records latency', async () => {
    const { conduit } = await createTestConduit({
      'outpost:srv-abc': { '/ping': { pong: true } },
    })

    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })
    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })

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

    await c.send({ target: 'outpost:missing',   method: 'POST' })
    await c.send({ target: 'outpost:missing-2', method: 'POST' })

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
    await c.send({ target: 'outpost:missing', method: 'POST' })
    expect(c.stats().requests.in_flight).toBe(0)
  })

  it('counts stream failures separately from requests', async () => {
    const c = createConduit()
    await c.init()

    await expect(
      c.stream({ target: 'outpost:missing', method: 'logs' })[Symbol.asyncIterator]().next()
    ).rejects.toBeInstanceOf(ConduitStreamError)

    const s = c.stats()
    expect(s.streams.failed).toBe(1)
    expect(s.streams.opened).toBe(0)
    expect(s.requests.total).toBe(0)      // a stream is not a request
    expect(s.errors.target_not_found).toBe(1)
  })

  it('counts opened streams', async () => {
    const { conduit } = await createTestConduit({ 'outpost:srv-abc': {} })

    for await (const _ of conduit.stream({ target: 'outpost:srv-abc', method: 'logs' })) {
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
    const c = createConduit({ targets: [outpostTarget(), providerTarget()] })
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
    const c = createConduit({ targets: [outpostTarget()] })
    await c.init()
    await c.destroy()

    await expect(
      c.stream({ target: 'outpost:srv-test', method: 'logs' })[Symbol.asyncIterator]().next()
    ).rejects.toBeInstanceOf(ConduitStreamError)
  })

})

// ─── WebSocket transport ─────────────────────────────────────

describe('WebSocket transport — stream()', () => {
  it('throws ConduitStreamError when the target is unreachable', async () => {
    // Previously this returned a silently-empty iterator, making
    // "outpost unreachable" indistinguishable from "outpost had no logs".
    const target = outpostTarget({ protocol: 'websocket', address: 'ws://127.0.0.1:1' })
    const t = new WebSocketTransport(target, createNullResolver())

    try {
      await expect(
        t.stream({ target: target.id, method: 'logs' })[Symbol.asyncIterator]().next()
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

    const target = outpostTarget({
      protocol: 'websocket',
      address:  `ws://localhost:${server.port}`,
    })
    const t = new WebSocketTransport(target, secrets())

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

    const target = outpostTarget({
      protocol: 'websocket',
      address:  `ws://localhost:${server.port}`,
    })
    const t = new WebSocketTransport(target, secrets())

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

// ─── WebSocket authentication (§1.1) ─────────────────────────

// Spins up a WS server that records upgrade headers and ends any stream
// immediately. `reject` refuses the upgrade, simulating an outpost enforcing auth.
function wsRecorder(opts: { reject?: boolean } = {}) {
  const upgrades: Record<string, string>[] = []
  const frames:   Record<string, unknown>[] = []

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      upgrades.push(Object.fromEntries(req.headers.entries()))
      if (opts.reject) return new Response('unauthorized', { status: 401 })
      return server.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw))
        frames.push(msg)
        ws.send(JSON.stringify({ id: msg.id, type: 'response', body: { ok: true } }))
      }
    }
  })

  return { upgrades, frames, url: `ws://localhost:${server.port}`, stop: () => server.stop(true) }
}

describe('WebSocket transport — auth on the upgrade', () => {
  it('sends a bearer credential on the upgrade request', async () => {
    const s = wsRecorder()
    const target = providerTarget({ protocol: 'websocket', address: s.url })
    const t = new WebSocketTransport(target, secrets())

    try {
      const result = await t.send({ target: target.id, method: 'POST', path: '/deploy' })
      expect(result.error).toBeNull()
      expect(s.upgrades[0].authorization).toBe('Bearer htz-token-abc')
    } finally { t.destroy(); s.stop() }
  })

  it('signs the upgrade for an hmac target', async () => {
    const s = wsRecorder()
    const target = outpostTarget({ protocol: 'websocket', address: s.url })
    const t = new WebSocketTransport(target, secrets())

    try {
      await t.send({ target: target.id, method: 'POST', path: '/deploy' })

      const up = s.upgrades[0]
      expect(up['x-hub-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
      expect(up['x-hub-timestamp']).toMatch(/^\d+$/)
      expect(up['x-hub-nonce']).toBeDefined()
    } finally { t.destroy(); s.stop() }
  })

  // The headline finding: a target declaring auth used to send fully
  // unauthenticated traffic over WebSocket, silently.
  it('never opens a connection when the credential cannot be resolved', async () => {
    const s = wsRecorder()
    const target = outpostTarget({ protocol: 'websocket', address: s.url })
    const t = new WebSocketTransport(target, createNullResolver())

    try {
      const result = await t.send({ target: target.id, method: 'POST', path: '/deploy' })

      expect(result.error!.kind).toBe('auth_failed')
      expect(result.error!.retryable).toBe(false)
      expect(s.upgrades).toHaveLength(0)   // no upgrade attempted at all
    } finally { t.destroy(); s.stop() }
  })

  it('an outpost rejecting the upgrade surfaces as connection_failed', async () => {
    const s = wsRecorder({ reject: true })
    const target = outpostTarget({ protocol: 'websocket', address: s.url })
    const t = new WebSocketTransport(target, secrets())

    try {
      const result = await t.send({ target: target.id, method: 'POST', path: '/deploy' })
      expect(result.error!.kind).toBe('connection_failed')
    } finally { t.destroy(); s.stop() }
  })
})

// ─── WebSocket connection lifecycle (§2.1, §2.2) ─────────────

describe('WebSocket transport — connection lifecycle', () => {
  it('concurrent sends open exactly one socket', async () => {
    let opened = 0
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        open() { opened++ },
        message(ws, raw) {
          const msg = JSON.parse(String(raw))
          ws.send(JSON.stringify({ id: msg.id, type: 'response', body: { ok: true } }))
        }
      }
    })

    const target = outpostTarget({ protocol: 'websocket', address: `ws://localhost:${server.port}` })
    const t = new WebSocketTransport(target, secrets())

    try {
      // Four sends before the connection exists — previously four sockets,
      // three of them untracked with orphaned ping intervals.
      const results = await Promise.all([1, 2, 3, 4].map(() =>
        t.send({ target: target.id, method: 'POST', path: '/deploy' })
      ))

      expect(results.every(r => r.error === null)).toBe(true)
      expect(opened).toBe(1)
    } finally { t.destroy(); server.stop(true) }
  })

  it('a socket dropping mid-stream terminates the consumer', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        return server.upgrade(req) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw))
          // One chunk, then close without stream_end
          ws.send(JSON.stringify({ id: msg.id, type: 'stream_chunk', body: 'line-1', seq: 0 }))
          setTimeout(() => ws.close(), 10)
        }
      }
    })

    const target = outpostTarget({ protocol: 'websocket', address: `ws://localhost:${server.port}` })
    const t = new WebSocketTransport(target, secrets())
    const chunks: unknown[] = []

    try {
      // Previously this for-await never terminated — the close handler
      // touched `pending` but never `streamListeners`.
      await expect((async () => {
        for await (const chunk of t.stream({ target: target.id, method: 'logs' })) {
          chunks.push(chunk.data)
        }
      })()).rejects.toBeInstanceOf(ConduitStreamError)

      expect(chunks).toEqual(['line-1'])
    } finally { t.destroy(); server.stop(true) }
  })
})

// ─── Retry policy (§2.5, §2.6) ───────────────────────────────

describe('retry policy', () => {
  it('does not retry a POST without an idempotency key', async () => {
    let hits = 0
    const s = recorder(() => { hits++; return new Response('boom', { status: 500 }) })
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 3 })

      const result = await t.send({ target: target.id, method: 'POST', path: '/servers' })

      expect(result.error!.kind).toBe('server_error')
      expect(hits).toBe(1)          // one attempt, not four servers
    } finally { s.stop() }
  })

  it('retries a POST when the caller supplies an idempotency key', async () => {
    let hits = 0
    const s = recorder(() => { hits++; return new Response('boom', { status: 500 }) })
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 1 })

      await t.send({
        target: target.id, method: 'POST', path: '/servers',
        idempotency_key: 'create-web-01',
      })

      expect(hits).toBe(2)          // initial + 1 retry
    } finally { s.stop() }
  })

  it('forwards the idempotency key as a header', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      await t.send({
        target: target.id, method: 'POST', path: '/servers',
        idempotency_key: 'create-web-01',
      })

      expect(s.seen[0].headers.get('idempotency-key')).toBe('create-web-01')
    } finally { s.stop() }
  })

  it('still retries idempotent methods', async () => {
    let hits = 0
    const s = recorder(() => { hits++; return new Response('boom', { status: 500 }) })
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 1 })

      await t.send({ target: target.id, method: 'GET', path: '/servers' })
      expect(hits).toBe(2)
    } finally { s.stop() }
  })

  it('a 200 with an HTML body is a non-retryable server_error', async () => {
    let hits = 0
    const s = recorder(() => {
      hits++
      return new Response('<html>captive portal</html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      })
    })
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 3 })

      const result = await t.send({ target: target.id, method: 'GET', path: '/servers' })

      // Was: connection_failed { retryable: true } and four attempts
      expect(result.error!.kind).toBe('server_error')
      expect(result.error!.retryable).toBe(false)
      expect(result.error!.message).toContain('text/html')
      expect(hits).toBe(1)
    } finally { s.stop() }
  })

  it('a 200 with a text/plain body succeeds, carrying the text', async () => {
    // A Slack incoming webhook answers `200 text/plain: ok`. The HTML check
    // above used to be spelled "not JSON", so every one of those was reported
    // as a server_error for a notification that had already been delivered —
    // found wiring basecamp's notification channels through conduit. Only
    // markup where a payload was expected is evidence of a broken target.
    const s = recorder(() => new Response('ok', {
      status: 200, headers: { 'content-type': 'text/plain;charset=utf-8' },
    }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 3 })

      const result = await t.send({ target: target.id, method: 'POST', path: '/hook', body: { a: 1 } })

      expect(result.error).toBe(null)
      expect(result.data).toBe('ok')
      expect(result.meta.status).toBe(200)
    } finally { s.stop() }
  })

  // Not tested: a response with NO content-type at all and a non-JSON body,
  // which falls through to the JSON.parse failure below. `new Response(…, {
  // headers: { 'content-type': '' } })` does not produce it — Bun normalises
  // the header back to text/plain — and a test that cannot construct its own
  // premise is theatre.

  it('malformed JSON under a JSON content-type is not retried either', async () => {
    let hits = 0
    const s = recorder(() => {
      hits++
      return new Response('{not json', { headers: { 'content-type': 'application/json' } })
    })
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 3 })

      const result = await t.send({ target: target.id, method: 'GET' })
      expect(result.error!.kind).toBe('server_error')
      expect(result.error!.retryable).toBe(false)
      expect(hits).toBe(1)
    } finally { s.stop() }
  })

  it('accepts vendor JSON content types', async () => {
    const s = recorder(() => new Response(JSON.stringify({ id: 1 }), {
      headers: { 'content-type': 'application/vnd.api+json' },
    }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      const result = await t.send<{ id: number }>({ target: target.id, method: 'GET' })
      expect(result.error).toBeNull()
      expect(result.data!.id).toBe(1)
    } finally { s.stop() }
  })
})

// ─── HMAC canonical signing (§1.3) ───────────────────────────

describe('hmac signing', () => {
  async function headersFor(req: Partial<ConduitRequest>, address: string) {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = outpostTarget({ address: address || s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      await t.send({ target: target.id, method: 'GET', ...req })
      return s.seen[0].headers
    } finally { s.stop() }
  }

  // Every bodyless command used to go out completely unsigned.
  it('signs a bodyless POST', async () => {
    const h = await headersFor({ method: 'POST', path: '/reboot' }, '')
    expect(h.get('x-hub-signature')).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('signs a DELETE', async () => {
    const h = await headersFor({ method: 'DELETE', path: '/servers/42' }, '')
    expect(h.get('x-hub-signature')).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('signs a GET', async () => {
    const h = await headersFor({ method: 'GET', path: '/status' }, '')
    expect(h.get('x-hub-signature')).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('emits a timestamp and nonce for replay rejection', async () => {
    const h = await headersFor({ method: 'POST', path: '/deploy', body: { a: 1 } }, '')
    const ts = Number(h.get('x-hub-timestamp'))
    expect(ts).toBeGreaterThan(Date.now() / 1000 - 60)
    expect(h.get('x-hub-nonce')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('binds the signature to the path — same body, different path, different sig', async () => {
    const a = await headersFor({ method: 'POST', path: '/deploy', body: { x: 1 } }, '')
    const b = await headersFor({ method: 'POST', path: '/destroy', body: { x: 1 } }, '')
    expect(a.get('x-hub-signature')).not.toBe(b.get('x-hub-signature'))
  })

  it('binds the signature to the method', async () => {
    const a = await headersFor({ method: 'POST',   path: '/x' }, '')
    const b = await headersFor({ method: 'DELETE', path: '/x' }, '')
    expect(a.get('x-hub-signature')).not.toBe(b.get('x-hub-signature'))
  })

  it('honours a custom header prefix', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = outpostTarget({
        address: s.url,
        auth: { type: 'hmac', ref: 'AGENT_SECRET', header_prefix: 'X-Frontier' },
      })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      await t.send({ target: target.id, method: 'POST', path: '/deploy' })

      expect(s.seen[0].headers.get('x-frontier-signature')).toMatch(/^sha256=/)
      expect(s.seen[0].headers.get('x-hub-signature')).toBeNull()
    } finally { s.stop() }
  })
})

// ─── Unix transport shares the HTTP contract (§3.1) ──────────

describe('unix transport', () => {
  const SOCK = `/tmp/conduit-test-${process.pid}.sock`

  it('applies auth, keeps the method, and passes caller headers', async () => {
    const seen: Request[] = []
    const server = Bun.serve({
      unix: SOCK,
      fetch(req) { seen.push(req.clone()); return Response.json({ ok: true }) }
    })

    try {
      const target = outpostTarget({ protocol: 'unix', address: SOCK, kind: 'local' })
      const t = new UnixTransport(target, secrets())

      const result = await t.send({
        target:  target.id,
        method:  'DELETE',
        path:    '/servers/42',
        headers: { 'X-Custom': '1' },
      })

      expect(result.error).toBeNull()
      const req = seen[0]
      expect(req.method).toBe('DELETE')                          // was forced to POST
      expect(new URL(req.url).pathname).toBe('/servers/42')      // was `/${path ?? method}`
      expect(req.headers.get('x-custom')).toBe('1')              // was dropped
      expect(req.headers.get('x-hub-signature')).toMatch(/^sha256=/) // was absent entirely
    } finally { server.stop(true) }
  })

  it('sends the body unwrapped, exactly like HTTP', async () => {
    const bodies: string[] = []
    const server = Bun.serve({
      unix: SOCK,
      async fetch(req) { bodies.push(await req.text()); return Response.json({ ok: true }) }
    })

    try {
      const target = outpostTarget({ protocol: 'unix', address: SOCK, kind: 'local' })
      const t = new UnixTransport(target, secrets())

      await t.send({ target: target.id, method: 'POST', path: '/deploy', body: { image: 'v2' } })

      // Was re-wrapped as {"method":"deploy","body":{...}}
      expect(JSON.parse(bodies[0])).toEqual({ image: 'v2' })
    } finally { server.stop(true) }
  })

  it('fails closed when the credential cannot be resolved', async () => {
    const target = outpostTarget({ protocol: 'unix', address: SOCK, kind: 'local' })
    const t = new UnixTransport(target, createNullResolver())

    const result = await t.send({ target: target.id, method: 'POST', path: '/deploy' })
    expect(result.error!.kind).toBe('auth_failed')
  })

  it('streaming throws rather than yielding nothing', async () => {
    const target = outpostTarget({ protocol: 'unix', address: SOCK, kind: 'local' })
    const t = new UnixTransport(target, secrets())

    await expect(
      t.stream({ target: target.id, method: 'logs' })[Symbol.asyncIterator]().next()
    ).rejects.toBeInstanceOf(ConduitStreamError)
  })
})

// ─── Unimplemented protocols ─────────────────────────────────

describe('NotImplementedTransport', () => {
  it('send() fails immediately and clearly for an ssh target', async () => {
    const c = createConduit({ credentials: secrets() })
    await c.init()
    await c.register(outpostTarget({ protocol: 'ssh', address: 'ssh://host' }))

    const result = await c.send({ target: 'outpost:srv-test', method: 'POST', path: '/x' })

    expect(result.error!.kind).toBe('not_implemented')
    expect(result.error!.retryable).toBe(false)
    expect(result.error!.message).toContain('ssh')
  })

  it('stream() throws rather than yielding nothing', async () => {
    const c = createConduit({ credentials: secrets() })
    await c.init()
    await c.register(outpostTarget({ protocol: 'nats', address: 'nats://host' }))

    await expect(
      c.stream({ target: 'outpost:srv-test', method: 'logs' })[Symbol.asyncIterator]().next()
    ).rejects.toBeInstanceOf(ConduitStreamError)
  })
})

// ─── Heartbeats (touch) ──────────────────────────────────────

describe('conduit.touch()', () => {
  // touch() existed on the store, was tested, and was called by nothing —
  // last_seen_at was permanently whatever registration set it to.
  it('refreshes last_seen_at without re-registering', async () => {
    const c = createConduit({ credentials: secrets() })
    await c.init()
    await c.register(outpostTarget({ last_seen_at: null }))

    const before = Date.now()
    await c.touch('outpost:srv-test')

    const found = (await c.resolve('outpost:srv-test'))!
    expect(found.last_seen_at).toBeGreaterThanOrEqual(before)
  })

  it('does not disturb the rest of the descriptor', async () => {
    const c = createConduit({ credentials: secrets() })
    await c.init()
    await c.register(outpostTarget({ registered_at: 1000 }))
    await c.touch('outpost:srv-test')

    const found = (await c.resolve('outpost:srv-test'))!
    expect(found.registered_at).toBe(1000)
    expect(found.address).toBe('http://10.0.0.5:7700')
  })

  it('is a no-op for an unknown target', async () => {
    const c = createConduit()
    await c.init()
    await expect(c.touch('outpost:never-existed')).resolves.toBeUndefined()
  })

  it('a restart does not wipe heartbeat state for a static target', async () => {
    const db     = new Database(':memory:')
    const target = providerTarget({ last_seen_at: null })

    const first = createConduit({ store: createSQLiteStore(db), targets: [target] })
    await first.init()
    await first.touch('provider:hetzner')
    const seenAt = (await first.resolve('provider:hetzner'))!.last_seen_at
    expect(seenAt).not.toBeNull()

    // Rebooting re-applies opts.targets, whose last_seen_at is null.
    // That used to overwrite the live heartbeat with null on every restart.
    const second = createConduit({ store: createSQLiteStore(db), targets: [target] })
    await second.init()

    expect((await second.resolve('provider:hetzner'))!.last_seen_at).toBe(seenAt)
  })
})

// ─── Retry observability and budget (§2.7) ───────────────────

describe('retry backoff, deadline and onRetry', () => {
  it('fires onRetry once per retried attempt', async () => {
    const seen: Array<{ kind: string; attempt: number }> = []
    const s = recorder(() => new Response('boom', { status: 500 }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 2,
        observers: { onRetry: (_req, err, attempt) => seen.push({ kind: err.kind, attempt }) },
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET', path: '/servers' })

      expect(seen).toEqual([
        { kind: 'server_error', attempt: 1 },
        { kind: 'server_error', attempt: 2 },
      ])
    } finally { s.stop() }
  })

  it('onRetry receives the original request', async () => {
    const paths: (string | undefined)[] = []
    const s = recorder(() => new Response('boom', { status: 500 }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 1,
        observers: { onRetry: (req) => paths.push(req.path) },
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET', path: '/servers' })
      expect(paths).toEqual(['/servers'])
    } finally { s.stop() }
  })

  it('a total deadline caps the whole call, retries included', async () => {
    let hits = 0
    const s = recorder(() => { hits++; return new Response('boom', { status: 500 }) })

    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), {
        retry_limit: 10,
        deadline_ms: 600,
      })

      const started = performance.now()
      const result  = await t.send({ target: target.id, method: 'GET' })
      const elapsed = performance.now() - started

      expect(result.error).not.toBeNull()
      expect(elapsed).toBeLessThan(2000)   // not 10 attempts' worth of backoff
      expect(hits).toBeLessThan(10)
    } finally { s.stop() }
  })

  it('backoff is jittered rather than fixed', async () => {
    // Same nominal backoff, sampled repeatedly — lockstep retry waves are
    // what jitter exists to prevent, so identical delays every time is a bug.
    const delays = new Set<number>()
    const s = recorder(() => new Response('boom', { status: 500 }))

    try {
      const target = providerTarget({ address: s.url })
      for (let i = 0; i < 6; i++) {
        const t = new HttpTransport(target, secrets(), { retry_limit: 1 })
        const started = performance.now()
        await t.send({ target: target.id, method: 'GET' })
        delays.add(Math.round(performance.now() - started))
      }
      expect(delays.size).toBeGreaterThan(1)
    } finally { s.stop() }
  })
})

// ─── Unknown methods (§3.3) ──────────────────────────────────

describe('unknown HTTP methods', () => {
  it('a typo is rejected rather than silently sent as POST', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      const result = await t.send({ target: target.id, method: 'GTE', path: '/servers' })

      expect(result.error!.kind).toBe('invalid_request')
      expect(result.error!.retryable).toBe(false)
      expect(s.seen).toHaveLength(0)   // was: POST /servers against a control plane
    } finally { s.stop() }
  })

  it('protocol-specific methods still work on a websocket target', async () => {
    // 'logs' is meaningless to HTTP but valid over the WS wire protocol
    const stub = new StubTransport(outpostTarget(), 'websocket')
    stub.mockStream('/logs', ['line-1'])

    const chunks: unknown[] = []
    for await (const c of stub.stream({ target: 'outpost:srv-test', method: 'logs', path: '/logs' })) {
      chunks.push(c.data)
    }
    expect(chunks).toEqual(['line-1'])
  })
})

// ─── Stream lifecycle observers ──────────────────────────────

describe('stream lifecycle observers', () => {
  it('onStreamStart and onStreamEnd report the chunk count', async () => {
    const events: string[] = []
    const { conduit, stubs } = await createTestConduit(
      { 'outpost:srv-abc': {} },
      {
        observers: {
          onStreamStart: () => events.push('start'),
          onStreamEnd:   (_req, chunks) => events.push(`end:${chunks}`),
        }
      }
    )
    stubs['outpost:srv-abc'].mockStream('/logs', ['a', 'b', 'c'])

    for await (const _ of conduit.stream({ target: 'outpost:srv-abc', method: 'logs', path: '/logs' })) {
      // drain
    }

    expect(events).toEqual(['start', 'end:3'])
  })

  it('a stream that fails mid-flight reports through onError', async () => {
    const errors: ConduitError[] = []
    const { conduit, stubs } = await createTestConduit(
      { 'outpost:srv-abc': {} },
      { observers: { onError: (_req, err) => errors.push(err) } }
    )
    stubs['outpost:srv-abc'].mockError('/logs', 'stream_error', { message: 'outpost vanished' })

    await expect((async () => {
      for await (const _ of conduit.stream({ target: 'outpost:srv-abc', method: 'logs', path: '/logs' })) {
        // never reached
      }
    })()).rejects.toBeInstanceOf(ConduitStreamError)

    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('stream_error')
  })
})

// ─── Circuit breaker (§2.7) ──────────────────────────────────

describe('circuit breaker', () => {
  it('opens after the failure threshold and sheds without dispatching', async () => {
    let hits = 0
    const s = recorder(() => { hits++; return new Response('boom', { status: 500 }) })

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 3, reset_ms: 60_000 },
      })
      await c.init()

      for (let i = 0; i < 3; i++) {
        await c.send({ target: target.id, method: 'GET', path: '/servers' })
      }
      expect(hits).toBe(3)

      // Fourth call must not reach the network at all
      const shed = await c.send({ target: target.id, method: 'GET', path: '/servers' })
      expect(shed.error!.kind).toBe('circuit_open')
      expect(hits).toBe(3)
    } finally { s.stop() }
  })

  it('a success resets the failure count', async () => {
    let fail = true
    const s = recorder(() => fail
      ? new Response('boom', { status: 500 })
      : Response.json({ ok: true }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 3, reset_ms: 60_000 },
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })
      await c.send({ target: target.id, method: 'GET' })
      fail = false
      await c.send({ target: target.id, method: 'GET' })   // resets
      fail = true
      await c.send({ target: target.id, method: 'GET' })
      await c.send({ target: target.id, method: 'GET' })

      // Only 2 consecutive failures since the reset — still closed
      const next = await c.send({ target: target.id, method: 'GET' })
      expect(next.error!.kind).toBe('server_error')
    } finally { s.stop() }
  })

  it('admits a trial request once the reset window elapses, and closes on success', async () => {
    let fail = true
    const s = recorder(() => fail
      ? new Response('boom', { status: 500 })
      : Response.json({ ok: true }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 2, reset_ms: 80 },
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })
      await c.send({ target: target.id, method: 'GET' })
      expect((await c.send({ target: target.id, method: 'GET' })).error!.kind).toBe('circuit_open')

      await new Promise(r => setTimeout(r, 120))
      fail = false

      const trial = await c.send({ target: target.id, method: 'GET' })
      expect(trial.error).toBeNull()

      // Closed again — subsequent calls flow
      expect((await c.send({ target: target.id, method: 'GET' })).error).toBeNull()
    } finally { s.stop() }
  })

  // A credential that will not resolve is a local bug. Counting it would
  // open a breaker that no amount of waiting can heal, and bury the real
  // error behind circuit_open.
  it('local faults do not trip the breaker', async () => {
    const s = recorder(() => Response.json({ ok: true }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: createNullResolver(),   // every ref fails
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 2, reset_ms: 60_000 },
      })
      await c.init()

      for (let i = 0; i < 4; i++) {
        const r = await c.send({ target: target.id, method: 'GET' })
        expect(r.error!.kind).toBe('auth_failed')   // never circuit_open
      }
      expect(c.stats().breakers['provider:hetzner']).toBeUndefined()
    } finally { s.stop() }
  })

  it('deregistering a target clears its breaker state', async () => {
    const s = recorder(() => new Response('boom', { status: 500 }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 2, reset_ms: 60_000 },
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })
      await c.send({ target: target.id, method: 'GET' })
      expect(c.stats().breakers[target.id].state).toBe('open')

      await c.deregister(target.id)
      expect(c.stats().breakers[target.id]).toBeUndefined()
    } finally { s.stop() }
  })

  it('stats report only unhealthy targets', async () => {
    const s = recorder(() => new Response('boom', { status: 500 }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 2, reset_ms: 60_000 },
      })
      await c.init()

      expect(c.stats().breakers).toEqual({})   // healthy and idle → omitted

      await c.send({ target: target.id, method: 'GET' })
      await c.send({ target: target.id, method: 'GET' })

      const b = c.stats().breakers[target.id]
      expect(b.state).toBe('open')
      expect(b.failures).toBe(2)
      expect(b.opened_at).not.toBeNull()
    } finally { s.stop() }
  })

  it('is disabled when failure_threshold is 0', async () => {
    let hits = 0
    const s = recorder(() => { hits++; return new Response('boom', { status: 500 }) })

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { failure_threshold: 0 },
      })
      await c.init()

      for (let i = 0; i < 6; i++) await c.send({ target: target.id, method: 'GET' })
      expect(hits).toBe(6)
    } finally { s.stop() }
  })
})

// ─── Concurrency cap ─────────────────────────────────────────

describe('per-target concurrency cap', () => {
  it('sheds beyond the cap instead of queueing', async () => {
    let inFlight = 0, peak = 0
    const s = recorder(async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 60))
      inFlight--
      return Response.json({ ok: true })
    })

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { max_concurrent: 2 },
      })
      await c.init()

      const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
        c.send({ target: target.id, method: 'GET' })
      ))

      const shed = results.filter(r => r.error?.kind === 'overloaded')
      expect(shed.length).toBe(3)
      expect(peak).toBeLessThanOrEqual(2)
    } finally { s.stop() }
  })

  it('frees slots as requests complete', async () => {
    const s = recorder(() => Response.json({ ok: true }))

    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(),
        targets:     [target],
        retry_limit: 0,
        resilience:  { max_concurrent: 1 },
      })
      await c.init()

      // Sequential calls all succeed — the cap is on concurrency, not rate
      for (let i = 0; i < 4; i++) {
        expect((await c.send({ target: target.id, method: 'GET' })).error).toBeNull()
      }
    } finally { s.stop() }
  })
})

// ─── Response validation (§2.8) ──────────────────────────────

describe('response validation', () => {
  const isServer = {
    validate(data: unknown) {
      const d = data as { id?: unknown }
      return typeof d?.id === 'number'
        ? { ok: true as const, value: d as { id: number } }
        : { ok: false as const, errors: ['expected numeric `id`'] }
    }
  }

  it('passes a valid payload through', async () => {
    const s = recorder(() => Response.json({ id: 42 }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({ credentials: secrets(), targets: [target], retry_limit: 0 })
      await c.init()

      const r = await c.send<{ id: number }>({
        target: target.id, method: 'GET', validate: isServer,
      })
      expect(r.error).toBeNull()
      expect(r.data!.id).toBe(42)
    } finally { s.stop() }
  })

  // A 200 carrying {"error": …} used to type and behave as a success.
  it('rejects a well-formed 200 that is the wrong shape', async () => {
    const s = recorder(() => Response.json({ error: 'quota exceeded' }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({ credentials: secrets(), targets: [target], retry_limit: 0 })
      await c.init()

      const r = await c.send({ target: target.id, method: 'GET', validate: isServer })

      expect(r.data).toBeNull()
      expect(r.error!.kind).toBe('server_error')
      expect(r.error!.retryable).toBe(false)
      expect(r.error!.message).toContain('numeric `id`')
      expect(r.error!.raw).toEqual({ error: 'quota exceeded' })
    } finally { s.stop() }
  })

  it('a validation failure counts as an error in stats', async () => {
    const s = recorder(() => Response.json({ nope: true }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({ credentials: secrets(), targets: [target], retry_limit: 0 })
      await c.init()

      await c.send({ target: target.id, method: 'GET', validate: isServer })
      expect(c.stats().requests.error).toBe(1)
      expect(c.stats().requests.success).toBe(0)
    } finally { s.stop() }
  })

  it('is skipped when the request already failed', async () => {
    let validated = false
    const s = recorder(() => new Response('nope', { status: 404 }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({ credentials: secrets(), targets: [target], retry_limit: 0 })
      await c.init()

      const r = await c.send({
        target: target.id, method: 'GET',
        validate: { validate() { validated = true; return { ok: false as const, errors: [] } } },
      })
      expect(r.error!.kind).toBe('server_error')
      expect(validated).toBe(false)
    } finally { s.stop() }
  })
})

// ─── Trace context (§4) ──────────────────────────────────────

describe('trace context', () => {
  it('attaches a W3C traceparent and correlation id', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(), targets: [target], retry_limit: 0,
        trace: createTraceContext(),
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })

      const tp = s.seen[0].headers.get('traceparent')!
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
      expect(s.seen[0].headers.get('x-request-id')).toBe(tp.split('-')[1])
    } finally { s.stop() }
  })

  it('continues an existing trace rather than starting a new one', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const traceId = 'a'.repeat(32)
      const c = createConduit({
        credentials: secrets(), targets: [target], retry_limit: 0,
        trace: createTraceContext({ current: () => ({ trace_id: traceId }) }),
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })
      expect(s.seen[0].headers.get('traceparent')).toContain(traceId)
    } finally { s.stop() }
  })

  it('a malformed upstream trace id is replaced, not propagated', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(), targets: [target], retry_limit: 0,
        trace: createTraceContext({ current: () => ({ trace_id: 'not-hex' }) }),
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })
      expect(s.seen[0].headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-/)
      expect(s.seen[0].headers.get('traceparent')).not.toContain('not-hex')
    } finally { s.stop() }
  })

  it('a new span id is minted per call', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(), targets: [target], retry_limit: 0,
        trace: createTraceContext({ current: () => ({ trace_id: 'b'.repeat(32) }) }),
      })
      await c.init()

      await c.send({ target: target.id, method: 'GET' })
      await c.send({ target: target.id, method: 'GET' })

      const spanOf = (i: number) => s.seen[i].headers.get('traceparent')!.split('-')[2]
      expect(spanOf(0)).not.toBe(spanOf(1))
    } finally { s.stop() }
  })

  it('caller headers override trace headers, and auth overrides both', async () => {
    const s = recorder(() => Response.json({ ok: true }))
    try {
      const target = providerTarget({ address: s.url })
      const c = createConduit({
        credentials: secrets(), targets: [target], retry_limit: 0,
        trace: createTraceContext(),
      })
      await c.init()

      await c.send({
        target: target.id, method: 'GET',
        headers: { traceparent: 'caller-supplied', Authorization: 'Bearer ATTACKER' },
      })

      expect(s.seen[0].headers.get('traceparent')).toBe('caller-supplied')
      expect(s.seen[0].headers.get('authorization')).toBe('Bearer htz-token-abc')
    } finally { s.stop() }
  })
})

// ─── Observer safety ─────────────────────────────────────────

describe('a throwing observer does not take down the caller', () => {
  it('onRequest', async () => {
    const { conduit } = await createTestConduit(
      { 'outpost:srv-abc': { '/ping': { pong: true } } },
      { observers: { onRequest() { throw new Error('boom') } } }
    )

    const result = await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ pong: true })
  })

  it('onResponse', async () => {
    const { conduit } = await createTestConduit(
      { 'outpost:srv-abc': { '/ping': { pong: true } } },
      { observers: { onResponse() { throw new Error('boom') } } }
    )

    const result = await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })
    expect(result.error).toBeNull()
  })

  it('onError', async () => {
    const c = createConduit({ observers: { onError() { throw new Error('boom') } } })
    await c.init()

    const result = await c.send({ target: 'outpost:missing', method: 'POST' })
    expect(result.error!.kind).toBe('target_not_found')
  })

  it('an async observer that rejects is caught, not left unhandled', async () => {
    const { conduit } = await createTestConduit(
      { 'outpost:srv-abc': { '/ping': { pong: true } } },
      { observers: { onResponse: async () => { throw new Error('async boom') } } }
    )

    const result = await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })
    expect(result.error).toBeNull()
    // Give the rejection a tick to surface if it were unhandled
    await new Promise(r => setTimeout(r, 10))
  })

  it('an async observer is not awaited by send()', async () => {
    let observerDone = false
    const { conduit } = await createTestConduit(
      { 'outpost:srv-abc': { '/ping': { pong: true } } },
      {
        observers: {
          onResponse: async () => {
            await new Promise(r => setTimeout(r, 200))
            observerDone = true
          }
        }
      }
    )

    await conduit.send({ target: 'outpost:srv-abc', method: 'POST', path: '/ping' })
    // send() returned without waiting for the 200ms observer
    expect(observerDone).toBe(false)
  })

  it('onRegistered and onDeregistered', async () => {
    const c = createConduit({
      observers: {
        onRegistered()   { throw new Error('boom') },
        onDeregistered() { throw new Error('boom') },
      }
    })
    await c.init()

    await expect(c.register(outpostTarget())).resolves.toBeUndefined()
    await expect(c.deregister('outpost:srv-test')).resolves.toBeUndefined()
  })
})

// ─── Junction plugin wiring ──────────────────────────────────

// Everything that requires a real App — lifecycle ordering, the metrics
// reach-in, service routing, app-level hooks — lives in
// junction-integration.test.ts. Driving a hand-rolled `{ _metricsSources:
// new Map() }` here would assert the fake's behaviour, not Junction's, and
// would keep passing after a breaking change on either side.
describe('conduit Junction plugin', () => {

  it('has the correct plugin shape', () => {
    const plugin = conduitPlugin()
    expect(plugin.name).toBe('conduit')
    expect(typeof plugin.register).toBe('function')
    expect(typeof plugin.boot).toBe('function')
    expect(typeof plugin.shutdown).toBe('function')
    expect(typeof plugin.ready).toBe('function')
  })

  // A minimal stand-in for the two seams register() uses — app.claim() for the
  // namespace and app.registerMetricsSource() for /metrics.
  const fakeApp = (): Record<string, unknown> => {
    const sources = new Map<string, () => unknown>()
    const a: Record<string, unknown> = { _metricsSources: sources }
    a.claim = (name: string, value: unknown) => {
      if (a[name] !== undefined) throw new Error(`already claimed: ${name}`)
      a[name] = value
    }
    a.registerMetricsSource = (name: string, fn: () => unknown) => { sources.set(name, fn) }
    return a
  }

  it('each call to the factory produces an independent instance', () => {
    const a = fakeApp()
    const b = fakeApp()

    conduitPlugin().register!(a as never)
    conduitPlugin().register!(b as never)

    expect(a.conduit).toBeDefined()
    expect(b.conduit).toBeDefined()
    expect(a.conduit).not.toBe(b.conduit)
  })

  it('ONE plugin object configured on two apps still gives each its own', () => {
    // The instance used to be created at factory time, so a reused plugin
    // object handed both apps the same conduit and the second register()
    // overwrote the first's app.conduit. It is created per register() now.
    const plugin = conduitPlugin()
    const a = fakeApp()
    const b = fakeApp()

    plugin.register!(a as never)
    plugin.register!(b as never)

    expect(a.conduit).toBeDefined()
    expect(b.conduit).toBeDefined()
    expect(a.conduit).not.toBe(b.conduit)
  })

})

// ─── Body encoding ───────────────────────────────────────────
//
// Conduit could only ever speak JSON (`FJS-556`), which is not a gap one vendor
// has: Stripe, PayPal, Twilio and every OAuth token endpoint take
// `application/x-www-form-urlencoded`. The trap it replaced is that
// `Content-Type` was already overridable through `req.headers` while the body
// was not — so a caller could say `form` and still send `{"amount":500}`, which
// looks configured and is not.

describe('body encoding — the encoder', () => {
  it('nests objects with brackets and INDEXES arrays', () => {
    // Indexed rather than `a[]`, because `a[]` cannot express two fields of one
    // item: two `a[][price]` pairs read as one item with two prices.
    expect(encodeBody({ items: [{ price: 'p1', qty: 2 }, { price: 'p2' }] }, 'form'))
      .toBe('items%5B0%5D%5Bprice%5D=p1&items%5B0%5D%5Bqty%5D=2&items%5B1%5D%5Bprice%5D=p2')
  })

  it('does not quote a string that looks like a number', () => {
    // The reason `@frontierjs/toolbelt/query` is not reused: its grammar quotes
    // this so it can round-trip back through parseValue. A provider stores the
    // quotes.
    expect(encodeBody({ code: '5', n: 5 }, 'form')).toBe('code=5&n=5')
  })

  it('drops undefined and sends null as an empty value', () => {
    // Absent and "not stated" are the same on a form; null is a provider's
    // "clear this", and dropping it would silently make it "leave alone".
    expect(encodeBody({ a: null, b: undefined, c: false }, 'form')).toBe('a=&c=false')
  })

  it('percent-encodes both halves of a pair', () => {
    expect(encodeBody({ 'a b': 'x&y=z' }, 'form')).toBe('a%20b=x%26y%3Dz')
  })

  it('refuses a non-object body rather than double-encoding a string', () => {
    // A pre-encoded string was the obvious workaround and is the trap:
    // JSON.stringify('a=1') is '"a=1"', quotes included.
    expect(() => encodeBody('amount=500', 'form')).toThrow(/needs an object body/)
  })

  it('json is unchanged', () => {
    expect(encodeBody({ amount: 500 }, 'json')).toBe('{"amount":500}')
  })
})

describe('body encoding — over a real socket', () => {
  // A recorder of its own: the shared `recorder()` keeps a cloned Request, and
  // reading a clone's body never resolves here. The bytes are taken inside the
  // handler instead, which is also what the assertion is about.
  function bodies(reply: () => Response = () => Response.json({ ok: true })) {
    const seen: Array<{ body: string, headers: Headers, url: string }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ body: await req.text(), headers: req.headers, url: req.url })
        return reply()
      },
    })
    return { seen, url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
  }

  it('a target declaring form sends form bytes and says so', async () => {
    const s = bodies()
    try {
      const target = providerTarget({ address: s.url, encoding: 'form' })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })

      const result = await t.send({
        target: target.id, method: 'POST',
        body: { amount: 500, currency: 'usd', metadata: { order_id: 'ORD-1' } },
      })

      expect(result.error).toBeNull()
      expect(s.seen[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded')
      expect(s.seen[0].body).toBe('amount=500&currency=usd&metadata%5Border_id%5D=ORD-1')
    } finally { s.stop() }
  })

  it('a target declaring nothing is still JSON', async () => {
    const s = bodies()
    try {
      const target = providerTarget({ address: s.url })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      const result = await t.send({ target: target.id, method: 'POST', body: { amount: 500 } })

      expect(result.error).toBeNull()
      expect(s.seen[0].headers.get('content-type')).toBe('application/json')
      expect(s.seen[0].body).toBe('{"amount":500}')
    } finally { s.stop() }
  })

  it('the bytes follow the TARGET even when a caller states another content-type', async () => {
    // `...req.headers` is spread after the default, so a caller can still set
    // the header — that precedence is documented. What it can no longer do is
    // disagree with the bytes, which is the shape that made `form` look
    // configurable before it was.
    const s = bodies()
    try {
      const target = providerTarget({ address: s.url, encoding: 'form' })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      await t.send({
        target: target.id, method: 'POST', body: { a: 1 },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(s.seen[0].body).toBe('a=1')
    } finally { s.stop() }
  })

  it('the HMAC signature is over the FORM bytes, not a JSON copy of them', async () => {
    // The whole reason encoding lives in the transport. An encoder in a caller
    // or a connector would hash a different string, and every signed form
    // request would fail as an invalid credential (`FJS-D153`).
    const s = bodies()
    try {
      const target = providerTarget({
        address: s.url, encoding: 'form',
        auth: { type: 'hmac', ref: 'AGENT_SECRET', header_prefix: 'X-Psp' },
      })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      const result = await t.send({ target: target.id, method: 'POST', body: { amount: 500 } })
      expect(result.error).toBeNull()

      const got = s.seen[0]
      expect(got.body).toBe('amount=500')

      const check = await verifyRequest({
        secret:  'test-secret',
        method:  'POST',
        path:    new URL(got.url).pathname,
        body:    got.body,
        headers: got.headers,
        prefix:  'X-Psp',
        now:     Math.floor(Date.now() / 1000),
      })
      // Reported rather than asserted bare: `{ ok: false, reason }` is the shape,
      // so a bare toBe(true) says "false" about a signature that is wrong for a
      // named reason.
      expect(check).toEqual({ ok: true })

      // The negative control. Same headers, the JSON the body WOULD have been —
      // if this also verified, the assertion above would be about nothing.
      const wrongBytes = await verifyRequest({
        secret:  'test-secret',
        method:  'POST',
        path:    new URL(got.url).pathname,
        body:    JSON.stringify({ amount: 500 }),
        headers: got.headers,
        prefix:  'X-Psp',
        now:     Math.floor(Date.now() / 1000),
      })
      expect(wrongBytes.ok).toBe(false)
    } finally { s.stop() }
  })

  it('a body that will not encode is reported, and nothing is sent', async () => {
    // A pre-encoded string is the workaround somebody will reach for, and it is
    // exactly wrong: under JSON it would go out as '"amount=500"'.
    const s = bodies()
    try {
      const target = providerTarget({ address: s.url, encoding: 'form' })
      const t = new HttpTransport(target, secrets(), { retry_limit: 0 })
      const result = await t.send({ target: target.id, method: 'POST', body: 'amount=500' })
      expect(result.error).not.toBeNull()
      expect(result.error!.kind).toBe('invalid_request')
      expect(s.seen.length).toBe(0)
    } finally { s.stop() }
  })
})
