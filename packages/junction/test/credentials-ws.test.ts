// test/credentials-ws.test.ts
//
// FJS-1607 / FJS-D475 — the credentials list is one door for both transports,
// and a bearer token is its last entry. A socket's upgrade is a GET with an
// empty body, so a signed machine connects as the principal the verifier names,
// a bad signature closes 4001 the way a bad bearer does, and a provider's
// `verifyApiKey` is asked by the transport rather than only from inside its own
// `verifySession`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { signRequest } from '@frontierjs/toolbelt/signature'
import { createApp, createService, channels, defaultConfig, signedRequest } from '../index.ts'
import type { SessionContext } from '../src/auth/types.ts'

const SECRET = 'outpost-secret'
const NOW    = 1_800_000_000
const ROBOT  = { userId: 'outpost:op-1' } as SessionContext
const ALICE  = { userId: 'u-alice' } as SessionContext
const KEYED  = { userId: 'u-keyed' } as SessionContext

const probe = createService({
  name: 'probe',
  methods: ['find'],
  async find(ctx: any) { return [{ user: ctx.auth?.user?.userId ?? null }] },
})

let app: any
let port: number

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:     0,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
    credentials: [signedRequest({
      now: () => NOW,
      keyFor: req => req.headers['x-outpost-id'] === 'op-1' ? { secret: SECRET, session: ROBOT } : null,
    })],
  })
  // verifySession knows sessions only; the key is reachable through verifyApiKey alone.
  app.setAuth({
    async verifySession(t: string) { return t === 'alice' ? ALICE : null },
    async verifyApiKey(k: string)  { return k === 'k-1' ? KEYED : null },
  })
  app.services.register(probe)
  app.post('/whoami', (ctx: any) => ctx.json({ userId: ctx.user?.userId ?? null }))
  app.configure(channels())
  await app.start()
  port = app.http.port
})

afterAll(async () => { await app?.stop() })

async function signedHeaders(secret = SECRET, id = 'op-1') {
  const sig = await signRequest({ secret, method: 'GET', path: '/ws', body: '', timestamp: NOW, nonce: `n-${Math.random()}` })
  return { ...sig, 'x-outpost-id': id }
}

function open(headers: Record<string, string>, protocols?: string[]) {
  const ws = new (WebSocket as any)(`ws://localhost:${port}/ws`, { headers, protocols })
  const frames: any[] = []
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
  const closed = new Promise<number>(r => { ws.onclose = (e: any) => r(e.code) })
  return { ws, frames, closed }
}

async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function whoami(s: ReturnType<typeof open>): Promise<string | null> {
  await until(() => s.frames.some(f => f.type === 'connected'))
  s.ws.send(JSON.stringify({ type: 'service_call', id: 'w', service: 'probe', method: 'find', data: null, meta: {} }))
  await until(() => s.frames.some(f => f.id === 'w'))
  const frame = s.frames.find(f => f.id === 'w')
  return (frame.result?.data ?? frame.result)[0].user
}

describe('credentials on the WebSocket upgrade', () => {
  test('a signed upgrade connects as the principal the verifier names', async () => {
    const s = open(await signedHeaders())
    expect(await whoami(s)).toBe('outpost:op-1')
    s.ws.close()
  })

  test('a signature made with the wrong secret closes 4001', async () => {
    const s = open(await signedHeaders('not-the-secret'))
    expect(await s.closed).toBe(4001)
  })

  test('a caller the app does not know closes 4001 even holding a good bearer', async () => {
    const s = open(await signedHeaders(SECRET, 'stranger'), ['fjs', 'fjs.bearer.alice'])
    expect(await s.closed).toBe(4001)
  })

  test('an unsigned upgrade still goes to the bearer path', async () => {
    const s = open({}, ['fjs', 'fjs.bearer.alice'])
    expect(await whoami(s)).toBe('u-alice')
    s.ws.close()
  })
})

describe('a bearer token is the last entry, and verifyApiKey is asked by the transport', () => {
  const post = (token: string) => app.http.fetch(new Request(`http://localhost:${port}/whoami`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  }))

  test('HTTP: a key verifySession does not know is verified by verifyApiKey', async () => {
    expect((await (await post('k-1')).json()).userId).toBe('u-keyed')
  })

  test('HTTP: a token neither knows is anonymous', async () => {
    expect((await (await post('nope')).json()).userId).toBeNull()
  })

  test('WS: a key verifySession does not know is verified by verifyApiKey', async () => {
    const s = open({}, ['fjs', 'fjs.bearer.k-1'])
    expect(await whoami(s)).toBe('u-keyed')
    s.ws.close()
  })
})
