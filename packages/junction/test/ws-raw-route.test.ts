// test/ws-raw-route.test.ts
//
// `app.ws` is the raw door (`FJS-1829`, `FJS-D688`). A vendor-dialled socket
// speaks its own protocol, so junction sends it no `connected` and no
// `{type:'error'}`; the route sets its own frame bounds, can refuse the
// upgrade as an HTTP response, takes `apiPrefix`, keeps per-socket state in
// `ctx.locals`, and a handler's throw reaches `onError`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let app: any
let BASE: string
const seen: string[] = []
const errors: unknown[] = []

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:      0,
      apiPrefix: '/api',
      services:  { dir: '/nonexistent' },
      http:      { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.events.on('error', (err: unknown) => { errors.push(err) })
  app.ws('/media/{ticket}', {
    open(ctx: any)  { ctx.locals.count = 0 },
    message(ctx: any, msg: any) {
      ctx.locals.count = (ctx.locals.count as number) + 1
      seen.push(`${msg}:${ctx.locals.count}`)
      if (msg === 'boom') throw new Error('handler failed')
    },
  }, {
    limits:  { maxFramesPerSecond: 0, maxInFlight: 0 },
    upgrade: (req: Request) => {
      if (!new URL(req.url).pathname.endsWith('/good')) return new Response('no such ticket', { status: 404 })
    },
  })
  app.ws('/tight', {
    message() {},
  }, { limits: { maxFramesPerSecond: 2 } })
  await app.start()
  BASE = `ws://localhost:${app.http.port}`
})

afterAll(async () => { await app?.stop() })

function dial(path: string) {
  const ws = new WebSocket(BASE + path)
  const frames: string[] = []
  ws.onmessage = (e: any) => { frames.push(String(e.data)) }
  const opened = new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('refused')) })
  const closed = new Promise<{ code: number; reason: string }>(r => { ws.onclose = (e: any) => r({ code: e.code, reason: e.reason }) })
  return { ws, frames, opened, closed }
}

describe('app.ws is the raw door (FJS-1829)', () => {

  test('junction sends the peer no connected frame', async () => {
    const s = dial('/api/media/good')
    await s.opened
    await sleep(100)
    expect(s.frames).toEqual([])
    s.ws.close()
  })

  test('apiPrefix applies as it does to app.post', async () => {
    const bare = dial('/media/good')
    await expect(bare.opened).rejects.toThrow()
  })

  test('upgrade(req) refuses before the socket exists', async () => {
    const res = await fetch(`http://localhost:${app.http.port}/api/media/bogus`, {
      headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('no such ticket')
  })

  test('ctx.locals is the socket\'s own', async () => {
    seen.length = 0
    const a = dial('/api/media/good'); const b = dial('/api/media/good')
    await Promise.all([a.opened, b.opened])
    a.ws.send('x'); a.ws.send('y'); b.ws.send('z')
    for (let i = 0; i < 100 && seen.length < 3; i++) await sleep(10)
    expect(seen.sort()).toEqual(['x:1', 'y:2', 'z:1'])
    a.ws.close(); b.ws.close()
  })

  test('a handler throw reaches onError', async () => {
    errors.length = 0
    const s = dial('/api/media/good')
    await s.opened
    s.ws.send('boom')
    for (let i = 0; i < 100 && !errors.length; i++) await sleep(10)
    expect((errors[0] as Error)?.message).toBe('handler failed')
    s.ws.close()
  })

  test('the route\'s limits override the app\'s, and a refusal closes 1008 with the code', async () => {
    // /media has no rate limit: 300 frames in a burst are all handled.
    seen.length = 0
    const free = dial('/api/media/good')
    await free.opened
    for (let i = 0; i < 300; i++) free.ws.send('f')
    for (let i = 0; i < 200 && seen.length < 300; i++) await sleep(10)
    expect(seen.length).toBe(300)
    free.ws.close()

    const tight = dial('/api/tight')
    await tight.opened
    for (let i = 0; i < 20; i++) tight.ws.send('t')
    const closed = await tight.closed
    expect(closed).toEqual({ code: 1008, reason: 'rate_limited' })
    expect(tight.frames).toEqual([])
  })
})
