// test/audit-services-cross-user.test.ts
//
// AUDIT 2026-10-05 — every service method, reached with ANOTHER person's row
// named in `ctx.id`, `ctx.query`, `ctx.data` and `$`-keys. The comments claim
// ownership is in the WHERE; this grades the claim. A row that passes is a
// refutation of the attack it names.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'
import { totp, TOTP_STEP_SEC } from '../totp.ts'

let h: Harness
let app: any
let seq = 0

const levelOf = (s: { role?: string }) => s.role === 'sysadmin' ? 7 : s.role === 'admin' ? 5 : 4
// A grader that answers a STRING — what an app reading a role column straight
// through would do.
let stringGrader = false
const standingLevel = (s: any) => stringGrader ? String(levelOf(s)) as any : levelOf(s)

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY, totpDrift: 10 })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { standingLevel, reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

const PW = 'pw-x-1'
async function person(role = 'user') {
  const email = `xu-${Date.now()}-${seq++}@example.com`
  const { userId } = await h.auth.createUser({ email, password: PW, role })
  const token = ((await request(app).post('/auth/login').send({ email, password: PW })).body as any).token as string
  const sessionId = ((await request(app).get('/account/me').auth(token)).body as any).sessionId as string
  return { email, userId, token, sessionId }
}
const me = (token: string) => request(app).get('/account/me').auth(token)

describe('sessions', () => {

  test('DELETE /sessions/{victim session id} by a stranger does nothing, and is not a 401', async () => {
    const alice = await person(), bob = await person()
    const res = await request(app).delete(`/sessions/${bob.sessionId}`).auth(alice.token)
    expect(res.status).not.toBe(200)
    // A 401 inside a live session signs the browser out (FJS-1088).
    expect(res.status).not.toBe(401)
    expect((await me(bob.token)).status).toBe(200)
  })

  test('a userId in the query or the body does not move the list or the revoke', async () => {
    const alice = await person(), bob = await person()
    const list = await request(app).get('/sessions').auth(alice.token).query({ userId: bob.userId })
    const rows = Array.isArray(list.body) ? list.body : (list.body as any).data
    expect(rows.map((r: any) => r.id)).not.toContain(bob.sessionId)

    const rev = await request(app).post('/sessions').set('x-service-method', 'revokeOthers').auth(alice.token)
      .send({ userId: bob.userId, exceptSessionId: alice.sessionId })
    expect(rev.status).toBe(200)
    expect((await me(bob.token)).status).toBe(200)
  })

  test('$-keys do not reach the delete', async () => {
    const alice = await person(), bob = await person()
    const res = await request(app).delete(`/sessions/${bob.sessionId}`).auth(alice.token)
      .query({ $where: JSON.stringify({ userId: bob.userId }), userId: bob.userId })
    expect(res.status).not.toBe(200)
    expect((await me(bob.token)).status).toBe(200)
  })
})

describe('api-keys', () => {

  test('DELETE /api-keys/{victim key id} by a stranger leaves the key live', async () => {
    const alice = await person(), bob = await person()
    const k = (await request(app).post('/api-keys').auth(bob.token).send({ name: 'bob' })).body as any
    const res = await request(app).delete(`/api-keys/${k.id}`).auth(alice.token)
    expect(res.status).not.toBe(200)
    expect(res.status).not.toBe(401)
    expect(await h.auth.verifySession(k.key)).not.toBeNull()
  })

  test("DELETE /api-keys/{own PASSWORD credential id} does not delete the password", async () => {
    const alice = await person()
    const pw = await h.sys.credential.findFirst({ where: { userId: alice.userId, type: 'password' } })
    const res = await request(app).delete(`/api-keys/${pw.id}`).auth(alice.token)
    expect(res.status).not.toBe(200)
    expect(await h.sys.credential.findFirst({ where: { id: pw.id } })).not.toBeNull()
  })

  test('a userId in the create payload mints for the caller, not the named person', async () => {
    const alice = await person(), bob = await person()
    const res = await request(app).post('/api-keys').auth(alice.token).send({ name: 'spoof', userId: bob.userId })
    expect(res.status).toBe(201)
    const who = await h.auth.verifySession((res.body as any).key)
    expect(who?.userId).toBe(alice.userId)
  })
})

describe('account', () => {
  test('GET /account/{victim id} is 404', async () => {
    const alice = await person(), bob = await person()
    expect((await request(app).get(`/account/${bob.userId}`).auth(alice.token)).status).toBe(404)
  })
  test('totpStatus answers the caller whatever id is in the path', async () => {
    const alice = await person(), bob = await person()
    const { secret } = await h.auth.setupTotp!(bob.userId, PW)
    await h.auth.confirmTotp!(bob.userId, totp(secret, new Date(Date.now() - 5 * TOTP_STEP_SEC * 1000)))
    const res = await request(app).post(`/account/${bob.userId}`).set('x-service-method', 'totpStatus').auth(alice.token).send({})
    // Either refused, or answered about ALICE (enabled: false) — never bob.
    if (res.status === 200) expect((res.body as any).enabled).toBe(false)
  })
})

describe('connections', () => {
  test("DELETE /connections/{victim oauth credential id} is 404 and the row survives", async () => {
    const alice = await person(), bob = await person()
    const row = await h.sys.credential.create({ data: { userId: bob.userId, type: 'oauth:github', value: 'gh-123' } })
    const res = await request(app).delete(`/connections/${row.id}`).auth(alice.token)
    expect(res.status).toBe(404)
    expect(await h.sys.credential.findFirst({ where: { id: row.id } })).not.toBeNull()
    const list = await request(app).get('/connections').auth(alice.token)
    const rows = Array.isArray(list.body) ? list.body : (list.body as any).data
    expect(rows.length).toBe(0)
  })
})

describe('account-recovery', () => {
  const reset = (token: string, id: string) =>
    request(app).post(`/account-recovery/${id}`).set('x-service-method', 'resetTotp').auth(token).send({})

  async function withFactor(role = 'user') {
    const u = await person(role)
    const { secret } = await h.auth.setupTotp!(u.userId, PW)
    await h.auth.confirmTotp!(u.userId, totp(secret, new Date(Date.now() - 5 * TOTP_STEP_SEC * 1000)))
    return u
  }

  test("'me', own id, a peer — all 403 and the factor stays", async () => {
    const op = await withFactor('sysadmin'), peer = await withFactor('sysadmin')
    expect((await reset(op.token, 'me')).status).toBe(403)
    expect((await reset(op.token, op.userId)).status).toBe(403)
    expect((await reset(op.token, peer.userId)).status).toBe(403)
    expect((await h.auth.totpStatus!(op.userId)).enabled).toBe(true)
    expect((await h.auth.totpStatus!(peer.userId)).enabled).toBe(true)
  })

  test("a grader answering the STRING '7' refuses", async () => {
    const op = await person('sysadmin'), u = await withFactor('user')
    stringGrader = true
    try {
      expect((await reset(op.token, u.userId)).status).toBe(403)
      expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(true)
    } finally { stringGrader = false }
  })

  test('a userId in the BODY does not redirect the reset', async () => {
    const op = await person('sysadmin'), u = await withFactor('user'), other = await withFactor('user')
    const res = await request(app).post(`/account-recovery/${u.userId}`).set('x-service-method', 'resetTotp')
      .auth(op.token).send({ userId: other.userId, id: other.userId })
    expect(res.status).toBe(200)
    expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(false)
    expect((await h.auth.totpStatus!(other.userId)).enabled).toBe(true)
  })
})
