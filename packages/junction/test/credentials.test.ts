// test/credentials.test.ts
//
// FJS-371 / FJS-D475 — a credential that is not a bearer token has a door.
// A signed request becomes a principal in the transport, before the bearer
// path; a bad signature is refused there rather than falling through to
// anonymous, which is the fail-open `FJS-349` was.

import { describe, it, expect } from 'bun:test'
import { signRequest } from '@frontierjs/toolbelt/signature'
import { createApp, defaultConfig, signedRequest } from '../index.ts'
import type { SessionContext } from '../src/auth/types.ts'

const SECRET = 'outpost-secret'
const NOW    = 1_800_000_000

function appWith(auth?: { verifySession: (t: string) => Promise<SessionContext | null> }) {
  const app = createApp({
    config: { ...defaultConfig, port: 0, services: { dir: '/nonexistent' } },
    ...(auth ? { auth } : {}),
    credentials: [signedRequest({
      now: () => NOW,
      keyFor: req => req.headers['x-outpost-id'] === 'op-1'
        ? { secret: SECRET, session: { userId: 'outpost:op-1' } as SessionContext }
        : null,
    })],
  })
  app.post('/whoami', (ctx: any) =>
    ctx.user ? ctx.json({ userId: ctx.user.userId }) : ctx.json({ anon: true }, 401))
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
    const app = appWith({ async verifySession(t) { return t === 'tok' ? { userId: 'alice' } as SessionContext : null } })
    await app.start()
    const req = await signed('{"n":1}', { id: 'stranger' })
    req.headers.set('authorization', 'Bearer tok')
    expect((await app.http.fetch(req)).status).toBe(401)
    await app.stop()
  })

  it('leaves a request with no signature to the bearer path', async () => {
    const app = appWith({ async verifySession(t) { return t === 'tok' ? { userId: 'alice' } as SessionContext : null } })
    await app.start()
    const res = await app.http.fetch(new Request('http://localhost/whoami', {
      method: 'POST', headers: { authorization: 'Bearer tok' }, body: '{}',
    }))
    expect((await res.json()).userId).toBe('alice')
    await app.stop()
  })
})
