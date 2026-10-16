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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join }   from 'node:path'
import { tmpdir } from 'node:os'

import { createApp } from '../src/core/app.ts'

const running: Array<{ stop: () => Promise<void> }> = []
const dirs:    string[] = []
const envPort = process.env.PORT
const envBroker = process.env.FLI_PORT_BE
afterEach(async () => {
  while (running.length) await running.pop()!.stop().catch(() => {})
  while (dirs.length)    rmSync(dirs.pop()!, { recursive: true, force: true })
  if (envPort === undefined) delete process.env.PORT
  else process.env.PORT = envPort
  if (envBroker === undefined) delete process.env.FLI_PORT_BE
  else process.env.FLI_PORT_BE = envBroker
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
  writeFileSync(join(dir, 'junction.config.js'), `export default ${JSON.stringify(file)}\n`)
  return dir
}

type Bound = { http: { port: number | null, _server?: { hostname?: string } } }

async function boot (file: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<Bound> {
  const app = createApp({ configPath: configDir(file), config: config as never, logLevel: 'silent' })
  await app.start()
  running.push(app as unknown as { stop: () => Promise<void> })
  return app as unknown as Bound
}

describe('the bind is read after the config file', () => {
  test('PORT is the port listened on', async () => {
    const port = freePort()
    process.env.PORT = String(port)
    const app = await boot({})
    expect(app.http.port).toBe(port)
    expect((await fetch(`http://127.0.0.1:${port}/nowhere`)).status).toBe(404)
  })

  // The port `fli dev` hands this process. Junction reads it once so no app
  // writes `process.env.FLI_PORT_BE ?? 8100` itself (`FJS-2975`).
  test('FLI_PORT_BE is the port listened on when PORT is unset', async () => {
    const port = freePort()
    delete process.env.PORT
    process.env.FLI_PORT_BE = String(port)
    const app = await boot({})
    expect(app.http.port).toBe(port)
  })

  test('PORT beats FLI_PORT_BE', async () => {
    const port = freePort()
    process.env.PORT = String(port)
    process.env.FLI_PORT_BE = String(freePort())
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

  test('a port passed to createApp still beats the file and PORT', async () => {
    process.env.PORT = String(freePort())
    const app = await boot({ app: { port: freePort() } }, { port: 0 })
    expect(app.http.port).not.toBe(Number(process.env.PORT))
    expect(app.http.port).toBeGreaterThan(0)
  })
})
