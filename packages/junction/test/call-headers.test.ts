// call-headers.test.ts — a value the CALLER varies, over either transport.
//
// Over HTTP a caller-varied value is a header and there was never a question.
// Over the socket there are no per-call headers at all: the server sees the
// UPGRADE request's headers and nothing else, one set for the life of the
// connection. So anything that comes into existence after the socket is up —
// a guest basket's token — or that changes without reconnecting — the
// workspace — has no way to travel.
//
// The workspace was the only value that had ever needed it, so it was built as
// one hardcoded name on each side. This is the same mechanism with the name
// taken out of it, and the security property is the reason it is an allow-list
// rather than a merge: a frame that could name its own header could name
// Authorization, and the caller's identity is established at upgrade.

import { describe, test, expect, mock, afterEach, afterAll } from 'bun:test'
import { createApp, channels, defaultConfig } from '../index.ts'
import { createJunctionClient }               from '../src/client/index.ts'
import { createService }                      from '../src/core/service.ts'
import type { ServiceContext }                from '../src/transport/bridge.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

/** Record the headers of every HTTP request the client makes. */
function traceHeaders() {
  const seen: Array<Record<string, string>> = []
  globalThis.fetch = mock(async (_url: unknown, init: Record<string, unknown> = {}) => {
    seen.push({ ...(init.headers ?? {}) as Record<string, string> })
    return new Response('{"data":[],"total":0,"limit":20,"offset":0}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as never
  return seen
}

/** A client that believes it has a live socket, recording what it sends. */
function withFakeSocket() {
  const c = createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 }) as unknown as {
    _wsReady: boolean
    _ws: { send(payload: string): void }
    _wsCallMap: Map<string, { resolve(v: unknown): void }>
    setCallHeader(name: string, value: string | null): void
    setWorkspace(id: string): void
    service(name: string): Record<string, (...a: never[]) => Promise<unknown>>
  }
  const sent: Array<Record<string, unknown>> = []
  c._wsReady = true
  c._ws = {
    send(payload: string) {
      const frame = JSON.parse(payload)
      sent.push(frame)
      queueMicrotask(() =>
        c._wsCallMap.get(String(frame.id))?.resolve({ data: [], total: 0, limit: 20, offset: 0 }))
    },
  }
  return { c, sent }
}

// ─── The client half ──────────────────────────────────────────────────────

describe('a call header rides both transports', () => {

  test('HTTP: it is an ordinary header', async () => {
    const seen = traceHeaders()
    const c = createJunctionClient({ url: 'http://localhost:3000' })
    c.setCallHeader('X-Cart-Token', 'tok-1')
    await c.service('carts').find()

    // Lowercased on the way in, because HTTP header names are
    // case-insensitive and the socket side merges into a lowercase map — two
    // spellings of one header is the bug this avoids.
    expect(seen[0]?.['x-cart-token']).toBe('tok-1')
  })

  test('HTTP: the constructor option is the same thing', async () => {
    const seen = traceHeaders()
    const c = createJunctionClient({
      url: 'http://localhost:3000',
      callHeaders: { 'x-cart-token': 'tok-boot' },
    })
    await c.service('carts').find()
    expect(seen[0]?.['x-cart-token']).toBe('tok-boot')
  })

  test('WS: it rides the frame under meta.headers', async () => {
    const { c, sent } = withFakeSocket()
    c.setCallHeader('x-cart-token', 'tok-2')
    await c.service('carts').find()

    expect((sent[0]?.meta as Record<string, unknown>)?.headers)
      .toEqual({ 'x-cart-token': 'tok-2' })
  })

  test('WS: a frame with nothing to add carries no headers key', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('carts').find()
    expect((sent[0]?.meta as Record<string, unknown> | undefined)?.headers).toBeUndefined()
  })

  test('null clears it', async () => {
    const seen = traceHeaders()
    const c = createJunctionClient({ url: 'http://localhost:3000' })
    c.setCallHeader('x-cart-token', 'tok-3')
    c.setCallHeader('x-cart-token', null)
    await c.service('carts').find()
    expect(seen[0]?.['x-cart-token']).toBeUndefined()
  })

  test('the workspace is one of these now, and still travels both ways', async () => {
    // It predates the general channel, so this is the regression: setWorkspace
    // must keep working over HTTP and over the socket with no app declaration.
    const seen = traceHeaders()
    const http = createJunctionClient({ url: 'http://localhost:3000' })
    http.setWorkspace('ws-9')
    await http.service('things').find()
    expect(seen[0]?.['x-workspace-id']).toBe('ws-9')

    const { c, sent } = withFakeSocket()
    c.setWorkspace('ws-9')
    await c.service('things').find()
    expect((sent[0]?.meta as Record<string, unknown>)?.headers)
      .toEqual({ 'x-workspace-id': 'ws-9' })
  })
})

// A write held offline is sent again after its author may have switched
// workspace, and the live set is then the WRONG one: made in Acme, graded and
// stamped as Globex (FJS-1300). The held call states the set it was made
// under, and that set replaces the live one rather than merging into it — a
// header set since would otherwise ride a call made before it existed.
describe('a call can state the headers it was made under', () => {

  test('callHeaders() is the set as it goes on the wire', () => {
    const c = createJunctionClient({ url: 'http://localhost:3000' })
    c.setCallHeader('X-Cart-Token', 'tok-1')
    c.setWorkspace('acme')
    expect(c.callHeaders()).toEqual({ 'x-cart-token': 'tok-1', 'x-workspace-id': 'acme' })
  })

  test('HTTP: every write states them, over the live set', async () => {
    const seen = traceHeaders()
    const c = createJunctionClient({ url: 'http://localhost:3000' })
    c.setWorkspace('acme')
    const made = c.callHeaders()
    c.setWorkspace('globex')
    c.setCallHeader('x-cart-token', 'later')

    const svc = c.service('issues')
    await svc.create({ title: 'a' }, undefined, { callHeaders: made })
    await svc.patch(1, { title: 'b' }, undefined, { callHeaders: made })
    await svc.patch(1, { title: 'b' }, undefined, { callHeaders: made, base: { title: 'a' } })
    await svc.remove(1, undefined, { callHeaders: made })
    await svc.restore(1, undefined, { callHeaders: made })
    await svc.invoke('close', 1, {}, undefined, { callHeaders: made })

    expect(seen.map(h => h['x-workspace-id'])).toEqual(Array(6).fill('acme'))
    expect(seen.map(h => h['x-cart-token'])).toEqual(Array(6).fill(undefined))
  })

  test('WS: the frame states them, over the live set', async () => {
    const { c, sent } = withFakeSocket()
    c.setWorkspace('acme')
    const made = (c as unknown as { callHeaders(): Record<string, string> }).callHeaders()
    c.setWorkspace('globex')
    await c.service('issues').create({ title: 'a' } as never, undefined as never,
      { callHeaders: made, idempotencyKey: 'k1' } as never)

    expect((sent[0]?.meta as Record<string, unknown>)?.headers)
      .toEqual({ 'x-workspace-id': 'acme', 'idempotency-key': 'k1' })
  })
})

// ─── The server half, against a real socket ───────────────────────────────

describe('the server merges only what the app declared', () => {

  // Port 0, read back after start(). A fixed port here was `FJS-900`: several
  // files in this package bound the same one and bun runs them in ONE process,
  // so an app answered while a previous file's app on that port was still
  // shutting down. Never hard-code a port in this package's tests.
  let PORT = 0
  let app: ReturnType<typeof createApp> | undefined
  afterAll(async () => { await app?.stop() })

  test('a declared header arrives; an undeclared one does not; identity is untouchable', async () => {
    let seen: Record<string, string> = {}

    app = createApp({
      config: {
        port: 0,
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 250, callHeaders: ['X-Cart-Token'] },
      },
    })
    app.services.register(createService({
      name: 'probe',
      async find(ctx: ServiceContext) { seen = { ...ctx.caller.headers }; return [] },
    }))
    app.configure(channels(() => {}))
    await app.start()
    PORT = (app as unknown as { http: { port: number } }).http.port

    const client = createJunctionClient({ url: `http://localhost:${PORT}` })
    client.setCallHeader('x-cart-token', 'tok-declared')
    client.setCallHeader('x-not-declared', 'tok-undeclared')
    // The one that matters. A frame naming Authorization must not become one:
    // the principal is resolved from the upgrade and nothing per-call may
    // restate it.
    client.setCallHeader('authorization', 'Bearer forged')
    client.connect()

    const ready = Date.now() + 5_000
    while (!(client as unknown as { _wsReady: boolean })._wsReady && Date.now() < ready) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect((client as unknown as { _wsReady: boolean })._wsReady).toBe(true)

    await client.service('probe').find()

    expect(seen['x-cart-token']).toBe('tok-declared')
    expect(seen['x-not-declared']).toBeUndefined()
    expect(seen['authorization']).toBeUndefined()
    // By VALUE as well as by name: a merge that lands under some other key is
    // the same breach, and the name assertions alone would not see it.
    expect(Object.values(seen)).not.toContain('Bearer forged')
    expect(Object.values(seen)).not.toContain('tok-undeclared')
  }, 15_000)
})
