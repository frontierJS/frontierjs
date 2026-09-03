// tests/idempotency.test.ts — the Idempotency-Key header, end to end.
//
// FJS-088: the header was parsed into request metadata and consumed by nothing,
// so a double-submitted create ran twice while carrying the value that says not
// to. These pin what a key now promises — one execution per (key, principal,
// service, method), a replayed answer for the repeat, and a released key when
// the call failed, because a failed request is one the caller may retry.

import { describe, test, expect } from 'bun:test'
import { createTestApp, createStubAuth, request } from '../src/testing/index.ts'
import { createService, callService } from '../src/core/service.ts'
import { enterRequest } from '../src/core/context.ts'
import { bridge } from '../src/transport/bridge.ts'
import { BadRequest } from '../src/core/errors.ts'

// A service that counts how many times its body actually ran.
function countingService(name = 'notes') {
  const calls = { create: 0, find: 0 }
  const svc = createService({
    name,
    create: async (ctx) => { calls.create++; return { id: String(calls.create), ...(ctx.data as object) } },
    find:   async ()    => { calls.find++;   return [] },
  })
  return { svc, calls }
}

// callService directly, inside a request-metadata store — the same store both
// transports establish. This is the level the guarantee lives at; the HTTP
// tests below prove the header reaches it.
async function callWithKey(
  app: Awaited<ReturnType<typeof createTestApp>>,
  svc: ReturnType<typeof createService>,
  method: string,
  key: string | undefined,
  opts: { user?: { userId: string } | null; data?: unknown } = {}
) {
  // A principal by default. A key is scoped to WHO sent it, and a caller with
  // none is not claimed at all (`FJS-680`) — the anonymous case is asserted on
  // its own below rather than being the shape every other test runs under.
  const ctx = bridge.internal(svc.name, method as 'create', (opts.data ?? { title: 'x' }) as Record<string, unknown>, {
    auth: { user: (opts.user === undefined ? { userId: 'u-default' } : opts.user) as never },
  }, app)
  ctx.method = method
  await enterRequest(
    { correlationId: 'c1', idempotencyKey: key, origin: 'internal' },
    () => callService(svc, ctx, app._appHooks, app.events, app.telemetry)
  )
  return ctx.result
}

describe('an Idempotency-Key executes a mutation once', () => {

  test('the repeat replays the first answer instead of running again', async () => {
    const app = await createTestApp()
    const { svc, calls } = countingService()

    const first  = await callWithKey(app, svc, 'create', 'k1')
    const second = await callWithKey(app, svc, 'create', 'k1')

    expect(calls.create).toBe(1)
    expect(second).toEqual(first)
  })

  test('a different key is a different request', async () => {
    const app = await createTestApp()
    const { svc, calls } = countingService()
    await callWithKey(app, svc, 'create', 'k1')
    await callWithKey(app, svc, 'create', 'k2')
    expect(calls.create).toBe(2)
  })

  test('no key at all is the path the app was always on', async () => {
    const app = await createTestApp()
    const { svc, calls } = countingService()
    await callWithKey(app, svc, 'create', undefined)
    await callWithKey(app, svc, 'create', undefined)
    expect(calls.create).toBe(2)
  })

  test('the same key from a different principal runs its own call', async () => {
    // Replay skips the pipeline, so it skips the auth checks in it. If the key
    // were not scoped to the principal, one caller could hand another caller's
    // answer to itself by guessing a key string.
    const app = await createTestApp()
    const { svc, calls } = countingService()
    const a = await callWithKey(app, svc, 'create', 'shared', { user: { userId: 'u1' } })
    const b = await callWithKey(app, svc, 'create', 'shared', { user: { userId: 'u2' } })
    expect(calls.create).toBe(2)
    expect(a).not.toEqual(b)
  })

  test('a read is never replayed', async () => {
    const app = await createTestApp()
    const { svc, calls } = countingService()
    await callWithKey(app, svc, 'find', 'k1')
    await callWithKey(app, svc, 'find', 'k1')
    expect(calls.find).toBe(2)
  })

  test('a failed call releases the key — the retry runs', async () => {
    const app = await createTestApp()
    let attempts = 0
    const svc = createService({
      name: 'flaky',
      create: async () => {
        attempts++
        if (attempts === 1) throw new BadRequest('nope')
        return { id: 'ok' }
      },
    })

    await expect(callWithKey(app, svc, 'create', 'k1')).rejects.toThrow('nope')
    const retry = await callWithKey(app, svc, 'create', 'k1')
    expect(attempts).toBe(2)
    expect(retry).toBeTruthy()
  })

  test('a duplicate arriving while the first is in flight is a retryable 409', async () => {
    const app = await createTestApp()
    let release: (() => void) | null = null
    const gate = new Promise<void>(r => { release = r })
    const svc = createService({
      name: 'slow',
      create: async () => { await gate; return { id: '1' } },
    })

    type HttpError = Error & { code: number, retryable: boolean }
    const first = callWithKey(app, svc, 'create', 'k1')
    const err   = await callWithKey(app, svc, 'create', 'k1')
      .then(() => null, (e: unknown) => e as HttpError)

    expect(err?.code).toBe(409)
    // Retryable: the first call may yet succeed, and then the same request is
    // answerable. A domain refusal would not be.
    expect(err?.retryable).toBe(true)

    release!()
    await first
  })

  test('the announcement fires once, not once per submission', async () => {
    const app = await createTestApp()
    const { svc } = countingService()
    const seen: unknown[] = []
    app.events.on('notes:created', (row) => { seen.push(row) })

    await callWithKey(app, svc, 'create', 'k1')
    await callWithKey(app, svc, 'create', 'k1')
    await new Promise(r => setTimeout(r, 10))

    expect(seen).toHaveLength(1)
  })
})

// A key needs a principal, and the principal is established at the TRANSPORT —
// `claimIdempotency` runs ahead of the pipeline, so a hook setting
// `ctx.auth.user` is already too late. Signed in for real, with a token.
const TOKEN = 'test-token-u1'
const signedIn = { auth: createStubAuth({ users: [{ id: 'u1' }] }) }

describe('the header reaches it', () => {

  test('two POSTs with the same Idempotency-Key create one row', async () => {
    const { svc, calls } = countingService('things')
    const app = await createTestApp({ services: [() => svc], ...signedIn })

    const post = () => request(app).post('/things')
      .auth(TOKEN)
      .set('idempotency-key', 'abc-123')
      .send({ title: 'hello' })

    const a = await post()
    const b = await post()

    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(calls.create).toBe(1)
    expect(b.body).toEqual(a.body)
  })

  test('without the header the same POST twice creates two', async () => {
    const { svc, calls } = countingService('things')
    const app = await createTestApp({ services: [() => svc] })
    await request(app).post('/things').send({ title: 'hello' })
    await request(app).post('/things').send({ title: 'hello' })
    expect(calls.create).toBe(2)
  })

  test('config.idempotency.enabled: false turns it off', async () => {
    const { svc, calls } = countingService('things')
    const app = await createTestApp({
      config: { idempotency: { enabled: false } },
      services: [() => svc],
      ...signedIn,
    })
    for (let i = 0; i < 2; i++)
      await request(app).post('/things').auth(TOKEN).set('idempotency-key', 'k').send({ title: 'x' })
    expect(calls.create).toBe(2)
  })
})

// ─── FJS-680 — a key belongs to WHO sent it ───────────────────────────────

describe('an Idempotency-Key from nobody is not honoured', () => {

  test('two anonymous calls with one key both run', async () => {
    // Anonymous callers shared the literal string `anonymous`, so the second
    // stranger to send a key the first had used was replayed the first one's
    // row — somebody else's created record, with their id in it.
    const app = await createTestApp()
    const { svc, calls } = countingService()

    const a = await callWithKey(app, svc, 'create', 'shared', { user: null, data: { title: 'first caller' } })
    const b = await callWithKey(app, svc, 'create', 'shared', { user: null, data: { title: 'second caller' } })

    expect(calls.create).toBe(2)
    expect(a).not.toEqual(b)
  })

  test('over HTTP, two anonymous POSTs with one key create two rows', async () => {
    const { svc, calls } = countingService('things')
    const app = await createTestApp({ services: [() => svc] })

    const a = await request(app).post('/things').set('idempotency-key', 'k').send({ title: 'first caller' })
    const b = await request(app).post('/things').set('idempotency-key', 'k').send({ title: 'second caller' })

    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(calls.create).toBe(2)
    expect(b.body).not.toEqual(a.body)
  })
})

// ─── FJS-680 — a key names ONE request ────────────────────────────────────

describe('the same key with a different payload is refused', () => {

  test('a changed body is a 422, not a silent replay of the first answer', async () => {
    const app = await createTestApp()
    const { svc, calls } = countingService()

    await callWithKey(app, svc, 'create', 'k1', { data: { title: 'first' } })
    const err = await callWithKey(app, svc, 'create', 'k1', { data: { title: 'second' } })
      .then(() => null, (e: unknown) => e as Error & { code: number, retryable: boolean })

    expect(err?.code).toBe(422)
    expect(err?.retryable).toBe(false)
    expect(calls.create).toBe(1)
  })

  test('the SAME body still replays', async () => {
    const app = await createTestApp()
    const { svc, calls } = countingService()
    const first  = await callWithKey(app, svc, 'create', 'k1', { data: { title: 'same' } })
    const second = await callWithKey(app, svc, 'create', 'k1', { data: { title: 'same' } })
    expect(calls.create).toBe(1)
    expect(second).toEqual(first)
  })

  test('over HTTP: same key, different body → 422', async () => {
    const { svc, calls } = countingService('things')
    const app = await createTestApp({ services: [() => svc], ...signedIn })

    const a = await request(app).post('/things').auth(TOKEN).set('idempotency-key', 'k').send({ title: 'one' })
    const b = await request(app).post('/things').auth(TOKEN).set('idempotency-key', 'k').send({ title: 'two' })

    expect(a.status).toBe(201)
    expect(b.status).toBe(422)
    expect(calls.create).toBe(1)
  })
})
