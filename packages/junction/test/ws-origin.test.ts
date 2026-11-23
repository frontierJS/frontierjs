// test/ws-origin.test.ts
//
// A browser applies no CORS to a WebSocket handshake and sends the page's
// cookies with it, so under cookie auth a page on another origin could open a
// socket the session cookie authenticates (`FJS-3189`, ASVS V4.4.2). Ruled by
// `FJS-D1207`: an upgrade carrying an Origin is checked against the app's csrf
// origin list, or, with none, its host must equal `Host`; an upgrade with no
// Origin passes, since only a browser sends one.
//
// Each refusal is paired with an admission on the same app (`FJS-351`).

import { afterAll, describe, expect, test } from 'bun:test'
import { createApp, channels, defaultConfig } from '../index.ts'

const apps: any[] = []

async function boot(http: Record<string, unknown> = {}) {
  const app = createApp({
    logLevel: 'silent',
    config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 250, ...http } } as any,
  })
  app.configure(channels(() => {}))
  await app.start()
  apps.push(app)
  return app
}

afterAll(async () => { for (const app of apps) await app.stop() })

// 'connected' once the server's first frame lands, 'refused' when the
// handshake is answered with anything but 101.
function upgrade(port: number | null, origin?: string): Promise<'connected' | 'refused'> {
  const headers: Record<string, string> = { cookie: 'session=abc' }
  if (origin) headers.origin = origin
  const ws = new (WebSocket as any)(`ws://localhost:${port}/ws`, { headers }) as WebSocket
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('neither connected nor refused')) }, 3000)
    ws.onmessage = (e: any) => {
      if (String(e.data).includes('"connected"')) { clearTimeout(timer); ws.close(); resolve('connected') }
    }
    ws.onerror = () => { clearTimeout(timer); resolve('refused') }
    ws.onclose = () => { clearTimeout(timer); resolve('refused') }
  })
}

describe('an upgrade with no origin list configured', () => {
  test('an Origin on another host is refused, and the app\'s own host is admitted', async () => {
    const app  = await boot()
    const port = app.http.port
    expect(await upgrade(port, 'https://evil.example')).toBe('refused')
    expect(await upgrade(port, `http://localhost:${port}`)).toBe('connected')
  })

  test('a different port on the same hostname is another origin', async () => {
    const app = await boot()
    expect(await upgrade(app.http.port, 'http://localhost:1')).toBe('refused')
  })

  test('an upgrade with no Origin passes', async () => {
    const app = await boot()
    expect(await upgrade(app.http.port)).toBe('connected')
  })
})

describe('an upgrade with an origin list', () => {
  test('a csrf origin is admitted and an unlisted one refused', async () => {
    const app = await boot({ csrf: { origins: ['https://app.example'] } })
    expect(await upgrade(app.http.port, 'https://app.example')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://evil.example')).toBe('refused')
  })

  test('with no csrf list, the cors origins csrf would borrow are the list', async () => {
    const app = await boot({ cors: { origins: ['https://app.example', '*'] } })
    expect(await upgrade(app.http.port, 'https://app.example')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://evil.example')).toBe('refused')
  })

  test('csrf() installed by hand names its list for the upgrade, over a cors list', async () => {
    const { csrf } = await import('../index.ts')
    const app = createApp({ logLevel: 'silent', config: { port: 0, http: {
      ...defaultConfig.http, drainTimeout: 250, cors: { origins: ['https://other.example'] },
    } } as any })
    app.configure(csrf({ origins: ['https://app.example'] }))
    app.configure(channels(() => {}))
    await app.start()
    apps.push(app)
    expect(await upgrade(app.http.port, 'https://app.example')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://evil.example')).toBe('refused')
    expect(await upgrade(app.http.port, 'https://other.example')).toBe('refused')
  })
})

// FJS-3921 — the scaffold declares cors '*', and a wrapped desktop shell's page
// is tauri://localhost (http://tauri.localhost on Windows). The '*' admits it
// over HTTP, and the origins fli hands the API as FRONTIER_CORS_ORIGINS have to
// reach the socket too, or the shell signs in and its socket is a 403.
describe('derived origins beside a cors wildcard', () => {
  async function bootDerived(env: string, http: Record<string, unknown>) {
    process.env.FRONTIER_CORS_ORIGINS = env
    try { return await boot(http) } finally { delete process.env.FRONTIER_CORS_ORIGINS }
  }

  test('each shell spelling opens a socket and an unlisted origin is still refused', async () => {
    const app = await bootDerived('tauri://localhost,http://tauri.localhost', { cors: { origins: ['*'] } })
    expect(await upgrade(app.http.port, 'tauri://localhost')).toBe('connected')
    expect(await upgrade(app.http.port, 'http://tauri.localhost')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://evil.example')).toBe('refused')
    expect(await upgrade(app.http.port, `http://localhost:${app.http.port}`)).toBe('connected')
  })

  test('with none derived, a wildcard still names no socket origin', async () => {
    const app = await boot({ cors: { origins: ['*'] } })
    expect(await upgrade(app.http.port, 'tauri://localhost')).toBe('refused')
  })
})

// FJS-4500 / FJS-D2310 — an extension page's origin holds an id fli cannot know
// for a deploy (a store id, a per-install Firefox uuid), so fli names the
// scheme. A scheme entry admits that scheme's origins and nothing else, on the
// socket as on csrf, and it never rides into a credentialed cors list.
describe('a scheme entry for an extension surface', () => {
  async function bootDerived(env: string, http: Record<string, unknown>) {
    process.env.FRONTIER_CORS_ORIGINS = env
    try { return await boot(http) } finally { delete process.env.FRONTIER_CORS_ORIGINS }
  }
  const EXTENSIONS = 'chrome-extension://*,moz-extension://*'

  test('any id of each scheme opens a socket, and a web origin is still refused', async () => {
    const app = await bootDerived(EXTENSIONS, { cors: { origins: ['*'] } })
    expect(await upgrade(app.http.port, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe('connected')
    expect(await upgrade(app.http.port, 'moz-extension://0b5e7c1a-2d3f-4e5a-8b9c-0d1e2f3a4b5c')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://evil.example')).toBe('refused')
    expect(await upgrade(app.http.port, 'chrome-extensionx://abc')).toBe('refused')
  })

  test('beside a credentialed cors list the app still boots and the socket admits the extension', async () => {
    const app = await bootDerived(EXTENSIONS, { cors: { origins: ['https://app.example'], credentials: true } })
    expect(await upgrade(app.http.port, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://app.example')).toBe('connected')
    expect(await upgrade(app.http.port, 'https://evil.example')).toBe('refused')
    const res = await app.http.fetch(new Request('http://localhost/health', {
      method: 'OPTIONS',
      headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'access-control-request-method': 'GET' },
    }))
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('originListed', () => {
  test('a scheme entry matches its scheme only; a web scheme is never a wildcard', async () => {
    const { originListed, cors } = await import('../src/transport/middleware.ts')
    expect(originListed(['chrome-extension://*'], 'chrome-extension://abc')).toBe(true)
    expect(originListed(['chrome-extension://*'], 'moz-extension://abc')).toBe(false)
    expect(originListed(['chrome-extension://*'], 'chrome-extension://')).toBe(false)
    expect(originListed(['https://*'], 'https://evil.example')).toBe(false)
    expect(originListed(['http://*'], 'http://evil.example')).toBe(false)
    expect(originListed(['https://app.example'], 'https://app.example')).toBe(true)
    expect(() => cors({ origins: ['moz-extension://*'], credentials: true })).toThrow(/credentials/)
  })
})
