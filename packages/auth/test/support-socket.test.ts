// test/support-socket.test.ts
//
// Both edges of a support episode close the operator's sockets on the server
// (plugin.ts), because a socket resolved its principal at upgrade. The server
// closes them AFTER it answers, so a browser client that asks "who am I now?"
// the moment `startSupport()` / `endSupport()` resolves sends that frame into
// a socket still open on its side: it is answered as the OLD principal, or
// rejected "WebSocket closed" — which sierra's `refresh()` reads as the server
// being silent, and restores the remembered session. Measured in Chrome
// (fjs-prototypes/maidtech 7e): after End support the banner said "You are
// supporting Owner" while every request ran as the operator.
//
// This is the round trip, real client and real server, eight edges each way.
// In one Bun process the server's close always lands before its answer, so
// this passes with or without the fix; the order a browser can see is pinned
// in junction's test/support-edge-socket.test.ts (FJS-2651).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { channels, createApp } from '@frontierjs/junction'
import { createJunctionClient } from '../../junction/src/client/index.ts'
import { auth } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

const PW = 'pw-support-socket-1'
const levelOf = (s: { role?: string }) => s.role === 'sysadmin' ? 7 : s.role === 'admin' ? 5 : 4

let h: Harness
let app: any
let base: string
const clients: any[] = []

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY, sessionFields: (u: any) => ({ role: u.role }) })
  app = createApp({ db: h.db, auth: h.auth as any, config: { port: 0 }, logLevel: 'silent' } as never)
  app.configure(auth({
    auth: h.auth,
    services: { level: levelOf },
    canStartSupport: ({ operator }) => operator.role === 'sysadmin',
    loginRateLimit: { max: 10_000, window: '15 minutes' },
  }))
  // The socket: an app with channels upgrades one, as every Sierra app does.
  app.configure(channels(() => {}))
  const warn = console.warn
  console.warn = () => {}
  await app.start()
  console.warn = warn
  base = `http://localhost:${app.http.port}`
})
afterAll(async () => { clients.forEach(c => { try { c.disconnect() } catch {} }); await app.stop?.(); h.cleanup() })

let seq = 0
async function person(role = 'user') {
  const email = `sock-${Date.now()}-${seq++}@example.com`
  const { id: userId } = await h.auth.createUser({ email, password: PW, role })
  const { token } = await h.auth.login(email, PW) as any
  return { userId, token }
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('a support episode’s edges, asked over a live socket', () => {
  test('“who am I?” right after start is the subject, and right after end the operator — every time', async () => {
    const operator = await person('sysadmin')
    const subject  = await person()
    const client: any = createJunctionClient({ url: base })
    clients.push(client)
    client.setToken(operator.token)

    for (let i = 0; i < 8; i++) {
      // The socket is up when the edge is crossed: the case a person is in.
      await until(() => client.connected)
      await client.auth.startSupport(subject.userId, `ticket ${i}`)
      const during = await client.auth.me()
      expect(during.id).toBe(subject.userId)
      expect(during.support?.operatorId).toBe(operator.userId)

      await until(() => client.connected)
      await client.auth.endSupport()
      const after = await client.auth.me()
      expect(after.id).toBe(operator.userId)
      expect(after.support ?? null).toBeNull()
    }
  }, 30_000)
})
