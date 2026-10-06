// test/audit-services-support.test.ts
//
// AUDIT 2026-10-05 — what an operator inside a live episode can make happen
// to the SUBJECT that outlives the episode, through the services and the raw
// routes that read `ctx.user`. The comment on `refuseInSupport` claims none.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'
import { totp, TOTP_STEP_SEC } from '../totp.ts'

let h: Harness
let app: any
let seq = 0
const mails: Array<{ email: string; token: string }> = []

beforeAll(async () => {
  h = await makeAuth({
    encryptionKey: TEST_KEY,
    totpDrift: 10,
    onEmailVerificationRequested: async (email: string, token: string) => { mails.push({ email, token }) },
  })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    canStartSupport:   () => true,
    services:          { standingLevel: () => 3 },
  }))
})
afterAll(() => h.cleanup())

const PW = 'pw-s-1'
async function person() {
  const email = `sp-${Date.now()}-${seq++}@example.com`
  const { userId } = await h.auth.createUser({ email, password: PW })
  const token = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token as string
  return { email, userId, token }
}
const me    = (token: string) => request(app).get('/account/me').auth(token)
const start = (op: string, subjectId: string) =>
  request(app).post('/auth/support/start').auth(op).send({ subjectId, reason: 'audit' })
const end   = (op: string) => request(app).post('/auth/support/end').auth(op)

describe('actions on the subject that outlive the episode', () => {

  test('POST /auth/email/verify/request inside an episode does not mail the subject', async () => {
    const op = await person(), sub = await person()
    expect((await start(op.token, sub.userId)).status).toBe(200)
    const before = mails.filter(m => m.email === sub.email).length

    const res = await request(app).post('/auth/email/verify/request').auth(op.token)
    expect(res.status).toBe(403)
    expect(mails.filter(m => m.email === sub.email).length).toBe(before)

    await end(op.token)
    // And no verification row for the subject's address was minted during it.
    const rows = await h.sys.verification.findMany({ where: { purpose: 'emailVerify', identifier: sub.email } })
    expect(rows.length).toBe(0)
  })

  test('account-recovery.resetTotp inside an episode is refused and the factor stays', async () => {
    const op = await person(), sub = await person(), third = await person()
    const { secret } = await h.auth.setupTotp!(third.userId, PW)
    await h.auth.confirmTotp!(third.userId, totp(secret, new Date(Date.now() - 5 * TOTP_STEP_SEC * 1000)))
    await start(op.token, sub.userId)
    const res = await request(app).post(`/account-recovery/${third.userId}`).set('x-service-method', 'resetTotp')
      .auth(op.token).send({})
    expect(res.status).toBe(403)
    expect((await h.auth.totpStatus!(third.userId)).enabled).toBe(true)
    await end(op.token)
  })
})

describe('refutation rows — expected to pass', () => {

  test('POST /auth/logout inside an episode ends the OPERATOR, not the subject', async () => {
    const op = await person(), sub = await person()
    await start(op.token, sub.userId)
    expect((await request(app).post('/auth/logout').auth(op.token)).status).toBe(200)
    expect((await me(op.token)).status).toBe(401)
    expect((await me(sub.token)).status).toBe(200)
  })

  test('reads answer the subject; the writes are refused', async () => {
    const op = await person(), sub = await person()
    await start(op.token, sub.userId)
    expect(((await me(op.token)).body as any).email).toBe(sub.email)
    expect((await request(app).get('/sessions').auth(op.token)).status).toBe(200)
    expect((await request(app).get('/api-keys').auth(op.token)).status).toBe(200)
    expect((await request(app).get('/connections').auth(op.token)).status).toBe(200)
    expect((await request(app).post('/account/me').set('x-service-method', 'totpStatus').auth(op.token).send({})).status).toBe(200)
    expect((await request(app).delete('/connections/x').auth(op.token)).status).toBe(403)
    expect((await request(app).post('/api-keys').auth(op.token).send({ name: 'x' })).status).toBe(403)
    expect((await request(app).post('/sessions').set('x-service-method', 'revokeOthers').auth(op.token).send({})).status).toBe(403)
    await end(op.token)
  })

  test('after end, and after the clock lapses, the operator is immediately themselves', async () => {
    const op = await person(), sub = await person()
    await start(op.token, sub.userId)
    await end(op.token)
    expect(((await me(op.token)).body as any).email).toBe(op.email)

    await start(op.token, sub.userId)
    const row = await h.sys.session.findFirst({ where: { token: op.token } })
    await h.sys.session.update({ where: { id: row.id }, data: { impersonationEndsAt: new Date(Date.now() - 1000).toISOString() } })
    expect(((await me(op.token)).body as any).email).toBe(op.email)
    expect((await request(app).post('/api-keys').auth(op.token).send({ name: 'own' })).status).toBe(201)
  })

  test('starting with an API key is refused — a key is not a session', async () => {
    const op = await person(), sub = await person()
    const k = (await request(app).post('/api-keys').auth(op.token).send({ name: 'k' })).body as any
    const res = await request(app).post('/auth/support/start').auth(k.key).send({ subjectId: sub.userId, reason: 'r' })
    expect(res.status).not.toBe(200)
    expect(((await me(k.key)).body as any).email).toBe(op.email)
  })
})
