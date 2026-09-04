// tests/presence-scale.test.ts
//
// Presence used to be unconditional, unturnoffable and quadratic.
//
// Every channel there is was wrapped, so every application paid for a feature
// most of them do not use — and a join sends the roster to the joiner AND a
// frame to every existing member, so N connections cost N x (N-1) frames.
// Measured at two channels per connection: 200 connections produced 40 600
// frames and 14.3MB, 500 produced **251 500 frames, 89.5MB out and 172MB of
// heap** (`FJS-703`). A post-deploy reconnect of a few thousand users is the
// ordinary event that makes fatal, and it compounds with `FJS-701`, since the
// reconnect is already lossy.
//
// Two fixes and they answer different halves. Opt-in removes the cost from
// every app that does not use presence; batching changes the exponent for the
// apps that do.

import { afterEach, describe, expect, it } from 'bun:test'
import { createApp, channels, defaultConfig } from '../index.ts'

const USERS: Record<string, { userId: string; userType: string; authMethod: 'session' }> =
  Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
    [`tok-${i}`, { userId: `u${i}`, userType: 'user', authMethod: 'session' as const }]))

let running: any[] = []

afterEach(async () => {
  await Promise.all(running.map(a => a.stop()))
  running = []
})

async function serve(port: number, room: string, opts: Record<string, unknown> = {}) {
  const app: any = createApp({
    config: {
      port, database: { url: '', log: false }, services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 250 },
    },
    auth: {
      async verifySession(t: string) { return USERS[t] ?? null },
      async login()       { return { token: '', user: null as never } },
      async logout()      {},
      async createUser()  { return {} as never },
      async deleteUser()  {},
      async createApiKey(id: string) { return { key: `k-${id}`, id: `k-${id}` } },
      async revokeApiKey() {},
      async verifyApiKey() { return null },
    },
  })
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel(room).join(conn) })
  }, opts))
  await app.start()
  running.push(app)
  return app
}

function client(port: number, token: string) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`)
  const frames: any[] = []
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('never connected')), 4000)
    const i = setInterval(() => {
      if (frames.some(f => f?.type === 'connected')) { clearInterval(i); clearTimeout(t); resolve() }
    }, 8)
    ws.onerror = () => { clearInterval(i); clearTimeout(t); reject(new Error('ws error')) }
  })
  const events = (name: string) => frames.filter(f => f?.type === 'event' && f?.event === name)
  return { ws, frames, ready, events, close: () => ws.close() }
}

const settle = (ms = 250) => new Promise(r => setTimeout(r, ms))

describe('presence is opt-in (FJS-703)', () => {

  it('is off by default — no roster, no join frames, nothing tracked', async () => {
    const app = await serve(3398, 'room:a')
    const a = client(3398, 'tok-0'), b = client(3398, 'tok-1')
    await Promise.all([a.ready, b.ready])
    await settle()

    expect(a.events('presence:sync')).toEqual([])
    expect(a.events('presence:diff')).toEqual([])
    expect(b.events('presence:join')).toEqual([])
    // And the server-side view is empty too — the wrap never ran, so nothing
    // is being kept either.
    expect(app.presence('room:a')).toEqual([])
    a.close(); b.close()
  })

  it('`presence: true` turns it on — the control', async () => {
    const app = await serve(3399, 'room:a', { presence: true })
    const a = client(3399, 'tok-0'), b = client(3399, 'tok-1')
    await Promise.all([a.ready, b.ready])
    await settle()

    expect(a.events('presence:sync').length).toBeGreaterThan(0)
    expect(app.presence('room:a').length).toBe(2)
    a.close(); b.close()
  })

  it('a list names the channels, exactly and by prefix', async () => {
    // The shape to reach for: presence belongs on the one channel a room is,
    // and never on the ten a data-sync app announces model writes over.
    const on  = await serve(3400, 'room:a', { presence: ['room:*'] })
    const c1 = client(3400, 'tok-0')
    await c1.ready; await settle()
    expect(c1.events('presence:sync').length).toBeGreaterThan(0)
    c1.close()

    const off = await serve(3401, 'orders', { presence: ['room:*'] })
    const c2 = client(3401, 'tok-0')
    await c2.ready; await settle()
    expect(c2.events('presence:sync')).toEqual([])
    expect(off.presence('orders')).toEqual([])
    c2.close()
    void on
  })
})

describe('a join storm costs one frame per window, not one per member', () => {

  it('N joins produce far fewer than N x (N-1) frames', async () => {
    const N = 24
    await serve(3402, 'room:a', { presence: true, presenceFlushMs: 60 })

    const clients = Array.from({ length: N }, (_, i) => client(3402, `tok-${i}`))
    await Promise.all(clients.map(c => c.ready))
    await settle(400)

    // What every member received about other members. Each connection still
    // gets its own `presence:sync` — that is the roster it needs and it is one
    // frame per join, not N.
    const fanout = clients.reduce((n, c) => n + c.events('presence:diff').length + c.events('presence:join').length, 0)

    // Unbatched this is N x (N-1) = 552. The window is what collapses it.
    expect(fanout).toBeLessThan(N * 4)

    // And the information still arrived: the last joiner is known to the first.
    const diffs = clients[0].events('presence:diff')
    const named = new Set(diffs.flatMap(d => (d.data.joined ?? []).map((m: any) => m.userId)))
    expect(named.size).toBeGreaterThan(N / 2)

    clients.forEach(c => c.close())
  })

  it('`presenceFlushMs: 0` is the unbatched protocol, and it is the control', async () => {
    // Same storm, no window: this is what the number above is measured against,
    // and it is a supported mode for a small app that wants presence instantly.
    const N = 24
    await serve(3403, 'room:a', { presence: true, presenceFlushMs: 0 })

    const clients = Array.from({ length: N }, (_, i) => client(3403, `tok-${i}`))
    await Promise.all(clients.map(c => c.ready))
    await settle(400)

    const fanout = clients.reduce((n, c) => n + c.events('presence:join').length, 0)
    expect(fanout).toBeGreaterThan(N * 4)
    clients.forEach(c => c.close())
  })

  it('a socket that joins and leaves inside one window announces neither', async () => {
    // A flapping connection is exactly what a reconnect storm is made of, and
    // announcing both halves of it is the amplifier this exists to remove.
    await serve(3404, 'room:a', { presence: true, presenceFlushMs: 120 })

    const watcher = client(3404, 'tok-0')
    await watcher.ready
    await settle(200)

    const flapper = client(3404, 'tok-1')
    await flapper.ready
    flapper.close()
    await settle(300)

    // Filtered to the flapper: a batch excludes nobody, so the watcher's own
    // earlier join is legitimately in a diff of its own and is not what this
    // is about.
    const moved = watcher.events('presence:diff')
      .flatMap(d => [...(d.data.joined ?? []), ...(d.data.left ?? [])])
      .filter((m: any) => m.userId === 'u1')
    expect(moved).toEqual([])
    watcher.close()
  })
})
