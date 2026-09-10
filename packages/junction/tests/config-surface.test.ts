/**
 * tests/config-surface.test.ts — every key `junction.config.js` may declare is
 * READ by something (`FJS-D256`).
 *
 * This is the completeness tripwire the ruling turns on, and the shape is the
 * one `verbs-rules.test.ts` already uses: the failure class here is not a wrong
 * value, it is a key that is typed, documented, exported and inert. Nine of
 * them were — `middleware.helmet` sat one letter from the `http.helmet` that is
 * read, and `plugins.health: false` served `/health` anyway. Nothing failed,
 * because nothing was asking.
 *
 * So the file grades in BOTH directions. The scan holds the two interfaces
 * against the table below, so a key added to either without a row here fails on
 * the next run rather than in a year. The rows themselves are behavioral and go
 * through a real listening server: a middleware patches the router, so the only
 * honest observation of *is it installed* is a request that comes back with its
 * effect on it.
 *
 * Every refusal is PAIRED with the same declaration one value away, because a
 * config reader that installed nothing at all satisfies every assertion about a
 * key being off.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join }   from 'node:path'
import { tmpdir } from 'node:os'

import { createApp } from '../src/core/app.ts'

// ─── The table ────────────────────────────────────────────────────────────
// One row per declarable key, naming how this file proves it is read. A row
// whose `how` is `registration` says so out loud: it is the weaker claim, and
// it is what a middleware with no visible effect on a response leaves available.

const COVERED: Record<string, { section: 'middleware' | 'plugins'; how: 'behavior' | 'registration' }> = {
  cors:          { section: 'middleware', how: 'behavior' },
  helmet:        { section: 'middleware', how: 'behavior' },
  requestLogger: { section: 'middleware', how: 'registration' },
  correlationId: { section: 'middleware', how: 'behavior' },
  rateLimit:     { section: 'middleware', how: 'behavior' },
  bodyLimit:     { section: 'middleware', how: 'behavior' },
  csrf:          { section: 'middleware', how: 'behavior' },
  health:        { section: 'plugins',    how: 'behavior' },
  manifest:      { section: 'plugins',    how: 'behavior' },
  openapi:       { section: 'plugins',    how: 'behavior' },
  devtools:      { section: 'plugins',    how: 'registration' },
}

/** The keys an interface declares, read off the source it is declared in. */
function declaredKeys(iface: string): string[] {
  const src   = readFileSync(join(import.meta.dir, '../src/config/index.ts'), 'utf8')
  const start = src.indexOf(`export interface ${iface} {`)
  if (start === -1) throw new Error(`${iface} is gone — this file grades a shape that no longer exists`)
  const body  = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map(m => m[1])
}

// ─── Harness ──────────────────────────────────────────────────────────────

const running: Array<{ stop: () => Promise<void> }> = []
const dirs:    string[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.stop().catch(() => {})
  while (dirs.length)    rmSync(dirs.pop()!, { recursive: true, force: true })
})

/**
 * A real `junction.config.js` on disk, and the app pointed at it.
 *
 * The file is the point rather than a convenience: `middleware:` and
 * `plugins:` are AUTHORING sections that `loadConfig` normalizes onto the
 * runtime shape, so an app handed `opts.config` directly skips the translation
 * — which is exactly where `rateLimit` was renaming `max` onto a transport
 * reading `limit`, and where five keys were mapped nowhere at all.
 */
function configDir(file: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-cfg-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'junction.config.js'), `export default ${JSON.stringify(file, null, 2)}\n`)
  return dir
}

async function serve(file: Record<string, unknown>, config: Record<string, unknown> = {}) {
  // Port 0 and read back, so parallel suites cannot collide.
  const app = createApp({
    configPath: configDir(file),
    config:     { port: 0, ...config } as never,
    logLevel:   'silent',
  })
  // A real route to aim at. Middleware patches the ROUTER, so a 404 never
  // reaches it — every header assertion below would read null against a
  // correctly installed middleware, which is a test that passes when the
  // feature is removed and fails when it works.
  app.get('/probe',  (ctx: { json: (b: unknown) => unknown }) => ctx.json({ ok: true }))
  app.post('/probe', (ctx: { json: (b: unknown) => unknown }) => ctx.json({ ok: true }))
  await app.start()
  running.push(app as unknown as { stop: () => Promise<void> })
  const port = (app as unknown as { http: { port: number } }).http.port
  return {
    app,
    get:  (path = '/probe', headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers }),
    post: (path = '/probe', headers: Record<string, string> = {}, body = '{}') =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }),
  }
}

// ─── The tripwire ─────────────────────────────────────────────────────────

describe('every declarable key is graded', () => {
  test('a key added to JunctionMiddlewareConfig has a row here', () => {
    const missing = declaredKeys('JunctionMiddlewareConfig')
      .filter(k => COVERED[k]?.section !== 'middleware')
    expect(missing).toEqual([])
  })

  test('a key added to JunctionPluginsConfig has a row here', () => {
    const missing = declaredKeys('JunctionPluginsConfig')
      .filter(k => COVERED[k]?.section !== 'plugins')
    expect(missing).toEqual([])
  })

  // The other direction, and it is not symmetric bookkeeping: a row grading a
  // key that has been deleted passes forever against nothing at all, which is
  // exactly the state this ruling was written about.
  test('a row here names a key that still exists', () => {
    const real = new Set([...declaredKeys('JunctionMiddlewareConfig'), ...declaredKeys('JunctionPluginsConfig')])
    expect(Object.keys(COVERED).filter(k => !real.has(k))).toEqual([])
  })

  // The control. A scan that matched nothing would pass both directions above
  // vacuously, and looks identical to one that works.
  test('the scan actually read something', () => {
    expect(declaredKeys('JunctionMiddlewareConfig').length).toBeGreaterThan(4)
    expect(declaredKeys('JunctionPluginsConfig').length).toBeGreaterThan(2)
  })
})

// ─── Middleware ───────────────────────────────────────────────────────────

describe('middleware declared in config is installed', () => {
  test('helmet is on by default and `helmet: false` turns it off', async () => {
    const on  = await serve({})
    expect((await on.get()).headers.get('x-content-type-options')).toBe('nosniff')

    const off = await serve({ middleware: { helmet: false } })
    expect((await off.get()).headers.get('x-content-type-options')).toBeNull()
  })

  test('cors answers a declared origin and nothing when none is declared', async () => {
    const on = await serve({ middleware: { cors: { origins: ['https://shop.test'] } } })
    expect((await on.get('/probe', { origin: 'https://shop.test' })).headers.get('access-control-allow-origin'))
      .toBe('https://shop.test')

    const off = await serve({})
    expect((await off.get('/probe', { origin: 'https://shop.test' })).headers.get('access-control-allow-origin'))
      .toBeNull()
  })

  test('correlationId stamps a response, and nothing does without it', async () => {
    const on  = await serve({ middleware: { correlationId: true } })
    expect((await on.get()).headers.get('x-request-id')).toBeTruthy()

    const off = await serve({})
    expect((await off.get()).headers.get('x-request-id')).toBeNull()
  })

  test('csrf refuses a foreign origin and lets the declared one through', async () => {
    const s = await serve({ middleware: { cors: { origins: ['https://shop.test'] }, csrf: true } })
    expect((await s.post('/probe', { origin: 'https://evil.test' })).status).toBe(403)
    expect((await s.post('/probe', { origin: 'https://shop.test' })).status).not.toBe(403)
  })

  // A CSRF guard with no origin list has one possible behavior and it is
  // allow. Refused at start rather than installed permissive.
  test('csrf with no list to borrow refuses to start', async () => {
    const app = createApp({ config: { port: 0, http: { csrf: true } } as never, logLevel: 'silent' })
    await expect(app.start()).rejects.toThrow(/csrf .*no origin list/i)
  })

  test('bodyLimit refuses an oversized body and passes one that fits', async () => {
    const s = await serve({ middleware: { bodyLimit: { maxSize: 1024 } } })
    expect((await s.post('/probe', {}, JSON.stringify({ a: 'x'.repeat(4096) }))).status).toBe(413)
    expect((await s.post('/probe', {}, JSON.stringify({ a: 'x' }))).status).not.toBe(413)
  })

  test('rateLimit refuses past its max and answers the request under it', async () => {
    // Declared the way an app writes it, which is what makes this a crossing
    // rather than a restatement: this used to map onto the transport's `ddos`
    // guard under two different names AND after the transport was already
    // built, so a declared limit refused nobody and looked identical to one
    // that worked (`FJS-1066`).
    const s = await serve({ middleware: { rateLimit: { max: 1, window: 60_000 } } })
    expect((await s.get('/probe')).status).not.toBe(429)
    expect((await s.get('/probe')).status).toBe(429)
  })

  // Registration only, and it is the weaker claim on purpose: a request logger
  // has no effect on a response, so what can be asked is that config reached
  // app.configure() at all.
  test('requestLogger is registered from config and absent without it', async () => {
    const on  = await serve({ middleware: { requestLogger: true } })
    expect((on.app as unknown as { _plugins: string[] })._plugins).toContain('requestLoggerPlugin')

    const off = await serve({})
    expect((off.app as unknown as { _plugins: string[] })._plugins).not.toContain('requestLoggerPlugin')
  })
})

// ─── Plugins ──────────────────────────────────────────────────────────────

describe('plugins declared in config are installed', () => {
  test('health answers when declared and 404s when it is not', async () => {
    const on = await serve({ plugins: { health: true } })
    expect((await on.get('/health')).status).toBe(200)

    const off = await serve({})
    expect((await off.get('/health')).status).toBe(404)
  })

  test('manifest answers when declared and 404s when it is not', async () => {
    const on = await serve({ plugins: { manifest: true } })
    expect((await on.get('/manifest')).status).toBe(200)

    const off = await serve({})
    expect((await off.get('/manifest')).status).toBe(404)
  })

  test('openapi answers when declared, titled from the app when nothing says', async () => {
    const on  = await serve({ app: { name: 'shop' }, plugins: { openapi: true } })
    const res = await on.get('/openapi.json')
    expect(res.status).toBe(200)
    expect((await res.json() as { info: { title: string } }).info.title).toBe('shop')

    const off = await serve({})
    expect((await off.get('/openapi.json')).status).toBe(404)
  })

  test('devtools is registered from config and absent without it', async () => {
    const on = await serve({ plugins: { devtools: { port: 0, hostname: '127.0.0.1' } } })
    expect((on.app as unknown as { _plugins: string[] })._plugins).toContain('devtools')

    const off = await serve({})
    expect((off.app as unknown as { _plugins: string[] })._plugins).not.toContain('devtools')
  })
})

// ─── One owner ────────────────────────────────────────────────────────────

describe('a plugin has one owner', () => {
  test('declared in config AND configured by hand is refused, naming it', async () => {
    const { healthPlugin } = await import('../src/transport/health.ts')
    const app = createApp({ config: { port: 0, plugins: { health: true } } as never, logLevel: 'silent' })
    app.configure(healthPlugin())
    await expect(app.start()).rejects.toThrow(/'health'.*declared in config AND configured by hand/s)
  })

  // The control, and it is the row that keeps the refusal honest: configuring a
  // plugin by hand is the documented way to give it CODE, so a guard that
  // refused every hand-configured plugin would satisfy the assertion above and
  // break every app that needs a readiness check.
  test('configured by hand and NOT declared is the supported way to pass code', async () => {
    const { healthPlugin } = await import('../src/transport/health.ts')
    const app = createApp({ config: { port: 0 } as never, logLevel: 'silent' })
    app.configure(healthPlugin({ checks: { db: async () => true } }))
    await app.start()
    running.push(app as unknown as { stop: () => Promise<void> })
    const port = (app as unknown as { http: { port: number } }).http.port
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
  })
})
