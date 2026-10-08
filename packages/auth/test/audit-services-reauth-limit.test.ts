// test/audit-services-reauth-limit.test.ts
//
// AUDIT 2026-10-05 — the `reauthenticate` bucket: which methods it covers,
// whether a success spends it, and that `confirmTotp` — a six-digit oracle
// reachable from any session — sits outside it.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

let h: Harness
let app: any
let seq = 0
const MAX = 3

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { level: () => 4, reauthenticationRateLimit: { max: MAX, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

const PW = 'pw-rl-1'
async function person() {
  const email = `rl-${Date.now()}-${seq++}@example.com`
  const { userId } = await h.auth.createUser({ email, password: PW })
  const token = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token as string
  return { email, userId, token }
}
const call = (token: string, method: string, data: unknown) =>
  request(app).post('/account/me').set('x-service-method', method).auth(token).send(data as any)

describe('the bucket', () => {

  test('changePassword, setupTotp, disableTotp, regenerateRecoveryCodes share it', async () => {
    const u = await person()
    for (let i = 0; i < MAX; i++) expect((await call(u.token, 'changePassword', { currentPassword: 'wrong', newPassword: 'x' })).status).toBe(403)
    expect((await call(u.token, 'setupTotp', { currentPassword: 'wrong' })).status).toBe(429)
    expect((await call(u.token, 'disableTotp', { currentPassword: 'wrong' })).status).toBe(429)
    expect((await call(u.token, 'regenerateRecoveryCodes', { currentPassword: 'wrong' })).status).toBe(429)
    expect((await call(u.token, 'changePassword', { currentPassword: PW, newPassword: 'x' })).status).toBe(429)
  })

  test('a SUCCESSFUL reauth spends the bucket too', async () => {
    // Observation, not a secure-behavior assertion: a person rotating their
    // password MAX times in the window locks themselves out of the four.
    const u = await person()
    let pw = PW
    for (let i = 0; i < MAX; i++) {
      const next = `${PW}-${i}`
      expect((await call(u.token, 'changePassword', { currentPassword: pw, newPassword: next })).status).toBe(200)
      pw = next
    }
    expect((await call(u.token, 'changePassword', { currentPassword: pw, newPassword: 'pw-final' })).status).toBe(429)
  })

  // FJS-1838: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('confirmTotp is behind a limit: wrong codes are not answered without bound', async () => {
    const u = await person()
    expect((await call(u.token, 'setupTotp', { currentPassword: PW })).status).toBe(200)
    const seen: number[] = []
    for (let i = 0; i < 25; i++) {
      seen.push((await call(u.token, 'confirmTotp', { code: String(i).padStart(6, '0') })).status)
      if (seen.at(-1) === 429) break
    }
    // Twenty-five guesses at a six-digit code from one session; a limiter
    // sized like login's (10 / 15 min) would have refused by now.
    expect(seen).toContain(429)
  })

  // FJS-1848: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a wrong CURRENT password through a session is in the trail', async () => {
    // `login.failed` records a wrong password at the front door; the same
    // guess through a stolen session answers 403 and writes nothing.
    const u = await person()
    await call(u.token, 'changePassword', { currentPassword: 'wrong', newPassword: 'x' })
    await new Promise(r => setImmediate(r))
    const rows = await h.sys.auditTrail.findMany({ where: { actorId: u.userId } })
    const ops  = rows.map((r: any) => String(r.operation))
    expect(ops.some((o: string) => /reauth|password/i.test(o) && /fail|refus|wrong|invalid/i.test(o))).toBe(true)
  })

  // FJS-1838: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a failed confirmTotp is in the trail', async () => {
    const u = await person()
    await call(u.token, 'setupTotp', { currentPassword: PW })
    await call(u.token, 'confirmTotp', { code: '000000' })
    await new Promise(r => setImmediate(r))
    const rows = await h.sys.auditTrail.findMany({ where: { actorId: u.userId } })
    const ops  = rows.map((r: any) => String(r.operation))
    expect(ops.some((o: string) => /totp|second-?factor|confirm/i.test(o) && /fail|refus|wrong|invalid/i.test(o))).toBe(true)
  })
})
