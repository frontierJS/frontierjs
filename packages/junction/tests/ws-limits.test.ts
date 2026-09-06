// tests/ws-limits.test.ts
//
// What one socket may do.
//
// Every bound the HTTP transport has — the body cap, the DDoS gate, the rate
// limiter — stops at the upgrade, so the transport junction PREFERS was the
// cheapest way to exhaust an application. Measured from one anonymous socket:
// a 15MB frame moved a victim's latency from 9.2ms to 49.8ms, 20 000 `find`
// frames were answered in 1.1s and took it to 1093ms with the offending socket
// still open, and 3000 sockets were accepted in 2.2s (`FJS-705`). Separately,
// one 200KB presence meta produced 39.8MB of egress to 199 members in 114ms —
// an amplifier whose factor is the channel's membership, so it grows with the
// application's success (`FJS-704`).
//
// Every refusal below is PAIRED with the same thing inside the limit, because
// a transport that refused everything would satisfy the refusals alone
// (`FJS-351`).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, channels, createService, defaultConfig } from '../index.ts'

// Port 0, read back after start(). A FIXED port here was the whole of
// `FJS-900`: three files in this package bound 3396 and four bound 3397, and
// bun runs them in one process — so under the full suite an app was answering
// on this port while a previous file's app on the same one was still shutting
// down, and a socket meant for the capped app below was refused by a DYING one
// (its 'Server shutting down' reached the client as `Expected 101`). It passed
// alone for the obvious reason. Nothing may hard-code a port in this package's
// tests; ask for 0 and read `app.http.port`.
let PORT = 0
const WS = () => `ws://localhost:${PORT}/ws`
const ROOM = 'room:1'

// Presence skips an anonymous caller, so the presence half of this file needs
// identities — which is also the diagnosis in `FJS-703`: the cost is paid
// exactly by the signed-in users an application has.
const USERS: Record<string, { userId: string; userType: string; authMethod: 'session' }> = {
  'tok-a': { userId: 'a', userType: 'user', authMethod: 'session' },
  'tok-b': { userId: 'b', userType: 'user', authMethod: 'session' },
}

let app: any

function client(token?: string) {
  const ws = new WebSocket(token ? `${WS()}?token=${token}` : WS())
  const frames: any[] = []
  let closed: { code: number; reason: string } | null = null

  ws.onmessage = (e: any) => {
    try { frames.push(JSON.parse(String(e.data))) } catch { frames.push(String(e.data)) }
  }
  ws.onclose = (e: any) => { closed = { code: e.code, reason: e.reason } }

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never connected')), 4000)
    const check = setInterval(() => {
      if (frames.some(f => f?.type === 'connected')) { clearInterval(check); clearTimeout(timer); resolve() }
    }, 10)
    ws.onerror = () => { clearInterval(check); clearTimeout(timer); reject(new Error('ws error')) }
  })

  const wait = async (pred: () => boolean, ms = 2500) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (pred()) return true
      await new Promise(r => setTimeout(r, 10))
    }
    return false
  }

  return {
    ws, frames, ready, wait,
    get closed() { return closed },
    errors: () => frames.filter(f => f?.type === 'error' || f?.event === 'error'),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  }
}

beforeAll(async () => {
  app = createApp({
    config: {
      port: 0,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http: {
        ...defaultConfig.http,
        drainTimeout: 250,
        // Small enough to reach in a test, and each one is the same mechanism
        // the default uses.
        // The connection cap is deliberately NOT here: it is per app, so a
        // small one in the shared app refuses the sockets every other test in
        // this file opens. It gets its own app below.
        ws: { maxFrameBytes: 2048, maxFramesPerSecond: 10, maxInFlight: 2 },
      },
    },
    auth: {
      async verifySession(token: string) { return USERS[token] ?? null },
      async login()       { return { token: '', user: null as never } },
      async logout()      {},
      async createUser()  { return {} as never },
      async deleteUser()  {},
      async createApiKey(id: string) { return { key: `k-${id}`, id: `k-${id}` } },
      async revokeApiKey() {},
      async verifyApiKey() { return null },
    },
  })
  app.services.register(createService({
    name: 'probe', methods: ['find'], async find() { return [] },
  }))
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel(ROOM).join(conn) })
  }, { presence: true, presenceFlushMs: 0, presenceMetaBytes: 256, presenceUpdatesPerSecond: 2 }))
  await app.start()
  PORT = (app as unknown as { http: { port: number } }).http.port
})

afterAll(async () => { await app?.stop() })

describe('a frame that is too big (FJS-705)', () => {

  it('is refused BY NAME with 1009, where the runtime closes 1006 with no reason', async () => {
    // Bun's own maxPayloadLength closes with a bare 1006 — measured, and
    // indistinguishable from the network dropping — so the app's limit sits
    // below it and answers first.
    const c = client()
    await c.ready
    c.send({ type: 'service_call', id: '1', service: 'probe', method: 'find', pad: 'x'.repeat(4096) })

    expect(await c.wait(() => c.closed !== null)).toBe(true)
    expect(c.closed!.code).toBe(1009)
    expect(c.closed!.reason).toBe('frame_too_large')
    expect(c.errors()[0]?.error?.code).toBe('frame_too_large')
  })

  it('a frame inside the limit is answered — the control', async () => {
    const c = client()
    await c.ready
    c.send({ type: 'service_call', id: '1', service: 'probe', method: 'find' })
    expect(await c.wait(() => c.frames.some(f => f?.type === 'service_result'))).toBe(true)
    expect(c.closed).toBeNull()
    c.close()
  })
})

describe('too many frames (FJS-705)', () => {

  it('a flood is throttled, told once, and the socket stays open', async () => {
    const c = client()
    await c.ready
    for (let i = 0; i < 200; i++)
      c.send({ type: 'service_call', id: String(i), service: 'probe', method: 'find' })

    expect(await c.wait(() => c.errors().length > 0)).toBe(true)
    expect(c.errors()[0].error.code).toBe('rate_limited')

    // Answered fewer than sent: the limit did something.
    const answered = c.frames.filter(f => f?.type === 'service_result').length
    expect(answered).toBeLessThan(200)

    // Told ONCE per second, not once per dropped frame — an error per refusal
    // is the same egress the limit exists to remove.
    expect(c.errors().length).toBeLessThan(5)

    // Not closed: a burst is a client catching up, not an attacker, and the
    // two are indistinguishable from one frame.
    expect(c.closed).toBeNull()
    c.close()
  })

  it('an ordinary rate is answered in full — the control', async () => {
    const c = client()
    await c.ready
    for (let i = 0; i < 5; i++)
      c.send({ type: 'service_call', id: String(i), service: 'probe', method: 'find' })

    expect(await c.wait(() => c.frames.filter(f => f?.type === 'service_result').length === 5)).toBe(true)
    expect(c.errors()).toEqual([])
    c.close()
  })
})

describe('too many sockets from one address (FJS-705)', () => {

  // Its own app on its own port: the cap is per APP, so a small one in the
  // shared app refuses every other socket this file opens.
  let CAP_PORT = 0   // bound at start(), read back — see the note above
  let capped: any

  const capClient = () => {
    const ws = new WebSocket(`ws://localhost:${CAP_PORT}/ws`)
    const frames: any[] = []
    ws.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('never connected')), 4000)
      const i = setInterval(() => {
        if (frames.some(f => f?.type === 'connected')) { clearInterval(i); clearTimeout(t); resolve() }
      }, 10)
      ws.onerror = () => { clearInterval(i); clearTimeout(t); reject(new Error('ws error')) }
    })
    return { ws, ready, close: () => ws.close() }
  }

  beforeAll(async () => {
    capped = createApp({
      config: {
        port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 250, ws: { maxConnectionsPerIp: 3 } },
      },
    })
    capped.configure(channels())
    await capped.start()
    CAP_PORT = (capped as { http: { port: number } }).http.port
  })
  afterAll(async () => { await capped?.stop() })

  const upgrade = () => fetch(`http://localhost:${CAP_PORT}/ws`, {
    headers: {
      upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-version': '13', 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
  })

  it('the fourth is refused at the UPGRADE, so the caller reads an HTTP status', async () => {
    // Refused before the upgrade rather than closed after `open`: a close code
    // arrives on a socket the client believes it established.
    const held = [capClient(), capClient(), capClient()]
    await Promise.all(held.map(c => c.ready))

    const res = await upgrade()
    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/this address/)

    // And the slot is RELEASED, or an app leaks its own capacity one
    // disconnection at a time — which is the half a refusal test cannot see.
    held[0].close()
    await new Promise(r => setTimeout(r, 200))
    const after = capClient()
    await after.ready
    after.close()
    held.slice(1).forEach(c => c.close())
  })
})

describe('presence meta is not an amplifier (FJS-704)', () => {

  it('an oversize meta is refused by name and not rebroadcast', async () => {
    const a = client('tok-a'), b = client('tok-b')
    await Promise.all([a.ready, b.ready])
    await new Promise(r => setTimeout(r, 60))

    a.send({ type: 'subscribe', channel: ROOM, meta: { pad: 'x'.repeat(1024) } })
    expect(await a.wait(() => a.errors().length > 0)).toBe(true)
    expect(a.errors()[0].error?.code ?? a.errors()[0].data?.code).toBe('presence_meta_too_large')

    // The point is the egress: nobody else was written to.
    await new Promise(r => setTimeout(r, 120))
    expect(b.frames.some(f => f?.event === 'presence:update')).toBe(false)
    a.close(); b.close()
  })

  it('a small meta IS rebroadcast — the control', async () => {
    const a = client('tok-a'), b = client('tok-b')
    await Promise.all([a.ready, b.ready])
    await new Promise(r => setTimeout(r, 60))

    a.send({ type: 'subscribe', channel: ROOM, meta: { typing: true } })
    expect(await b.wait(() => b.frames.some(f => f?.event === 'presence:update'))).toBe(true)
    a.close(); b.close()
  })

  it('a stream of updates is rate-limited, and dropped in silence', async () => {
    // Silence rather than an error frame: presence is an affordance, and an
    // error per refused update is the egress the cap exists to stop.
    const a = client('tok-a'), b = client('tok-b')
    await Promise.all([a.ready, b.ready])
    await new Promise(r => setTimeout(r, 60))

    for (let i = 0; i < 50; i++) a.send({ type: 'subscribe', channel: ROOM, meta: { n: i } })
    await new Promise(r => setTimeout(r, 250))

    const updates = b.frames.filter(f => f?.event === 'presence:update').length
    expect(updates).toBeGreaterThan(0)
    expect(updates).toBeLessThan(50)
    expect(a.errors().filter(e => (e.error?.code ?? '') === 'presence_meta_too_large')).toEqual([])
    a.close(); b.close()
  })
})
