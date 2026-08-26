// shutdown.test.ts — `app.stop()` with a client still attached.
//
// A server that cannot shut down while somebody holds a socket is a container
// that will not stop and gets SIGKILLed, and a suite whose `afterAll` outlives
// bun's 5s hook limit. Both were true: `tests/query-parity.test.ts` opened two
// clients, connected one over WebSocket, and its teardown timed out four runs in
// five (`FJS-460`). What it reported was worse than slow: *Shutdown complete*,
// with the client's socket still open at `readyState 1`.
//
// ─── What the fix could not use ───────────────────────────────────────────
//
// Bun's own graceful `server.stop()`. Measured against a bare `Bun.serve`, not
// inferred: once a WebSocket has been upgraded the promise never resolves — not
// after the socket is closed, not after the server's own close handler has run
// and the client reads `readyState 3`. `app.stop()` raced it against
// `drainTimeout`, so every shutdown that had ever held a client cost the full
// five seconds and then reported success with the port still bound.
//
// So the waits below are junction's own: the sockets it is holding, and the
// requests it is answering. The timings are the point of this file — a test
// that only asserted `stop()` resolves passed before the fix as well.
import { describe, test, expect } from 'bun:test'
import { createApp } from '../index.ts'
import { channels } from '../src/transport/channels.ts'

/**
 * An app on an OS-assigned port, so parallel suites cannot collide.
 *
 * `port` is top-level rather than under `http` — that is the key the transport
 * is constructed from — and the port is read BACK off the running server, since
 * asking for 0 is the only way to be sure the number is free and reading it
 * back is the only way to learn which one it got.
 */
async function serve(http: Record<string, unknown> = {}, routes?: (app: ReturnType<typeof createApp>) => void) {
  const app = createApp({
    config: {
      port:     0,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http,
    },
  })
  app.configure(channels())
  // Before start(): the router is built by a start phase and refuses a route
  // added afterwards, by name.
  routes?.(app)
  await app.start()
  return { app, port: app.http.port as number }
}

const open = async (port: number) => {
  const ws = new WebSocket(`ws://localhost:${port}/ws`)
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej })
  return ws
}

describe('app.stop() with a live socket (FJS-460)', () => {

  test('resolves promptly rather than burning the drain timeout', async () => {
    const { app, port } = await serve()
    const ws = await open(port)
    expect(ws.readyState).toBe(1)

    const started = Date.now()
    await app.stop()
    const took = Date.now() - started

    // The number is the assertion. Before the fix this was the drain timeout
    // every time — 5s, which is bun's hook limit, which is why it failed four
    // runs in five rather than every run.
    expect(took).toBeLessThan(1_000)
  })

  test('the client is told, with a code that survives the transport', async () => {
    const { app, port } = await serve()
    const ws = await open(port)
    const closed = new Promise<{ code: number, reason: string }>(res => {
      ws.onclose = (e) => res({ code: e.code, reason: e.reason })
    })

    await app.stop()
    const seen = await Promise.race([
      closed,
      new Promise<{ code: number, reason: string }>(res =>
        setTimeout(() => res({ code: -1, reason: 'never closed' }), 3_000)),
    ])

    // 1012 Service Restart, and not 1001 Going Away — which is the code that
    // means this and is the one code Bun does not deliver: sent as 1001 it
    // reaches the peer as 1000. Pinned because the choice is a workaround, and
    // a Bun release that fixed it should make this test say so.
    expect(seen.code).toBe(1012)
    expect(seen.reason).toBe('Server shutting down')
  })

  test('the port is released, so the next app can take it', async () => {
    const { app, port } = await serve()
    await open(port)
    await app.stop()

    // A property rather than a defect: the old race released the port too,
    // because a graceful stop stops ACCEPTING at once and only its promise
    // hangs. Pinned because forcing is now the only path, and a forced stop
    // that somehow left the listener up would be a worse bug than the one this
    // file is about.
    let answered = false
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) })
      answered = true
    } catch { /* refused, which is the point */ }
    expect(answered).toBe(false)
  })

  test('an in-flight request is still allowed to finish', async () => {
    // The thing the drain exists for, and the half that must not regress: a
    // shutdown that closed sockets promptly and cut a request off mid-answer
    // would trade one defect for a worse one.
    const { app, port } = await serve({}, (a) => {
      a.get('/slow', async () => {
        await new Promise(r => setTimeout(r, 300))
        return { ok: true }
      })
    })

    await open(port)
    const inFlight = fetch(`http://localhost:${port}/slow`)
    await new Promise(r => setTimeout(r, 50))   // let it arrive

    await app.stop()
    const res = await inFlight
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('a request that never finishes cannot hold the shutdown open', async () => {
    // The other side of the same rule. `drainTimeout` bounds the wait, and what
    // happens when it runs out is a FORCED stop — the alternative is a process
    // that never exits and is killed by whatever is supervising it.
    const { app, port } = await serve(
      { drainTimeout: 200 },
      (a) => { a.get('/hang', () => new Promise(() => { /* never resolves */ })) },
    )

    await open(port)
    fetch(`http://localhost:${port}/hang`).catch(() => {})
    await new Promise(r => setTimeout(r, 50))

    const started = Date.now()
    await app.stop()
    const took = Date.now() - started

    expect(took).toBeGreaterThanOrEqual(150)   // it did wait
    expect(took).toBeLessThan(2_000)           // and then it stopped waiting
  })

  test('stopping twice is not an error', async () => {
    const { app, port } = await serve()
    await open(port)
    await app.stop()
    await app.stop()
    expect(true).toBe(true)
  })

  test('an app that never held a socket is unaffected', async () => {
    const { app } = await serve()
    const started = Date.now()
    await app.stop()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
