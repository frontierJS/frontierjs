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

// ─── The server half, against a real socket ───────────────────────────────

describe('the server merges only what the app declared', () => {

  const PORT = 3397
  let app: ReturnType<typeof createApp> | undefined
  afterAll(async () => { await app?.stop() })

  test('a declared header arrives; an undeclared one does not; identity is untouchable', async () => {
    let seen: Record<string, string> = {}

    app = createApp({
      config: {
        port: PORT,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 250, callHeaders: ['X-Cart-Token'] },
      },
    })
    app.services.register(createService({
      name: 'probe',
      async find(ctx: ServiceContext) { seen = { ...ctx.client.headers }; return [] },
    }))
    app.configure(channels(() => {}))
    await app.start()

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
