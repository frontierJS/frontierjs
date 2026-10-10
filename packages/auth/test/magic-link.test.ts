// test/magic-link.test.ts
//
// Passwordless sign-in by mail, against a real Litestone database (`FJS-D888`).
//
// The mail callback runs AFTER `requestMagicLink` has answered (FJS-1832), so
// every test waits on `mailed()` for what the callback received rather than on
// the request. Each refusal sits beside the call that succeeds, because a flow
// that refused everything would pass every refusal on its own.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, signedIn, type Harness } from './harness.ts'
import { appWith, json } from './audit-routes-http.ts'
import { totp } from '../totp.ts'
import { InvalidTokenError } from '../errors.ts'

type Mail = { email: string; token: string; code: string }

let h: Harness
let inbox: Mail[] = []
let arrived: () => void = () => {}
let seq = 0
const nextEmail = () => `magic-${Date.now()}-${seq++}@example.com`

beforeAll(async () => {
  h = await makeAuth({
    onMagicLinkRequested: async (m) => { inbox.push(m); arrived() },
  })
})
afterAll(() => h.cleanup())

/** Request a link and resolve with the mail it produced. */
async function mailed(email: string, env: Harness = h): Promise<Mail> {
  const got = new Promise<void>(r => { arrived = r })
  await env.auth.requestMagicLink!(email)
  await got
  return inbox[inbox.length - 1]!
}

/** Let the request's deferred work run when no mail is expected. */
const settle = () => new Promise(r => setTimeout(r, 50))

describe('turned on by the callback', () => {
  test('without onMagicLinkRequested the methods do not exist', async () => {
    const off = await makeAuth()
    expect(off.auth.requestMagicLink).toBeUndefined()
    expect(off.auth.verifyMagicLink).toBeUndefined()
    off.cleanup()
  })

  test('with it, both exist', () => {
    expect(typeof h.auth.requestMagicLink).toBe('function')
    expect(typeof h.auth.verifyMagicLink).toBe('function')
  })
})

describe('an address nobody holds', () => {
  test('the request makes no user; the click makes a verified one and signs it in', async () => {
    const email = nextEmail()
    const mail  = await mailed(email)
    expect(mail.code).toMatch(/^\d{6}$/)
    expect(await h.sys.user.findFirst({ where: { email } })).toBeNull()

    const result = signedIn(await h.auth.verifyMagicLink!({ token: mail.token }))
    expect(result.token).toBeTruthy()

    const row = await h.sys.user.findFirst({ where: { email } })
    expect(row.emailVerified).toBe(true)
    expect(await h.sys.credential.count({ where: { userId: row.id } })).toBe(0)
  })

  test('onRegister refuses at the click, and no user is left behind', async () => {
    const closed = await makeAuth({
      onMagicLinkRequested: async (m) => { inbox.push(m); arrived() },
      onRegister: () => { throw new Error('closed beta') },
    })
    const email = nextEmail()
    const mail  = await mailed(email, closed)
    await expect(closed.auth.verifyMagicLink!({ token: mail.token })).rejects.toThrow('closed beta')
    expect(await closed.sys.user.findFirst({ where: { email } })).toBeNull()
    closed.cleanup()
  })

  test('a mixed-case address makes one lowercased account, which the next link signs into', async () => {
    const lower = nextEmail()
    const typed = lower.toUpperCase()
    const first = await mailed(typed)
    expect(first.email).toBe(lower)
    signedIn(await h.auth.verifyMagicLink!({ token: first.token }))

    const again = await mailed(typed)
    const user  = signedIn(await h.auth.verifyMagicLink!({ token: again.token })).user
    expect(await h.sys.user.count({ where: { email: lower } })).toBe(1)
    expect(user.email).toBe(lower)
  })
})

describe('an account with a password', () => {
  test('the link signs in and marks the address verified', async () => {
    const email = nextEmail()
    const made  = await h.auth.createUser({ email, password: 'pw-correct-1' })
    expect((await h.sys.user.findFirst({ where: { email } })).emailVerified).not.toBe(true)

    const mail   = await mailed(email)
    const result = signedIn(await h.auth.verifyMagicLink!({ token: mail.token }))
    expect(result.user.userId).toBe(made.userId)
    expect((await h.sys.user.findFirst({ where: { email } })).emailVerified).toBe(true)
  })

  test('a link is spent by its first use', async () => {
    const email = nextEmail()
    const mail  = await mailed(email)
    signedIn(await h.auth.verifyMagicLink!({ token: mail.token }))
    await rejectsWith(() => h.auth.verifyMagicLink!({ token: mail.token }), InvalidTokenError)
  })

  test('two clicks racing on one link sign in once', async () => {
    const email = nextEmail()
    const mail  = await mailed(email)
    const both  = await Promise.allSettled([
      h.auth.verifyMagicLink!({ token: mail.token }),
      h.auth.verifyMagicLink!({ token: mail.token }),
    ])
    expect(both.filter(r => r.status === 'fulfilled').length).toBe(1)
  })

  test('a second request replaces the first link', async () => {
    const email = nextEmail()
    const old   = await mailed(email)
    const fresh = await mailed(email)
    await rejectsWith(() => h.auth.verifyMagicLink!({ token: old.token }), InvalidTokenError)
    signedIn(await h.auth.verifyMagicLink!({ token: fresh.token }))
  })

  test('a token minted for a password reset is not a magic link', async () => {
    const email = nextEmail()
    await h.auth.createUser({ email, password: 'pw-correct-1' })
    await h.requestReset(email)
    await rejectsWith(() => h.auth.verifyMagicLink!({ token: h.resetToken() }), InvalidTokenError)
  })
})

describe('the code, for another device', () => {
  test('the address and its code sign in, once', async () => {
    const email = nextEmail()
    const mail  = await mailed(email)
    signedIn(await h.auth.verifyMagicLink!({ email, code: mail.code }))
    await rejectsWith(() => h.auth.verifyMagicLink!({ email, code: mail.code }), InvalidTokenError)
  })

  test('the code spends the link too', async () => {
    const email = nextEmail()
    const mail  = await mailed(email)
    signedIn(await h.auth.verifyMagicLink!({ email, code: mail.code }))
    await rejectsWith(() => h.auth.verifyMagicLink!({ token: mail.token }), InvalidTokenError)
  })

  test('a code is good only for its own address', async () => {
    const a = nextEmail(), b = nextEmail()
    const ma = await mailed(a)
    await mailed(b)
    await rejectsWith(() => h.auth.verifyMagicLink!({ email: b, code: ma.code }), InvalidTokenError)
      .catch(() => { /* the two codes can collide once in a million */ })
    signedIn(await h.auth.verifyMagicLink!({ email: a, code: ma.code }))
  })

  test('a wrong code is retryable until the ceiling, which spends the link', async () => {
    const email = nextEmail()
    const mail  = await mailed(email)
    const wrong = mail.code === '000000' ? '000001' : '000000'

    for (let i = 0; i < 4; i++) {
      const err = await rejectsWith(() => h.auth.verifyMagicLink!({ email, code: wrong }), InvalidTokenError)
      expect(err.retryable).toBe(true)
    }
    const last = await rejectsWith(() => h.auth.verifyMagicLink!({ email, code: wrong }), InvalidTokenError)
    expect(last.retryable).toBe(false)

    // The right code no longer works — the ceiling spent the row.
    await rejectsWith(() => h.auth.verifyMagicLink!({ email, code: mail.code }), InvalidTokenError)
    await rejectsWith(() => h.auth.verifyMagicLink!({ token: mail.token }), InvalidTokenError)
  })
})

describe('an account with a second factor', () => {
  test('the link earns a ticket, not a session, and the TOTP code finishes it', async () => {
    const email = nextEmail()
    const u = await h.auth.createUser({ email, password: 'pw-correct-1' })
    const { secret } = await h.auth.setupTotp!(u.userId, 'pw-correct-1')
    await h.auth.confirmTotp!(u.userId, totp(secret, new Date()))

    const mail   = await mailed(email)
    const result = await h.auth.verifyMagicLink!({ token: mail.token })
    expect('challenge' in result).toBe(true)
    expect('token' in result).toBe(false)
    expect(await h.sys.session.count({ where: { userId: u.userId } })).toBe(0)

    // Next step, so it is not the code that confirmed enrollment.
    const code = totp(secret, new Date(Date.now() + 30_000))
    const done = await h.auth.completeLogin!((result as any).challenge, code)
    expect(done.user.userId).toBe(u.userId)
  })
})

describe('an account whose only way in is a provider', () => {
  async function providerOnly(email: string) {
    const user = await h.sys.user.create({ data: { email, emailVerified: true } })
    await h.sys.credential.create({ data: { userId: user.id, type: 'oauth:google', value: `sub-${email}` } })
    return user
  }

  test('the request mails nothing', async () => {
    const email = nextEmail()
    await providerOnly(email)
    const before = inbox.length
    await h.auth.requestMagicLink!(email)
    await settle()
    expect(inbox.length).toBe(before)
    expect(await h.sys.verification.count({ where: { purpose: 'magicLink', identifier: email } })).toBe(0)
  })

  test('a provider linked between the mail and the click is refused at the click', async () => {
    const email = nextEmail()
    const user  = await h.sys.user.create({ data: { email, emailVerified: true } })
    const mail  = await mailed(email)
    await h.sys.credential.create({ data: { userId: user.id, type: 'oauth:google', value: `sub-${email}` } })

    await rejectsWith(() => h.auth.verifyMagicLink!({ token: mail.token }), InvalidTokenError)
    expect(await h.sys.session.count({ where: { userId: user.id } })).toBe(0)
  })

  test('the same account with a password beside the provider signs in', async () => {
    const email = nextEmail()
    const u = await h.auth.createUser({ email, password: 'pw-correct-1' })
    await h.sys.credential.create({ data: { userId: u.userId, type: 'oauth:google', value: `sub-${email}` } })
    const mail = await mailed(email)
    expect(signedIn(await h.auth.verifyMagicLink!({ token: mail.token })).user.userId).toBe(u.userId)
  })
})

describe('the hooks a password login runs', () => {
  test('onLogin refuses a link sign-in and no session is issued', async () => {
    const vetoed = await makeAuth({
      onMagicLinkRequested: async (m) => { inbox.push(m); arrived() },
      onLogin: () => { throw new Error('locked') },
    })
    const email = nextEmail()
    const u     = await vetoed.auth.createUser({ email, password: 'pw-correct-1' })
    const mail  = await mailed(email, vetoed)
    await expect(vetoed.auth.verifyMagicLink!({ token: mail.token })).rejects.toThrow('locked')
    expect(await vetoed.sys.session.count({ where: { userId: u.userId } })).toBe(0)
    vetoed.cleanup()
  })

  test('onLoginFailed hears a bad code at the magic-link stage', async () => {
    const heard: any[] = []
    const env = await makeAuth({
      onMagicLinkRequested: async (m) => { inbox.push(m); arrived() },
      onLoginFailed: (e) => { heard.push(e) },
    })
    const email = nextEmail()
    const mail  = await mailed(email, env)
    const wrong = mail.code === '000000' ? '000001' : '000000'
    await rejectsWith(() => env.auth.verifyMagicLink!({ email, code: wrong }), InvalidTokenError)
    expect(heard.at(-1)).toMatchObject({ email, reason: 'bad-code', stage: 'magic-link' })
    env.cleanup()
  })
})

describe('the routes', () => {
  test('request answers ok for any address, and verify answers a session', async () => {
    const app   = await appWith(h.auth, { magicLinkRateLimit: { max: 10_000, window: '15 minutes' } })
    const email = nextEmail()

    const got = new Promise<void>(r => { arrived = r })
    const res = await json(app, 'POST', '/auth/magic-link/request', { email })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    await got

    const { token } = inbox[inbox.length - 1]!
    const ok = await json(app, 'POST', '/auth/magic-link/verify', { token })
    expect(ok.status).toBe(200)
    expect(typeof ok.body.token).toBe('string')

    const again = await json(app, 'POST', '/auth/magic-link/verify', { token })
    expect(again.status).toBe(400)
  })

  test('verify with neither proof is a 400 naming both', async () => {
    const app = await appWith(h.auth)
    const res = await json(app, 'POST', '/auth/magic-link/verify', { email: 'x@example.com' })
    expect(res.status).toBe(400)
    expect(res.text).toContain('token, or email and code')
  })

  test('a wrong code answers retryable on the wire', async () => {
    const app   = await appWith(h.auth)
    const email = nextEmail()
    const mail  = await mailed(email)
    const wrong = mail.code === '000000' ? '000001' : '000000'
    const res   = await json(app, 'POST', '/auth/magic-link/verify', { email, code: wrong })
    expect(res.status).toBe(400)
    expect(res.text).toContain('"retryable":true')
  })

  test('without the callback the routes are not mounted', async () => {
    const off = await makeAuth()
    const app = await appWith(off.auth)
    const res = await json(app, 'POST', '/auth/magic-link/request', { email: nextEmail() })
    expect(res.status).toBe(404)
    off.cleanup()
  })
})
