// test/ws-cookie-change.test.ts
//
// A socket's headers are the upgrade's for its whole life, so a cookie a raw
// route sets or clears after the socket opened never reaches a frame
// (`FJS-1503`, ruled by `FJS-D548`). Measured in Chrome: a link redeemed for a
// cookie read nothing over the open socket, and a cookie cleared by *forget
// this browser* kept reading the application over it until the tab reloaded.
//
// The pins: the response that changes a cookie closes every socket whose
// upgrade carried that name at the old value, and nobody else's; it says so
// under `x-fjs-credential`; and the browser client cycles its socket on it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient }                              from '../src/client/index.ts'

const probe = createService({
  name: 'probe',
  methods: ['find'],
  async find(ctx: any) {
    return [{ cookie: ctx.caller?.headers?.cookie ?? null }]
  },
})

let app: any
let BASE: string
let WS: string
let upgrades = 0

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:     0,
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.services.register(probe)
  app.configure(channels(a => { a.channels.on('connection', () => { upgrades++ }) }))
  app.post('/redeem', (ctx: any) => { ctx.setCookie('portal', 'fresh', { httpOnly: true }); return ctx.json({ ok: true }) })
  app.post('/leave',  (ctx: any) => { ctx.setCookie('portal', '', { maxAge: 0 }); return ctx.json({ ok: true }) })
  app.post('/same',   (ctx: any) => { ctx.setCookie('portal', 'old', { httpOnly: true }); return ctx.json({ ok: true }) })
  app.post('/quiet',  (ctx: any) => ctx.json({ ok: true }))
  await app.start()
  BASE = `http://localhost:${app.http.port}`
  WS   = `ws://localhost:${app.http.port}/ws`
})

afterAll(async () => { await app?.stop() })

interface Opened { ws: WebSocket; frames: any[]; closed: Promise<number>; code: number | null }

function open(cookie: string): Opened {
  const ws = new (WebSocket as any)(WS, { headers: { cookie } }) as WebSocket
  const s: Opened = { ws, frames: [], closed: null as never, code: null }
  ws.onmessage = (e: any) => { try { s.frames.push(JSON.parse(String(e.data))) } catch {} }
  s.closed = new Promise<number>(r => { ws.onclose = (e: any) => { s.code = e.code; r(e.code) } })
  return s
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

const settle = () => new Promise(r => setTimeout(r, 100))

describe('a cookie changed after the upgrade', () => {
  test('clearing it closes the sockets that carried it, and nobody else', async () => {
    const holder = open('portal=old')
    const other  = open('portal=someone-else')
    await until(() => holder.frames.some(f => f.type === 'connected') && other.frames.some(f => f.type === 'connected'))

    const res = await fetch(`${BASE}/leave`, { method: 'POST', headers: { cookie: 'portal=old' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-fjs-credential')).toBe('changed')

    await Promise.race([holder.closed, settle().then(settle).then(settle)])
    expect(holder.code).not.toBeNull()
    expect(holder.code).not.toBe(4001)
    expect(other.code).toBeNull()
    other.ws.close()
  })

  test('a redeem with no cookie on the request closes nothing and still signals', async () => {
    const holder = open('portal=old')
    await until(() => holder.frames.some(f => f.type === 'connected'))

    const res = await fetch(`${BASE}/redeem`, { method: 'POST' })
    expect(res.headers.get('x-fjs-credential')).toBe('changed')
    await settle()
    expect(holder.code).toBeNull()
    holder.ws.close()
  })

  test('a cookie set to the value it already had changes nothing', async () => {
    const holder = open('portal=old')
    await until(() => holder.frames.some(f => f.type === 'connected'))

    const same = await fetch(`${BASE}/same`, { method: 'POST', headers: { cookie: 'portal=old' } })
    expect(same.headers.get('x-fjs-credential')).toBeNull()
    const quiet = await fetch(`${BASE}/quiet`, { method: 'POST', headers: { cookie: 'portal=old' } })
    expect(quiet.headers.get('x-fjs-credential')).toBeNull()
    await settle()
    expect(holder.code).toBeNull()
    holder.ws.close()
  })

  test('the client cycles its socket when a raw route says a credential changed', async () => {
    const client = createJunctionClient({ url: BASE, apiPrefix: '' } as any) as any
    client.connect()
    await until(() => client._wsReady === true)
    const before = upgrades

    await client.fetch('/redeem', { method: 'POST' })
    await until(() => upgrades > before && client._wsReady === true)
    expect(upgrades).toBe(before + 1)

    // A response that changed nothing leaves the socket alone.
    await client.fetch('/quiet', { method: 'POST' })
    await settle()
    expect(upgrades).toBe(before + 1)

    // A client the app disconnected is not reopened by one.
    client.disconnect()
    await client.fetch('/redeem', { method: 'POST' })
    await settle()
    expect(upgrades).toBe(before + 1)
    expect(client._ws).toBeNull()
  })
})
