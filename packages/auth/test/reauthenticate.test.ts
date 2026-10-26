// test/reauthenticate.test.ts
//
// Sudo mode (`FJS-D1209`) and the sessions a sign-in change ends (`FJS-D1208`),
// against a real database on a clock this file owns.
//
// The failure this file exists for is a credential change made from a session
// nobody proved recently, and a change of how the account signs in that leaves
// a stolen session live. Every refusal is asserted beside the call that passes
// on the same session once it is confirmed, because a check that refused
// everybody would look identical from the refused side.

import { describe, test, expect, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { auth as authPlugin } from '../plugin.ts'
import { makeAuth, rejectsWith, signedIn, TEST_KEY, type Harness } from './harness.ts'
import { totp } from '../totp.ts'
import {
  ReauthenticationRequiredError, ReauthenticationFailedError, InvalidTokenError,
} from '../index.ts'
import type { LitestoneAuthOptions } from '../types.ts'

const PW     = 'pw-sudo-1'
const MINUTE = 60 * 1000

const harnesses: Harness[] = []
afterAll(() => harnesses.forEach(h => h.cleanup()))

let seq = 0
const address = () => `sudo-${Date.now()}-${seq++}@example.com`

async function staged(opts: LitestoneAuthOptions = {}) {
  let at = Date.parse('2031-05-05T09:00:00.000Z')
  const h = await makeAuth({ encryptionKey: TEST_KEY, ...opts }, { now: () => new Date(at) })
  harnesses.push(h)
  const now = () => new Date(at)
  async function person() {
    const email = address()
    await h.auth.createUser({ email, password: PW })
    const { token, user } = signedIn(await h.auth.login(email, PW))
    return { email, token, id: String(user.id), sessionId: String(user.sessionId) }
  }
  async function enrolled(p: { id: string; sessionId: string }) {
    const { secret } = await h.auth.setupTotp!(p.id)
    await h.auth.confirmTotp!(p.id, totp(secret, now()), { exceptSessionId: p.sessionId })
    // The confirming code spent its step; the next one is a step on.
    at += 30_000
    return secret
  }
  const live = async (id: string) => (await h.sys.session.findMany({ where: { userId: id } })).map((s: any) => String(s.id)).sort()
  return { ...h, now, advance: (ms: number) => { at += ms }, person, enrolled, live }
}

describe('sudo mode — a session proves the password, and the proof lapses', () => {
  test('a sign-in is fresh, stops being fresh past the hour, and reauthenticate restores it', async () => {
    const s = await staged()
    const p = await s.person()
    await s.auth.requireReauthenticated!(p.id, p.sessionId)

    s.advance(61 * MINUTE)
    const refused = await rejectsWith(() => s.auth.requireReauthenticated!(p.id, p.sessionId), ReauthenticationRequiredError)
    expect((refused as any).status).toBe(403)
    expect((refused as any).data).toEqual({ reason: 'reauthentication_required' })

    const { until } = await s.auth.reauthenticate!(p.id, p.sessionId, { password: PW })
    expect(Date.parse(until) - s.now().getTime()).toBe(60 * MINUTE)
    await s.auth.requireReauthenticated!(p.id, p.sessionId)
  })

  test('a wrong password confirms nothing — paired with the right one', async () => {
    const s = await staged()
    const p = await s.person()
    s.advance(61 * MINUTE)

    await rejectsWith(() => s.auth.reauthenticate!(p.id, p.sessionId, { password: 'not-it' }), ReauthenticationFailedError)
    await rejectsWith(() => s.auth.requireReauthenticated!(p.id, p.sessionId), ReauthenticationRequiredError)
    await s.auth.reauthenticate!(p.id, p.sessionId, { password: PW })
    await s.auth.requireReauthenticated!(p.id, p.sessionId)
  })

  test('with a factor on, the password alone is not enough, and a wrong code is not either', async () => {
    const s = await staged()
    const p = await s.person()
    const secret = await s.enrolled(p)
    s.advance(61 * MINUTE)

    await rejectsWith(() => s.auth.reauthenticate!(p.id, p.sessionId, { password: PW }), ReauthenticationFailedError)
    await rejectsWith(() => s.auth.reauthenticate!(p.id, p.sessionId, { password: PW, code: '000000' }), ReauthenticationFailedError)
    await rejectsWith(() => s.auth.requireReauthenticated!(p.id, p.sessionId), ReauthenticationRequiredError)

    await s.auth.reauthenticate!(p.id, p.sessionId, { password: PW, code: totp(secret, s.now()) })
    await s.auth.requireReauthenticated!(p.id, p.sessionId)
  })

  test('a null stamp is never fresh, and somebody else\'s session is a miss', async () => {
    const s = await staged()
    const p = await s.person()
    const q = await s.person()

    await rejectsWith(() => s.auth.requireReauthenticated!(q.id, p.sessionId), ReauthenticationRequiredError)
    await rejectsWith(() => s.auth.requireReauthenticated!(p.id, undefined), ReauthenticationRequiredError)
    await rejectsWith(() => s.auth.reauthenticate!(q.id, p.sessionId, { password: PW }), InvalidTokenError)

    await s.sys.session.update({ where: { id: p.sessionId }, data: { reauthenticatedAt: null } })
    await rejectsWith(() => s.auth.requireReauthenticated!(p.id, p.sessionId), ReauthenticationRequiredError)
  })

  test('the window is the app\'s to set', async () => {
    const s = await staged({ reauthenticationWindow: '5 minutes' })
    const p = await s.person()
    s.advance(4 * MINUTE)
    await s.auth.requireReauthenticated!(p.id, p.sessionId)
    s.advance(2 * MINUTE)
    await rejectsWith(() => s.auth.requireReauthenticated!(p.id, p.sessionId), ReauthenticationRequiredError)
  })
})

describe('a change to how the account signs in ends every other session (FJS-D1208)', () => {
  test('confirmTotp, regenerateRecoveryCodes and disableTotp each keep the session that asked', async () => {
    const s = await staged()
    const p = await s.person()

    const other = async () => signedIn(await s.auth.login(p.email, PW)).user.sessionId
    const otherEnrolling = await other()
    const secret = await s.enrolled(p)
    expect(await s.live(p.id)).toEqual([p.sessionId])
    expect(await s.live(p.id)).not.toContain(otherEnrolling)

    // With the factor on, a second sign-in owes a code; the code is what
    // makes it a session.
    const second = async () => {
      const c = await s.auth.login(p.email, PW) as any
      s.advance(30_000)
      return String(signedIn(await s.auth.completeLogin!(c.challenge, totp(secret, s.now()))).user.sessionId)
    }
    await second()
    await s.auth.regenerateRecoveryCodes!(p.id, { exceptSessionId: p.sessionId })
    expect(await s.live(p.id)).toEqual([p.sessionId])

    await second()
    await s.auth.disableTotp!(p.id, { exceptSessionId: p.sessionId })
    expect(await s.live(p.id)).toEqual([p.sessionId])
  })
})

describe('over HTTP', () => {
  async function mounted() {
    const s = await staged()
    const app = await createTestApp({ auth: s.auth as any })
    app.setAuth(s.auth as any)
    app.configure(authPlugin({
      auth: s.auth,
      loginRateLimit:    { max: 10_000, window: '15 minutes' },
      registerRateLimit: { max: 10_000, window: '15 minutes' },
      services:          { reauthenticationRateLimit: { max: 10_000, window: '15 minutes' } },
    }))
    const call = (token: string, method: string, data: Record<string, unknown> = {}) =>
      request(app).post('/account/me').set('x-service-method', method).auth(token).send(data as any)
    return { s, app, call }
  }

  test('past the window, every credential change answers 403 by reason — and after account.reauthenticate it goes through', async () => {
    const { s, app, call } = await mounted()
    const p = await s.person()
    s.advance(61 * MINUTE)

    const stale = [
      await call(p.token, 'changePassword', { newPassword: 'pw-sudo-2' }),
      await call(p.token, 'requestEmailChange', { newEmail: address() }),
      await call(p.token, 'setupTotp'),
      await call(p.token, 'disableTotp'),
      await call(p.token, 'regenerateRecoveryCodes'),
      await request(app).post('/api-keys').auth(p.token).send({ name: 'ci' } as any),
      await request(app).delete('/connections/anything').auth(p.token),
    ]
    expect(stale.map(r => [r.status, (r.body as any)?.data?.reason]))
      .toEqual(stale.map(() => [403, 'reauthentication_required']))
    // 403, not 401: the session that was refused is still a session.
    expect((await request(app).get('/account/me').auth(p.token)).status).toBe(200)
    expect(signedIn(await s.auth.login(p.email, PW)).token).toBeTruthy()

    const wrong = await call(p.token, 'reauthenticate', { password: 'not-it' })
    expect(wrong.status).toBe(403)
    expect((await call(p.token, 'setupTotp')).status).toBe(403)

    const confirmed = await call(p.token, 'reauthenticate', { password: PW })
    expect(confirmed.status).toBe(200)
    expect(typeof (confirmed.body as any).until).toBe('string')
    expect((await call(p.token, 'setupTotp')).status).toBe(200)
    expect((await request(app).post('/api-keys').auth(p.token).send({ name: 'ci' } as any)).status).toBe(201)
  })

  test('a confirmed change of address ends the other sessions and keeps the one that posted the click', async () => {
    const { s, app, call } = await mounted()
    const p = await s.person()
    const elsewhere = signedIn(await s.auth.login(p.email, PW)).token

    expect((await call(p.token, 'requestEmailChange', { newEmail: address() })).status).toBe(200)
    const clicked = await request(app).post('/auth/email/verify').auth(p.token).send({ token: s.verifyToken() } as any)
    expect(clicked.status).toBe(200)

    expect((await request(app).get('/account/me').auth(p.token)).status).toBe(200)
    expect((await request(app).get('/account/me').auth(elsewhere)).status).toBe(401)
  })
})
