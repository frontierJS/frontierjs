// test/audit-services-password-change.test.ts
//
// AUDIT 2026-10-05 — `account.changePassword` over HTTP, and what it does to
// the caller's OTHER sessions. `confirmPasswordReset` purges every session the
// moment the password changes; `changePassword` purges none, so a stolen
// session survives the one act its owner takes to end it. Written to FAIL on
// current code: the assertions are the secure behavior.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

let h: Harness
let app: any
let seq = 0

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { level: () => 4, reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

async function person(pw = 'pw-old-1') {
  const email = `pc-${Date.now()}-${seq++}@example.com`
  await request(app).post('/auth/register').send({ email, password: pw })
  const login = async () => ((await request(app).post('/auth/login').send({ email, password: pw })).body as any).token as string
  return { email, login }
}

const change = (token: string, currentPassword: string, newPassword: string) =>
  request(app).post('/account/me').set('x-service-method', 'changePassword').auth(token)
    .send({ currentPassword, newPassword })

const me = (token: string) => request(app).get('/account/me').auth(token)

describe('changing the password ends the other sessions', () => {

  test('session B is signed out when session A changes the password', async () => {
    const u = await person()
    const a = await u.login()
    const b = await u.login()
    expect((await me(b)).status).toBe(200)

    expect((await change(a, 'pw-old-1', 'pw-new-1')).status).toBe(200)

    // The session that asked keeps working — a person who changed their
    // password is not signed out of the tab they did it in.
    expect((await me(a)).status).toBe(200)
    // The one that did not is gone: this is the act a person takes AGAINST a
    // stolen session, and a stolen session that survives it was not answered.
    expect((await me(b)).status).toBe(401)
  })

  test('the row count agrees: one session left for the account', async () => {
    const u = await person()
    const a = await u.login()
    await u.login()
    await u.login()
    expect((await change(a, 'pw-old-1', 'pw-new-2')).status).toBe(200)
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const rows = await h.sys.session.findMany({ where: { userId: user.id } })
    expect(rows.length).toBe(1)
  })
})
