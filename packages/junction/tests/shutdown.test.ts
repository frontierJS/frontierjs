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

// ─── FJS-693 · a process that is leaving says so, and cannot exit 0 ────────
//
// `FJS-460` made `stop()` finish. These are what it finishes AS. Three things
// were measured and all three were silent: a request arriving during the drain
// was answered 200 with `/health` still 200, so a load balancer kept choosing
// a process that had stopped accepting connections; and a plugin whose
// `shutdown()` never settles ended with the process exiting **0** in 54ms —
// every timer unref'd, the loop empty — with the queue, the outbox and the
// database close all skipped and *Shutdown complete* never printed.
//
// The exit-code half cannot be asserted in-process (a test that exits is not a
// test), so it is asserted where the decision is made: the deadline fires, the
// remaining steps still run, and `stop()` resolves rather than hanging.

describe('shutdown says what it is doing (FJS-693)', () => {

  test('readiness answers 503 while draining, with Connection: close', async () => {
    const { healthPlugin } = await import('../src/transport/health.ts')
    const app  = createApp({ config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
    app.configure(healthPlugin())
    await app.start()
    const port = app.http.port as number

    // The control: up, and it says so.
    const before = await fetch(`http://localhost:${port}/health`)
    expect(before.status).toBe(200)
    expect((await before.json() as { status: string }).status).toBe('ok')

    // Draining is a state, not the act of stopping — assert it directly rather
    // than racing `stop()`, which closes the port it would be asked on.
    app.draining = true
    const during = await fetch(`http://localhost:${port}/health`)
    expect(during.status).toBe(503)
    expect((await during.json() as { status: string }).status).toBe('draining')
    expect(during.headers.get('connection')).toBe('close')

    app.draining = false
    await app.stop()
  })

  test('an ordinary answer carries Connection: close while draining', async () => {
    // A load balancer stops choosing this process once /health fails, but a
    // client already holding a keep-alive socket does not — it sends its next
    // request into a process that is closing, and was answered 200.
    const { app, port } = await serve({}, a => a.get('/ping', (ctx: { json: (d: unknown) => Response }) => ctx.json({ ok: true })))

    const before = await fetch(`http://localhost:${port}/ping`)
    expect(before.headers.get('connection')).not.toBe('close')

    app.http.setDraining(true)
    const during = await fetch(`http://localhost:${port}/ping`)
    expect(during.headers.get('connection')).toBe('close')

    app.http.setDraining(false)
    await app.stop()
  })

  test('a plugin that never settles does not take the rest of shutdown with it', async () => {
    const ran: string[] = []
    const app = createApp({
      config: {
        port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
        shutdown: { pluginTimeout: 60 },
      },
    })
    app.configure({ name: 'first',  register() {}, shutdown() { ran.push('first') } })
    app.configure({ name: 'hangs',  register() {}, shutdown() { return new Promise<void>(() => {}) } })
    app.configure({ name: 'last',   register() {}, shutdown() { ran.push('last') } })
    await app.start()

    const t = Date.now()
    await app.stop()

    // Reverse order, and the hung one is skipped rather than blocking.
    expect(ran).toEqual(['last', 'first'])
    expect(Date.now() - t).toBeLessThan(2_000)
  })

  test('the whole shutdown is bounded — the control for the row above', async () => {
    // A plugin that settles inside its own budget is NOT skipped: a deadline
    // that gave up on everything would pass the previous assertion too.
    const ran: string[] = []
    const app = createApp({
      config: {
        port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
        shutdown: { pluginTimeout: 500 },
      },
    })
    app.configure({
      name: 'slow', register() {},
      async shutdown() { await Bun.sleep(40); ran.push('slow') },
    })
    await app.start()
    await app.stop()
    expect(ran).toEqual(['slow'])
  })

  test('a plugin shutdown that throws is logged and the rest still run', async () => {
    const ran: string[] = []
    const app = createApp({ config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
    app.configure({ name: 'ok',     register() {}, shutdown() { ran.push('ok') } })
    app.configure({ name: 'throws', register() {}, shutdown() { throw new Error('boom') } })
    await app.start()
    await app.stop()
    expect(ran).toEqual(['ok'])
  })

  test('crash handlers are not installed over an application that has its own', async () => {
    // A framework replacing an app's crash policy is worse than not having one.
    const mine = () => {}
    process.on('unhandledRejection', mine)
    try {
      const app = createApp({ config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
      await app.start()
      expect(process.listenerCount('unhandledRejection')).toBe(1)
      await app.stop()
    } finally {
      process.removeListener('unhandledRejection', mine)
    }
  })

  test('stop() detaches every handler it installed', async () => {
    // Repeated app lifecycles in one process must not accumulate listeners.
    // Asserted in three steps rather than two: before === after is also true of
    // an app that installed nothing, which is the row above passing for the
    // wrong reason.
    const before = {
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    }
    const app = createApp({ config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
    await app.start()
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1)
    expect(process.listenerCount('uncaughtException')).toBe(before.exception + 1)

    await app.stop()
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection)
    expect(process.listenerCount('uncaughtException')).toBe(before.exception)
  })

  test('crashHandlers: false installs neither', async () => {
    const before = process.listenerCount('unhandledRejection')
    const app = createApp({
      config: {
        port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
        shutdown: { crashHandlers: false },
      },
    })
    await app.start()
    expect(process.listenerCount('unhandledRejection')).toBe(before)
    await app.stop()
  })
})
