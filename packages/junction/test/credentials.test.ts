// test/credentials.test.ts
//
// FJS-371 / FJS-D475 — a credential that is not a bearer token has a door.
// A signed request becomes a principal in the transport, before the bearer
// path; a bad signature is refused there rather than falling through to
// anonymous, which is the fail-open `FJS-349` was.

import { describe, it, expect } from 'bun:test'
import { signRequest } from '@frontierjs/toolbelt/signature'
import { createApp, defaultConfig, signedRequest } from '../index.ts'
import { REFUSE } from '../src/auth/credentials.ts'
import type { SessionContext } from '../src/auth/types.ts'

const SECRET = 'outpost-secret'
const NOW    = 1_800_000_000

function appWith(auth?: { verifySession: (t: string) => Promise<SessionContext | null> }) {
  const app = createApp({
    config: { ...defaultConfig, port: 0 },
    ...(auth ? { auth } : {}),
    credentials: [signedRequest({
      now: () => NOW,
      keyFor: req => req.headers['x-outpost-id'] === 'op-1'
        ? { secret: SECRET, session: { id: 'outpost:op-1' } as SessionContext }
        : null,
    })],
  })
  app.post('/whoami', (ctx: any) =>
    ctx.user ? ctx.json({ userId: ctx.user.id }) : ctx.json({ anon: true }, 401))
  return app
}

async function signed(body: string, { secret = SECRET, id = 'op-1', tamper = false } = {}) {
  const sig = await signRequest({ secret, method: 'POST', path: '/whoami', body, timestamp: NOW, nonce: 'n1' })
  return new Request('http://localhost/whoami', {
    method: 'POST',
    headers: { ...sig, 'x-outpost-id': id, 'content-type': 'application/json' },
    body: tamper ? body.replace('1', '2') : body,
  })
}

describe('credentials: a signed request', () => {
  it('becomes the principal the verifier names', async () => {
    const app = appWith()
    await app.start()
    const res = await app.http.fetch(await signed('{"n":1}'))
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBe('outpost:op-1')
    await app.stop()
  })

  it('is refused when the body was changed after signing', async () => {
    const app = appWith()
    await app.start()
    expect((await app.http.fetch(await signed('{"n":1}', { tamper: true }))).status).toBe(401)
    await app.stop()
  })

  it('is refused for a caller the app does not know, even with a valid bearer token', async () => {
    const app = appWith({ async verifySession(t) { return t === 'tok' ? { id: 'alice' } as SessionContext : null } })
    await app.start()
    const req = await signed('{"n":1}', { id: 'stranger' })
    req.headers.set('authorization', 'Bearer tok')
    expect((await app.http.fetch(req)).status).toBe(401)
    await app.stop()
  })

  it('leaves a request with no signature to the bearer path', async () => {
    const app = appWith({ async verifySession(t) { return t === 'tok' ? { id: 'alice' } as SessionContext : null } })
    await app.start()
    const res = await app.http.fetch(new Request('http://localhost/whoami', {
      method: 'POST', headers: { authorization: 'Bearer tok' }, body: '{}',
    }))
    expect((await res.json()).userId).toBe('alice')
    await app.stop()
  })
})

// FJS-2209 — a captured signed request replays for the whole window unless a
// nonce is remembered, and a socket authenticates every later frame on one
// upgrade. junction ships the memory so a receiver that passes nothing is not
// the one that replays.
describe('credentials: a signed request replayed', () => {
  const ROBOT = { id: 'outpost:op-1' } as SessionContext
  async function inbound(nonce: string, timestamp = NOW) {
    const sig = await signRequest({ secret: SECRET, method: 'GET', path: '/ws', body: '', timestamp, nonce })
    return { method: 'GET', path: '/ws', query: '', headers: Object.fromEntries(Object.entries(sig).map(([k, v]) => [k.toLowerCase(), v])), body: '', host: null }
  }

  it('is refused the second time, without the app passing seenNonce', async () => {
    const verify = signedRequest({ now: () => NOW, keyFor: () => ({ secret: SECRET, session: ROBOT }) })
    const req = await inbound('replayed')
    expect(await verify(req)).toBe(ROBOT)
    expect(await verify(req)).toBe(REFUSE)
    expect(await verify(await inbound('another'))).toBe(ROBOT)
  })

  it('refuses a window that is not a finite number at boot, not as a window of no limit (FJS-2188)', () => {
    for (const window of [NaN, Infinity, -1])
      expect(() => signedRequest({ window, keyFor: () => null })).toThrow(/window/)
  })

  it('stays refused for twice the window, the span a timestamp stays fresh', async () => {
    let t = NOW
    const verify = signedRequest({ now: () => t, window: 100, keyFor: () => ({ secret: SECRET, session: ROBOT }) })
    // Signed 100s ahead of this clock: the furthest a timestamp is accepted.
    const req = await inbound('ahead', NOW + 100)
    expect(await verify(req)).toBe(ROBOT)
    t = NOW + 150   // past one window, timestamp still fresh
    expect(await verify(req)).toBe(REFUSE)
  })

  it('does not spend a nonce on a signature that failed', async () => {
    const verify = signedRequest({ now: () => NOW, keyFor: () => ({ secret: 'other', session: ROBOT }) })
    const req = await inbound('burnt')
    expect(await verify(req)).toBe(REFUSE)
    const good = signedRequest({ now: () => NOW, keyFor: () => ({ secret: SECRET, session: ROBOT }) })
    expect(await good(req)).toBe(ROBOT)
  })

  it('leaves an app-supplied seenNonce in charge', async () => {
    const verify = signedRequest({ now: () => NOW, seenNonce: () => false, keyFor: () => ({ secret: SECRET, session: ROBOT }) })
    const req = await inbound('mine')
    expect(await verify(req)).toBe(ROBOT)
    expect(await verify(req)).toBe(ROBOT)
  })
})
