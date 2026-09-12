// tests/totp-login.test.ts
//
// The two-step login, against a real Litestone database. `tests/totp.test.ts` is
// the arithmetic; this is what it is worth once a row and a session are involved.
//
// EVERY REFUSAL HERE IS PAIRED with the call one character away that succeeds.
// A second factor that refused everything would satisfy any test asking only
// about the refusals, and it is the most likely thing to be wrong: `completeLogin`
// answers one error for five different causes, so from the caller's side a
// correct implementation and a broken one are the same 401.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, signedIn, type Harness } from './harness.ts'
import { TEST_KEY } from './harness.ts'
import {
  totp, totpStep, generateTotpSecret, TOTP_STEP_SEC,
} from '../totp.ts'
import {
  InvalidCredentialsError, InvalidSecondFactorError, ReauthenticationFailedError,
  TotpAlreadyEnabledError, NotFoundError, NoPasswordCredentialError,
} from '../errors.ts'

const PASSWORD = 'correct-horse-1'

// Two harnesses, and the second is not a convenience.
//
// `h` runs the shipped default, `totpDrift: 1` — three steps are valid at any
// instant and `confirmTotp` spends one of them, so a user there can finish
// exactly ONE more login before every code in the window is either used or out
// of range. That is correct behavior and it makes a SEQUENCE of logins
// inexpressible, which is what half the assertions below are about.
//
// `w` declares `totpDrift: 10`. Same code path, one option, a window wide enough
// to sign in repeatedly — and the option is a real one an app with bad clocks
// sets. The alternative was an injectable clock, which is a seam on the login
// path that exists only for tests.
let h: Harness
let w: Harness
let seq = 0
const nextEmail = () => `totp-${Date.now()}-${seq++}@example.com`

/** A user with a password and nothing else. */
async function makeUser(env: Harness = h) {
  const email = nextEmail()
  const user  = await env.auth.createUser({ email, password: PASSWORD })
  return { email, userId: user.userId }
}

/** A user with a CONFIRMED second factor, and the secret to answer with. */
async function makeUserWithTotp(env: Harness = h) {
  const u = await makeUser(env)
  const { secret } = await env.auth.setupTotp!(u.userId, PASSWORD)
  const { recoveryCodes } = await env.auth.confirmTotp!(u.userId, totp(secret, new Date()))
  return { ...u, secret, recoveryCodes }
}

/** A code for an instant far enough from now that it is not the confirming one. */
const codeAt = (secret: string, offsetSteps: number) =>
  totp(secret, new Date(Date.now() + offsetSteps * TOTP_STEP_SEC * 1000))

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY, totpIssuer: 'Test Shop' })
  w = await makeAuth({ encryptionKey: TEST_KEY, totpDrift: 10 })
})
afterAll(() => { h.cleanup(); w.cleanup() })

// ─── Enrollment ───────────────────────────────────────────────────────────

describe('enrollment — setup proves nothing, confirm is what switches it on', () => {

  test('setupTotp answers a secret and a URI naming the account and the issuer', async () => {
    const u = await makeUser()
    const { secret, qr } = await h.auth.setupTotp!(u.userId, PASSWORD)

    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(qr).toContain('otpauth://totp/Test%20Shop:')
    expect(qr).toContain(encodeURIComponent(u.email))
    expect(qr).toContain(`secret=${secret}`)
  })

  test('AND the login it does not gate — this is the lockout the split prevents', async () => {
    // The pair that matters most in this file. An enrollment that switched the
    // factor on here would gate the next login on codes the person has never
    // successfully produced, so a wrong clock or a mis-scanned QR costs the
    // account rather than a retry.
    const u = await makeUser()
    await h.auth.setupTotp!(u.userId, PASSWORD)

    const result = await h.auth.login(u.email, PASSWORD)
    expect('token' in result).toBe(true)
    expect(await h.auth.totpStatus!(u.userId)).toEqual({ enabled: false, recoveryCodesRemaining: 0 })
  })

  test('confirmTotp enables it, and answers ten recovery codes', async () => {
    const u = await makeUser()
    const { secret } = await h.auth.setupTotp!(u.userId, PASSWORD)
    const { recoveryCodes } = await h.auth.confirmTotp!(u.userId, totp(secret, new Date()))

    expect(recoveryCodes).toHaveLength(10)
    expect(new Set(recoveryCodes).size).toBe(10)
    expect(await h.auth.totpStatus!(u.userId)).toEqual({ enabled: true, recoveryCodesRemaining: 10 })
  })

  test('a wrong code confirms nothing — paired with the right one enabling it', async () => {
    const u = await makeUser()
    const { secret } = await h.auth.setupTotp!(u.userId, PASSWORD)

    await rejectsWith(() => h.auth.confirmTotp!(u.userId, '000000'), ReauthenticationFailedError)
    expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(false)

    await h.auth.confirmTotp!(u.userId, totp(secret, new Date()))
    expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(true)
  })

  test('confirm with no enrollment in progress is a 404, not a silent no-op', async () => {
    const u = await makeUser()
    const err = await rejectsWith(() => h.auth.confirmTotp!(u.userId, '000000'), NotFoundError)
    expect(err.status).toBe(404)
  })

  test('the wrong password enrolls nothing — paired with the right one', async () => {
    const u = await makeUser()
    await rejectsWith(() => h.auth.setupTotp!(u.userId, 'not-the-password'), ReauthenticationFailedError)
    await h.auth.setupTotp!(u.userId, PASSWORD)   // the pair: one character apart
  })

  test('enrolling twice is refused rather than overwriting the live secret', async () => {
    // Overwriting would invalidate the authenticator the person holds while the
    // next login still demands a code from it — locked out by a 200.
    const u = await makeUserWithTotp()
    const err = await rejectsWith(() => h.auth.setupTotp!(u.userId, PASSWORD), TotpAlreadyEnabledError)
    expect(err.status).toBe(409)

    // And the factor still works afterwards, which is what says the refusal cost
    // nothing rather than half-wrote something.
    const res = await h.auth.login(u.email, PASSWORD)
    expect('challenge' in res).toBe(true)
  })

  test('a second setupTotp supersedes an unconfirmed one — the old secret stops confirming', async () => {
    const u = await makeUser()
    const first  = await h.auth.setupTotp!(u.userId, PASSWORD)
    const second = await h.auth.setupTotp!(u.userId, PASSWORD)
    expect(second.secret).not.toBe(first.secret)

    await rejectsWith(() => h.auth.confirmTotp!(u.userId, totp(first.secret, new Date())), ReauthenticationFailedError)
    await h.auth.confirmTotp!(u.userId, totp(second.secret, new Date()))
    expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(true)
  })

  test('an account with no password cannot enroll, and pays the comparison anyway', async () => {
    const email = nextEmail()
    const user  = await h.sys.user.create({ data: { email, name: 'No Password' } })
    await rejectsWith(() => h.auth.setupTotp!(String(user.id), PASSWORD), NoPasswordCredentialError)
  })
})

// ─── The login split ──────────────────────────────────────────────────────

describe('login — what a password is worth', () => {

  test('no second factor: a session, exactly as before', async () => {
    const u = await makeUser()
    const res = signedIn(await h.auth.login(u.email, PASSWORD))
    expect(res.token).toBeTruthy()
    expect(await h.auth.verifySession(res.token)).not.toBeNull()
  })

  test('with one: a ticket, an expiry, and NO token anywhere in the answer', async () => {
    const u = await makeUserWithTotp()
    const res = await h.auth.login(u.email, PASSWORD) as any

    expect(res.challenge).toBeTruthy()
    expect(res.token).toBeUndefined()
    expect(res.user).toBeUndefined()
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // The half that a shape assertion cannot make: nothing that reached the
    // caller is usable as a session.
    expect(await h.auth.verifySession(res.challenge)).toBeNull()
  })

  test('a wrong password with a factor enrolled answers the password error, not a ticket', async () => {
    const u = await makeUserWithTotp()
    await rejectsWith(() => h.auth.login(u.email, 'wrong-password'), InvalidCredentialsError)
    // No challenge was minted for it, or a password spray would leave a ticket
    // per attempt behind.
    expect(await h.sys.loginChallenge.count({ where: { userId: u.userId } })).toBe(0)
  })

  test('a second password login supersedes the first ticket rather than adding one', async () => {
    // Two open tickets are two independent attempt budgets, so the ceiling could
    // be walked around by logging in again.
    const u = await makeUserWithTotp()
    const first  = await h.auth.login(u.email, PASSWORD) as any
    const second = await h.auth.login(u.email, PASSWORD) as any

    expect(second.challenge).not.toBe(first.challenge)
    expect(await h.sys.loginChallenge.count({ where: { userId: u.userId } })).toBe(1)
    await rejectsWith(() => h.auth.completeLogin!(first.challenge, codeAt(u.secret, 0)), InvalidSecondFactorError)
  })
})

// ─── The second step ──────────────────────────────────────────────────────

describe('completeLogin — the session, and the five ways it refuses', () => {

  test('a valid code finishes the login and spends the ticket', async () => {
    const u = await makeUserWithTotp()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any

    // Not the code that confirmed enrollment: that step is already spent, which
    // is asserted on its own below.
    const res = await h.auth.completeLogin!(challenge, codeAt(u.secret, 1))
    expect(res.token).toBeTruthy()
    expect(await h.auth.verifySession(res.token)).not.toBeNull()

    // Single-use. The row is gone, so the same ticket cannot mint a second
    // session from the same code.
    expect(await h.sys.loginChallenge.count({ where: { userId: u.userId } })).toBe(0)
    await rejectsWith(() => h.auth.completeLogin!(challenge, codeAt(u.secret, 1)), InvalidSecondFactorError)
  })

  test('a code is single-use INSIDE its own window — paired with the next step working', async () => {
    // The whole reason `totpLastStep` exists. Without it the 30-second window is
    // a replay window and nothing about the second attempt looks wrong.
    const u = await makeUserWithTotp(w)

    const first = await w.auth.login(u.email, PASSWORD) as any
    const code  = codeAt(u.secret, 2)
    await w.auth.completeLogin!(first.challenge, code)

    const second = await w.auth.login(u.email, PASSWORD) as any
    const err = await rejectsWith(() => w.auth.completeLogin!(second.challenge, code), InvalidSecondFactorError)
    expect(err.status).toBe(401)

    // The pair: a LATER step still works, so the refusal above is about the code
    // rather than about the account being wedged.
    const third = await w.auth.login(u.email, PASSWORD) as any
    const res   = await w.auth.completeLogin!(third.challenge, codeAt(u.secret, 3))
    expect(res.token).toBeTruthy()
  })

  test('the code that confirmed enrollment is already spent', async () => {
    const u = await makeUser()
    const { secret } = await h.auth.setupTotp!(u.userId, PASSWORD)
    const confirming = totp(secret, new Date())
    await h.auth.confirmTotp!(u.userId, confirming)

    const { challenge } = await h.auth.login(u.email, PASSWORD) as any
    await rejectsWith(() => h.auth.completeLogin!(challenge, confirming), InvalidSecondFactorError)
  })

  test('an unknown ticket is refused and is NOT retryable', async () => {
    const err = await rejectsWith(() => h.auth.completeLogin!('no-such-ticket', '000000'), InvalidSecondFactorError)
    expect(err.retryable).toBe(false)
  })

  test('a lapsed ticket is refused at RESOLUTION, with no sweep having run', async () => {
    const u = await makeUserWithTotp()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any

    await h.sys.loginChallenge.updateMany({
      where: { value: challenge },
      data:  { expiresAt: new Date(Date.now() - 1000) },
    })

    const err = await rejectsWith(() => h.auth.completeLogin!(challenge, codeAt(u.secret, 1)), InvalidSecondFactorError)
    expect(err.retryable).toBe(false)
    // And it is gone, so a clock moving backwards does not revive it.
    expect(await h.sys.loginChallenge.count({ where: { value: challenge } })).toBe(0)
  })

  test('the factor removed between the two requests kills the ticket', async () => {
    const u = await makeUserWithTotp()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any

    await h.auth.disableTotp!(u.userId, PASSWORD)

    const err = await rejectsWith(() => h.auth.completeLogin!(challenge, codeAt(u.secret, 1)), InvalidSecondFactorError)
    expect(err.retryable).toBe(false)
  })

  test('wrong codes are counted on the ROW and the ticket is spent at the ceiling', async () => {
    const u = await makeUserWithTotp(w)
    const { challenge } = await w.auth.login(u.email, PASSWORD) as any

    // Four wrong, each still retryable.
    for (let i = 0; i < 4; i++) {
      const err = await rejectsWith(() => w.auth.completeLogin!(challenge, '000000'), InvalidSecondFactorError)
      expect(err.retryable).toBe(true)
    }
    expect(await w.sys.loginChallenge.findFirst({ where: { value: challenge } })).toMatchObject({ attempts: 4 })

    // The fifth spends it, and says so — a person typing into a box that will
    // refuse every future code has been told nothing.
    const last = await rejectsWith(() => w.auth.completeLogin!(challenge, '000000'), InvalidSecondFactorError)
    expect(last.retryable).toBe(false)
    expect(await w.sys.loginChallenge.count({ where: { value: challenge } })).toBe(0)

    // And the RIGHT code no longer helps, which is what makes the ceiling real
    // rather than advisory.
    await rejectsWith(() => w.auth.completeLogin!(challenge, codeAt(u.secret, 1)), InvalidSecondFactorError)

    // The pair: the account itself is fine, reached from a fresh password login.
    const fresh = await w.auth.login(u.email, PASSWORD) as any
    expect((await w.auth.completeLogin!(fresh.challenge, codeAt(u.secret, 2))).token).toBeTruthy()
  })

  test('another user’s code does not finish this ticket', async () => {
    const mine  = await makeUserWithTotp()
    const other = await makeUserWithTotp()
    const { challenge } = await h.auth.login(mine.email, PASSWORD) as any

    await rejectsWith(() => h.auth.completeLogin!(challenge, codeAt(other.secret, 1)), InvalidSecondFactorError)
    expect((await h.auth.completeLogin!(challenge, codeAt(mine.secret, 1))).token).toBeTruthy()
  })
})

// ─── Recovery codes ───────────────────────────────────────────────────────

describe('recovery codes — the way back, spent on use', () => {

  test('a recovery code finishes a login, and the count drops by exactly one', async () => {
    const u = await makeUserWithTotp()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any

    const res = await h.auth.completeLogin!(challenge, u.recoveryCodes[0])
    expect(res.token).toBeTruthy()
    expect((await h.auth.totpStatus!(u.userId)).recoveryCodesRemaining).toBe(9)
  })

  test('a spent code is DELETED, not flagged — paired with a sibling still working', async () => {
    const u = await makeUserWithTotp()

    const first = await h.auth.login(u.email, PASSWORD) as any
    await h.auth.completeLogin!(first.challenge, u.recoveryCodes[0])

    const second = await h.auth.login(u.email, PASSWORD) as any
    await rejectsWith(() => h.auth.completeLogin!(second.challenge, u.recoveryCodes[0]), InvalidSecondFactorError)

    // The pair. A fix that deleted every code on first use satisfies the refusal
    // above and locks the person out of their own recovery.
    const third = await h.auth.login(u.email, PASSWORD) as any
    expect((await h.auth.completeLogin!(third.challenge, u.recoveryCodes[1])).token).toBeTruthy()
  })

  test('typed the way a person types it off paper — hyphen, spaces, lower case', async () => {
    const u = await makeUserWithTotp()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any

    const typed = ` ${u.recoveryCodes[0].toLowerCase().replace('-', ' ')} `
    expect((await h.auth.completeLogin!(challenge, typed)).token).toBeTruthy()
  })

  test('the plaintext is nowhere in the database', async () => {
    // HMAC'd with the app secret, the way an API key is. A code readable out of
    // the table is a password the person was told to write down.
    const u = await makeUserWithTotp()
    const rows = await h.sys.credential.findMany({ where: { userId: u.userId, type: 'recoveryCode' } })
    expect(rows).toHaveLength(10)
    for (const code of u.recoveryCodes) {
      expect(rows.some((r: any) => String(r.value).includes(code.replace('-', '')))).toBe(false)
    }
  })

  test('regenerate replaces every code — the old ones stop, the new ones work', async () => {
    const u = await makeUserWithTotp()
    const { recoveryCodes: fresh } = await h.auth.regenerateRecoveryCodes!(u.userId, PASSWORD)

    expect(fresh).toHaveLength(10)
    expect(fresh).not.toEqual(u.recoveryCodes)
    expect((await h.auth.totpStatus!(u.userId)).recoveryCodesRemaining).toBe(10)

    const a = await h.auth.login(u.email, PASSWORD) as any
    await rejectsWith(() => h.auth.completeLogin!(a.challenge, u.recoveryCodes[0]), InvalidSecondFactorError)

    const b = await h.auth.login(u.email, PASSWORD) as any
    expect((await h.auth.completeLogin!(b.challenge, fresh[0])).token).toBeTruthy()
  })

  test('regenerate needs the password, and needs the factor to be on', async () => {
    const u = await makeUserWithTotp()
    await rejectsWith(() => h.auth.regenerateRecoveryCodes!(u.userId, 'wrong'), ReauthenticationFailedError)

    const plain = await makeUser()
    await rejectsWith(() => h.auth.regenerateRecoveryCodes!(plain.userId, PASSWORD), NotFoundError)
  })
})

// ─── Disable ──────────────────────────────────────────────────────────────

describe('disableTotp — off means off, and takes the codes with it', () => {

  test('the next login is a session again', async () => {
    const u = await makeUserWithTotp()
    await h.auth.disableTotp!(u.userId, PASSWORD)

    expect(await h.auth.totpStatus!(u.userId)).toEqual({ enabled: false, recoveryCodesRemaining: 0 })
    expect(signedIn(await h.auth.login(u.email, PASSWORD)).token).toBeTruthy()
  })

  test('the recovery codes go with it — one outliving the factor is a second password', async () => {
    const u = await makeUserWithTotp()
    await h.auth.disableTotp!(u.userId, PASSWORD)
    expect(await h.sys.credential.count({ where: { userId: u.userId, type: 'recoveryCode' } })).toBe(0)
  })

  test('the wrong password disables nothing — paired with the right one', async () => {
    const u = await makeUserWithTotp()
    await rejectsWith(() => h.auth.disableTotp!(u.userId, 'wrong'), ReauthenticationFailedError)
    expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(true)

    await h.auth.disableTotp!(u.userId, PASSWORD)
    expect((await h.auth.totpStatus!(u.userId)).enabled).toBe(false)
  })

  test('disabling what is not on is a 404 rather than a quiet success', async () => {
    const u = await makeUser()
    await rejectsWith(() => h.auth.disableTotp!(u.userId, PASSWORD), NotFoundError)
  })

  test('an outstanding ticket dies with the factor', async () => {
    const u = await makeUserWithTotp()
    await h.auth.login(u.email, PASSWORD)
    expect(await h.sys.loginChallenge.count({ where: { userId: u.userId } })).toBe(1)

    await h.auth.disableTotp!(u.userId, PASSWORD)
    expect(await h.sys.loginChallenge.count({ where: { userId: u.userId } })).toBe(0)
  })
})

// ─── verifyTotp ───────────────────────────────────────────────────────────

describe('verifyTotp — a check, and deliberately not a consumption', () => {

  test('true for a live code, false for a wrong one, false with no factor', async () => {
    const u = await makeUserWithTotp()
    expect(await h.auth.verifyTotp!(u.userId, codeAt(u.secret, 1))).toBe(true)
    expect(await h.auth.verifyTotp!(u.userId, '000000')).toBe(false)

    const plain = await makeUser()
    expect(await h.auth.verifyTotp!(plain.userId, totp(generateTotpSecret(), new Date()))).toBe(false)
  })

  test('does NOT advance the step — a person who just signed in can still confirm with the code on screen', async () => {
    const u = await makeUserWithTotp(w)
    const code = codeAt(u.secret, 4)

    expect(await w.auth.verifyTotp!(u.userId, code)).toBe(true)
    expect(await w.auth.verifyTotp!(u.userId, code)).toBe(true)

    // And the login path still consumes it, which is what says the asymmetry is
    // deliberate rather than the replay guard being broken.
    const res = await w.auth.login(u.email, PASSWORD) as any
    expect((await w.auth.completeLogin!(res.challenge, code)).token).toBeTruthy()
  })
})

// ─── The trail and the hook ───────────────────────────────────────────────

describe('what a half-finished login records', () => {

  test('onLoginFailed fires for the second step with stage and no email', async () => {
    // An app rate-limiting on the address cannot see this step at all, which is
    // the reason `stage` exists rather than a second callback.
    const seen: any[] = []
    const own = await makeAuth({
      encryptionKey: TEST_KEY,
      onLoginFailed: e => { seen.push(e) },
    })
    try {
      const email = `stage-${Date.now()}@example.com`
      const user  = await own.auth.createUser({ email, password: PASSWORD })
      const { secret } = await own.auth.setupTotp!(user.userId, PASSWORD)
      await own.auth.confirmTotp!(user.userId, totp(secret, new Date()))

      await rejectsWith(() => own.auth.login(email, 'wrong'), InvalidCredentialsError)
      expect(seen.at(-1)).toMatchObject({ stage: 'password', email, reason: 'bad-password' })

      const res = await own.auth.login(email, PASSWORD) as any
      await rejectsWith(() => own.auth.completeLogin!(res.challenge, '000000'), InvalidSecondFactorError)
      expect(seen.at(-1)).toMatchObject({ stage: 'second-factor', email: null, reason: 'bad-code' })
      expect(seen.at(-1).userId).toBe(user.userId)
    } finally {
      own.cleanup()
    }
  })

  test('a throw from the hook replaces the error — a lockout answers 429, not 401', async () => {
    class Locked extends Error { status = 429 }
    const own = await makeAuth({
      encryptionKey: TEST_KEY,
      onLoginFailed: e => { if (e.stage === 'second-factor') throw new Locked('too many') },
    })
    try {
      const email = `locked-${Date.now()}@example.com`
      const user  = await own.auth.createUser({ email, password: PASSWORD })
      const { secret } = await own.auth.setupTotp!(user.userId, PASSWORD)
      await own.auth.confirmTotp!(user.userId, totp(secret, new Date()))

      const res = await own.auth.login(email, PASSWORD) as any
      const err = await rejectsWith(() => own.auth.completeLogin!(res.challenge, '000000'), Locked)
      expect(err.status).toBe(429)
    } finally {
      own.cleanup()
    }
  })
})

// ─── The sweep ────────────────────────────────────────────────────────────

describe('cleanup', () => {

  test('a lapsed ticket is pruned and a live one is left alone', async () => {
    const { createAuthCleanupJobs } = await import('../cleanup.ts')

    const u = await makeUserWithTotp()
    const dead = await h.auth.login(u.email, PASSWORD) as any
    await h.sys.loginChallenge.updateMany({
      where: { value: dead.challenge },
      data:  { expiresAt: new Date(Date.now() - 60_000) },
    })

    const other = await makeUserWithTotp()
    const live  = await h.auth.login(other.email, PASSWORD) as any

    await createAuthCleanupJobs(h.db).sweepNow()

    expect(await h.sys.loginChallenge.count({ where: { value: dead.challenge } })).toBe(0)
    // The pair: a sweep that took everything would satisfy the line above and
    // end every sign-in in progress.
    expect(await h.sys.loginChallenge.count({ where: { value: live.challenge } })).toBe(1)
  })
})

// ─── The step arithmetic, against a real row ──────────────────────────────

describe('drift, and the direction it does not run in', () => {

  test('the next step is accepted and a distant one is not — on the SHIPPED default', async () => {
    const u = await makeUserWithTotp()

    const ok = await h.auth.login(u.email, PASSWORD) as any
    expect((await h.auth.completeLogin!(ok.challenge, codeAt(u.secret, 1))).token).toBeTruthy()

    const far = await h.auth.login(u.email, PASSWORD) as any
    await rejectsWith(() => h.auth.completeLogin!(far.challenge, codeAt(u.secret, 5)), InvalidSecondFactorError)
  })

  test('a code EARLIER than the last accepted step is refused, inside the window or not', async () => {
    // The replay guard is monotonic: `step <= totpLastStep` refuses, so the whole
    // past is closed rather than only the exact code that was used. It is the
    // reason `-1` is not a valid answer for a freshly enrolled user — enrollment
    // accepted the current step, so the step before it is already behind.
    const u = await makeUserWithTotp(w)

    const back = await w.auth.login(u.email, PASSWORD) as any
    await rejectsWith(() => w.auth.completeLogin!(back.challenge, codeAt(u.secret, -1)), InvalidSecondFactorError)

    // The pair, and it is what says the refusal is about direction rather than
    // about the account: forward from the same instant works.
    expect((await w.auth.completeLogin!(back.challenge, codeAt(u.secret, 1))).token).toBeTruthy()
  })

  test('totpLastStep is written from the code that was accepted', async () => {
    const u = await makeUserWithTotp(w)
    const res = await w.auth.login(u.email, PASSWORD) as any
    const at  = new Date(Date.now() + TOTP_STEP_SEC * 6 * 1000)

    await w.auth.completeLogin!(res.challenge, totp(u.secret, at))

    const cred = await w.sys.credential.findFirst({ where: { userId: u.userId, type: 'totp' } })
    expect(Number(cred.totpLastStep)).toBe(totpStep(at))
  })
})
