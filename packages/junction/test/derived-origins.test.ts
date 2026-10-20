// FJS-2655 / FJS-D912 — `fli deploy` hands the API the origins its page will
// call from as FRONTIER_CORS_ORIGINS; junction merges them into cors and csrf so an
// app writes no second copy of the web domain in junction.config.js.

import { describe, it, expect, afterEach } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'

const base = { ...defaultConfig, port: 0 }
const WEB   = 'https://app.example.com'
const TAURI = 'tauri://localhost'

afterEach(() => { delete process.env.FRONTIER_CORS_ORIGINS })

async function allowed(env: string | undefined, http: Record<string, unknown>, origin: string) {
  if (env !== undefined) process.env.FRONTIER_CORS_ORIGINS = env
  const app = createApp({ config: { ...base, http } as never })
  await app.start()
  try {
    const res = await app.http.fetch(new Request('http://localhost/health', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET' },
    }))
    return res.headers.get('access-control-allow-origin')
  } finally { await app.stop() }
}

describe('FRONTIER_CORS_ORIGINS — the derived cross-origin list', () => {
  it('an app declaring no cors admits the derived origins', async () => {
    const env = `${WEB},${TAURI}`
    expect(await allowed(env, {}, WEB)).toBe(WEB)
    expect(await allowed(env, {}, TAURI)).toBe(TAURI)
    expect(await allowed(env, {}, 'https://evil.example.com')).toBeNull()
  })

  it('joins the origins the app declared rather than replacing them', async () => {
    const http = { cors: { origins: ['http://localhost:8020'] } }
    expect(await allowed(WEB, http, 'http://localhost:8020')).toBe('http://localhost:8020')
    expect(await allowed(WEB, http, WEB)).toBe(WEB)
  })

  it('a declared wildcard stays a wildcard', async () => {
    expect(await allowed(WEB, { cors: { origins: ['*'] } }, 'https://other.example.com')).toBe('https://other.example.com')
  })

  it('unset changes nothing', async () => {
    expect(await allowed(undefined, {}, WEB)).toBeNull()
  })

  it('csrf with its own list gains the derived origins', async () => {
    const app = createApp({ config: { ...base, http: { csrf: { origins: ['https://admin.example.com'] } } } as never })
    process.env.FRONTIER_CORS_ORIGINS = WEB
    app.get('/ping', (ctx) => ctx.json({ ok: true }))
    app.post('/ping', (ctx) => ctx.json({ ok: true }))
    await app.start()
    try {
      app.http.setAuthCookie('sid')
      const post = (origin: string) => app.http.fetch(new Request('http://localhost/ping', {
        method: 'POST', headers: { origin, cookie: 'sid=x', 'content-type': 'application/json' }, body: '{}',
      })).then(r => r.status)
      expect(await post(WEB)).not.toBe(403)
      expect(await post('https://evil.example.com')).toBe(403)
    } finally { await app.stop() }
  })
})
