// tests/request-scope.test.ts
//
// One owner opens the request scope, and every entry point goes through it.
//
// Five places establish a request — the HTTP handler, the WebSocket frame
// dispatcher, app.runAs(), a service call arriving with no store at all, and
// the test harness — and each of them used to build a RequestMeta literal by
// hand. The copies were not the same, and the two failures that shipped are
// both the same shape as each other: the socket path wrapped NOTHING for its
// whole life, so requestMeta() was undefined for every WS call and the
// Idempotency-Key that decides whether a create runs twice applied to half the
// transports; and withTestMeta() forwarded four of six fields, so `user` and
// `client` were dropped and propagation behaved one way under test and another
// in production.
//
// Neither is visible from inside the entry point that has the bug — the app
// runs, the call answers, and the thing that is missing is a store nobody in
// that file reads. So the assertion has to come from OUTSIDE: a service method
// that records requestMeta(), driven down each entry point in turn.
//
// A sixth transport is the reason this file exists rather than a comment.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { requestMeta, enterRequest, reenterAs }             from '../src/core/context.ts'
import { withTestMeta }                                     from '../src/testing/index.ts'
import type { RequestMeta }                                 from '../src/core/context.ts'
import type { SessionContext }                              from '../src/auth/types.ts'

const PORT = 3399
const BASE = `http://localhost:${PORT}`

const ALICE = { userId: 'u-alice', userType: 'user', roles: [], scopes: [] } as unknown as SessionContext
const BOB   = { userId: 'u-bob',   userType: 'user', roles: [], scopes: [] } as unknown as SessionContext
const SYS   = { userId: 'u-sys',   userType: 'system', roles: [], scopes: [] } as unknown as SessionContext

/** What the method saw, from inside the call. Overwritten per call. */
let seen: RequestMeta | undefined

// Two methods, because "the store is open" and "the store survives a nested
// call" are different claims and a single method can only make the first.
const probe = createService({
  name: 'probe',
  methods: ['find', 'create', 'nested'],
  async find(_ctx: unknown)   { seen = requestMeta(); return [] },
  async create(_ctx: unknown) { seen = requestMeta(); return { ok: true } },
  async nested(_ctx: unknown) {
    await app.service('probe').find()
    return { ok: true }
  },
})

let app: any

beforeAll(async () => {
  app = createApp({
    // `system` is who runAs(null, …) resolves to — the one place an app says
    // who it is acting on its own behalf.
    system: SYS,
    config: {
      port:     PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  // Inline rather than createStubAuth: this needs sessionFor(), which is what
  // runAs(userId) re-resolves a principal through, and the stub has none.
  app.setAuth({
    async verifySession(token: string) { return token === 'alice' ? ALICE : null },
    async sessionFor(userId: string)   { return userId === 'u-bob' ? BOB : null },
  })
  app.services.register(probe)
  app.configure(channels())
  await app.start()
})

afterAll(async () => { await app?.stop() })

describe('every entry point opens the request scope', () => {

  test('HTTP — the store is open, and carries who and where', async () => {
    seen = undefined
    const res = await fetch(`${BASE}/probe`, {
      headers: {
        authorization:     'Bearer alice',
        'x-request-id':    'corr-http',
        'idempotency-key': 'idem-http',
        'accept-language': 'en-GB,en;q=0.9',
      },
    })
    expect(res.status).toBe(200)

    expect(seen).toBeDefined()
    expect(seen!.origin).toBe('http')
    expect(seen!.user?.userId).toBe('u-alice')
    expect(seen!.client).toBeDefined()
    // The three header-derived fields have one reader, and this is what it reads.
    expect(seen!.correlationId).toBe('corr-http')
    expect(seen!.idempotencyKey).toBe('idem-http')
    expect(seen!.locale).toBe('en-GB')
  })

  test('WebSocket — the same six fields, stated on the frame', async () => {
    seen = undefined
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    await new Promise<void>((ok, no) => {
      ws.onopen  = () => ok()
      ws.onerror = () => no(new Error('ws did not open'))
    })

    const done = new Promise<void>(ok => {
      ws.onmessage = (e: any) => {
        const f = JSON.parse(e.data)
        if (f.type === 'service_result' || f.type === 'service_error') ok()
      }
    })
    ws.send(JSON.stringify({
      type: 'service_call', id: 'c1', service: 'probe', method: 'find',
      // A socket has no per-call headers, so the two values a header would
      // have carried ride the frame's own `meta` — the same place it carries
      // the id and the workspace.
      meta: { correlationId: 'corr-ws', idempotencyKey: 'idem-ws' },
    }))
    await done
    ws.close()

    // This is the assertion the socket path failed for its whole life.
    expect(seen).toBeDefined()
    expect(seen!.origin).toBe('websocket')
    expect(seen!.correlationId).toBe('corr-ws')
    expect(seen!.idempotencyKey).toBe('idem-ws')
    expect(seen!.client).toBeDefined()
  })

  test('runAs(userId) — the principal is re-resolved, not restored', async () => {
    seen = undefined
    await app.runAs('u-bob', async () => { await app.service('probe').find() })
    expect(seen!.origin).toBe('internal')
    expect(seen!.user?.userId).toBe('u-bob')
  })

  test('runAs(null) — the app acting on its own behalf', async () => {
    seen = undefined
    await app.runAs(null, async () => { await app.service('probe').find() })
    expect(seen!.user?.userId).toBe('u-sys')
  })

  test('a call arriving with no store IS the entry point', async () => {
    seen = undefined
    await app.service('probe').find()
    expect(seen).toBeDefined()
    expect(seen!.origin).toBe('internal')
    expect(seen!.correlationId).toBeTruthy()
  })

  test('withTestMeta forwards user and client, like a real transport', () => {
    // The regression: it built the meta itself and forwarded four of six
    // fields, so a test could not reproduce propagation at all.
    let inner: RequestMeta | undefined
    withTestMeta(
      { user: ALICE, client: { ip: '1.2.3.4', headers: {} }, origin: 'http' },
      () => { inner = requestMeta() },
    )
    expect(inner!.user?.userId).toBe('u-alice')
    expect(inner!.client?.ip).toBe('1.2.3.4')
    expect(inner!.origin).toBe('http')
  })
})

describe('the scope propagates, and re-opens only when the principal changes', () => {

  test('a nested call inherits the request it is inside', async () => {
    seen = undefined
    await app.runAs('u-bob', async () => { await app.service('probe').call('nested') })
    // The inner find() named no principal, so it inherited bob's.
    expect(seen!.user?.userId).toBe('u-bob')
  })

  test('same principal opens nothing — the trace is not restarted', () => {
    enterRequest({ origin: 'http', correlationId: 'trace-1', user: ALICE }, () => {
      const before = requestMeta()
      reenterAs(ALICE, () => {
        // Identity, not equality: the common path must not allocate a store.
        expect(requestMeta()).toBe(before!)
      })
    })
  })

  test('a changed principal carries the correlation id over', () => {
    enterRequest({ origin: 'http', correlationId: 'trace-2', user: ALICE }, () => {
      reenterAs(BOB, () => {
        expect(requestMeta()!.user?.userId).toBe('u-bob')
        // A correlation id that changed mid-request is a broken trace.
        expect(requestMeta()!.correlationId).toBe('trace-2')
      })
    })
  })

  test('reenterAs with no store at all opens an internal request', () => {
    expect(requestMeta()).toBeUndefined()
    reenterAs(ALICE, () => {
      expect(requestMeta()!.origin).toBe('internal')
      expect(requestMeta()!.user?.userId).toBe('u-alice')
    })
  })
})
