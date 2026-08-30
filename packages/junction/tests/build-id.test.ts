// tests/build-id.test.ts
//
// A deploy replaces the code under browsers that are already running. This is
// how they find out — the server STATES its build and the client compares.
//
// The two claims worth asserting are the two that are easy to get wrong:
//
//   IT IS INERT WHEN NOBODY SET ONE. A dev server, a test, an app nobody
//   deployed — none of them announce anything, and `_finalizeWithHeaders`'s
//   no-op fast path is preserved for them, which is why the header is gated
//   rather than always set.
//
//   `stale` FIRES ONCE. Being told a new version is available is useful; being
//   told on every call afterwards is the same fact turned into noise, and the
//   reload that settles it belongs to the person.
//
// The comparison is deliberately the CLIENT's. A server that diffed per request
// would answer a question that changes at most once per deploy, on every call,
// and would have to be written twice because the two transports carry headers
// differently.

import { describe, it, expect, afterEach } from 'bun:test'
import { resolveBuildId, BUILD_HEADER, BUILD_FIELD } from '../src/core/build-id.ts'
import { createApp } from '../src/core/app.ts'
import { channels } from '../index.ts'
import { createJunctionClient } from '../src/client/index.ts'

const clearEnv = () => { delete process.env.FJS_BUILD }
afterEach(clearEnv)

describe('resolveBuildId', () => {

  it('is null when nothing set one', () => {
    clearEnv()
    expect(resolveBuildId({})).toBeNull()
    expect(resolveBuildId(null)).toBeNull()
    expect(resolveBuildId(undefined)).toBeNull()
  })

  it('reads the environment, which is how a deploy supplies it', () => {
    process.env.FJS_BUILD = 'abc123'
    expect(resolveBuildId({})).toBe('abc123')
  })

  // A stated value is an app or a test saying what this process is; the
  // environment is what the container was started with.
  it('prefers a stated value over the environment', () => {
    process.env.FJS_BUILD = 'from-env'
    expect(resolveBuildId({ build: 'stated' })).toBe('stated')
  })

  it('treats blank as absent, which is what an unset env var expands to', () => {
    process.env.FJS_BUILD = '   '
    expect(resolveBuildId({})).toBeNull()
    expect(resolveBuildId({ build: '' })).toBeNull()
  })

  it('trims, because a shell heredoc leaves a newline on the value', () => {
    expect(resolveBuildId({ build: ' abc123\n' })).toBe('abc123')
  })

  it('ignores a non-string, rather than stringifying whatever arrived', () => {
    expect(resolveBuildId({ build: 42 })).toBeNull()
    expect(resolveBuildId({ build: {} })).toBeNull()
  })
})

describe('the wire names', () => {
  it('are one owner for both transports', () => {
    expect(BUILD_HEADER).toBe('x-fjs-build')
    expect(BUILD_FIELD).toBe('build')
  })
})

describe('an app that knows its build', () => {

  it('records it on the config so every reader sees the resolved value', async () => {
    process.env.FJS_BUILD = 'deploy-42'
    const app = createApp({ logLevel: 'silent' })
    await app._startForTest()
    expect(app.config.build).toBe('deploy-42')
  })

  it('leaves an app nobody deployed with none', async () => {
    clearEnv()
    const app = createApp({ logLevel: 'silent' })
    await app._startForTest()
    expect(app.config.build).toBeUndefined()
  })

  it('takes a stated one without an environment', async () => {
    clearEnv()
    const app = createApp({ config: { build: 'stated-7' }, logLevel: 'silent' })
    await app._startForTest()
    expect(app.config.build).toBe('stated-7')
  })
})

// ─── the wire ────────────────────────────────────────────────────────────────
//
// Against a REAL listening server and a REAL client, because the header is set
// inside `_finalizeWithHeaders` behind the no-op fast path that exists to hand
// an untouched Response back when nothing needs adding. A stubbed fetch would
// assert the client's half against a header this repo wrote by hand, which is
// exactly the seam where a gating bug lives.

describe('the server states its build and the client compares', () => {

  const serve = async (build?: string) => {
    const app = createApp({
      config: {
        port: 0,
        ...(build ? { build } : {}),
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
      },
      logLevel: 'silent',
    })
    app.configure(channels())
    app.get('/ping', (ctx) => ctx.json({ ok: true }))
    await app.start()
    return { app, port: app.http.port as number }
  }

  it('puts the header on an HTTP response', async () => {
    clearEnv()
    const { app, port } = await serve('server-1')
    try {
      const res = await fetch(`http://localhost:${port}/ping`)
      expect(res.headers.get(BUILD_HEADER)).toBe('server-1')
    } finally { await app.stop() }
  })

  // The gate is what preserves the fast path for every app that never deployed.
  it('sets no header when the app has no build', async () => {
    clearEnv()
    const { app, port } = await serve()
    try {
      const res = await fetch(`http://localhost:${port}/ping`)
      expect(res.headers.get(BUILD_HEADER)).toBeNull()
    } finally { await app.stop() }
  })

  it('leaves a client on the same build not stale', async () => {
    clearEnv()
    const { app, port } = await serve('same')
    const client = createJunctionClient({ url: `http://localhost:${port}`, build: 'same', timeout: 2_000 })
    try {
      await client._request('GET', '/ping')
      expect(client.serverBuild).toBe('same')
      expect(client.stale).toBe(false)
    } finally { await app.stop() }
  })

  it('makes a client on an older build stale, and says which two', async () => {
    clearEnv()
    const { app, port } = await serve('server-2')
    const client = createJunctionClient({ url: `http://localhost:${port}`, build: 'client-1', timeout: 2_000 })
    const seen: Array<Record<string, unknown>> = []
    client.on('stale', (p: Record<string, unknown>) => seen.push(p))
    try {
      await client._request('GET', '/ping')
      expect(client.stale).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({ client: 'client-1', server: 'server-2' })
    } finally { await app.stop() }
  })

  // Told once. Told on every call afterwards is the same fact as noise, and the
  // reload that settles it is the person's to make.
  it('fires stale once, not once per call', async () => {
    clearEnv()
    const { app, port } = await serve('server-2')
    const client = createJunctionClient({ url: `http://localhost:${port}`, build: 'client-1', timeout: 2_000 })
    let fired = 0
    client.on('stale', () => { fired++ })
    try {
      await client._request('GET', '/ping')
      await client._request('GET', '/ping')
      await client._request('GET', '/ping')
      expect(fired).toBe(1)
    } finally { await app.stop() }
  })

  // A client with no build of its own cannot know it is behind, and saying so
  // would be a reload prompt fired at every dev server.
  it('never fires for a client that was not stamped', async () => {
    clearEnv()
    const { app, port } = await serve('server-2')
    const client = createJunctionClient({ url: `http://localhost:${port}`, timeout: 2_000 })
    let fired = 0
    client.on('stale', () => { fired++ })
    try {
      await client._request('GET', '/ping')
      expect(client.serverBuild).toBe('server-2')
      expect(client.stale).toBe(false)
      expect(fired).toBe(0)
    } finally { await app.stop() }
  })

  // The socket half. A deploy restarts the container, so every socket drops and
  // the `connected` frame after the reconnect is the first thing a stale client
  // sees — which is why the field rides that frame rather than a new one.
  it('carries the build on the connected frame', async () => {
    clearEnv()
    const { app, port } = await serve('server-3')
    try {
      const ws = new WebSocket(`ws://localhost:${port}/ws`)
      const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no connected frame')), 4_000)
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data))
          if (msg.type !== 'connected') return
          clearTimeout(timer)
          resolve(msg)
        }
        ws.onerror = reject
      })
      expect(frame[BUILD_FIELD]).toBe('server-3')
      ws.close()
    } finally { await app.stop() }
  })

  it('omits the field when the app has no build', async () => {
    clearEnv()
    const { app, port } = await serve()
    try {
      const ws = new WebSocket(`ws://localhost:${port}/ws`)
      const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no connected frame')), 4_000)
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data))
          if (msg.type !== 'connected') return
          clearTimeout(timer)
          resolve(msg)
        }
        ws.onerror = reject
      })
      expect(BUILD_FIELD in frame).toBe(false)
      ws.close()
    } finally { await app.stop() }
  })
})
