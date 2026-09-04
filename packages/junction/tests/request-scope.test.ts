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

// ─── one correlation id ───────────────────────────────────────────────────
// Junction has two spellings of "which request is this" — `ctx.requestId`, set
// by the `correlationId()` middleware, and `RequestMeta.correlationId`, minted
// by `enterRequest`. Two ids for one request would make an app log line and the
// audit row from the same request unjoinable, which is the exact failure the
// provenance columns exist to close.
//
// They agree because both transport entry points read
// `x-request-id ?? ctx.requestId` — the store DEFERS to the middleware rather
// than minting beside it. Pinned here because nothing said so, and because the
// deferral is one `??` in two files: delete it and every reader still works,
// separately, on different ids.
describe('the correlation id has one value per request', () => {

  test('a stated x-request-id is what the store carries', async () => {
    seen = undefined
    const res = await fetch(`${BASE}/probe`, { headers: { 'x-request-id': 'stated-1' } })
    expect(res.status).toBe(200)
    expect(seen!.correlationId).toBe('stated-1')
  })

  test('with no header, one id is minted and it is stable across the request', async () => {
    seen = undefined
    const res = await fetch(`${BASE}/probe`)
    expect(res.status).toBe(200)
    const id = seen!.correlationId
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    // The negative control: a second request must not reuse it. A constant or a
    // per-process id would satisfy every other assertion here.
    seen = undefined
    await fetch(`${BASE}/probe`)
    expect(seen!.correlationId).not.toBe(id)
  })
})

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
    // The header-derived fields have one reader, and this is what it reads.
    expect(seen!.correlationId).toBe('corr-http')
    expect(seen!.idempotencyKey).toBe('idem-http')
    expect(seen!.locale).toBe('en-GB')
  })

  // Carried, never emitted: junction traces nothing itself. It is the value an
  // outbound call needs to hang off the inbound one, and without it every call
  // this process makes is the root of an unrelated trace (`FJS-742`).
  test('HTTP — a W3C trace the caller stated is carried', async () => {
    seen = undefined
    await fetch(`${BASE}/probe`, {
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate:  'congo=t61rcWkgMzE',
      },
    })
    // Verbatim and unparsed — what to do with it belongs to whoever continues
    // the trace, and a parse here would be a second reading of the spec.
    expect(seen!.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    // `tracestate` is not decoration: a vendor's own position in the trace is
    // carried there, so dropping it breaks the chain for that vendor alone.
    expect(seen!.tracestate).toBe('congo=t61rcWkgMzE')

    // The control — a request that stated none carries none, rather than an
    // invented one that would read as an upstream trace downstream.
    seen = undefined
    await fetch(`${BASE}/probe`)
    expect(seen!.traceparent).toBeUndefined()
    expect(seen!.tracestate).toBeUndefined()
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

  // ── FJS-467 ───────────────────────────────────────────────────────────
  //
  // `runAs(null)` above is *nobody asked*, and it works. This is *the APP
  // asked*, which reaches the same principal by its id — and it threw.
  //
  // The system principal is declared by the app and is deliberately not a row
  // anything can log in as, so `sessionFor` cannot answer for it. Every id but
  // null went through that lookup, so work enqueued while the app's own
  // principal was in scope — a webhook, a raw route, anything calling a
  // service as the app — recorded an id no re-resolution could ever satisfy,
  // and failed its whole retry ladder with a message about a deleted user.
  //
  // Not the fallback the code deliberately refuses: this matches the id the
  // app ITSELF supplied, where a fallback would run a demoted user's work with
  // authority they never held.
  test("runAs(<the app's own principal>) — recognised, not looked up", async () => {
    seen = undefined
    await app.runAs(SYS.userId, async () => { await app.service('probe').find() })
    expect(seen!.user?.userId).toBe('u-sys')
  })

  test('an id the provider cannot resolve still throws by name', async () => {
    await expect(app.runAs('u-ghost', async () => {})).rejects.toThrow(/no such principal/)
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
