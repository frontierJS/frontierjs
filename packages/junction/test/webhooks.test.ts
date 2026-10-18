// test/webhooks.test.ts
//
// Webhook delivery against a REAL receiving server: signing, status
// transitions, retries, dead-lettering, and event matching.
//
// The plugin is 698 lines of outbound HTTP with HMAC signing and a retry
// schedule, and the only coverage was four route-security assertions in
// p0-fixes.test.ts. Nothing had ever sent a webhook and looked at what arrived.
// Doing that found four defects; every describe block below is one of them.

import { Database } from 'bun:sqlite'
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { webhooks, createSqliteWebhookStore } from '../src/plugins/webhooks/index.ts'
import { verifyRequest } from '@frontierjs/toolbelt/signature'

// ─── A real receiver ──────────────────────────────────────────────────────

type Hit = { headers: Record<string, string>; body: string }
const hits: Hit[] = []
let respondWith = 200
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,                     // ephemeral — no fixed-port collisions in CI
    async fetch(req) {
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => { headers[k] = v })
      hits.push({ headers, body: await req.text() })
      return new Response('ok', { status: respondWith })
    },
  })
})
afterAll(() => server.stop(true))

const url = () => `http://localhost:${server.port}/hook`

async function makeApp(events: string[] = ['*']) {
  // `isAdmin`, not `role: 'admin'`: managing registrations needs level 5 and
  // `sessionGateLevel` reads the standing fields rather than an app's own
  // `role` column, which grades 4 however it is spelled.
  const app = await createTestApp({ users: [{ id: 'u1', role: 'admin', isAdmin: true }] })
  // A retryInterval an hour out keeps the background scheduler from firing
  // mid-test; every retry below is driven explicitly.
  //
  // `targets` is off because the receiver above is a real server on localhost,
  // which is exactly what the SSRF guard refuses (`FJS-681`). Saying so here is
  // the point: these tests are about delivery mechanics, and the guard has its
  // own file. Nothing else in the repo turns it off.
  app.configure(webhooks({
    events,
    store:         createSqliteWebhookStore(new Database(':memory:')),
    retryInterval: 3_600_000,
    targets: { allowHttp: true, allowPrivate: true },
  }))
  await app._startForTest()
  return app as typeof app & { webhooks: NonNullable<typeof app.webhooks> }
}

// ─── event matching ───────────────────────────────────────────────────────

describe('event matching is exact', () => {
  // findForEvent built a SQL LIKE pattern out of the EVENT NAME:
  //   events LIKE ('%"' || ? || '"%')
  // so metacharacters in the event name matched other registrations. A partner
  // received payloads, correctly HMAC-signed, for events they never subscribed
  // to. It uses json_each() equality now.

  it('delivers to a subscriber of that exact event', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['orders:created'])
    hits.length = 0

    await app.webhooks.deliver('orders:created', { id: 'ord_1' })

    expect(hits).toHaveLength(1)
  })

  it('an underscore in the event name does NOT match a different registration', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['userXcreated'])
    hits.length = 0

    // '_' was a SQL single-character wildcard — this used to be delivered.
    await app.webhooks.deliver('user_created', { leak: true })

    expect(hits).toHaveLength(0)
  })

  it('an event named "%" does NOT match every registration', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['orders:created'])
    await app.webhooks.register(url(), ['users:created'])
    hits.length = 0

    await app.webhooks.deliver('%', { leak: true })

    expect(hits).toHaveLength(0)
  })

  it('an unrelated event is not delivered', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['orders:created'])
    hits.length = 0

    await app.webhooks.deliver('users:deleted', {})

    expect(hits).toHaveLength(0)
  })

  it('a "*" registration still receives everything', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['*'])
    hits.length = 0

    await app.webhooks.deliver('anything:at:all', {})

    expect(hits).toHaveLength(1)
  })
})

// ─── signing ──────────────────────────────────────────────────────────────

describe('signing', () => {
  // The plugin signed `${timestamp}.${body}`, which binds neither the method nor
  // the path — a captured signature replayed against any other endpoint on the
  // same receiver trusting the same secret — and carried no nonce, so a repeat
  // inside the freshness window was indistinguishable from a first delivery.
  // Both are things a subscriber cannot fix from its side.
  //
  // It signs `@frontierjs/toolbelt/signature`'s canonical string now, and these
  // assertions VERIFY rather than recompute: a receiver that reimplements the
  // signer is the shape `FJS-349` was, where three signers existed and nothing
  // ever checked one.

  it('sends the documented headers, and a real receiver verifies it', async () => {
    const app  = await makeApp()
    const hook = await app.webhooks.register(url(), ['orders:created'])
    hits.length = 0

    await app.webhooks.deliver('orders:created', { id: 'ord_1' })
    const hit = hits[0]

    expect(hit.headers['x-webhook-id']).toBeTruthy()
    expect(hit.headers['x-webhook-event']).toBe('orders:created')
    expect(hit.headers['x-webhook-timestamp']).toMatch(/^\d+$/)
    expect(hit.headers['x-webhook-nonce']).toBeTruthy()

    const check = await verifyRequest({
      secret: hook.secret, method: 'POST', path: '/hook', body: hit.body,
      headers: hit.headers, prefix: 'X-Webhook', now: Math.floor(Date.now() / 1000),
    })
    expect(check).toEqual({ ok: true })
  })

  it('a wrong secret does not verify — the signature is really keyed', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['e'])
    hits.length = 0
    await app.webhooks.deliver('e', {})

    const check = await verifyRequest({
      secret: 'not-the-secret', method: 'POST', path: '/hook', body: hits[0].body,
      headers: hits[0].headers, prefix: 'X-Webhook', now: Math.floor(Date.now() / 1000),
    })
    expect(check.ok).toBe(false)
  })

  it('the PATH is bound, so a signature does not replay against another endpoint', async () => {
    // The half `${timestamp}.${body}` could not express, and the reason this
    // moved onto the shared canonical string rather than being left alone.
    const app  = await makeApp()
    const hook = await app.webhooks.register(url(), ['e'])
    hits.length = 0
    await app.webhooks.deliver('e', {})

    const elsewhere = await verifyRequest({
      secret: hook.secret, method: 'POST', path: '/admin/hook', body: hits[0].body,
      headers: hits[0].headers, prefix: 'X-Webhook', now: Math.floor(Date.now() / 1000),
    })
    expect(elsewhere.ok).toBe(false)
  })

  it('a body swapped under a real signature does not verify', async () => {
    const app  = await makeApp()
    const hook = await app.webhooks.register(url(), ['e'])
    hits.length = 0
    await app.webhooks.deliver('e', { amount: 1 })

    const swapped = await verifyRequest({
      secret: hook.secret, method: 'POST', path: '/hook',
      body: JSON.stringify({ amount: 1000 }),
      headers: hits[0].headers, prefix: 'X-Webhook', now: Math.floor(Date.now() / 1000),
    })
    expect(swapped.ok).toBe(false)
  })

  it('a retry carries a NEW nonce, so a receiver keeping a nonce store still takes it', async () => {
    // The event's identity is `x-webhook-id` and it is stable across attempts;
    // the nonce is per attempt. Reusing it would dead-letter every retry against
    // exactly the receivers that implemented replay protection properly.
    const app  = await makeApp()
    const hook = await app.webhooks.register(url(), ['e'])
    hits.length = 0

    respondWith = 500
    try { await app.webhooks.deliver('e', {}) } finally { respondWith = 200 }
    const [failed] = await app.webhooks.deliveries(hook.id)
    await app.webhooks.retry(failed.id)

    expect(hits.length).toBeGreaterThan(1)
    expect(hits[0].headers['x-webhook-id']).toBe(hits[1].headers['x-webhook-id'])
    expect(hits[0].headers['x-webhook-nonce']).not.toBe(hits[1].headers['x-webhook-nonce'])
  })

  it('a receiver outside its freshness window refuses it', async () => {
    const app  = await makeApp()
    const hook = await app.webhooks.register(url(), ['e'])
    hits.length = 0
    await app.webhooks.deliver('e', {})

    const stale = await verifyRequest({
      secret: hook.secret, method: 'POST', path: '/hook', body: hits[0].body,
      headers: hits[0].headers, prefix: 'X-Webhook',
      now: Math.floor(Date.now() / 1000) + 3_600,
    })
    expect(stale.ok).toBe(false)
  })
})

// ─── deliver() is observable ──────────────────────────────────────────────

describe('deliver() awaits the attempt', () => {
  // Documented as "useful for testing", it used to fire-and-forget, so it
  // resolved before anything had been sent and a caller could not observe the
  // outcome it called the method to observe.
  it('has delivered by the time it resolves', async () => {
    const app = await makeApp()
    await app.webhooks.register(url(), ['sync:check'])
    hits.length = 0

    await app.webhooks.deliver('sync:check', {})

    expect(hits).toHaveLength(1)          // no settle() needed
  })

  it('the delivery row is already terminal when it resolves', async () => {
    const app = await makeApp()
    const hook = await app.webhooks.register(url(), ['sync:row'])

    await app.webhooks.deliver('sync:row', {})

    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('delivered')
    expect(d.attempts).toBe(1)
  })
})

// ─── status transitions ───────────────────────────────────────────────────

describe('delivery status transitions', () => {
  it('a success records delivered with no error and no retry scheduled', async () => {
    const app = await makeApp()
    const hook = await app.webhooks.register(url(), ['ok'])
    respondWith = 200

    await app.webhooks.deliver('ok', {})

    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('delivered')
    expect(d.lastError).toBeNull()
    expect(d.nextRetryAt).toBeNull()
    expect(d.deliveredAt).not.toBeNull()
  })

  it('a failure records the error and schedules a retry', async () => {
    const app = await makeApp()
    const hook = await app.webhooks.register(url(), ['bad'])
    respondWith = 500
    try {
      await app.webhooks.deliver('bad', {})
    } finally { respondWith = 200 }

    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('failed')
    expect(d.attempts).toBe(1)
    expect(d.lastError).toBe('HTTP 500')
    expect(d.nextRetryAt).not.toBeNull()
  })

  // updateDelivery used `??`, so an explicit null meant "leave it alone" and a
  // nullable column could never be cleared: a delivered row kept reporting the
  // error it had already recovered from, and kept a stale retry time.
  it('a successful retry CLEARS the previous error and retry time', async () => {
    const app = await makeApp()
    const hook = await app.webhooks.register(url(), ['recover'])

    respondWith = 500
    try { await app.webhooks.deliver('recover', {}) } finally { respondWith = 200 }
    const [failed] = await app.webhooks.deliveries(hook.id)
    expect(failed.lastError).toBe('HTTP 500')

    await app.webhooks.retry(failed.id)

    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('delivered')
    expect(d.attempts).toBe(2)
    expect(d.lastError).toBeNull()
    expect(d.nextRetryAt).toBeNull()
  })

  // retry() wrote its own status updates and omitted the exhaustion check, so
  // a hand-retried delivery ran past MAX_ATTEMPTS and never dead-lettered.
  it('repeated failing retries eventually dead-letter', async () => {
    const app = await makeApp()
    const hook = await app.webhooks.register(url(), ['doomed'])

    respondWith = 500
    try {
      await app.webhooks.deliver('doomed', {})
      const [d0] = await app.webhooks.deliveries(hook.id)
      for (let i = 0; i < 8; i++) await app.webhooks.retry(d0.id)

      const d = await app.webhooks.getDelivery(d0.id)
      expect(d!.status).toBe('dead')
      expect(d!.nextRetryAt).toBeNull()
    } finally { respondWith = 200 }
  })

  it('retry() on an unknown delivery returns null', async () => {
    const app = await makeApp()
    expect(await app.webhooks.retry('no-such-id')).toBeNull()
  })
})

// ─── management routes ────────────────────────────────────────────────────

describe('management routes', () => {
  it('refuse an unauthenticated caller', async () => {
    const app = await makeApp()
    expect((await request(app).get('/webhooks')).status).toBe(401)
  })

  it('return the secret on create and never again', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')

    const created = await request(app).post('/webhooks').auth(tok)
      .send({ url: url(), events: ['a'] })
    expect(created.status).toBe(201)
    expect((created.body as { secret?: string }).secret).toBeTruthy()

    const id   = (created.body as { id: string }).id
    const one  = await request(app).get(`/webhooks/${id}`).auth(tok)
    const list = await request(app).get('/webhooks').auth(tok)

    expect(one.text).not.toContain('secret')
    expect(list.text).not.toContain('secret')
  })

  it('validate url and events', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')

    expect((await request(app).post('/webhooks').auth(tok).send({ events: ['a'] })).status).toBe(400)
    expect((await request(app).post('/webhooks').auth(tok).send({ url: url() })).status).toBe(400)
  })

  it('404 on unknown ids across every by-id route', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')

    expect((await request(app).get('/webhooks/nope').auth(tok)).status).toBe(404)
    expect((await request(app).delete('/webhooks/nope').auth(tok)).status).toBe(404)
    expect((await request(app).post('/webhooks/nope/test').auth(tok)).status).toBe(404)
    expect((await request(app).post('/webhook-deliveries/nope/retry').auth(tok)).status).toBe(404)
  })

  it('DELETE deregisters', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')
    const created = await request(app).post('/webhooks').auth(tok).send({ url: url(), events: ['a'] })
    const id = (created.body as { id: string }).id

    expect((await request(app).delete(`/webhooks/${id}`).auth(tok)).status).toBe(204)
    expect((await request(app).get(`/webhooks/${id}`).auth(tok)).status).toBe(404)
  })

  it('the test ping reaches the receiver', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')
    const created = await request(app).post('/webhooks').auth(tok).send({ url: url(), events: ['a'] })
    hits.length = 0

    const res = await request(app).post(`/webhooks/${(created.body as { id: string }).id}/test`).auth(tok)

    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
    expect(hits).toHaveLength(1)
  })

  // A test ping is one-shot. Recording a failure as 'failed' with a null
  // next_retry_at left a row pendingRetries could never select — neither
  // retried nor final.
  it('a FAILED test ping is terminal, not stuck awaiting a retry', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')
    const created = await request(app).post('/webhooks').auth(tok).send({ url: url(), events: ['a'] })
    const id = (created.body as { id: string }).id

    respondWith = 500
    try {
      const res = await request(app).post(`/webhooks/${id}/test`).auth(tok)
      expect((res.body as { ok: boolean }).ok).toBe(false)
    } finally { respondWith = 200 }

    const [d] = await app.webhooks.deliveries(id)
    expect(d.status).toBe('dead')
    expect(d.nextRetryAt).toBeNull()
  })

  it('delivery history is listable and fetchable by id', async () => {
    const app = await makeApp()
    const tok = app.tokenFor('u1')
    const hook = await app.webhooks.register(url(), ['hist'])
    await app.webhooks.deliver('hist', { n: 1 })

    const list = await request(app).get('/webhook-deliveries').auth(tok)
    expect(list.status).toBe(200)
    expect((list.body as unknown[]).length).toBeGreaterThan(0)

    const [d] = await app.webhooks.deliveries(hook.id)
    const one = await request(app).get(`/webhook-deliveries/${d.id}`).auth(tok)
    expect(one.status).toBe(200)
    expect((one.body as { id: string }).id).toBe(d.id)
  })
})

// ─── plugin wiring ────────────────────────────────────────────────────────

describe('plugin wiring', () => {
  it('owns app.webhooks, so a second owner fails loudly', async () => {
    const app = await makeApp()
    expect(app.webhooks).toBeDefined()

    expect(() => app.configure({ name: 'squatter', register(a) { a.own('webhooks', {}) } }))
      .toThrow(/already owned/)
  })

  it('refuses to register with no store', async () => {
    const app = await createTestApp()

    expect(() => app.configure(webhooks({ events: [] } as never))).toThrow(/No store/)
  })

  it('accepts a custom store', async () => {
    const app = await createTestApp()
    const registrations: unknown[] = []
    const store = {
      register: async (u: string, e: string[]) => {
        const reg = { id: 'r1', url: u, events: e, secret: 's', active: true, createdAt: 0 }
        registrations.push(reg); return reg
      },
      unregister: async () => {}, setActive: async () => {}, list: async () => registrations as never[],
      getRegistration: async () => null, findForEvent: async () => [],
      createDelivery: async () => ({}) as never, updateDelivery: async () => {},
      pendingRetries: async () => [], getDeliveries: async () => [], getDelivery: async () => null,
    }

    // The destination is not what this test is about, and `.test` does not
    // resolve — which the target guard correctly refuses.
    app.configure(webhooks({ events: [], store: store as never, targets: { allowPrivate: true } }))
    await app.webhooks.register('https://x.test', ['a'])

    expect(registrations).toHaveLength(1)
  })
})

// ─── receiving — the scheme read the other way ────────────────────────────
//
// A SUBSCRIPTION is this app's side of a far app's registration (`FJS-D1087`).
// The sender below is a second junction app running this same plugin, so what
// is proved is the pair: what `attemptDelivery` signs is what the route
// verifies, dedupes on and hands to `receive`.

import { signRequest } from '@frontierjs/toolbelt/signature'
import type { ReceivedWebhook, ReceiveOutcome } from '../src/plugins/webhooks/index.ts'

type Seen = { ev: ReceivedWebhook; outcome: ReceiveOutcome }

async function makeReceiver(receive?: (ev: ReceivedWebhook) => ReceiveOutcome | Promise<ReceiveOutcome>) {
  const app = await createTestApp({ config: { apiPrefix: '/api' } })
  app.configure(webhooks({
    events:        [],
    store:         createSqliteWebhookStore(new Database(':memory:')),
    retryInterval: 3_600_000,
    ...(receive ? { receive } : {}),
  }))
  await app._startForTest()
  app.http.router.build()
  const answers: Array<{ status: number; body: unknown }> = []
  // A real socket, because the sender's `fetch` needs one; the handler is the
  // app's own transport, so the request runs the same pipeline a test request does.
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const res = await app.http.fetch(req)
      answers.push({ status: res.status, body: await res.clone().json().catch(() => null) })
      return res
    },
  })
  return {
    app: app as typeof app & { webhooks: NonNullable<typeof app.webhooks> },
    origin: `http://localhost:${server.port}`,
    answers,
    stop: () => server.stop(true),
  }
}

/** A delivery signed by hand, posted straight at the app's transport — no port. */
async function postSigned(app: Awaited<ReturnType<typeof makeReceiver>>['app'], path: string, secret: string, body: unknown, over: Partial<{ timestamp: number; nonce: string; headers: Record<string, string> }> = {}) {
  const raw    = JSON.stringify(body)
  const signed = await signRequest({
    secret, method: 'POST', path, body: raw, prefix: 'X-Webhook',
    timestamp: over.timestamp ?? Math.floor(Date.now() / 1000),
    nonce:     over.nonce ?? crypto.randomUUID(),
  })
  const res = await app.http.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed, ...(over.headers ?? {}) },
    body: raw,
  }))
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null }
}

const envelope = (id: string, event = 'e', data: unknown = { x: 1 }) =>
  ({ id, event, timestamp: Math.floor(Date.now() / 1000), data })

describe('receiving', () => {

  it('a subscription names the route under apiPrefix and mints the secret to hand out', async () => {
    const r = await makeReceiver(() => 'applied')
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'shop' })
      expect(sub.path).toBe(`/api/webhooks/subscriptions/${sub.id}`)
      expect(sub.secrets).toHaveLength(1)
      expect(sub.secrets[0]).toMatch(/^[0-9a-f]{48}$/)
      expect(await r.app.webhooks.subscriptions()).toHaveLength(1)
      await r.app.webhooks.unsubscribe(sub.id)
      expect(await r.app.webhooks.subscriptions()).toHaveLength(0)
    } finally { r.stop() }
  })

  it('a delivery from another junction app verifies, is applied once, and a redelivery is a duplicate', async () => {
    const seen: Seen[] = []
    const r = await makeReceiver(ev => { seen.push({ ev, outcome: 'applied' }); return 'applied' })
    try {
      const sub    = await r.app.webhooks.subscribe({ to: 'sender' })
      const sender = await makeApp()
      const hook   = await sender.webhooks.register(`${r.origin}${sub.path}`, ['orders:created'], sub.secrets[0])

      await sender.webhooks.deliver('orders:created', { id: 'ord_1', total: 99 })

      expect(seen).toHaveLength(1)
      expect(seen[0].ev.event).toBe('orders:created')
      expect(seen[0].ev.payload).toEqual({ id: 'ord_1', total: 99 })
      const [delivery] = await sender.webhooks.deliveries(hook.id)
      expect(delivery.status).toBe('delivered')
      expect(seen[0].ev.id).toBe(delivery.id)
      expect(r.answers.at(-1)).toEqual({ status: 200, body: { received: true, outcome: 'applied' } })

      // The sender's retry carries a new nonce and the same delivery id, so the
      // nonce memory lets it through and the receipt names it a duplicate.
      await sender.webhooks.retry(delivery.id)
      expect(seen).toHaveLength(1)
      expect(r.answers.at(-1)).toEqual({ status: 200, body: { received: true, outcome: 'duplicate' } })
    } finally { r.stop() }
  })

  it('dedupe means APPLIED: a receive that throws answers 500, the retry applies it, the next retry is a duplicate', async () => {
    let calls = 0
    const r = await makeReceiver(() => { if (++calls === 1) throw new Error('db locked'); return 'applied' })
    try {
      const sub    = await r.app.webhooks.subscribe({ to: 'sender' })
      const sender = await makeApp()
      const hook   = await sender.webhooks.register(`${r.origin}${sub.path}`, ['e'], sub.secrets[0])

      await sender.webhooks.deliver('e', {})
      let [delivery] = await sender.webhooks.deliveries(hook.id)
      expect(delivery.status).toBe('failed')
      expect(r.answers.at(-1)).toEqual({ status: 500, body: { error: 'not applied' } })

      await sender.webhooks.retry(delivery.id)
      ;[delivery] = await sender.webhooks.deliveries(hook.id)
      expect(delivery.status).toBe('delivered')
      expect(calls).toBe(2)

      await sender.webhooks.retry(delivery.id)
      expect(calls).toBe(2)
      expect(r.answers.at(-1)?.body).toEqual({ received: true, outcome: 'duplicate' })
    } finally { r.stop() }
  })

  it('parked leaves the receipt unapplied, so a redelivery runs receive again', async () => {
    const outcomes: ReceiveOutcome[] = ['parked', 'applied']
    let calls = 0
    const r = await makeReceiver(() => outcomes[calls++])
    try {
      const sub    = await r.app.webhooks.subscribe({ to: 'sender' })
      const sender = await makeApp()
      const hook   = await sender.webhooks.register(`${r.origin}${sub.path}`, ['e'], sub.secrets[0])

      await sender.webhooks.deliver('e', {})
      const [delivery] = await sender.webhooks.deliveries(hook.id)
      expect(delivery.status).toBe('delivered')
      expect(r.answers.at(-1)?.body).toEqual({ received: true, outcome: 'parked' })

      await sender.webhooks.retry(delivery.id)
      expect(calls).toBe(2)
      expect(r.answers.at(-1)?.body).toEqual({ received: true, outcome: 'applied' })
    } finally { r.stop() }
  })

  it('refuses, with one sentence: a wrong secret, an unknown subscription, a stale timestamp, a replayed nonce', async () => {
    let calls = 0
    const r = await makeReceiver(() => { calls++; return 'applied' })
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'sender' })

      const forged = await postSigned(r.app, sub.path, 'not-the-secret', envelope('d1'))
      expect(forged).toEqual({ status: 401, body: { error: 'not verified' } })

      const unknown = await postSigned(r.app, sub.path.replace(sub.id, 'nobody'), sub.secrets[0], envelope('d1'))
      expect(unknown).toEqual({ status: 401, body: { error: 'not verified' } })

      const stale = await postSigned(r.app, sub.path, sub.secrets[0], envelope('d1'), { timestamp: Math.floor(Date.now() / 1000) - 3600 })
      expect(stale).toEqual({ status: 401, body: { error: 'not verified' } })

      const nonce = crypto.randomUUID()
      const first  = await postSigned(r.app, sub.path, sub.secrets[0], envelope('d1'), { nonce })
      const replay = await postSigned(r.app, sub.path, sub.secrets[0], envelope('d1'), { nonce })
      expect(first.status).toBe(200)
      expect(replay).toEqual({ status: 401, body: { error: 'not verified' } })

      expect(calls).toBe(1)
    } finally { r.stop() }
  })

  it('a rotation is two valid secrets: the second one verifies too', async () => {
    const r = await makeReceiver(() => 'applied')
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'sender', secrets: ['old-secret', 'new-secret'] })
      expect((await postSigned(r.app, sub.path, 'new-secret', envelope('d1'))).status).toBe(200)
      expect((await postSigned(r.app, sub.path, 'old-secret', envelope('d2'))).status).toBe(200)
      expect((await postSigned(r.app, sub.path, 'other', envelope('d3'))).status).toBe(401)
    } finally { r.stop() }
  })

  it('dedupes on the SIGNED body id, not the X-Webhook-Id header', async () => {
    let calls = 0
    const r = await makeReceiver(() => { calls++; return 'applied' })
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'sender' })
      await postSigned(r.app, sub.path, sub.secrets[0], envelope('same'), { headers: { 'x-webhook-id': 'h1' } })
      const again = await postSigned(r.app, sub.path, sub.secrets[0], envelope('same'), { headers: { 'x-webhook-id': 'h2' } })
      expect(again.body).toEqual({ received: true, outcome: 'duplicate' })
      expect(calls).toBe(1)
    } finally { r.stop() }
  })

  it('a verified body that is not the envelope is 200 ignored, and receive is not called', async () => {
    let calls = 0
    const r = await makeReceiver(() => { calls++; return 'applied' })
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'sender' })
      const res = await postSigned(r.app, sub.path, sub.secrets[0], { hello: 'world' })
      expect(res).toEqual({ status: 200, body: { received: true, outcome: 'ignored' } })
      expect(calls).toBe(0)
    } finally { r.stop() }
  })

  it('a receive answering a word that is not an outcome is a 500, and the receipt stays unapplied', async () => {
    let calls = 0
    const r = await makeReceiver(() => (++calls === 1 ? 'done' : 'applied') as ReceiveOutcome)
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'sender' })
      expect((await postSigned(r.app, sub.path, sub.secrets[0], envelope('d1'))).status).toBe(500)
      expect((await postSigned(r.app, sub.path, sub.secrets[0], envelope('d1'))).body).toEqual({ received: true, outcome: 'applied' })
    } finally { r.stop() }
  })

  it('with no receive configured the route is not mounted', async () => {
    const r = await makeReceiver()
    try {
      const sub = await r.app.webhooks.subscribe({ to: 'sender' })
      const res = await postSigned(r.app, sub.path, sub.secrets[0], envelope('d1'))
      expect(res.status).toBe(404)
    } finally { r.stop() }
  })

  it('subscribe refuses a missing label and an empty secret list by name', async () => {
    const r = await makeReceiver(() => 'applied')
    try {
      await expect(r.app.webhooks.subscribe({ to: '' })).rejects.toThrow(/`to` names/)
      await expect(r.app.webhooks.subscribe({ to: 'x', secrets: [] })).rejects.toThrow(/non-empty list/)
    } finally { r.stop() }
  })
})
