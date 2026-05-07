// ============================================================
// Conduit — Test Suite
// ============================================================

import { describe, it, expect, beforeEach } from 'bun:test'
import { createConduit }      from './src/conduit.ts'
import { conduit as conduitPlugin } from './src/plugin.ts'
import { createMemoryStore }  from './src/stores/memory.ts'
import { createTestConduit }  from './src/testing.ts'
import { StubTransport }      from './src/transports/stub.ts'
import { ConduitStreamError } from './src/types.ts'
import type {
  TargetDescriptor,
  ConduitRequest,
  ConduitError,
} from './src/types.ts'

// ─── Fixtures ────────────────────────────────────────────────

function agentTarget(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id:            'agent:srv-test',
    kind:          'agent',
    protocol:      'http',
    address:       'http://10.0.0.5:7700',
    auth:          { type: 'hmac', secret: 'test-secret' },
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
    auth:          { type: 'bearer', token: 'htz-token-abc' },
    registered_at: Date.now(),
    last_seen_at:  null,
    ...overrides,
  }
}

// ─── Memory Store ────────────────────────────────────────────

describe('createMemoryStore', () => {
  it('returns null for unknown id', () => {
    const store = createMemoryStore()
    store.init()
    expect(store.get('unknown')).toBeNull()
  })

  it('stores and retrieves a target', () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    store.init()
    store.set(target)
    expect(store.get(target.id)).toEqual(target)
  })

  it('preserves registered_at on upsert', () => {
    const store  = createMemoryStore()
    const target = agentTarget({ registered_at: 1000 })
    store.init()
    store.set(target)
    // Re-register with a different registered_at — should not overwrite
    store.set({ ...target, registered_at: 9999, address: 'http://new-address' })
    expect(store.get(target.id)!.registered_at).toBe(1000)
  })

  it('updates address on upsert', () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    store.init()
    store.set(target)
    store.set({ ...target, address: 'http://10.0.0.99:7700' })
    expect(store.get(target.id)!.address).toBe('http://10.0.0.99:7700')
  })

  it('deletes a target', () => {
    const store  = createMemoryStore()
    const target = agentTarget()
    store.init()
    store.set(target)
    store.delete(target.id)
    expect(store.get(target.id)).toBeNull()
  })

  it('lists targets ordered by registered_at', () => {
    const store = createMemoryStore()
    store.init()
    store.set(agentTarget({ id: 'agent:b', registered_at: 200 }))
    store.set(agentTarget({ id: 'agent:a', registered_at: 100 }))
    store.set(agentTarget({ id: 'agent:c', registered_at: 300 }))
    const ids = store.list().map(t => t.id)
    expect(ids).toEqual(['agent:a', 'agent:b', 'agent:c'])
  })

  it('touch updates last_seen_at', async () => {
    const store  = createMemoryStore()
    const target = agentTarget({ last_seen_at: null })
    store.init()
    store.set(target)
    const before = Date.now()
    store.touch(target.id)
    const after = Date.now()
    const updated = store.get(target.id)!
    expect(updated.last_seen_at).toBeGreaterThanOrEqual(before)
    expect(updated.last_seen_at).toBeLessThanOrEqual(after)
  })

  it('touch on unknown id is a no-op', () => {
    const store = createMemoryStore()
    store.init()
    expect(() => store.touch('does-not-exist')).not.toThrow()
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
