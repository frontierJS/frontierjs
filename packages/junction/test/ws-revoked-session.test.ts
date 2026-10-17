// test/ws-revoked-session.test.ts
//
// A credential that is present and does not verify closes the app's socket
// 4001 (`FJS-702`) — and that held only for a provider that THROWS.
// `@frontierjs/auth`'s `verifySession` answers null for a revoked, expired or
// forged token, so a signed-out session reopened `/ws` as anonymous and got
// `connected` (`FJS-1830`). The provider here answers null, as the framework's
// own does.
//
// The refusal belongs to the socket that reads the app's sessions. A raw
// `app.ws` route may be a carrier's, whose own token rides `Authorization`
// (Telnyx's `stream_auth_token`), and closing it 4001 before its handler ran
// would refuse a credential the app never issued.
//
// An open socket asks the bearer again on every frame and on
// `http.ws.reverifySeconds` (`FJS-D1201`), so a session revoked AFTER the
// upgrade closes it too (`FJS-3187`). A verifier is never asked again: it is
// shown the upgrade request, and a signed one refuses its nonce a second time.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import type { SessionContext }                               from '../src/auth/types.ts'

const ALICE = { userId: 'u-alice', userType: 'user', roles: [], scopes: [] } as unknown as SessionContext
const MACHINE = { userId: 'm-1', userType: 'peer', roles: [], scopes: [] } as unknown as SessionContext

// What each live token answers. A fresh object per call, as `@frontierjs/auth`
// answers one, so an unchanged principal is told apart by value.
const live = new Map<string, () => SessionContext>([['alice', () => ({ ...ALICE })]])
let machineAsked = 0

const probe = createService({
  name: 'probe',
  methods: ['find'],
  async find(ctx: any) { return [{ user: ctx.auth?.user?.userId ?? null }] },
})

let app: any
let BASE: string
const carrier: Array<{ user: unknown; authorization: string | undefined }> = []

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:     0,
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250, ws: { reverifySeconds: 1 } },
    },
    credentials: [req => {
      if (!req.headers['x-machine']) return null
      machineAsked++
      return MACHINE
    }],
  })
  app.setAuth({
    async verifySession(token: string) { return live.get(token)?.() ?? null },
    async verifyApiKey() { return null },
  })
  app.services.register(probe)
  app.configure(channels())
  app.ws('/carrier', {
    open(ctx: any) {
      carrier.push({ user: ctx.user, authorization: ctx.headers.authorization })
      ctx.send({ type: 'hello' })
    },
  })
  await app.start()
  BASE = `ws://localhost:${app.http.port}`
})

afterAll(async () => { await app?.stop() })

interface Opened { ws: WebSocket; frames: any[]; closed: Promise<number> }

function open(path: string, init?: { protocols?: string[]; headers?: Record<string, string> }): Opened {
  const ws = init?.headers
    ? new WebSocket(BASE + path, { headers: init.headers, protocols: init.protocols } as any)
    : new WebSocket(BASE + path, init?.protocols)
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

let asked = 0
async function whoami(s: Opened): Promise<string | null> {
  await until(() => s.frames.some(f => f.type === 'connected'))
  const id = `w${++asked}`
  s.ws.send(JSON.stringify({ type: 'service_call', id, service: 'probe', method: 'find', data: null, meta: {} }))
  await until(() => s.frames.some(f => f.id === id))
  const frame = s.frames.find(f => f.id === id)
  return (frame.result?.data ?? frame.result)[0].user
}

describe('/ws refuses a session the provider answers null for (FJS-1830)', () => {

  test('a good session still connects as itself', async () => {
    const s = open('/ws', { protocols: ['fjs', 'fjs.bearer.alice'] })
    expect(await whoami(s)).toBe('u-alice')
    s.ws.close()
  })

  test('a revoked session on the subprotocol closes 4001 and is never connected', async () => {
    const s = open('/ws', { protocols: ['fjs', 'fjs.bearer.revoked'] })
    expect(await s.closed).toBe(4001)
    expect(s.frames.some(f => f.type === 'connected')).toBe(false)
  })

  test('a forged Authorization bearer closes 4001', async () => {
    const s = open('/ws', { headers: { authorization: 'Bearer bogus' } })
    expect(await s.closed).toBe(4001)
    expect(s.frames.some(f => f.type === 'connected')).toBe(false)
  })

  test('no credential at all is still anonymous, not refused', async () => {
    const s = open('/ws')
    expect(await whoami(s)).toBeNull()
    s.ws.close()
  })
})

describe('a raw route is handed the token it may own', () => {

  test("a carrier's bearer reaches the route's open, anonymous and not closed", async () => {
    const s = open('/carrier', { headers: { authorization: 'Bearer carrier-stream-token' } })
    await until(() => s.frames.some(f => f.type === 'hello'))
    expect(carrier.at(-1)).toEqual({ user: null, authorization: 'Bearer carrier-stream-token' })
    s.ws.close()
  })
})

describe('a session that changes after the upgrade closes the socket (FJS-3187)', () => {

  test('a revoke, then a frame: closed 4001 and the frame is not answered', async () => {
    live.set('bob', () => ({ ...ALICE, userId: 'u-bob' }))
    const s = open('/ws', { protocols: ['fjs', 'fjs.bearer.bob'] })
    expect(await whoami(s)).toBe('u-bob')
    live.delete('bob')
    s.ws.send(JSON.stringify({ type: 'service_call', id: 'after', service: 'probe', method: 'find', data: null, meta: {} }))
    expect(await s.closed).toBe(4001)
    expect(s.frames.some(f => f.id === 'after')).toBe(false)
  })

  test('a socket that only receives is closed on the interval', async () => {
    live.set('carol', () => ({ ...ALICE, userId: 'u-carol' }))
    const s = open('/ws', { protocols: ['fjs', 'fjs.bearer.carol'] })
    expect(await whoami(s)).toBe('u-carol')
    live.delete('carol')
    const started = Date.now()
    expect(await s.closed).toBe(4001)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('a changed principal closes 1001, so the client reconnects as the new one', async () => {
    live.set('dave', () => ({ ...ALICE, userId: 'u-dave' }))
    const s = open('/ws', { protocols: ['fjs', 'fjs.bearer.dave'] })
    expect(await whoami(s)).toBe('u-dave')
    live.set('dave', () => ({ ...ALICE, userId: 'u-dave', roles: ['admin'] }))
    expect(await s.closed).toBe(1001)
  })

  test('an unchanged principal stays open past the interval', async () => {
    const s = open('/ws', { protocols: ['fjs', 'fjs.bearer.alice'] })
    expect(await whoami(s)).toBe('u-alice')
    let closed = false
    s.closed.then(() => { closed = true })
    await new Promise(r => setTimeout(r, 2500))
    expect(closed).toBe(false)
    s.ws.close()
  })

  test('a verifier answered the upgrade: it is not asked again', async () => {
    const before = machineAsked
    const s = open('/ws', { headers: { 'x-machine': '1' } })
    expect(await whoami(s)).toBe('m-1')
    await new Promise(r => setTimeout(r, 2500))
    expect(await whoami(s)).toBe('m-1')
    expect(machineAsked - before).toBe(1)
    s.ws.close()
  })
})
