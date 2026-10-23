// test/require-second-factor.test.ts
//
// `requireSecondFactor` (FJS-2554, FJS-D1008 B): an account the app says must
// have a second factor, and has none, signs in to a session that can do one
// thing -- enroll. Over a real Junction app, because the refusal lives in the
// plugin's hook and nothing below the transport would show it.
//
// EVERY REFUSAL IS PAIRED with the call beside it that succeeds: a hook that
// refused everything would satisfy any test asking only about the refusals.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { auth } from '../plugin.ts'
import { totp } from '../totp.ts'
import { makeAuth, type Harness, TEST_KEY, withoutRegistrationMail } from './harness.ts'

const PW = 'pw-1'

async function mount(h: Harness) {
  const app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(auth({
    auth: withoutRegistrationMail(h.auth),
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { level: () => 4, reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
  }))
  return app
}

const signIn = async (app: any, email: string) =>
  (await request(app).post('/auth/login').send({ email, password: PW })).body as any

const call = (app: any, token: string, method: string, data: object = {}) =>
  request(app).post('/account/me').set('x-service-method', method).auth(token).send(data as any)

describe('requireSecondFactor: true', () => {
  let h: Harness
  let app: any
  beforeAll(async () => {
    h   = await makeAuth({ encryptionKey: TEST_KEY, requireSecondFactor: true })
    app = await mount(h)
  })
  afterAll(() => h.cleanup())

  test('an unenrolled account signs in, and is held to enrollment until confirmTotp', async () => {
    const email = 'held@example.com'
    await h.auth.createUser({ email, password: PW })
    const login = await signIn(app, email)
    expect(typeof login.token).toBe('string')
    expect(login.user.enrollmentOnly).toBe(true)

    const refused = await request(app).get('/sessions').auth(login.token)
    expect(refused.status).toBe(403)
    expect((refused.body as any).data?.reason).toBe('second_factor_required')
    expect((await request(app).get('/account/me').auth(login.token)).status).toBe(403)

    // The three it may call.
    expect((await call(app, login.token, 'totpStatus')).status).toBe(200)
    const setup = await call(app, login.token, 'setupTotp', {})
    expect(setup.status).toBe(200)
    const secret = (setup.body as any).secret as string
    // Still held: setup enables nothing.
    expect((await request(app).get('/sessions').auth(login.token)).status).toBe(403)

    const confirmed = await call(app, login.token, 'confirmTotp', { code: totp(secret, new Date()) })
    expect(confirmed.status).toBe(200)

    // The same token, no new sign-in.
    expect((await request(app).get('/sessions').auth(login.token)).status).toBe(200)
    expect(((await request(app).get('/account/me').auth(login.token)).body as any).enrollmentOnly).toBeFalsy()
  })

  test('an enrolled account still owes a code, and its session is not held', async () => {
    const email = 'enrolled@example.com'
    const user  = await h.auth.createUser({ email, password: PW })
    const { secret } = await h.auth.setupTotp!(user.id)
    await h.auth.confirmTotp!(user.id, totp(secret, new Date()))
    const login = await signIn(app, email)
    expect(typeof login.challenge).toBe('string')
    expect(login.token).toBeUndefined()
  })

  test('a wrong code leaves the session held', async () => {
    const email = 'wrong-code@example.com'
    await h.auth.createUser({ email, password: PW })
    const login = await signIn(app, email)
    await call(app, login.token, 'setupTotp', {})
    expect((await call(app, login.token, 'confirmTotp', { code: '000000' })).status).toBeGreaterThanOrEqual(400)
    expect((await request(app).get('/sessions').auth(login.token)).status).toBe(403)
  })
})

describe('requireSecondFactor: a predicate over the user row', () => {
  let h: Harness
  let app: any
  beforeAll(async () => {
    h   = await makeAuth({ encryptionKey: TEST_KEY, requireSecondFactor: (u: any) => u.role === 'admin' })
    app = await mount(h)
  })
  afterAll(() => h.cleanup())

  test('holds the account it names and lets the others through', async () => {
    await h.auth.createUser({ email: 'boss@example.com', password: PW, role: 'admin' } as any)
    await h.auth.createUser({ email: 'staff@example.com', password: PW })
    const boss  = await signIn(app, 'boss@example.com')
    const staff = await signIn(app, 'staff@example.com')
    expect((await request(app).get('/sessions').auth(boss.token)).status).toBe(403)
    expect((await request(app).get('/sessions').auth(staff.token)).status).toBe(200)
  })
})

describe('requireSecondFactor unset', () => {
  test('an unenrolled account is not held', async () => {
    const h   = await makeAuth({ encryptionKey: TEST_KEY })
    const app = await mount(h)
    await h.auth.createUser({ email: 'free@example.com', password: PW })
    const login = await signIn(app, 'free@example.com')
    expect(login.user.enrollmentOnly).toBeUndefined()
    expect((await request(app).get('/sessions').auth(login.token)).status).toBe(200)
  })
})
