// test/email-change.test.ts
//
// `requestEmailChange` → the link → `verifyEmail`, against a real database and,
// for the service half, a real Junction app.
//
// The address is where a password reset goes, so the failure this file exists
// for is an address that moved without both proofs: a session reauthenticated
// inside the window at the request (`FJS-D1209`), the new mailbox at the click. Every refusal re-reads the row
// afterwards, because a 403 that had already moved the address is the worst
// answer this can give.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { auth } from '../plugin.ts'
import { makeAuth, rejectsWith, signedIn, verified, type Harness, TEST_KEY } from './harness.ts'
import { EmailTakenError, InvalidTokenError, AuthConfigError } from '../index.ts'
import type { CredentialChange } from '../types.ts'

const PW = 'pw-change-1'

let h: Harness
let app: any
let told: CredentialChange[] = []
let seq = 0

beforeAll(async () => {
  h = await makeAuth({
    encryptionKey: TEST_KEY,
    onCredentialChanged: (c) => { told.push(c) },
  })
  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(auth({
    auth: h.auth,
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    services:          { reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
  }))
})
afterAll(() => h.cleanup())

const address = (tag = 'u') => `${tag}-${Date.now()}-${seq++}@example.com`

async function person() {
  const email = address('old')
  const { id: userId } = await h.auth.createUser({ email, password: PW })
  return { email, userId }
}

const row = (id: string) => h.sys.user.findUnique({ where: { id } })

// ─── The provider ─────────────────────────────────────────────────────────

describe('requestEmailChange, then the link', () => {

  test('the address moves at the click and not before, verified, and the old one stops signing in', async () => {
    const u  = await person()
    const to = address('new')
    await h.auth.requestEmailChange!(u.userId, to)
    expect((await row(u.userId)).email).toBe(u.email)

    const ctx = verified(await h.auth.verifyEmail!(h.verifyToken()))
    expect(ctx.email).toBe(to)
    const after = await row(u.userId)
    expect(after.email).toBe(to)
    expect(after.emailVerified).toBe(true)

    expect(signedIn(await h.auth.login(to, PW)).user.id).toBe(u.userId)
    await expect(h.auth.login(u.email, PW)).rejects.toThrow()
  })

  test('the link is single-use', async () => {
    const u = await person()
    await h.auth.requestEmailChange!(u.userId, address('new'))
    const token = h.verifyToken()
    await h.auth.verifyEmail!(token)
    await rejectsWith(() => h.auth.verifyEmail!(token), InvalidTokenError)
  })

  test('the new address is lowercased and trimmed before it is stored', async () => {
    const u  = await person()
    const to = address('mixed')
    await h.auth.requestEmailChange!(u.userId, `  ${to.toUpperCase()} `)
    await h.auth.verifyEmail!(h.verifyToken())
    expect((await row(u.userId)).email).toBe(to)
  })

  test('an address another account holds is refused at the request', async () => {
    const u = await person()
    const other = await person()
    await rejectsWith(() => h.auth.requestEmailChange!(u.userId, other.email), EmailTakenError)
    expect((await row(u.userId)).email).toBe(u.email)
  })

  test('an address taken between the mail and the click is refused at the click, and the link is spent', async () => {
    const u  = await person()
    const to = address('race')
    await h.auth.requestEmailChange!(u.userId, to)
    const token = h.verifyToken()
    await h.auth.createUser({ email: to, password: 'someone-else' })

    await rejectsWith(() => h.auth.verifyEmail!(token), EmailTakenError)
    expect((await row(u.userId)).email).toBe(u.email)
    await rejectsWith(() => h.auth.verifyEmail!(token), InvalidTokenError)
  })

  test('a second request supersedes the first link', async () => {
    const u = await person()
    await h.auth.requestEmailChange!(u.userId, address('first'))
    const first = h.verifyToken()
    const to = address('second')
    await h.auth.requestEmailChange!(u.userId, to)

    await rejectsWith(() => h.auth.verifyEmail!(first), InvalidTokenError)
    await h.auth.verifyEmail!(h.verifyToken())
    expect((await row(u.userId)).email).toBe(to)
  })

  test('a reset link minted for the old address is purged by the move', async () => {
    const u = await person()
    await h.requestReset(u.email)
    const reset = h.resetToken()

    await h.auth.requestEmailChange!(u.userId, address('new'))
    await h.auth.verifyEmail!(h.verifyToken())

    await rejectsWith(() => h.auth.confirmPasswordReset!(reset, 'pw-taken-over'), InvalidTokenError)
  })

  test('the OLD address is told, and nothing is told before the click', async () => {
    const u  = await person()
    const to = address('new')
    told = []
    await h.auth.requestEmailChange!(u.userId, to)
    expect(told).toEqual([])

    await h.auth.verifyEmail!(h.verifyToken())
    expect(told.map(c => c.event)).toEqual(['email.changed'])
    expect(told[0]).toMatchObject({ userId: u.userId, email: u.email, actorId: u.userId })
    expect(JSON.stringify(told[0]!.meta)).not.toContain(to)
  })

  test('an ordinary verification link still verifies and moves nothing', async () => {
    const u = await person()
    await h.auth.requestEmailVerification!(u.userId)
    await h.auth.verifyEmail!(h.verifyToken())
    const after = await row(u.userId)
    expect(after.email).toBe(u.email)
    expect(after.emailVerified).toBe(true)
  })

  test('without a way to mail the link the request is refused, not answered as sent', async () => {
    const bare = await makeAuth({ encryptionKey: TEST_KEY, onEmailVerificationRequested: undefined })
    const email = address('bare')
    const { id: userId } = await bare.auth.createUser({ email, password: PW })
    await rejectsWith(() => bare.auth.requestEmailChange!(userId, address('new')), AuthConfigError)
  })
})

// ─── The service ──────────────────────────────────────────────────────────

describe('account.requestEmailChange over HTTP', () => {

  async function signIn() {
    const u = await person()
    const token = signedIn(await h.auth.login(u.email, PW)).token
    const sessionId = (await h.auth.verifySession(token))!.sessionId!
    return { ...u, token, sessionId }
  }

  const ask = (token: string, body: Record<string, unknown>) =>
    request(app).post('/account/me').auth(token).set('x-service-method', 'requestEmailChange').send(body)

  const stale = (sessionId: string) =>
    h.sys.session.update({ where: { id: sessionId }, data: { reauthenticatedAt: null } })

  test('mails the link, GET /account/me answers the new address once it is spent, and only the clicking session survives', async () => {
    const u  = await signIn()
    const other = signedIn(await h.auth.login(u.email, PW)).token
    const to = address('svc')
    expect((await ask(u.token, { newEmail: to })).status).toBe(200)

    const spent = await request(app).post('/auth/email/verify').auth(u.token).send({ token: h.verifyToken() })
    expect(spent.status).toBe(200)
    expect(((await request(app).get('/account/me').auth(u.token)).body as any).email).toBe(to)
    expect((await request(app).get('/account/me').auth(other)).status).toBe(401)
  })

  test('a stale session is 403 reauthentication_required — mints nothing, moves nothing, and the session survives', async () => {
    const u = await signIn()
    await stale(u.sessionId)
    const before = h.verifyToken()
    const res = await ask(u.token, { newEmail: address('svc') })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('reauthentication_required')
    expect(h.verifyToken()).toBe(before)
    expect(await h.sys.verification.findMany({ where: { purpose: 'emailChange', userId: u.userId } })).toEqual([])
    expect((await row(u.userId)).email).toBe(u.email)
    expect((await request(app).get('/account/me').auth(u.token)).status).toBe(200)
  })

  test('a wrong password at reauthenticate is 403 and leaves the session stale; the right one lets the request through', async () => {
    const u = await signIn()
    await stale(u.sessionId)
    const reauth = (password: string) =>
      request(app).post('/account/me').auth(u.token).set('x-service-method', 'reauthenticate').send({ password })

    expect((await reauth('wrong')).status).toBe(403)
    expect((await ask(u.token, { newEmail: address('svc') })).status).toBe(403)
    expect((await request(app).get('/account/me').auth(u.token)).status).toBe(200)

    expect((await reauth(PW)).status).toBe(200)
    expect((await ask(u.token, { newEmail: address('svc') })).status).toBe(200)
  })

  test('the address already on the account is 400 by name', async () => {
    const u = await signIn()
    const res = await ask(u.token, { newEmail: u.email.toUpperCase() })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('already the address')
  })

  test('a missing address is 400, and anonymous is 401', async () => {
    const u = await signIn()
    expect((await ask(u.token, {})).status).toBe(400)
    expect((await request(app).post('/account/me').set('x-service-method', 'requestEmailChange')
      .send({ newEmail: address('svc') })).status).toBe(401)
  })
})
