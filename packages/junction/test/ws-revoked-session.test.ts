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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import type { SessionContext }                               from '../src/auth/types.ts'

const ALICE = { userId: 'u-alice', userType: 'user', roles: [], scopes: [] } as unknown as SessionContext

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
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.setAuth({
    async verifySession(token: string) { return token === 'alice' ? ALICE : null },
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

async function whoami(s: Opened): Promise<string | null> {
  await until(() => s.frames.some(f => f.type === 'connected'))
  s.ws.send(JSON.stringify({ type: 'service_call', id: 'w', service: 'probe', method: 'find', data: null, meta: {} }))
  await until(() => s.frames.some(f => f.id === 'w'))
  const frame = s.frames.find(f => f.id === 'w')
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
