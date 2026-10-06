// AUDIT 1.1 (2026-10-05) — the token-lifecycle checks from the attack brief,
// run rather than read. Most of these are expected to PASS (the secure
// behavior holds, so the claim is refuted); any that FAIL are findings.
//
//   · a session token after logout
//   · every session after a password reset
//   · a reset token: single use, purpose-bound, lapses on the client clock
//   · a verify token: single use, purpose-bound
//   · a TOTP code replayed inside its own step; a recovery code reused
//   · token entropy and shape
//   · `confirmTotp` — is there any ceiling on code guesses?

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn, rejectsWith } from './harness.ts'
import { InvalidTokenError, InvalidSecondFactorError, ReauthenticationFailedError } from '../errors.ts'
import { generateToken, generateSessionToken, generateApiKey } from '../crypto.ts'
import { hotp, totpStep } from '../totp.ts'

let h: Harness
let now = new Date('2026-10-05T12:00:00.000Z')
const clock = { now: () => now }
beforeAll(async () => { h = await makeAuth({ totpDrift: 1 }, clock) })
afterAll(() => h.cleanup())

const fresh = async (name: string) => {
  const email = `${name}@example.test`
  const made  = await h.auth.createUser({ email, password: 'pw-1' })
  return { email, userId: made.userId, password: 'pw-1' }
}

describe('session tokens', () => {
  test('a token does not verify after logout', async () => {
    const u = await fresh('logout')
    const s = signedIn(await h.auth.login(u.email, u.password))
    expect(await h.auth.verifySession(s.token)).not.toBeNull()
    await h.auth.logout(s.token)
    expect(await h.auth.verifySession(s.token)).toBeNull()
  })

  test('a token does not verify after the session lapses on the client clock', async () => {
    const u = await fresh('lapse')
    const s = signedIn(await h.auth.login(u.email, u.password))
    const was = now
    now = new Date(was.getTime() + 31 * 24 * 3600 * 1000)
    try {
      expect(await h.auth.verifySession(s.token)).toBeNull()
    } finally { now = was }
  })

  test('every login mints a fresh token — nothing a caller supplies becomes the token', async () => {
    const u = await fresh('fixation')
    const a = signedIn(await h.auth.login(u.email, u.password))
    const b = signedIn(await h.auth.login(u.email, u.password))
    expect(a.token).not.toBe(b.token)
    expect(a.user.sessionId).not.toBe(b.user.sessionId)
  })
})

describe('reset tokens', () => {
  test('single use, and the second use burns nothing', async () => {
    const u = await fresh('reset-once')
    await h.auth.requestPasswordReset!(u.email)
    const t = h.resetToken()
    await h.auth.confirmPasswordReset!(t, 'pw-2')
    await rejectsWith(() => h.auth.confirmPasswordReset!(t, 'pw-3'), InvalidTokenError)
    signedIn(await h.auth.login(u.email, 'pw-2'))
  })

  test('a reset token is refused by verifyEmail and a verify token by confirmPasswordReset', async () => {
    const u = await fresh('reset-purpose')
    await h.auth.requestPasswordReset!(u.email)
    await h.auth.requestEmailVerification!(u.userId)
    await rejectsWith(() => h.auth.verifyEmail!(h.resetToken()), InvalidTokenError)
    await rejectsWith(() => h.auth.confirmPasswordReset!(h.verifyToken(), 'pw-x'), InvalidTokenError)
  })

  test('a reset token lapses after passwordResetTtl on the client clock', async () => {
    const u = await fresh('reset-lapse')
    await h.auth.requestPasswordReset!(u.email)
    const t = h.resetToken()
    const was = now
    now = new Date(was.getTime() + 61 * 60 * 1000)
    try {
      await rejectsWith(() => h.auth.confirmPasswordReset!(t, 'pw-2'), InvalidTokenError)
    } finally { now = was }
  })

  test('a second request supersedes the first token', async () => {
    const u = await fresh('reset-supersede')
    await h.auth.requestPasswordReset!(u.email)
    const first = h.resetToken()
    await h.auth.requestPasswordReset!(u.email)
    await rejectsWith(() => h.auth.confirmPasswordReset!(first, 'pw-2'), InvalidTokenError)
  })

  test('every session is revoked by a reset', async () => {
    const u = await fresh('reset-revokes')
    const a = signedIn(await h.auth.login(u.email, u.password))
    const b = signedIn(await h.auth.login(u.email, u.password))
    await h.auth.requestPasswordReset!(u.email)
    await h.auth.confirmPasswordReset!(h.resetToken(), 'pw-2')
    expect(await h.auth.verifySession(a.token)).toBeNull()
    expect(await h.auth.verifySession(b.token)).toBeNull()
  })
})

describe('verify tokens', () => {
  test('single use', async () => {
    const u = await fresh('verify-once')
    await h.auth.requestEmailVerification!(u.userId)
    const t = h.verifyToken()
    await h.auth.verifyEmail!(t)
    await rejectsWith(() => h.auth.verifyEmail!(t), InvalidTokenError)
  })

  test('a lapsed verify token is refused', async () => {
    const u = await fresh('verify-lapse')
    await h.auth.requestEmailVerification!(u.userId)
    const t = h.verifyToken()
    const was = now
    now = new Date(was.getTime() + 25 * 3600 * 1000)
    try {
      await rejectsWith(() => h.auth.verifyEmail!(t), InvalidTokenError)
    } finally { now = was }
  })
})

describe('token shape and entropy', () => {
  test('reset/verify/challenge tokens are 32 random bytes; session tokens are v4 uuids; api keys are prefixed 32 bytes', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const t = generateToken()
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
      seen.add(t)
      const s = generateSessionToken()
      expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      seen.add(s)
      const k = generateApiKey()
      expect(k).toMatch(/^fjs_[A-Za-z0-9_-]{43}$/)
      seen.add(k)
    }
    expect(seen.size).toBe(3000)
  })
})

describe('the second factor', () => {
  const enroll = async (name: string) => {
    const u = await fresh(name)
    const { secret } = await h.auth.setupTotp!(u.userId, u.password)
    // Confirm with the code for the CURRENT step; that step is then spent.
    const { recoveryCodes } = await h.auth.confirmTotp!(u.userId, hotp(secret, totpStep(now), 6))
    return { ...u, secret, recoveryCodes }
  }

  test('a TOTP code is not accepted twice, and the confirming code is already spent', async () => {
    const u = await enroll('totp-replay')
    const r1 = await h.auth.login(u.email, u.password)
    if (!('challenge' in r1)) throw new Error('expected a challenge')
    // The confirming code (step N) is spent — N+1 is the next valid one.
    const was = now
    now = new Date(was.getTime() + 30_000)
    try {
      const code = hotp(u.secret, totpStep(now), 6)
      signedIn(await h.auth.completeLogin!(r1.challenge, code))

      const r2 = await h.auth.login(u.email, u.password)
      if (!('challenge' in r2)) throw new Error('expected a challenge')
      const err = await rejectsWith(() => h.auth.completeLogin!(r2.challenge, code), InvalidSecondFactorError)
      expect(err.retryable).toBe(true)
    } finally { now = was }
  })

  test('a recovery code is spent by the login it completes', async () => {
    const u = await enroll('recovery-once')
    const code = u.recoveryCodes[0]
    const r1 = await h.auth.login(u.email, u.password)
    if (!('challenge' in r1)) throw new Error('expected a challenge')
    signedIn(await h.auth.completeLogin!(r1.challenge, code))
    const r2 = await h.auth.login(u.email, u.password)
    if (!('challenge' in r2)) throw new Error('expected a challenge')
    await rejectsWith(() => h.auth.completeLogin!(r2.challenge, code), InvalidSecondFactorError)
  })

  test('a challenge is spent after loginChallengeAttempts wrong codes', async () => {
    const u = await enroll('challenge-ceiling')
    const r = await h.auth.login(u.email, u.password)
    if (!('challenge' in r)) throw new Error('expected a challenge')
    let last: InvalidSecondFactorError | null = null
    for (let i = 0; i < 5; i++) {
      last = await rejectsWith(() => h.auth.completeLogin!(r.challenge, '000000'), InvalidSecondFactorError)
    }
    expect(last!.retryable).toBe(false)
    // And the right code no longer works on that ticket.
    const was = now
    now = new Date(was.getTime() + 30_000)
    try {
      await rejectsWith(() => h.auth.completeLogin!(r.challenge, hotp(u.secret, totpStep(now), 6)), InvalidSecondFactorError)
    } finally { now = was }
  })

  // EXPECTED TO FAIL: `confirmTotp` (auth.ts ~857) has no attempt ceiling and
  // the service puts no limiter in front of it (services.ts `confirmTotp` does
  // not call `reauthenticate`). A pending enrollment can be guessed through at
  // 6 digits × a 3-step drift window — ~333k guesses, unbounded.
  // FJS-1838: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('confirmTotp has a ceiling on wrong codes', async () => {
    const u = await fresh('confirm-ceiling')
    await h.auth.setupTotp!(u.userId, u.password)
    let refusedByCeiling = false
    for (let i = 0; i < 50; i++) {
      try {
        await h.auth.confirmTotp!(u.userId, String(i).padStart(6, '0'))
      } catch (err) {
        if (!(err instanceof ReauthenticationFailedError)) { refusedByCeiling = true; break }
      }
    }
    expect(refusedByCeiling).toBe(true)
  })
})
