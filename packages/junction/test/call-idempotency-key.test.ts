// call-idempotency-key.test.ts — a key a caller states for ONE call, over
// whichever transport is live.
//
// The server has always been ready for this: `idempotency-key` is one of
// Junction's own protocol call headers, merged from a socket frame whether or
// not the app declared any call headers, and `callService` claims it and
// answers the first call's result without running the pipeline. What was
// missing was any way for a browser to send one PER CALL — `setCallHeader` is
// client-wide, and over the socket only those client-wide headers travelled.
//
// It is needed by anything that re-sends a write nobody can say arrived. A
// socket that has not noticed the network is gone carries a call that lands
// minutes later; re-sending without a key writes the row twice
// (`IDEAS/homestead.md` phase 1).
//
// **Both transports are asserted, because they disagreed by construction.** The
// HTTP path had `opts.header` at the request level and nothing above it; the
// socket path had no per-call header at all. A test over one of them would have
// passed against a client that could only do the other.

import { describe, it, expect, mock, afterEach } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

/** Record the headers of every HTTP request the client makes. */
function traceHeaders() {
  const seen: Array<Record<string, string>> = []
  globalThis.fetch = mock(async (_url: unknown, init: Record<string, unknown> = {}) => {
    seen.push((init.headers ?? {}) as Record<string, string>)
    return new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as never
  return seen
}

const client = () => createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 })

/** A client that believes it has a live socket, recording what it sends. */
function withFakeSocket() {
  const c = client() as unknown as {
    _wsReady: boolean
    _ws: { send(payload: string): void }
    _wsCallMap: Map<string, { resolve(v: unknown): void }>
    service(name: string): Record<string, (...a: never[]) => Promise<unknown>>
  }
  const sent: Array<Record<string, unknown>> = []
  c._wsReady = true
  c._ws = {
    send(payload: string) {
      const frame = JSON.parse(payload)
      sent.push(frame)
      queueMicrotask(() => c._wsCallMap.get(String(frame.id))?.resolve({ ok: true }))
    },
  }
  return { c, sent }
}

const frameKey = (frame: Record<string, unknown>) =>
  ((frame.meta as Record<string, unknown> | undefined)?.headers as
    Record<string, string> | undefined)?.['idempotency-key'] ?? null

const httpKey = (headers: Record<string, string>): string | null =>
  headers['Idempotency-Key'] ?? headers['idempotency-key'] ?? null

describe('over the socket', () => {
  it('create carries the key in the frame', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('orders').create({ total: 1 } as never, undefined as never, { idempotencyKey: 'k-create' } as never)
    expect(frameKey(sent[0])).toBe('k-create')
  })

  it('patch carries it', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('orders').patch(3 as never, { total: 2 } as never, undefined as never, { idempotencyKey: 'k-patch' } as never)
    expect(frameKey(sent[0])).toBe('k-patch')
  })

  it('remove carries it', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('orders').remove(3 as never, undefined as never, { idempotencyKey: 'k-remove' } as never)
    expect(frameKey(sent[0])).toBe('k-remove')
  })

  // The absence matters as much as the presence: an app that states no key is
  // on exactly the path it was on before, and the server claims nothing.
  it('states nothing when no key was given', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('orders').create({ total: 1 } as never)
    expect(frameKey(sent[0])).toBe(null)
  })
})

describe('over HTTP', () => {
  it('create carries the key as a header', async () => {
    const seen = traceHeaders()
    await client().service('orders').create({ total: 1 }, undefined, { idempotencyKey: 'k-create' })
    expect(httpKey(seen[0])).toBe('k-create')
  })

  it('patch carries it', async () => {
    const seen = traceHeaders()
    await client().service('orders').patch(3, { total: 2 }, undefined, { idempotencyKey: 'k-patch' })
    expect(httpKey(seen[0])).toBe('k-patch')
  })

  it('remove carries it', async () => {
    const seen = traceHeaders()
    await client().service('orders').remove(3, undefined, { idempotencyKey: 'k-remove' })
    expect(httpKey(seen[0])).toBe('k-remove')
  })

  it('states nothing when no key was given', async () => {
    const seen = traceHeaders()
    await client().service('orders').create({ total: 1 })
    expect(httpKey(seen[0])).toBe(null)
  })
})

// A custom method is the shape a real app writes most of its verbs in —
// `inventory().invoke('adjust', …)` is the write `example`'s `verify:offline`
// drives — so a key that reached CRUD and not this would reach the queue's own
// test case and not the feature.
describe('a custom method carries it too', () => {
  it('invoke over the socket', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('inventory').invoke(
      'adjust' as never, 3 as never, { quantity: -1 } as never,
      undefined as never, { idempotencyKey: 'k-invoke' } as never)
    expect(frameKey(sent[0])).toBe('k-invoke')
  })

  it('call() over the socket', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('inventory').call(
      'adjust' as never, 3 as never, { quantity: -1 } as never,
      { idempotencyKey: 'k-call' } as never)
    expect(frameKey(sent[0])).toBe('k-call')
  })

  it('invoke over HTTP', async () => {
    const seen = traceHeaders()
    await client().service('inventory').invoke(
      'adjust', 3, { quantity: -1 }, undefined, { idempotencyKey: 'k-invoke-http' })
    expect(httpKey(seen[0])).toBe('k-invoke-http')
  })

  // The merge, which is the one way this could have broken something that
  // worked: `X-Service-Method` is what the bridge dispatches a custom method
  // ON, and a per-call header object written in its place would turn every
  // invoke into a plain create — with no error anywhere, just the wrong verb.
  it('and still says which method it is', async () => {
    const seen = traceHeaders()
    await client().service('inventory').invoke(
      'adjust', 3, { quantity: -1 }, undefined, { idempotencyKey: 'k-both' })
    expect(seen[0]['X-Service-Method']).toBe('adjust')
    expect(httpKey(seen[0])).toBe('k-both')
  })
})

// The fallback is the path a queue actually drains on after an outage: the
// socket is down, the write goes out over HTTP, and it must carry the same key
// the socket would have carried or the two transports disagree about what a
// replay is.
describe('the fallback keeps it', () => {
  it('_wsCall with no socket reaches HTTP with the key intact', async () => {
    const seen = traceHeaders()
    const c = client() as unknown as {
      _wsCall(s: string, m: string, id: unknown, d: unknown, q: unknown, o: unknown): Promise<unknown>
    }
    await c._wsCall('orders', 'create', null, { total: 1 }, null, { idempotencyKey: 'k-fallback' })
    expect(httpKey(seen[0])).toBe('k-fallback')
  })
})
