// tests/dev-services.test.ts
//
// A second listener the app started — a dev mail catcher, a stand-in payment
// provider — is invisible to everything that describes a running app, because
// every one of those readers is derived from MOUNTED ROUTES and a sidecar has
// none. It is its own server on its own port.
//
// So the two assertions here are the two readers, and the banner is the one
// that matters: an app printing what it serves used to be silent about three
// of the four processes it had just started, and the only record of them was a
// hand-written console.log in the app's entry file.
//
// `_devtools` is the same problem solved once for one case; this is the general
// one, and the reason it has to be an announcement rather than a discovery is
// that only the app knows a sidecar exists.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, manifestPlugin, defaultConfig } from '../index.ts'
import type { ILogger } from '../src/core/logger.ts'

const PORT = 3401

let app: any
const lines: { message: string, data?: Record<string, unknown> }[] = []

/** A logger that keeps what it was told, so the banner is assertable. */
function capturingLogger(): ILogger {
  const log: ILogger = {
    debug: () => {},
    info:  (message, data) => { lines.push({ message, data }) },
    warn:  () => {},
    error: () => {},
    child: () => log,
    level: 'debug',
    setLevel: () => {},
  }
  return log
}

const manifest = async () =>
  (await fetch(`http://localhost:${PORT}/manifest`)).json() as Promise<any>

beforeAll(async () => {
  app = createApp({
    logger: capturingLogger(),
    config: {
      port: PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
  app.configure(manifestPlugin())

  app.registerDevService({
    name: 'mail',
    url:  'http://localhost:8111',
    note: 'inbox: http://localhost:8111/',
  })
  app.registerDevService({ name: 'psp', url: 'http://localhost:8112' })

  await app.start()
})

afterAll(async () => { await app?.stop() })

describe('registerDevService', () => {
  it('names each one on the boot banner', () => {
    const mail = lines.find(l => l.message.includes('mail'))
    const psp  = lines.find(l => l.message.includes('psp'))

    expect(mail?.data?.url).toBe('http://localhost:8111')
    expect(mail?.data?.note).toBe('inbox: http://localhost:8111/')
    expect(psp?.data?.url).toBe('http://localhost:8112')
    // Absent rather than null — the logger drops undefined, and a note nobody
    // wrote should not print as an empty field.
    expect(psp?.data?.note).toBeUndefined()
  })

  it('prints them after the app has said what it is', () => {
    const banner = lines.findIndex(l => l.message.includes('🚀'))
    const mail   = lines.findIndex(l => l.message.includes('mail'))

    expect(banner).toBeGreaterThanOrEqual(0)
    expect(mail).toBeGreaterThan(banner)
  })

  it('carries them in the manifest, which no route of theirs could', async () => {
    const m = await manifest()
    expect(m.devServices).toEqual([
      { name: 'mail', url: 'http://localhost:8111', note: 'inbox: http://localhost:8111/' },
      { name: 'psp',  url: 'http://localhost:8112' },
    ])

    // The negative control for the paragraph above: neither one mounted a
    // route, so every other section of this document is blind to them.
    const paths = (m.routes as { path: string }[]).map(r => r.path)
    expect(paths.some(p => p.includes('8111') || p.includes('mail'))).toBe(false)
  })

  it('is keyed by name, so a re-register replaces', () => {
    app.registerDevService({ name: 'psp', url: 'http://localhost:9112' })
    expect(app._devServices.size).toBe(2)
    expect(app._devServices.get('psp').url).toBe('http://localhost:9112')
  })

  it('refuses a service that cannot be reached or named', () => {
    expect(() => app.registerDevService({ name: 'x' } as any)).toThrow(/name and a url/)
    expect(() => app.registerDevService({ url: 'http://x' } as any)).toThrow(/name and a url/)
  })
})

describe('an app that started no second listener', () => {
  it('answers an empty list rather than omitting the key', async () => {
    const quiet = createApp({
      config: {
        port: PORT + 1,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 200 },
      },
    })
    quiet.configure(manifestPlugin())
    await quiet.start()
    try {
      const m = await (await fetch(`http://localhost:${PORT + 1}/manifest`)).json() as any
      expect(m.devServices).toEqual([])
    } finally {
      await quiet.stop()
    }
  })
})
