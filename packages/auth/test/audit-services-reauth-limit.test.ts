// test/audit-services-reauth-limit.test.ts
//
// AUDIT 2026-10-05 — the `reauthenticate` bucket: which methods it covers,
// whether a success spends it, and that `confirmTotp` — a six-digit oracle
// reachable from any session — sits inside it. Since sudo mode (`FJS-D1209`)
// the bucket is `reauthenticate` + `confirmTotp`, the two that check a secret;
// the changes that ride a fresh session check none and spend nothing.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { auth } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

let h: Harness
let app: any
let seq = 0
const MAX = 3

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(auth({
    auth: h.auth,
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { level: () => 4, reauthenticationRateLimit: { max: MAX, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

const PW = 'pw-rl-1'
async function person() {
  const email = `rl-${Date.now()}-${seq++}@example.com`
  const { id: userId } = await h.auth.createUser({ email, password: PW })
  const token = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token as string
  return { email, userId, token }
}
const call = (token: string, method: string, data: unknown) =>
  request(app).post('/account/me').set('x-service-method', method).auth(token).send(data as any)

describe('the bucket', () => {

  test('reauthenticate and confirmTotp share it — guesses spread across both are one budget', async () => {
    const u = await person()
    expect((await call(u.token, 'setupTotp', {})).status).toBe(200)
    for (let i = 0; i < MAX - 1; i++) expect((await call(u.token, 'reauthenticate', { password: 'wrong' })).status).toBe(403)
    expect((await call(u.token, 'confirmTotp', { code: '000000' })).status).toBe(403)

    expect((await call(u.token, 'reauthenticate', { password: PW })).status).toBe(429)
    expect((await call(u.token, 'confirmTotp', { code: '000001' })).status).toBe(429)
  })

  test('the changes that check no secret are outside it — an empty bucket still changes the password', async () => {
    const u = await person()
    for (let i = 0; i < MAX; i++) expect((await call(u.token, 'reauthenticate', { password: 'wrong' })).status).toBe(403)
    expect((await call(u.token, 'reauthenticate', { password: PW })).status).toBe(429)

    // The session is fresh from its sign-in, so these ride that proof.
    expect((await call(u.token, 'changePassword', { newPassword: `${PW}-next` })).status).toBe(200)
    expect((await call(u.token, 'setupTotp', {})).status).toBe(200)
    expect((await call(u.token, 'disableTotp', {})).status).not.toBe(429)
    expect((await call(u.token, 'regenerateRecoveryCodes', {})).status).not.toBe(429)
  })

  test('a SUCCESSFUL reauth spends the bucket too', async () => {
    // Observation, not a secure-behavior assertion: a person confirming their
    // password MAX times in the window is refused the next confirm.
    const u = await person()
    for (let i = 0; i < MAX; i++) expect((await call(u.token, 'reauthenticate', { password: PW })).status).toBe(200)
    expect((await call(u.token, 'reauthenticate', { password: PW })).status).toBe(429)
  })

  test('confirmTotp is behind a limit: wrong codes are not answered without bound', async () => {
    const u = await person()
    expect((await call(u.token, 'setupTotp', {})).status).toBe(200)
    const seen: number[] = []
    for (let i = 0; i < 25; i++) {
      seen.push((await call(u.token, 'confirmTotp', { code: String(i).padStart(6, '0') })).status)
      if (seen.at(-1) === 429) break
    }
    // Twenty-five guesses at a six-digit code from one session; a limiter
    // sized like login's (10 / 15 min) would have refused by now.
    expect(seen).toContain(429)
  })

  test('a wrong CURRENT password through a session is in the trail', async () => {
    // `login.failed` records a wrong password at the front door; the same
    // guess through a stolen session answers 403 and writes nothing.
    const u = await person()
    expect((await call(u.token, 'reauthenticate', { password: 'wrong' })).status).toBe(403)
    await new Promise(r => setImmediate(r))
    const rows = await h.sys.auditTrail.findMany({ where: { actorId: u.userId } })
    const ops  = rows.map((r: any) => String(r.operation))
    expect(ops.some((o: string) => /reauth|password/i.test(o) && /fail|refus|wrong|invalid/i.test(o))).toBe(true)
  })

  test('a failed confirmTotp is in the trail', async () => {
    const u = await person()
    await call(u.token, 'setupTotp', {})
    await call(u.token, 'confirmTotp', { code: '000000' })
    await new Promise(r => setImmediate(r))
    const rows = await h.sys.auditTrail.findMany({ where: { actorId: u.userId } })
    const ops  = rows.map((r: any) => String(r.operation))
    expect(ops.some((o: string) => /totp|second-?factor|confirm/i.test(o) && /fail|refus|wrong|invalid/i.test(o))).toBe(true)
  })
})
