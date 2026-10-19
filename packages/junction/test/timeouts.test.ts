// The two timers, and which of them the caller hears from.
//
// Measured on Bun 1.3.11 before any of this existed: a handler that takes more
// than ten seconds is killed by the runtime's own `idleTimeout`, and what the
// caller reads is ECONNRESET — no status, no body, and nothing this app logs.
// Bun prints a warning naming an option junction passed through from nowhere,
// so an operator was told to configure something they could not reach.
//
// Every timing assertion is PAIRED with a request that must NOT be cut off, or
// a transport that refused everything slowly would satisfy each one alone.

import { describe, it, expect } from 'bun:test'
import { HttpTransport } from '../src/transport/http.ts'

type Opts = ConstructorParameters<typeof HttpTransport>[0]

async function serve(opts: Opts, slowMs = 3_000) {
  const errors: string[] = []
  const t = new HttpTransport({
    port: 0,
    onError: (e) => errors.push(String((e as Error)?.message ?? e)),
    ...opts,
  })
  t.router.get('/slow', async () => {
    await new Promise(r => setTimeout(r, slowMs))
    return new Response('done')
  })
  t.router.get('/fast', () => new Response('quick'))
  t.router.build()
  t.start(0)
  const url = (p: string) => `http://localhost:${t.port}${p}`
  return { t, errors, url }
}

describe('http.idleTimeout', () => {

  it('is refused at boot above the runtime ceiling, naming the other option', () => {
    expect(() => new HttpTransport({ port: 0, idleTimeout: 300 }))
      .toThrow(/255[\s\S]*requestTimeout/)
  })

  it('accepts 0, which is how an app turns it off', () => {
    expect(() => new HttpTransport({ port: 0, idleTimeout: 0 })).not.toThrow()
  })

  it('refuses a fraction — the runtime counts whole seconds', () => {
    expect(() => new HttpTransport({ port: 0, idleTimeout: 1.5 })).toThrow(/whole number/)
  })

  // The runtime's timer is COARSE, and knowing by how much is what makes these
  // two rows cheap. Measured on Bun 1.3.11: it closes at roughly twice the
  // configured value with a floor near four seconds — `idleTimeout: 1` and
  // `: 2` both cut a 10s handler at 4.0s, `: 5` cut a 20s one at 8.0s, and `: 0`
  // let a 12s one finish. So a configured 10 is a kill at about 20, and the
  // pair below is the shortest one that can tell the option from its absence.
  it('reaches the runtime — a short one cuts a handler off', async () => {
    const { t, url } = await serve({ idleTimeout: 1 }, 10_000)
    try {
      await fetch(url('/slow'))
      throw new Error('should have been cut off')
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('should have been')
    } finally { await t.stop(100) }
  }, 20_000)

  it('0 turns it off, and the same handler finishes', async () => {
    const { t, url } = await serve({ idleTimeout: 0 }, 6_000)
    try {
      const r = await fetch(url('/slow'))
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('done')
    } finally { await t.stop(100) }
  }, 20_000)
})

describe('http.requestTimeout', () => {

  it('answers 503 itself instead of letting the socket reset', async () => {
    const { t, url } = await serve({ requestTimeout: 500 })
    try {
      const at = Date.now()
      const r  = await fetch(url('/slow'))
      const ms = Date.now() - at
      expect(r.status).toBe(503)
      const body = await r.json() as Record<string, unknown>
      expect(body.name).toBe('RequestTimeout')
      // Retryable, because the deadline says nothing about the request being
      // wrong — a domain refusal would not be.
      expect(body.retryable).toBe(true)
      expect(ms).toBeLessThan(2_000)
    } finally { await t.stop(100) }
  }, 20_000)

  it('does not touch a handler that answers in time', async () => {
    const { t, url } = await serve({ requestTimeout: 500 })
    try {
      const r = await fetch(url('/fast'))
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('quick')
    } finally { await t.stop(100) }
  })

  it('announces the handler that finished afterwards, rather than swallowing it', async () => {
    const { t, url, errors } = await serve({ requestTimeout: 300 }, 900)
    try {
      expect((await fetch(url('/slow'))).status).toBe(503)
      await new Promise(r => setTimeout(r, 1_200))
      expect(errors.some(e => /deadline/.test(e))).toBe(true)
    } finally { await t.stop(100) }
  }, 20_000)

  it('absent means no bound — the app was not given a default deadline', async () => {
    // The reason this row exists: a default here would cut off every
    // legitimately long request in every app that upgraded.
    const { t, url } = await serve({ idleTimeout: 0 }, 6_000)
    try {
      expect((await fetch(url('/slow'))).status).toBe(200)
    } finally { await t.stop(100) }
  }, 20_000)

  it('wins the race against the runtime timer, which would answer nothing', async () => {
    // The runtime bound is BELOW the app's deadline here — `idleTimeout: 1`
    // cuts a handler at about 4s (see above) and the deadline is 6s. Without
    // the per-request extension the socket resets first and the caller reads
    // ECONNRESET; with it they read the app's own 503.
    const { t, url } = await serve({ idleTimeout: 1, requestTimeout: 6_000 }, 12_000)
    try {
      const r = await fetch(url('/slow'))
      expect(r.status).toBe(503)
      expect((await r.json() as Record<string, unknown>).name).toBe('RequestTimeout')
    } finally { await t.stop(100) }
  }, 30_000)
})

// The cap on requests being handled (`FJS-D901`). Sockets have `ws.maxConnections`;
// HTTP counts what Bun lets it count, which is requests in hand.
describe('http.maxConcurrentRequests', () => {

  async function held(opts: Opts) {
    const s = await serve(opts, 400)
    return s
  }

  it('refuses the request over the cap with 503, Retry-After and a retryable body', async () => {
    const { t, url } = await held({ maxConcurrentRequests: 2 })
    try {
      const rs = await Promise.all([1, 2, 3].map(() => fetch(url('/slow'))))
      const statuses = rs.map(r => r.status).sort()
      expect(statuses).toEqual([200, 200, 503])
      const refused = rs.find(r => r.status === 503)!
      expect(refused.headers.get('retry-after')).toBe('1')
      const body = await refused.json() as Record<string, unknown>
      expect(body.retryable).toBe(true)
      expect(body.code).toBe(503)
      expect(t.stats.response.error).toBe(1)
    } finally { await t.stop(100) }
  })

  it('frees the slot when a request ends', async () => {
    const { t, url } = await held({ maxConcurrentRequests: 1 })
    try {
      expect((await fetch(url('/slow'))).status).toBe(200)
      expect((await fetch(url('/slow'))).status).toBe(200)
    } finally { await t.stop(100) }
  })

  it('is off by default', async () => {
    const { t, url } = await held({})
    try {
      const rs = await Promise.all([1, 2, 3, 4].map(() => fetch(url('/slow'))))
      expect(rs.map(r => r.status)).toEqual([200, 200, 200, 200])
    } finally { await t.stop(100) }
  })

  it('is refused at boot when not a positive whole number', () => {
    expect(() => new HttpTransport({ port: 0, maxConcurrentRequests: 1.5 })).toThrow(/maxConcurrentRequests/)
    expect(() => new HttpTransport({ port: 0, maxConcurrentRequests: -1 })).toThrow(/maxConcurrentRequests/)
    expect(() => new HttpTransport({ port: 0, maxConcurrentRequests: 0 })).not.toThrow()
  })
})

// FJS-3105: a client that refuses http:// (the Bitwarden CLI since 2025.11,
// localhost included) cannot reach a dev API unless the server itself speaks
// TLS. The cert and key are PATHS, so an app points at files mkcert wrote.
describe('http.tls', () => {

  async function selfSigned() {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir  = mkdtempSync(join(tmpdir(), 'fjs-tls-'))
    const cert = join(dir, 'cert.pem')
    const key  = join(dir, 'key.pem')
    const p = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'])
    if (p.exitCode !== 0) throw new Error('openssl failed')
    return { cert, key }
  }

  it('serves https when a cert and key are given', async () => {
    const tls = await selfSigned()
    const t = new HttpTransport({ port: 0, tls })
    t.router.get('/fast', () => new Response('quick'))
    t.router.build()
    t.start(0)
    try {
      const r = await fetch(`https://localhost:${t.port}/fast`, { tls: { rejectUnauthorized: false } })
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('quick')
    } finally { await t.stop(100) }
  })

  it('without it the same port is plain http', async () => {
    const t = new HttpTransport({ port: 0 })
    t.router.get('/fast', () => new Response('quick'))
    t.router.build()
    t.start(0)
    try {
      const r = await fetch(`http://localhost:${t.port}/fast`)
      expect(r.status).toBe(200)
    } finally { await t.stop(100) }
  })

  it('a missing file is refused at boot, naming the path', () => {
    expect(() => new HttpTransport({ port: 0, tls: { cert: '/nope/cert.pem', key: '/nope/key.pem' } }))
      .toThrow(/http\.tls[\s\S]*\/nope\/cert\.pem/)
  })
})
