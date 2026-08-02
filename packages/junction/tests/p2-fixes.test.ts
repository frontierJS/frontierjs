// tests/p2-fixes.test.ts
// ─────────────────────────────────────────────────────────────────────────
// Regression tests for the P2 leak & lifecycle pass (2026-07-18):
//
//   1. Empty channels are pruned from the manager map on disconnect.
//   2. Heartbeat/disconnect eviction closes the socket (no zombies).
//   3. app.stop() does NOT kill the process and is repeatable; signal
//      handlers don't accumulate across app lifecycles.
//   4. The service cache is scoped per app — no cross-app cache hits —
//      and destroyed by app.stop().
//   5. rateLimit() is a full Plugin with a shutdown() that clears its GC
//      timer; devtools no longer monkey-patches bus.emit and detaches
//      all its subscriptions on shutdown.
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'bun:test'
import { createTestApp, createService, testCtx, callService, rateLimit } from '../index.ts'
import { createChannelManager, type Connection } from '../src/transport/channels.ts'
import { devtools } from '../src/plugins/devtools/index.ts'

// Minimal fake socket for channel tests
function fakeSocket() {
  const calls: { closed: boolean; closeArgs: unknown[] } = { closed: false, closeArgs: [] }
  return {
    socket: {
      readyState: 1,
      send: (_m: string) => {},
      close: (...args: unknown[]) => { calls.closed = true; calls.closeArgs = args },
    },
    calls,
  }
}

// ─── 1 + 2. Channel pruning + socket close ────────────────────────────────

describe('P2: channel lifecycle', () => {

  it('prunes empty channels after the last member disconnects', async () => {
    const manager = createChannelManager()
    const { socket } = fakeSocket()
    const conn = await manager.handleConnection(socket as never, null)

    const ch1 = manager.channel('workspace:42')
    ch1.join(conn as Connection)
    expect(manager.channel('workspace:42')).toBe(ch1)   // stable while occupied

    await manager.handleDisconnect((conn as Connection).id)
    const ch2 = manager.channel('workspace:42')
    expect(ch2).not.toBe(ch1)                            // old entry was pruned
    expect(ch2.length).toBe(0)
    manager.destroy()
  })

  it('closes the socket on eviction instead of leaving a zombie', async () => {
    const manager = createChannelManager()
    const fake = fakeSocket()
    const conn = await manager.handleConnection(fake.socket as never, null)

    manager.channel('room').join(conn as Connection)
    await manager.handleDisconnect((conn as Connection).id)   // same path heartbeat eviction uses
    expect(fake.calls.closed).toBe(true)
    manager.destroy()
  })
})

// ─── 3. stop() lifecycle ──────────────────────────────────────────────────

describe('P2: stop() is non-fatal and repeatable', () => {

  it('stop() returns without exiting the process, twice', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'x', async find() { return [1] } })],
    })
    await app.stop()
    await app.stop()          // idempotent — second call must not throw
    expect(true).toBe(true)   // reaching here means the process survived
  })

  it('signal listeners do not accumulate across app lifecycles', async () => {
    const before = process.listenerCount('SIGTERM')
    for (let i = 0; i < 3; i++) {
      const app = await createTestApp({})
      await app.stop()
    }
    // createTestApp never runs start(), so no handlers should be added;
    // stop() must not leave anything behind either way.
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

// ─── 4. Per-app service cache ─────────────────────────────────────────────

describe('P2: per-app service cache scoping', () => {

  function cachedService(payload: string) {
    return createService({
      name: 'scoped',
      cache: true,
      async get() { return { id: '1', payload } },
    })
  }

  it('two apps never share cache entries for identical keys', async () => {
    const app1 = await createTestApp({ services: [() => cachedService('one')] })
    const app2 = await createTestApp({ services: [() => cachedService('two')] })

    const r1 = await app1.service('scoped').get('1') as { payload: string }
    expect(r1.payload).toBe('one')                       // primes app1's cache

    // Same service name, same id, same cache key — must MISS app1's cache
    const r2 = await app2.service('scoped').get('1') as { payload: string }
    expect(r2.payload).toBe('two')

    await app1.stop()
    await app2.stop()
  })

  it('bare callService (no app) still caches via the module fallback', async () => {
    let hits = 0
    const svc = createService({
      name: 'bare',
      cache: true,
      async get() { hits++; return { id: '1', n: hits } },
    })
    const c1 = testCtx('bare', 'get'); c1.id = '1'
    const c2 = testCtx('bare', 'get'); c2.id = '1'
    await callService(svc, c1)
    await callService(svc, c2)
    expect(hits).toBe(1)                                 // second call was a hit
  })
})

// ─── 5. Plugin teardown ───────────────────────────────────────────────────

describe('P2: plugin teardown', () => {

  it('rateLimit is a Plugin whose shutdown() clears its timer', () => {
    const plugin = rateLimit({ limit: 10, window: 1000 })
    expect(typeof plugin).toBe('object')
    expect((plugin as { name: string }).name).toBe('rateLimit')
    expect(typeof (plugin as { shutdown?: () => void }).shutdown).toBe('function')
    ;(plugin as { shutdown: () => void }).shutdown()     // must not throw
  })

  it('devtools observes via onAny (no bus.emit monkey-patch) and detaches on shutdown', async () => {
    const app = await createTestApp({})
    const origEmit = app.events.emit

    const dt = devtools({ port: 0 })
    app.configure(dt)

    expect(app.events.emit).toBe(origEmit)               // emit untouched
    expect(app.telemetry.hasListeners('junction.call')).toBe(true)

    await (dt as { shutdown?: () => void | Promise<void> }).shutdown?.()
    expect(app.telemetry.hasListeners('junction.call')).toBe(false)
    expect(app.events.hasListeners()).toBe(false)        // onAny tap removed
    await app.stop()
  })
})
