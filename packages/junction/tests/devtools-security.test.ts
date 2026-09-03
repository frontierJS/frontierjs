// tests/devtools-security.test.ts
//
// FJS-691 — the console serves request logs, request PARAMS, a live event feed
// and a POST that runs a job by name. It bound `Bun.serve({ port })` with no
// `hostname`, which is every interface, and the only thing standing between a
// laptop on a café network and that surface was `NODE_ENV === 'production'` —
// unset in dev, and unset is the common case.
//
// Three separate refusals, and they fail apart:
//   • the bound address is loopback unless the app says otherwise;
//   • off loopback with no `auth` it refuses to BIND, whatever NODE_ENV says;
//   • a cross-site POST is 403, because a `text/plain` POST needs no preflight
//     and a page on any origin could otherwise run a job by name.

import { describe, test, expect, afterEach } from 'bun:test'
import { createApp } from '../src/core/app.ts'
import { devtools }  from '../src/plugins/devtools/index.ts'

const running: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) })

async function mkApp(opts: Parameters<typeof devtools>[0] = {}) {
  const app: any = createApp({
    logLevel: 'silent',
    config: { port: 0, services: { dir: '/nonexistent' } },
  })
  app.configure(devtools({ port: 0, ...opts }))
  await app.start()
  running.push(app)
  return app
}

describe('where the console binds (FJS-691)', () => {

  test('the default hostname is loopback', async () => {
    const app = await mkApp()
    expect(app._devtools.status).toBe('on')
    // Asked of the URL the app itself reports, which is the one a person opens.
    expect(app._devtools.url).toMatch(/^http:\/\/localhost:/)
  })

  test('a non-loopback hostname with no auth gate refuses to bind', async () => {
    const app = await mkApp({ hostname: '0.0.0.0' })
    expect(app._devtools.status).toBe('refused')
    // Named, because "devtools is off" with no reason is the state that gets a
    // gate added and then removed again.
    expect(app._devtools.reason).toContain('0.0.0.0')
    expect(app._devtools.reason).toContain('auth')
  })

  test('a non-loopback hostname WITH an auth gate binds', async () => {
    const app = await mkApp({ hostname: '127.0.0.2', auth: () => true })
    // The control: it is the missing gate that refuses, not the hostname.
    expect(app._devtools.status).toBe('on')
  })
})

describe('cross-site requests (FJS-691)', () => {

  const url = (app: any, path: string) => `${app._devtools.url.replace('localhost', '127.0.0.1')}${path}`

  test('a POST from another origin is 403', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/api/jobs/run/send-invoices'), {
      method:  'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body:    '{}',
    })
    expect(res.status).toBe(403)
  })

  test('a POST declaring Sec-Fetch-Site: cross-site is 403', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/api/jobs/run/x'), {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}',
    })
    expect(res.status).toBe(403)
  })

  test('a WS upgrade from another origin is 403', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/'), {
      headers: { upgrade: 'websocket', connection: 'Upgrade', origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  test('a POST with no Origin at all is not refused', async () => {
    const app = await mkApp()
    // The rule is about a BROWSER. A request carrying neither header is not one,
    // and refusing it would break curl and every drive here — the 501 below is
    // the app answering that it has no job queue, which is the point: it got
    // past the check.
    const res = await fetch(url(app, '/api/jobs/run/x'), { method: 'POST', body: '{}' })
    expect(res.status).not.toBe(403)
  })

  test('a same-origin GET is served', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/api/state'), { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(res.status).toBe(200)
  })
})
