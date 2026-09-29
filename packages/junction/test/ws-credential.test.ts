// test/ws-credential.test.ts
//
// A socket's credential rides the handshake's subprotocol list, never the URL
// (`FJS-D486`, `FJS-1322`).
//
// A browser WebSocket cannot set Authorization, so the client put the session
// token in `/ws?token=`, and a URL is what gets logged: Firefox printed the
// whole token in the console on every failed reconnect, and nginx's default
// `$request` and any APM that records upgrade URLs keep it too. Nothing inside
// the app notices, because the socket still authenticates. So the pins are
// from outside: the URL the client opens, what the server believes when the
// query names a token, and what a hook can read back off the headers.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient }                              from '../src/client/index.ts'
import type { SessionContext }                               from '../src/auth/types.ts'

const ALICE = { userId: 'u-alice', userType: 'user', roles: [], scopes: [] } as unknown as SessionContext

const probe = createService({
  name: 'probe',
  methods: ['find'],
  async find(ctx: any) {
    return [{
      user:     ctx.auth?.user?.userId ?? null,
      protocol: ctx.caller?.headers?.['sec-websocket-protocol'] ?? null,
    }]
  },
})

let app: any
let WS: string

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:     0,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.setAuth({
    async verifySession(token: string) {
      if (token === 'alice') return ALICE
      throw new Error('bad token')
    },
  })
  app.services.register(probe)
  app.configure(channels())
  await app.start()
  WS = `ws://localhost:${app.http.port}/ws`
})

afterAll(async () => { await app?.stop() })

interface Opened { ws: WebSocket; frames: any[]; closed: Promise<number> }

function open(url: string, protocols?: string[]): Opened {
  const ws = new WebSocket(url, protocols)
  const frames: any[] = []
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
  const closed = new Promise<number>(r => { ws.onclose = (e: any) => r(e.code) })
  return { ws, frames, closed }
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function whoami(s: Opened): Promise<{ user: string | null; protocol: string | null }> {
  await until(() => s.frames.some(f => f.type === 'connected'))
  s.ws.send(JSON.stringify({ type: 'service_call', id: 'w', service: 'probe', method: 'find', data: null, meta: {} }))
  await until(() => s.frames.some(f => f.id === 'w'))
  const frame = s.frames.find(f => f.id === 'w')
  const rows  = frame.result?.data ?? frame.result
  return rows[0]
}

// ─── the server ───────────────────────────────────────────────────────────

describe('the server reads the credential off the handshake', () => {

  test('a bearer subprotocol authenticates, and fjs is the one selected', async () => {
    const s = open(WS, ['fjs', 'fjs.bearer.alice'])
    const me = await whoami(s)
    expect(me.user).toBe('u-alice')
    expect(s.ws.protocol).toBe('fjs')
    s.ws.close()
  })

  test('the credential is gone from the headers every frame is handed', async () => {
    const s = open(WS, ['fjs', 'fjs.bearer.alice'])
    const me = await whoami(s)
    // ctx.caller.headers is the upgrade's, on every call, and the logger
    // redacts a header by NAME, which this one is not.
    expect(me.protocol).toBe('fjs')
    s.ws.close()
  })

  test('a bearer that does not verify closes 4001, as a bad Authorization does', async () => {
    const s = open(WS, ['fjs', 'fjs.bearer.mallory'])
    expect(await s.closed).toBe(4001)
  })

  test('?token= is not a credential: the socket is anonymous and not refused', async () => {
    const good = open(`${WS}?token=alice`)
    expect((await whoami(good)).user).toBeNull()
    good.ws.close()

    // A refused token would close 4001. Ignored is the other answer.
    const bad = open(`${WS}?token=mallory`)
    expect((await whoami(bad)).user).toBeNull()
    bad.ws.close()
  })
})

// ─── the browser client ───────────────────────────────────────────────────

describe('the browser client never puts the token in the URL', () => {

  test('the URL is bare and the token is the second subprotocol', async () => {
    const Real = globalThis.WebSocket
    const opened: Array<{ url: string; protocols: unknown }> = []
    ;(globalThis as any).WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        opened.push({ url: String(url), protocols })
      }
    }
    try {
      const client = createJunctionClient({ url: `http://localhost:${app.http.port}` })
      const connected = new Promise<void>(r => client.on('connect', () => r()))
      client.setToken('alice')
      await connected
      expect(opened).toHaveLength(1)
      expect(opened[0].url).toBe(`${WS}`)
      expect(opened[0].url).not.toContain('alice')
      expect(opened[0].protocols).toEqual(['fjs', 'fjs.bearer.alice'])
      client.disconnect()
    } finally {
      ;(globalThis as any).WebSocket = Real
    }
  })

  test('a token a subprotocol cannot carry is refused by the client, not sent mangled', () => {
    const client = createJunctionClient({ url: `http://localhost:${app.http.port}` })
    expect(() => client.setToken('has space')).toThrow(/RFC 7230/)
    client.disconnect()
  })
})
