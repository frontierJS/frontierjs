// test/made-at.test.ts
//
// A replayed write is dated when it was MADE, not when the network came back
// (`FJS-D469`, `FJS-1278`). connectteam measured the failure: a clock-in held
// at 09:46 on a device with no network and drained at 17:46 was stored as
// 17:46, eight worked hours the row said were not worked.
//
// The call states two instants off the device's own clock — when the write was
// made and when it was sent — and the boundary reads the device's offset from
// the second against its own clock. So a device clock wrong by a constant is
// corrected exactly, and `@default(now())` and `@updatedAt` inside the call
// resolve to the corrected made-at.
//
// Against a real Litestone client, because the stamps are litestone's.

import { describe, test, expect, afterEach } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient } from '../src/client/index.ts'
import { currentCall } from '../src/core/context.ts'

const SCHEMA = `
  model ClockEntry {
    id        Int      @id @default(autoincrement())
    note      String?
    startedAt DateTime @default(now())
    updatedAt DateTime @updatedAt
    @@gate("0")
  }
`

const HOUR = 3_600_000

async function boot() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const app: any = createApp({
    db,
    config: { port: 0, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 50 } },
  } as never)
  app.services.register(createService({ name: 'clock-entries', model: 'ClockEntry' }))
  app.services.register(createService({
    name: 'probes',
    methods: [{ method: 'when', gate: 0 }],
    async when() { return { madeAt: (currentCall()?.madeAt as Date | undefined)?.toISOString() ?? null } },
  } as never))
  await app.start()

  const call = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.http.fetch(new Request(`http://localhost${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }))
    const json: any = await res.json().catch(() => null)
    return { status: res.status, body: json?.data ?? json }
  }
  return { app, db, call, close: async () => { await app.stop(); db.$close() } }
}

const iso = (ms: number) => new Date(ms).toISOString()
const near = (actual: string, expected: number, within = 5_000) =>
  expect(Math.abs(Date.parse(actual) - expected)).toBeLessThan(within)

describe('a replayed write is dated when it was made', () => {
  test('`@default(now())` and `@updatedAt` resolve to the made-at on a create', async () => {
    const { call, close } = await boot()
    try {
      const made = Date.now() - 8 * HOUR
      const { status, body } = await call('POST', '/clock-entries', { note: 'in' },
        { 'x-fjs-made-at': iso(made), 'x-fjs-sent-at': iso(Date.now()) })
      expect(status).toBe(201)
      near(body.startedAt, made)
      near(body.updatedAt, made)
    } finally { await close() }
  })

  test('a device clock wrong by a constant is corrected by its own sent-at', async () => {
    const { call, close } = await boot()
    try {
      const skew = 3 * HOUR                     // the device runs three hours fast
      const made = Date.now() - 8 * HOUR
      const { body } = await call('POST', '/clock-entries', { note: 'in' },
        { 'x-fjs-made-at': iso(made + skew), 'x-fjs-sent-at': iso(Date.now() + skew) })
      near(body.startedAt, made)
    } finally { await close() }
  })

  test('`@updatedAt` on a patch resolves to the made-at', async () => {
    const { call, close } = await boot()
    try {
      const { body: row } = await call('POST', '/clock-entries', { note: 'in' })
      const made = Date.now() - 2 * HOUR
      const { body } = await call('PATCH', `/clock-entries/${row.id}`, { note: 'out' },
        { 'x-fjs-made-at': iso(made), 'x-fjs-sent-at': iso(Date.now()) })
      near(body.updatedAt, made)
      near(body.startedAt, Date.now())          // the create's stamp is untouched
    } finally { await close() }
  })

  test('a live call states nothing and lands at the server\'s now', async () => {
    const { call, close } = await boot()
    try {
      const { body } = await call('POST', '/clock-entries', { note: 'in' })
      near(body.startedAt, Date.now())
    } finally { await close() }
  })
})

describe('`$.madeAt`', () => {
  test('is the corrected made-at on a replay', async () => {
    const { call, close } = await boot()
    try {
      const made = Date.now() - 8 * HOUR
      const { body } = await call('POST', '/probes/1', {},
        { 'x-service-method': 'when', 'x-fjs-made-at': iso(made + HOUR), 'x-fjs-sent-at': iso(Date.now() + HOUR) })
      near(body.madeAt, made)
    } finally { await close() }
  })

  test('is the arrival on a live call, so it is always set', async () => {
    const { call, close } = await boot()
    try {
      const { body } = await call('POST', '/probes/1', {}, { 'x-service-method': 'when' })
      near(body.madeAt, Date.now())
    } finally { await close() }
  })
})

describe('what the boundary refuses', () => {
  test('a made-at with no sent-at — a device clock with nothing to compare it against', async () => {
    const { call, close } = await boot()
    try {
      const { status, body } = await call('POST', '/clock-entries', { note: 'in' },
        { 'x-fjs-made-at': iso(Date.now() - HOUR) })
      expect(status).toBe(400)
      expect(JSON.stringify(body)).toContain('X-Fjs-Sent-At')
    } finally { await close() }
  })

  test('a made-at later than its own sent-at', async () => {
    const { call, close } = await boot()
    try {
      const { status, body } = await call('POST', '/clock-entries', { note: 'in' },
        { 'x-fjs-made-at': iso(Date.now() + HOUR), 'x-fjs-sent-at': iso(Date.now()) })
      expect(status).toBe(400)
      expect(JSON.stringify(body)).toContain('X-Fjs-Made-At')
    } finally { await close() }
  })

  test('an instant that does not parse', async () => {
    const { call, close } = await boot()
    try {
      const { status } = await call('POST', '/clock-entries', { note: 'in' },
        { 'x-fjs-made-at': 'yesterday', 'x-fjs-sent-at': iso(Date.now()) })
      expect(status).toBe(400)
    } finally { await close() }
  })
})

// ─── over the socket ──────────────────────────────────────────────────────
// A frame has no headers of its own, so the browser client puts the two
// instants in `meta.headers`, where it already puts the idempotency key.

describe('over the socket', () => {
  test('the frame\'s two instants date the write', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const app: any = createApp({
      db,
      config: { port: 0, services: { dir: '/nonexistent' },
                http: { ...defaultConfig.http, drainTimeout: 50 } },
    } as never)
    app.services.register(createService({ name: 'clock-entries', model: 'ClockEntry' }))
    app.configure(channels())
    await app.start()
    try {
      const ws = new WebSocket(`ws://localhost:${app.http.port}/ws`)
      await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('ws did not open')) })
      const reply = new Promise<any>(ok => {
        ws.onmessage = (e: any) => {
          const f = JSON.parse(e.data)
          if (f.type === 'service_result' || f.type === 'service_error') ok(f)
        }
      })
      const made = Date.now() - 8 * HOUR
      ws.send(JSON.stringify({
        type: 'service_call', id: 'c1', service: 'clock-entries', method: 'create', data: { note: 'in' },
        meta: { headers: { 'x-fjs-made-at': iso(made + HOUR), 'x-fjs-sent-at': iso(Date.now() + HOUR) } },
      }))
      const frame = await reply
      ws.close()
      expect(frame.type).toBe('service_result')
      near(frame.result.startedAt, made)
    } finally { await app.stop(); db.$close() }
  })
})

// ─── the browser client ───────────────────────────────────────────────────

describe('the client states `madeAt` on either transport, with its own clock at the send', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  test('over HTTP, as two headers', async () => {
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = (async (_url: unknown, init: Record<string, unknown> = {}) => {
      seen.push((init.headers ?? {}) as Record<string, string>)
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as never
    const c: any = createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 })
    const made = Date.now() - HOUR
    await c.service('clock-entries').create({ note: 'in' }, undefined, { madeAt: made, idempotencyKey: 'k1' })
    const h = Object.fromEntries(Object.entries(seen[0]).map(([k, v]) => [k.toLowerCase(), v]))
    expect(h['x-fjs-made-at']).toBe(iso(made))
    near(h['x-fjs-sent-at'], Date.now())
    expect(h['idempotency-key']).toBe('k1')
  })

  test('over the socket, in the frame\'s headers', async () => {
    const c: any = createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 })
    const sent: any[] = []
    c._wsReady = true
    c._ws = { send(payload: string) {
      const frame = JSON.parse(payload)
      sent.push(frame)
      queueMicrotask(() => c._wsCallMap.get(String(frame.id))?.resolve({ ok: true }))
    } }
    const made = Date.now() - HOUR
    await c.service('clock-entries').patch(3, { note: 'out' }, undefined, { madeAt: new Date(made) })
    expect(sent[0].meta.headers['x-fjs-made-at']).toBe(iso(made))
    near(sent[0].meta.headers['x-fjs-sent-at'], Date.now())
  })

  test('a call that states none sends neither', async () => {
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = (async (_url: unknown, init: Record<string, unknown> = {}) => {
      seen.push((init.headers ?? {}) as Record<string, string>)
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as never
    const c: any = createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 })
    await c.service('clock-entries').create({ note: 'in' })
    expect(Object.keys(seen[0]).map(k => k.toLowerCase())).not.toContain('x-fjs-sent-at')
  })
})
