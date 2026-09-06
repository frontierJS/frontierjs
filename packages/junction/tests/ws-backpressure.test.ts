// tests/ws-backpressure.test.ts
//
// A WebSocket send can fail without failing.
//
// Bun's `ws.send()` returns the bytes written, `-1` when the frame was buffered
// under backpressure, and `0` when it was DROPPED — the socket's buffer is full
// and the frame is discarded. Junction ignored that number at all five send
// sites. A dropped `service_result` therefore left the caller's promise pending
// until its own 30s timeout, with no error, no close and nothing logged: the
// screen sits on "Loading…" while the server believes it answered (`FJS-139`).
//
// Reproduced headless before any of this existed: one socket, 200 concurrent
// reads of a ~1MB payload, 193 of them never settled. A call issued afterwards
// answered in 34ms, which is what made it read as "the socket is fine".
//
// Two things are pinned here. The unit tests own the contract — what happens to
// a dropped frame, in what order it comes back, and what happens to a consumer
// that never drains. The integration test owns the claim that it works against
// a real socket, because a stub cannot tell you that Bun's number means what we
// think it means.
//
// Note for anyone tempted to make the integration test cheaper by lowering
// Bun's own limit: `maxBackpressureLimit` is accepted and ignored — measured on
// Bun 1.3.11, a 64KB, 1MB and 16MB limit all start dropping at the same ~16.9MB.
// The volume below is what it takes to reach the path for real.

import { describe, test, expect, afterAll } from 'bun:test'
import { wsSend, flushSendQueue, dropSendQueue, queuedFrames, setMaxQueuedBytes } from '../src/transport/send-queue.ts'
import { createApp, channels, defaultConfig } from '../index.ts'
import { createJunctionClient } from '../src/client/index.ts'
import { createService } from '../src/core/service.ts'

// ─── The contract ─────────────────────────────────────────────────────────

/** A socket whose send() answers whatever the test says it answers. */
function fakeSocket(script: number[] | (() => number)) {
  const sent: string[] = []
  let i = 0
  return {
    sent,
    closed: null as { code?: number; reason?: string } | null,
    readyState: 1,
    send(payload: string) {
      const r = typeof script === 'function' ? script() : (script[i++] ?? payload.length)
      if (r !== 0) sent.push(payload)
      return r
    },
    close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3 },
  }
}

describe('the send queue — a dropped frame is held, not lost', () => {

  test('a frame Bun accepted is not queued', () => {
    const ws = fakeSocket(() => 42)
    expect(wsSend(ws, 'a')).toBe('sent')
    expect(queuedFrames(ws)).toBe(0)
    dropSendQueue(ws)
  })

  test('-1 is backpressure with the frame SAFE — Bun delivers it, we do nothing', () => {
    // The distinction that matters: treating -1 as a failure would double every
    // frame the moment a socket got busy.
    const ws = fakeSocket(() => -1)
    expect(wsSend(ws, 'a')).toBe('sent')
    expect(queuedFrames(ws)).toBe(0)
    dropSendQueue(ws)
  })

  test('0 is the drop — the frame is held until drain', () => {
    const ws = fakeSocket([0])
    expect(wsSend(ws, 'held')).toBe('queued')
    expect(queuedFrames(ws)).toBe(1)
    expect(ws.sent).toEqual([])

    flushSendQueue(ws)
    expect(ws.sent).toEqual(['held'])
    expect(queuedFrames(ws)).toBe(0)
  })

  test('once anything is held, everything queues behind it — order survives', () => {
    // A frame that jumped the queue would arrive before one sent earlier, and
    // an event stream that reorders is worse than one that pauses.
    const ws = fakeSocket([0])
    wsSend(ws, 'one')
    wsSend(ws, 'two')
    wsSend(ws, 'three')
    expect(ws.sent).toEqual([])

    flushSendQueue(ws)
    expect(ws.sent).toEqual(['one', 'two', 'three'])
  })

  test('a flush that is dropped again leaves the frame at the head', () => {
    const ws = fakeSocket([0, 0])   // the send, then the first flush attempt
    wsSend(ws, 'one')
    wsSend(ws, 'two')

    flushSendQueue(ws)
    expect(ws.sent).toEqual([])
    expect(queuedFrames(ws)).toBe(2)

    flushSendQueue(ws)                  // socket has room now
    expect(ws.sent).toEqual(['one', 'two'])
  })

  test('a consumer that never drains is closed, not grown without bound', () => {
    setMaxQueuedBytes(1_000)
    const ws = fakeSocket(() => 0)
    wsSend(ws, 'x'.repeat(600))
    expect(queuedFrames(ws)).toBe(1)

    expect(wsSend(ws, 'x'.repeat(600))).toBe('closed')
    // 1013 Try Again Later. The client rejects every pending call on close and
    // reconnects — a caller learns the truth instead of waiting on a frame that
    // is never coming.
    expect(ws.closed?.code).toBe(1013)
    setMaxQueuedBytes(undefined)
  })

  test('a closed socket is not queued for', () => {
    const ws = fakeSocket(() => 0)
    ws.readyState = 3
    expect(wsSend(ws, 'a')).toBe('closed')
    expect(queuedFrames(ws)).toBe(0)
  })
})

// ─── Against a real socket ────────────────────────────────────────────────

describe('a burst big enough to drop frames still delivers every one', () => {

  // Port 0, read back after start(). A fixed port here was `FJS-900`: several
  // files in this package bound the same one and bun runs them in ONE process,
  // so an app answered while a previous file's app on that port was still
  // shutting down. Never hard-code a port in this package's tests.
  let PORT = 0
  const ROOM  = 'ws:1'
  const FRAME = 200_000     // 200KB × 200 = 40MB, well past Bun's ~16.9MB
  const COUNT = 200

  let app: any
  afterAll(async () => { await app?.stop() })

  test('200 × 200KB down one socket: all 200 arrive', async () => {
    app = createApp({
      config: {
        port: 0,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        // The held queue has to cover what Bun drops — 20MB of it here. The
        // 8MB default would close this socket instead, which is the other
        // half of the contract and is pinned by the unit test above.
        http: { ...defaultConfig.http, drainTimeout: 250, wsMaxQueued: 64 * 1024 * 1024 },
      },
    })
    app.services.register(createService({ name: 'things', find: async () => [] }))
    app.configure(channels((a: any) => {
      a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel(ROOM).join(conn) })
    }))
    await app.start()
    PORT = (app as unknown as { http: { port: number } }).http.port

    const client = createJunctionClient({ url: `http://localhost:${PORT}` })
    let received = 0
    client.on('event', () => { received++ })
    client.connect()

    const ready = Date.now() + 5_000
    while (!(client as any)._wsReady && Date.now() < ready) await new Promise(r => setTimeout(r, 20))
    expect((client as any)._wsReady).toBe(true)

    const blob = 'y'.repeat(FRAME)
    for (let i = 0; i < COUNT; i++) app.channel(ROOM).send('things patched', { i, blob })

    const deadline = Date.now() + 20_000
    while (received < COUNT && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))

    // Before the send queue this was ~100 of 200, silently.
    expect(received).toBe(COUNT)
  }, 30_000)
})
