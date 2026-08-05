// client-transport.test.ts — the browser client's transport rule.
//
// The rule, from the README:
//
//   "Service proxy — CRUD methods prefer WebSocket when connected, fall back to
//    HTTP automatically. File uploads always use HTTP (multipart/form-data)."
//
// WebSockets are the default when one is available; HTTP is the fallback. Two
// methods did not follow it — `restore` and `action` were unconditionally HTTP,
// so a custom action was the only service call that ignored a live connection.
//
// And the fallback had a hole with no bottom: `_httpFallback`'s default branch
// called `svc.call()`, which is `_wsCall()`, which routes to `_httpFallback`
// when the socket is down. A custom action with no connection recursed between
// the two forever — asynchronously, so there was no stack overflow to point at
// it. The call simply never settled, which is the worst way for this to fail.

import { describe, it, expect, mock, afterEach } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

/** Record every HTTP request the client makes, and answer them all. */
function traceHttp() {
  const seen: Array<{ method: string; path: string; action: string | null }> = []
  globalThis.fetch = mock(async (url: unknown, init: Record<string, unknown> = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    seen.push({
      method: (init.method as string) ?? 'GET',
      path:   String(url).replace('http://localhost:3000', ''),
      action: headers['X-Service-Method'] ?? headers['x-service-method'] ?? null,
    })
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
      // Answer immediately so the awaiting promise settles.
      queueMicrotask(() => c._wsCallMap.get(String(frame.id))?.resolve({ ok: true }))
    },
  }
  return { c, sent }
}

describe('with no socket, everything falls back to HTTP and settles', () => {
  // Each of these hung indefinitely before the fallback stopped recursing.
  it('call() on a custom action', async () => {
    const seen = traceHttp()
    await client().service('orders').call('pay', 3, {})
    expect(seen).toEqual([{ method: 'POST', path: '/orders/3', action: 'pay' }])
  })

  it('action()', async () => {
    const seen = traceHttp()
    await client().service('orders').action('pay', 3, {})
    expect(seen).toEqual([{ method: 'POST', path: '/orders/3', action: 'pay' }])
  })

  it('restore()', async () => {
    const seen = traceHttp()
    await client().service('orders').restore(3)
    expect(seen).toEqual([{ method: 'PUT', path: '/orders/3', action: 'restore' }])
  })
})

describe('with a socket, the socket wins', () => {
  const overSocket = async (call: (svc: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>) => {
    const httpSeen = traceHttp()
    const { c, sent } = withFakeSocket()
    await call(c.service('orders'))
    return { sent, httpSeen }
  }

  it('a custom action goes over WS, not HTTP', async () => {
    const { sent, httpSeen } = await overSocket(svc => svc.action('pay' as never, 3 as never))
    expect(httpSeen).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'service_call', service: 'orders', method: 'pay' })
    expect((sent[0].meta as Record<string, unknown>).id).toBe(3)
  })

  it('restore goes over WS, not HTTP', async () => {
    const { sent, httpSeen } = await overSocket(svc => svc.restore(3 as never))
    expect(httpSeen).toEqual([])
    expect(sent[0]).toMatchObject({ type: 'service_call', service: 'orders', method: 'restore' })
  })

  it('and so does ordinary CRUD, unchanged', async () => {
    const { sent, httpSeen } = await overSocket(svc => svc.get(3 as never))
    expect(httpSeen).toEqual([])
    expect(sent[0]).toMatchObject({ method: 'get' })
  })
})

describe('the documented exception', () => {
  it('a payload carrying a File goes over HTTP even with a socket up', async () => {
    const httpSeen = traceHttp()
    const { c, sent } = withFakeSocket()
    await c.service('orders').action(
      'attach' as never,
      3 as never,
      { receipt: new File(['x'], 'r.txt') } as never,
    )
    expect(sent).toEqual([])                       // never reached the socket
    expect(httpSeen).toHaveLength(1)
    expect(httpSeen[0].action).toBe('attach')
  })
})

describe('the workspace survives the switch to WebSocket', () => {
  // The bug this pins: setWorkspace() puts X-Workspace-Id on every HTTP
  // request, and the socket has no per-call headers at all — the server sees
  // only the upgrade request's. So an app that scopes by workspace worked
  // until the socket connected and then answered 'workspace_id required' on
  // every call, pointing at the app rather than at the transport that dropped
  // the scope. Found by building a real UI on it.
  //
  // It rides `meta.workspaceId` because meta is the field the server reads,
  // and it is the ONLY caller-supplied value lifted onto ctx.client.headers
  // server-side: identity stays with the connection, established at upgrade.

  it('HTTP sends it as a header', async () => {
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = mock(async (_url: unknown, init: Record<string, unknown> = {}) => {
      seen.push((init.headers ?? {}) as Record<string, string>)
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as never

    const c = client()
    c.setWorkspace('ws-1')
    await c.service('orders').get(3)
    expect(seen[0]['X-Workspace-Id']).toBe('ws-1')
  })

  it('WS sends it on the frame', async () => {
    const { c, sent } = withFakeSocket()
    ;(c as unknown as { setWorkspace(id: string): void }).setWorkspace('ws-1')
    await c.service('orders').get(3 as never)
    expect((sent[0].meta as Record<string, unknown>).workspaceId).toBe('ws-1')
  })

  it('and omits it entirely when no workspace is set', async () => {
    const { c, sent } = withFakeSocket()
    await c.service('orders').get(3 as never)
    expect((sent[0].meta as Record<string, unknown>)?.workspaceId).toBeUndefined()
  })
})
