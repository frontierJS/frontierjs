// tests/account-recovery.test.ts
//
// `account-recovery.resetTotp` — an operator removing somebody else's lost second
// factor, over a REAL Junction app, graded by the app's own `level`.
//
// Every refusal is PAIRED with the reset that succeeds: a service that refused
// every caller satisfies each refusal row, so the success row is what separates
// *the floor is SYSADMIN* from *nobody can*. And every refusal re-reads the
// person's factor afterwards, because a reset that answered 403 having already
// deleted the secret is the worst thing this method can do.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'
import { totp, TOTP_STEP_SEC } from '../totp.ts'

const PW = 'pw-recovery-1'

// The app's own ladder, keyed on the role string the way `example` keys it.
const levelOf = (s: { role?: string }) => s.role === 'sysadmin' ? 7 : s.role === 'admin' ? 5 : 4

let h: Harness
let app: any
let seq = 0

const rateLimits = {
  loginRateLimit:    { max: 10_000, window: '15 minutes' },
  registerRateLimit: { max: 10_000, window: '15 minutes' },
}

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY, totpDrift: 10 })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, { ...rateLimits, services: { level: levelOf } }))
})
afterAll(() => h.cleanup())

async function person(role = 'user', factor = true) {
  const email = `rec-${Date.now()}-${seq++}@example.com`
  const { userId } = await h.auth.createUser({ email, password: PW, role })
  let token = ''
  if (factor) {
    const { secret } = await h.auth.setupTotp!(userId, PW)
    await h.auth.confirmTotp!(userId, totp(secret, new Date(Date.now() - 5 * TOTP_STEP_SEC * 1000)))
    const { challenge } = await h.auth.login(email, PW) as any
    token = (await h.auth.completeLogin!(challenge, totp(secret, new Date())) as any).token
  } else {
    token = (await h.auth.login(email, PW) as any).token
  }
  return { email, userId, token }
}

const reset = (asToken: string | null, userId: string, on = app) => {
  const r = request(on).post(`/account-recovery/${userId}`).set('x-service-method', 'resetTotp')
  return (asToken ? r.auth(asToken) : r).send({})
}
const enabled = async (userId: string) => (await h.auth.totpStatus!(userId)).enabled

describe('a sysadmin resets a person who lost their factor', () => {

  test('the factor goes, every session goes, and the password alone signs them in again', async () => {
    const op = await person('sysadmin', false)
    const u  = await person('user')

    const res = await reset(op.token, u.userId)
    expect(res.status).toBe(200)
    expect((res.body as any).sessionsRevoked).toBe(1)

    expect(await h.auth.totpStatus!(u.userId)).toEqual({ enabled: false, recoveryCodesRemaining: 0 })
    expect((await request(app).get('/account/me').auth(u.token)).status).toBe(401)
    expect('token' in (await h.auth.login(u.email, PW) as any)).toBe(true)
  })

  test('an admin (5) is refused — paired with the same person reset by a sysadmin above', async () => {
    const admin = await person('admin', false)
    const u     = await person('user')
    const res   = await reset(admin.token, u.userId)
    expect(res.status).toBe(403)
    expect(await enabled(u.userId)).toBe(true)
    expect((await request(app).get('/account/me').auth(u.token)).status).toBe(200)
  })

  test('a sysadmin cannot reset a peer — and can reset the admin below them', async () => {
    const op    = await person('sysadmin', false)
    const peer  = await person('sysadmin')
    const admin = await person('admin')

    expect((await reset(op.token, peer.userId)).status).toBe(403)
    expect(await enabled(peer.userId)).toBe(true)

    expect((await reset(op.token, admin.userId)).status).toBe(200)
    expect(await enabled(admin.userId)).toBe(false)
  })

  test('not yourself, by id or by `me` — that is disableTotp, which asks for the password', async () => {
    const op = await person('sysadmin')
    expect((await reset(op.token, op.userId)).status).toBe(403)
    expect((await reset(op.token, 'me')).status).toBe(403)
    expect(await enabled(op.userId)).toBe(true)
  })

  test('a stranger is 401, and nothing moved', async () => {
    const u = await person('user')
    expect((await reset(null, u.userId)).status).toBe(401)
    expect(await enabled(u.userId)).toBe(true)
  })

  test('nobody by that id is 404; somebody with no factor is 404', async () => {
    const op = await person('sysadmin', false)
    expect((await reset(op.token, 'no-such-user')).status).toBe(404)
    const bare = await person('user', false)
    expect((await reset(op.token, bare.userId)).status).toBe(404)
  })

  test('refused inside a support episode — the operator is resolving as somebody else', async () => {
    // The subject is a sysadmin too, so the episode alone is what refuses: a
    // subject graded 4 is turned away by the floor and this row would pass
    // with the support refusal deleted.
    const op = await person('sysadmin', false)
    const subject = await person('sysadmin', false)
    const u = await person('user')

    await h.auth.startSupport!(op.token, subject.userId, 'ticket 12')
    expect((await reset(op.token, u.userId)).status).toBe(403)
    expect(await enabled(u.userId)).toBe(true)

    await h.auth.endSupport!(op.token)
    expect((await reset(op.token, u.userId)).status).toBe(200)
  })
})

describe('the floor needs the app\'s own grading', () => {

  test('with no `level` resolver every call is refused, naming the option', async () => {
    const bare = await createTestApp({ auth: h.auth as any })
    bare.setAuth(h.auth as any)
    bare.configure(createAuthPlugin(h.auth, { ...rateLimits, services: {} }))

    const op = await person('sysadmin', false)
    const u  = await person('user')
    const res = await reset(op.token, u.userId, bare)
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('services: { level }')
    expect(await enabled(u.userId)).toBe(true)
  })
})
