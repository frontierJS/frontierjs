// tests/heartbeat.test.ts
//
// A connection was evicted at 30s unless the client sent {type:'ping'}, and
// NOTHING in the framework sent one — not junction, not sierra, not the
// scaffold. Every app flapped out of the box: open, {"connected"}, close 1000
// "connection evicted" ~35s later, reconnect, repeat. The socket never
// carried an event, so a live list looked simply broken.
//
// Two halves are asserted here, because either alone leaves the flap:
//   the server pings an idle socket, and any frame back answers it;
//   the shipped client replies to that ping from its message handler.
//
// The client's reply is not a timer on purpose — browsers throttle timers to
// ~1/min in a hidden tab, slower than any eviction window, so a timer-driven
// client is evicted the moment the tab is backgrounded. A message handler is
// not throttled.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, channels, defaultConfig }        from '../index.ts'
import { createJunctionClient }                      from '../src/client/index.ts'

const PORT = 3397
const WS   = `ws://localhost:${PORT}/ws`

// Scaled down from the shipped 15s/40s. Same ratio, so the eviction under
// test is the shipped one and not a different race.
const INTERVAL = 100
const TIMEOUT  = 400

let app: any

beforeAll(async () => {
  app = createApp({
    config: {
      port:     PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.configure(channels(undefined, { heartbeatInterval: INTERVAL, heartbeatTimeout: TIMEOUT }))
  await app.start()
})

afterAll(async () => { await app?.stop() })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Raw socket recording every frame and every close, answering nothing. */
function raw(opts: { pong?: boolean } = {}) {
  const ws = new WebSocket(WS)
  const frames: any[] = []
  let closed: { code: number; reason: string } | null = null

  ws.onmessage = (e: any) => {
    let f: any
    try { f = JSON.parse(String(e.data)) } catch { return }
    frames.push(f)
    if (opts.pong && f.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
  }
  ws.onclose = (e: any) => { closed = { code: e.code, reason: e.reason } }

  const ready = (async () => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      if (frames.some(f => f?.type === 'connected')) return
      await sleep(15)
    }
    throw new Error('ws never sent {type:"connected"}')
  })()

  return {
    ws, frames, ready,
    get closed() { return closed },
    pings: () => frames.filter(f => f?.type === 'ping').length,
    send:  (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  }
}

describe('ws liveness — the server drives it', () => {
  it('pings an idle connection rather than waiting to evict it', async () => {
    const c = raw()
    await c.ready
    await sleep(INTERVAL * 2.5)
    expect(c.pings()).toBeGreaterThan(0)
    c.close()
  })

  it('evicts a connection that answers nothing', async () => {
    const c = raw()
    await c.ready
    await sleep(TIMEOUT + INTERVAL * 3)
    expect(c.closed).not.toBeNull()
    expect(app.channels.stats().connections).toBe(0)
  })

  it('holds a connection that answers the ping, past several timeouts', async () => {
    const c = raw({ pong: true })
    await c.ready
    await sleep(TIMEOUT * 3)
    expect(c.closed).toBeNull()
    // `> 0` and not `=== 1`. This case owns one connection and `stats()` counts
    // every socket the server holds, so exclusivity is a claim about the other
    // cases in this file rather than about the heartbeat — it read 2 on every
    // full-suite run and passed in isolation (FJS-516). What the case is named
    // for is the line above; this one only has to see the connection counted.
    expect(app.channels.stats().connections).toBeGreaterThan(0)
    c.close()
    await sleep(50)
  })

  it('counts any frame as liveness, not only a pong', async () => {
    // A client mid-service-call is plainly alive. Grading on pings alone
    // evicted a socket that had been talking the whole time.
    const c = raw()
    await c.ready
    const until = Date.now() + TIMEOUT * 2
    while (Date.now() < until) {
      c.send({ type: 'subscribe', channel: 'room:1' })
      await sleep(INTERVAL / 2)
    }
    expect(c.closed).toBeNull()
    c.close()
    await sleep(50)
  })
})

describe('ws liveness — the shipped client answers on its own', () => {
  it('stays connected with no heartbeat call by the app', async () => {
    // No startHeartbeat() here, which is the point: an app that does nothing
    // must not flap.
    const client = createJunctionClient({ url: `http://localhost:${PORT}` }) as any
    client.connect()

    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !client._wsReady) await sleep(15)
    expect(client._wsReady).toBe(true)

    let closes = 0
    client.on('disconnect', () => { closes++ })

    await sleep(TIMEOUT * 3)
    expect(closes).toBe(0)
    expect(client._wsReady).toBe(true)

    client.disconnect()
    await sleep(50)
  })
})
