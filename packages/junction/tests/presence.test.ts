// tests/presence.test.ts
//
// Presence had ZERO coverage, and the untested code was broken: both
// `manager.presenceOf()` and `manager._presenceGet()` referenced a bare
// `presence` identifier that does not exist in channels.ts (the tracker is
// `_presence` and its Map is private to presence.ts). Every call threw
// `ReferenceError: presence is not defined`.
//
// It stayed invisible because the WS message handler swallows everything —
// `try { await handlers.message?.(ctx, message) } catch {}` in transport/http.ts
// — so a crash inside `subscribe` looked exactly like a client that sent
// nothing. Only asserting on the frames the client actually receives catches
// this class of bug, which is what these tests do.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, channels, defaultConfig }        from '../index.ts'

const PORT = 3391
const WS   = `ws://localhost:${PORT}/ws`
const ROOM = 'room:1'

// Two users so presence has someone to be a list of.
const USERS: Record<string, { userId: string; userType: string; authMethod: 'session' }> = {
  'tok-alice': { userId: 'alice', userType: 'user', authMethod: 'session' },
  'tok-bob':   { userId: 'bob',   userType: 'user', authMethod: 'session' },
}

let app: any

/** A WS client that records every frame, so tests assert on what arrived. */
function client(token?: string) {
  const url    = token ? `${WS}?token=${token}` : WS
  const ws     = new WebSocket(url)
  const frames: any[] = []

  ws.onmessage = (e: any) => {
    try { frames.push(JSON.parse(String(e.data))) } catch { frames.push(String(e.data)) }
  }

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws never sent {type:"connected"}')), 4000)
    const check = setInterval(() => {
      if (frames.some(f => f?.type === 'connected')) { clearInterval(check); clearTimeout(timer); resolve() }
    }, 15)
    ws.onerror = () => { clearInterval(check); clearTimeout(timer); reject(new Error('ws error')) }
  })

  // Every channel broadcast uses ONE wire format — encodeEventFrame() emits
  // { type: 'event', event, data } — so presence frames are matched on `event`,
  // not on `type`.
  const find = (event: string) => frames.find(f => f?.type === 'event' && f?.event === event)

  /** Wait for a presence event, or throw with what did arrive — a silent
   *  swallowed handler error otherwise shows up as an unhelpful timeout. */
  const waitFor = async (event: string, ms = 2500) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = find(event)
      if (hit) return hit
      await new Promise(r => setTimeout(r, 15))
    }
    throw new Error(
      `no "${event}" frame; got: ${JSON.stringify(frames.map(f => f?.event ?? f?.type))}`
    )
  }

  const has = (event: string) => Boolean(find(event))

  return { ws, frames, ready, waitFor, has, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => ws.close() }
}

beforeAll(async () => {
  app = createApp({
    config: {
      port: PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      // app.stop() races http.stop() against this. Bun's stop() without
      // force never closes WebSockets and they never drain on their own, so
      // shutting down with a live socket ALWAYS waits the whole drain window
      // — 5s by default, which blows the afterAll hook budget. 250ms here.
      http: { ...defaultConfig.http, drainTimeout: 250 },
    },
    auth: {
      async verifySession(token: string) { return USERS[token] ?? null },
      async login()      { return { token: '', user: null as never } },
      async logout()      {},
      async createUser()  { return {} as never },
      async deleteUser()  {},
      async createApiKey(id: string) { return { key: `k-${id}`, id: `k-${id}` } },
      async revokeApiKey() {},
      async verifyApiKey() { return null },
    },
  })

  app.configure(channels((a: any) => {
    // Server owns membership: everyone who connects lands in ROOM.
    a.channels.on('connection', (_session: unknown, conn: unknown) => { a.channel(ROOM).join(conn) })
  }))

  await app.start()
})

afterAll(async () => { await app?.stop() })

describe('presence — regression: the functions must not throw', () => {
  it('presenceOf() returns a list instead of throwing ReferenceError', () => {
    expect(() => app.presenceOf('nobody')).not.toThrow()
    expect(app.presenceOf('nobody')).toEqual([])
  })

  it('_presenceGet() returns undefined for an unknown member instead of throwing', () => {
    const mgr = app.channels
    expect(() => mgr._presenceGet(ROOM, 'no-such-conn')).not.toThrow()
    expect(mgr._presenceGet(ROOM, 'no-such-conn')).toBeUndefined()
  })

  it('a lookup for an unjoined channel does not allocate a channel map', () => {
    const mgr = app.channels
    mgr._presenceGet('channel:never-joined', 'x')
    expect(app.presence('channel:never-joined')).toEqual([])
  })
})

describe('presence — join and sync', () => {
  it('sends presence:sync to a joining member, listing themselves', async () => {
    const alice = client('tok-alice')
    await alice.ready

    const sync = await alice.waitFor('presence:sync')
    expect(sync.data.channelId).toBe(ROOM)
    expect(sync.data.members.map((m: any) => m.userId)).toContain('alice')

    alice.close()
  })

  it('broadcasts presence:join to existing members when a second user arrives', async () => {
    const alice = client('tok-alice')
    await alice.ready
    await alice.waitFor('presence:sync')

    const bob = client('tok-bob')
    await bob.ready

    const join = await alice.waitFor('presence:join')
    expect(join.data.member.userId).toBe('bob')
    expect(join.data.channelId).toBe(ROOM)

    // The joiner sees itself in its own sync, not a join for itself.
    const bobSync = await bob.waitFor('presence:sync')
    expect(bobSync.data.members.map((m: any) => m.userId).sort()).toEqual(['alice', 'bob'])

    alice.close(); bob.close()
  })

  it('app.presence(channel) lists current members server-side', async () => {
    const alice = client('tok-alice')
    await alice.ready
    await alice.waitFor('presence:sync')

    const members = app.presence(ROOM)
    expect(members.map((m: any) => m.userId)).toContain('alice')

    alice.close()
  })

  it('app.presenceOf(userId) finds the membership across channels', async () => {
    const alice = client('tok-alice')
    await alice.ready
    await alice.waitFor('presence:sync')

    const mine = app.presenceOf('alice')
    expect(mine.length).toBeGreaterThan(0)
    expect(mine[0].channelId).toBe(ROOM)
    expect(mine[0].userId).toBe('alice')

    alice.close()
  })

  it('does not track anonymous connections', async () => {
    const anon = client()            // no token
    await anon.ready
    await new Promise(r => setTimeout(r, 200))

    expect(anon.has('presence:sync')).toBe(false)
    expect(app.presence(ROOM).some((m: any) => m.userId == null)).toBe(false)

    anon.close()
  })
})

describe('presence — subscribe (the path that used to crash)', () => {
  it('a subscribe with meta broadcasts presence:update to others', async () => {
    const alice = client('tok-alice')
    await alice.ready
    await alice.waitFor('presence:sync')

    const bob = client('tok-bob')
    await bob.ready
    await bob.waitFor('presence:sync')

    // This is the line that threw: the handler looks the member up via
    // _presenceGet before touching meta. A throw here is swallowed by the
    // transport, so the only symptom is this frame never arriving.
    bob.send({ type: 'subscribe', channel: ROOM, meta: { status: 'typing' } })

    const update = await alice.waitFor('presence:update')
    expect(update.data.channelId).toBe(ROOM)
    expect(update.data.meta).toEqual({ status: 'typing' })

    alice.close(); bob.close()
  })

  it('subscribe is ignored for a channel the connection is not in', async () => {
    const alice = client('tok-alice')
    await alice.ready
    await alice.waitFor('presence:sync')

    alice.send({ type: 'subscribe', channel: 'room:not-mine', meta: { x: 1 } })
    await new Promise(r => setTimeout(r, 200))

    expect(alice.frames.some(f => f?.data?.channelId === 'room:not-mine')).toBe(false)
    alice.close()
  })
})

describe('presence — leave', () => {
  it('broadcasts presence:leave and drops the member on disconnect', async () => {
    const alice = client('tok-alice')
    await alice.ready
    await alice.waitFor('presence:sync')

    const bob = client('tok-bob')
    await bob.ready
    await bob.waitFor('presence:sync')
    await alice.waitFor('presence:join')

    bob.close()

    const leave = await alice.waitFor('presence:leave')
    expect(leave.data.member.userId).toBe('bob')

    expect(app.presenceOf('bob')).toEqual([])
    expect(app.presence(ROOM).map((m: any) => m.userId)).not.toContain('bob')

    alice.close()
  })
})
