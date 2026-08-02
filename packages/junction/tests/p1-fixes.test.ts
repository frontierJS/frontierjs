// tests/p1-fixes.test.ts
// ─────────────────────────────────────────────────────────────────────────
// Regression tests for the P1 performance pass (2026-07-18):
//
//   1. app.service() callers are memoized (stable identity, still lazy).
//   2. Event bus exposes hasListeners() — the telemetry fast-path gate.
//   3. Internal-call auth principals are frozen shared refs, not clones.
//   4. Channel event frames use one wire format; undefined data stays
//      valid JSON.
//   5. Static gzip output is cached and byte-identical across requests.
//   6. The OpenAPI spec is cached between requests and busted by late
//      service registration.
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'bun:test'
import { createTestApp, request, createService } from '../index.ts'
import { createEventBus } from '../src/events/index.ts'
import { encodeEventFrame } from '../src/transport/channels.ts'
import { serveStatic } from '../src/transport/static.ts'
import { openapi } from '../src/plugins/openapi/index.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── 1. Memoized service callers ──────────────────────────────────────────

describe('P1: service caller memoization', () => {

  it('returns the same caller object for the same name', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'a', async find() { return [1] } })],
    })
    expect(app.service('a')).toBe(app.service('a'))
    expect(app.service('a')).not.toBe(app.service('b'))
  })

  it('caller obtained before registration works after it', async () => {
    const app = await createTestApp({})
    const early = app.service('late')                       // service doesn't exist yet
    app.services.register(createService({ name: 'late', async find() { return [42] } }))
    const result = await early.find()
    expect((result as { data?: unknown[] })?.data ?? result).toBeDefined()
  })
})

// ─── 2. hasListeners ──────────────────────────────────────────────────────

describe('P1: event bus hasListeners', () => {

  it('reports listener presence accurately', () => {
    const bus = createEventBus()
    expect(bus.hasListeners()).toBe(false)
    expect(bus.hasListeners('x')).toBe(false)

    const off = bus.on('x', () => {})
    expect(bus.hasListeners()).toBe(true)
    expect(bus.hasListeners('x')).toBe(true)
    expect(bus.hasListeners('y')).toBe(false)

    off()
    expect(bus.hasListeners('x')).toBe(false)
  })

  it('onAny counts as a listener for every event', () => {
    const bus = createEventBus()
    const off = bus.onAny(() => {})
    expect(bus.hasListeners('anything')).toBe(true)
    off()
    expect(bus.hasListeners('anything')).toBe(false)
  })
})

// ─── 3. Frozen auth principal ─────────────────────────────────────────────

describe('P1: frozen shared auth principal', () => {

  it('internal calls receive a frozen user object', async () => {
    let seenFrozen = false
    const app = await createTestApp({
      services: [() => createService({
        name: 'whoami',
        async find(ctx) {
          seenFrozen = ctx.auth.user !== null && Object.isFrozen(ctx.auth.user)
          return [{ ok: true }]
        },
      })],
    })
    await app.service('whoami').find(undefined, {
      auth: { user: { userId: 'u1', userType: 'user', authMethod: 'session' } as never },
    })
    expect(seenFrozen).toBe(true)
  })
})

// ─── 4. One wire format for channel frames ────────────────────────────────

describe('P1: channel frame encoding', () => {

  it('produces valid JSON even for undefined data', () => {
    const frame = encodeEventFrame('ping', undefined)
    const parsed = JSON.parse(frame)          // old template-string path emitted `"data":undefined`
    expect(parsed.type).toBe('event')
    expect(parsed.event).toBe('ping')
    expect('data' in parsed).toBe(false)
  })

  it('round-trips normal payloads', () => {
    const parsed = JSON.parse(encodeEventFrame('msg', { a: 1 }))
    expect(parsed.data).toEqual({ a: 1 })
  })
})

// ─── 5. Static gzip cache ─────────────────────────────────────────────────

describe('P1: static gzip caching', () => {

  it('serves identical compressed bytes across repeated requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junction-gzip-'))
    try {
      const content = 'x'.repeat(4096) + 'hello world'
      writeFileSync(join(dir, 'big.txt'), content)

      const req = () => new Request('http://localhost/big.txt', {
        headers: { 'accept-encoding': 'gzip' },
      })

      const r1 = await serveStatic(req(), '/big.txt', { root: dir })
      const r2 = await serveStatic(req(), '/big.txt', { root: dir })
      expect(r1?.headers.get('content-encoding')).toBe('gzip')
      expect(r2?.headers.get('content-encoding')).toBe('gzip')

      const b1 = new Uint8Array(await r1!.arrayBuffer())
      const b2 = new Uint8Array(await r2!.arrayBuffer())
      expect(b1).toEqual(b2)

      // Decompressed content is intact
      const round = new TextDecoder().decode(Bun.gunzipSync(b1))
      expect(round).toBe(content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── 6. OpenAPI spec cache ────────────────────────────────────────────────

describe('P1: OpenAPI spec caching', () => {

  it('caches between requests and busts on late service registration', async () => {
    const app = await createTestApp({
      config: { apiPrefix: '/api' },
      services: [() => createService({ name: 'first', async find() { return [] } })],
    })
    app.configure(openapi({ title: 'T', version: '1' }))

    const s1 = await request(app).get('/api/openapi.json')
    expect(s1.status).toBe(200)
    expect(s1.text).toContain('/api/first')

    const s2 = await request(app).get('/api/openapi.json')
    expect(s2.text).toBe(s1.text)                    // cached — identical string

    app.services.register(createService({ name: 'second', async find() { return [] } }))
    const s3 = await request(app).get('/api/openapi.json')
    expect(s3.text).toContain('/api/second')         // cache busted by new service
  })
})
