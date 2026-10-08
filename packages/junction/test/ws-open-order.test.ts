// test/ws-open-order.test.ts
//
// A raw `app.ws` route's frames wait for `open` (`FJS-1828`). Bun dispatches
// `message` as soon as a frame arrives, and `_wsOpen` is async — it awaits the
// credential verifier, then the route's own `open` — so a caller that writes
// the instant its socket opens (Telnyx sends `connected` and `start` that way)
// reached `message` before `open` had run, with `ctx.user` still null.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import type { SessionContext }      from '../src/auth/types.ts'

const ALICE = { userId: 'u-alice', userType: 'user', roles: [], scopes: [] } as unknown as SessionContext
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let app: any
let BASE: string
const log: string[] = []

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: {
      port:     0,
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.setAuth({
    async verifySession(token: string) { await sleep(20); return token === 'alice' ? ALICE : null },
    async verifyApiKey() { return null },
  })
  app.ws('/stream', {
    open(ctx: any)  { log.push(`open:${ctx.user?.userId ?? null}`) },
    message(ctx: any, msg: any) { log.push(`message:${msg}:${ctx.user?.userId ?? null}`) },
  })
  app.ws('/slow-open', {
    async open() { log.push('open:start'); await sleep(30); log.push('open:end') },
    message(_ctx: any, msg: any) { log.push(`message:${msg}`) },
  })
  await app.start()
  BASE = `ws://localhost:${app.http.port}`
})

afterAll(async () => { await app?.stop() })

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out; log: ${log.join(', ')}`)
    await sleep(5)
  }
}

function sendOnOpen(path: string, frames: string[], headers?: Record<string, string>): WebSocket {
  const ws = headers ? new WebSocket(BASE + path, { headers } as any) : new WebSocket(BASE + path)
  ws.onopen = () => { for (const f of frames) ws.send(f) }
  return ws
}

describe('frames sent the instant a socket opens wait for open (FJS-1828)', () => {

  test('behind a credential verifier, open runs first and every frame sees the user', async () => {
    log.length = 0
    const ws = sendOnOpen('/stream', ['connected', 'start'], { authorization: 'Bearer alice' })
    await until(() => log.length === 3)
    expect(log).toEqual(['open:u-alice', 'message:connected:u-alice', 'message:start:u-alice'])
    ws.close()
  })

  test('an async open settles before the first frame is handled', async () => {
    log.length = 0
    const ws = sendOnOpen('/slow-open', ['connected', 'start'])
    await until(() => log.length === 4)
    expect(log).toEqual(['open:start', 'open:end', 'message:connected', 'message:start'])
    ws.close()
  })
})
