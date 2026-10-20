// bind-config.test.ts
//
// The address an app binds is the one its config states after `load-config`,
// not the one `createApp` saw. The transport is built inside `createApp`,
// before `junction.config.js` and `PORT` are read, so a bind taken from the
// transport's own options listened on the default 3000 whatever either said —
// `PORT=8100 bun run api` answered on 3000 and every client aimed at 8100 was
// refused (`FJS-2839`).
//
// Each case binds a port the OS just freed rather than a literal, so no two
// files can collide on it (`test-ports.test.ts`).

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join }   from 'node:path'
import { tmpdir } from 'node:os'

import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

const running: Array<{ stop: () => Promise<void> }> = []
const dirs:    string[] = []
const envPort = process.env.PORT
const envBroker = process.env.FRONTIER_PORT_BE
afterEach(async () => {
  while (running.length) await running.pop()!.stop().catch(() => {})
  while (dirs.length)    rmSync(dirs.pop()!, { recursive: true, force: true })
  if (envPort === undefined) delete process.env.PORT
  else process.env.PORT = envPort
  if (envBroker === undefined) delete process.env.FRONTIER_PORT_BE
  else process.env.FRONTIER_PORT_BE = envBroker
})

function freePort (): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port  = probe.port as number
  probe.stop(true)
  return port
}

function configDir (file: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-bind-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'junction.config.js'), `export default ${JSON.stringify(file)}\n`)
  return join(dir, 'src')
}

type Bound = { http: { port: number | null, _server?: { hostname?: string } } }

async function boot (file: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<Bound> {
  const app = createApp({ root: configDir(file), config: config as never, logLevel: 'silent' })
  await app.start()
  running.push(app as unknown as { stop: () => Promise<void> })
  return app as unknown as Bound
}

describe('the bind is read after the config file', () => {
  test('PORT is the port listened on when no slot was handed', async () => {
    const port = freePort()
    delete process.env.FRONTIER_PORT_BE
    process.env.PORT = String(port)
    const app = await boot({})
    expect(app.http.port).toBe(port)
    expect((await fetch(`http://127.0.0.1:${port}/nowhere`)).status).toBe(404)
  })

  // The port `fli dev` hands this process. Junction reads it once so no app
  // writes `process.env.FRONTIER_PORT_BE ?? 8100` itself (`FJS-2975`).
  test('FRONTIER_PORT_BE is the port listened on when PORT is unset', async () => {
    const port = freePort()
    delete process.env.PORT
    process.env.FRONTIER_PORT_BE = String(port)
    const app = await boot({})
    expect(app.http.port).toBe(port)
  })

  // Every PaaS injects PORT, so it is read — but below the slot, or a PORT left
  // in a shell or a .env moves the API off the port web/'s proxy forwards to
  // (`FJS-3000`).
  test('FRONTIER_PORT_BE beats PORT', async () => {
    const port = freePort()
    process.env.FRONTIER_PORT_BE = String(port)
    process.env.PORT = String(freePort())
    const app = await boot({})
    expect(app.http.port).toBe(port)
  })

  test("junction.config.js's app.port is the port listened on", async () => {
    const port = freePort()
    const app  = await boot({ app: { port } })
    expect(app.http.port).toBe(port)
  })

  test("junction.config.js's app.hostname is the address bound", async () => {
    const app = await boot({ app: { port: 0, hostname: '127.0.0.1' } })
    expect(app.http._server?.hostname).toBe('127.0.0.1')
  })

  test("a port in createApp's config still beats the file and the env", async () => {
    process.env.PORT = String(freePort())
    process.env.FRONTIER_PORT_BE = String(freePort())
    const app = await boot({ app: { port: freePort() } }, { port: 0 })
    expect(app.http.port).not.toBe(Number(process.env.PORT))
    expect(app.http.port).not.toBe(Number(process.env.FRONTIER_PORT_BE))
    expect(app.http.port).toBeGreaterThan(0)
  })
})

// A plugin's `register()` runs inside `configure()`, before `start()` reads the
// file, so its routes were mounted under the prefix `createApp` saw while the
// manifest advertised the file's. Every `fli new --full` app states apiPrefix in
// junction.config.js alone, and served its login and its services at the root
// behind a web proxy forwarding `/api` (`FJS-3072`).
describe("the file's apiPrefix moves every route", () => {
  test('routes registered before start, during it and by services', async () => {
    const app = createApp({
      root: configDir({ app: { apiPrefix: '/api' } }),
      config:     { port: 0 } as never,
      logLevel:   'silent',
    })
    app.post('/auth/login', ctx => ctx.json({ ok: true }))
    app.ws('/media', { message () {} })
    app.services.register(createService({ name: 'items', find: async () => [] }))
    await app.start()
    running.push(app as unknown as { stop: () => Promise<void> })
    const base = `http://127.0.0.1:${app.http.port}`

    expect((await fetch(`${base}/api/auth/login`, { method: 'POST' })).status).toBe(200)
    expect((await fetch(`${base}/auth/login`,     { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/api/items`)).status).toBe(200)
    expect((await fetch(`${base}/items`)).status).toBe(404)
    expect(app.http.router.routePaths('POST')).toContain('/api/auth/login')
    expect((await fetch(`${base}/api/media`, { headers: { upgrade: 'websocket' } })).status).not.toBe(404)
  })

  test('a prefix passed to createApp still beats the file', async () => {
    const app = createApp({
      root: configDir({ app: { apiPrefix: '/api' } }),
      config:     { port: 0, apiPrefix: '/v1' } as never,
      logLevel:   'silent',
    })
    app.post('/auth/login', ctx => ctx.json({ ok: true }))
    await app.start()
    running.push(app as unknown as { stop: () => Promise<void> })
    expect(app.http.router.routePaths('POST')).toContain('/v1/auth/login')
  })
})
