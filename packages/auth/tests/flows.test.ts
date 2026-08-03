// tests/flows.test.ts
//
// The 13 IAuth methods, exercised on their FAILURE paths against a real
// Litestone database. Until 2026-08-02 this package had zero coverage here:
// all 7 tests covered schema fragments and accessor naming, while password
// reset, email verification, session verification and API keys — every
// security-critical path — were untested in a v1.0.0 package.
//
// These began as throwaway probes. Per ../../VERIFYING.md, a probe that found
// (or confirmed) something lives on as a test.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import {
  InvalidCredentialsError, EmailTakenError,
  InvalidTokenError, UserNotFoundError, AuthConfigError,
} from '../errors.ts'

let h: Harness
beforeAll(async () => { h = await makeAuth() })
afterAll(() => h.cleanup())

const email = (n: string) => `${n}@example.com`

async function freshUser(name: string, password = 'pw-correct-1') {
  const e = email(name)
  await h.auth.createUser({ email: e, password, name })
  return { email: e, password }
}

// ─── login ────────────────────────────────────────────────────────────────

describe('login', () => {
  test('succeeds with the right password and returns a session token', async () => {
    const u = await freshUser('login-ok')
    const { token, user } = await h.auth.login(u.email, u.password)

    expect(token).toBeTruthy()
    expect(user.email).toBe(u.email)
    expect(user.authMethod).toBe('session')
  })

  test('wrong password is InvalidCredentialsError — NOT a generic Error', async () => {
    // The type is what makes this a 401 instead of a 500 at the transport.
    const u = await freshUser('login-wrong')
    await rejectsWith(() => h.auth.login(u.email, 'not-the-password'), InvalidCredentialsError)
  })

  test('unknown email raises the SAME error as a wrong password', async () => {
    // Distinguishing the two would be a user-enumeration oracle.
    const err = await rejectsWith(() => h.auth.login(email('nobody'), 'x'), InvalidCredentialsError)
    const u   = await freshUser('login-same')
    const err2 = await rejectsWith(() => h.auth.login(u.email, 'wrong'), InvalidCredentialsError)
    expect(err.message).toBe(err2.message)
  })

  test('a user with no password credential cannot log in', async () => {
    await h.auth.createUser({ email: email('no-cred') })   // no password
    await rejectsWith(() => h.auth.login(email('no-cred'), 'anything'), InvalidCredentialsError)
  })
})

// ─── createUser ───────────────────────────────────────────────────────────

describe('createUser', () => {
  test('duplicate email is EmailTakenError', async () => {
    await freshUser('dupe')
    await rejectsWith(() => h.auth.createUser({ email: email('dupe'), password: 'x' }), EmailTakenError)
  })

  test('does not issue a session — authMethod is "created"', async () => {
    const ctx = await h.auth.createUser({ email: email('created'), password: 'pw-1' })
    expect(ctx.authMethod).toBe('created')
  })
})

// ─── verifySession ────────────────────────────────────────────────────────

describe('verifySession', () => {
  test('returns a context for a live token', async () => {
    const u = await freshUser('vs-live')
    const { token } = await h.auth.login(u.email, u.password)
    expect((await h.auth.verifySession(token))?.email).toBe(u.email)
  })

  test('returns null for garbage and for the empty string', async () => {
    expect(await h.auth.verifySession('not-a-token')).toBeNull()
    expect(await h.auth.verifySession('')).toBeNull()
  })

  test('returns null for an EXPIRED session', async () => {
    // crypto.ts writes expiresAt as an ISO string while the query compares
    // against a Date. If that comparison ever stops working, expired sessions
    // authenticate — this is the test that catches it.
    const u    = await freshUser('vs-expired')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    await h.sys.session.create({ data: {
      userId:    user.id,
      token:     'expired-token-fixture',
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    } })

    expect(await h.auth.verifySession('expired-token-fixture')).toBeNull()
  })

  test('returns null after logout', async () => {
    const u = await freshUser('vs-logout')
    const { token } = await h.auth.login(u.email, u.password)
    await h.auth.logout(token)
    expect(await h.auth.verifySession(token)).toBeNull()
  })
})

// ─── password reset ───────────────────────────────────────────────────────

describe('password reset', () => {
  test('request for an UNKNOWN email resolves silently — no enumeration', async () => {
    await expect(h.auth.requestPasswordReset!(email('ghost'))).resolves.toBeUndefined()
  })

  test('confirm sets the new password and retires the old one', async () => {
    const u = await freshUser('pr-happy')
    await h.auth.requestPasswordReset!(u.email)

    await h.auth.confirmPasswordReset!(h.resetToken(), 'pw-new-2')

    expect((await h.auth.login(u.email, 'pw-new-2')).token).toBeTruthy()
    await rejectsWith(() => h.auth.login(u.email, u.password), InvalidCredentialsError)
  })

  test('confirm INVALIDATES every pre-existing session', async () => {
    const u = await freshUser('pr-sessions')
    const live = await h.auth.login(u.email, u.password)
    expect(await h.auth.verifySession(live.token)).not.toBeNull()

    await h.auth.requestPasswordReset!(u.email)
    await h.auth.confirmPasswordReset!(h.resetToken(), 'pw-new-2')

    expect(await h.auth.verifySession(live.token)).toBeNull()
  })

  test('a reset token is single-use', async () => {
    const u = await freshUser('pr-reuse')
    await h.auth.requestPasswordReset!(u.email)
    const token = h.resetToken()

    await h.auth.confirmPasswordReset!(token, 'pw-new-2')
    await rejectsWith(() => h.auth.confirmPasswordReset!(token, 'pw-hijack-3'), InvalidTokenError)
  })

  test('an EXPIRED reset token is refused', async () => {
    const u = await freshUser('pr-expired')
    await h.auth.requestPasswordReset!(u.email)
    const token = h.resetToken()

    const row = await h.sys.verification.findFirst({ where: { identifier: `reset:${u.email}` } })
    await h.sys.verification.update({
      where: { id: row.id },
      data:  { expiresAt: new Date(Date.now() - 1_000).toISOString() },
    })

    await rejectsWith(() => h.auth.confirmPasswordReset!(token, 'pw-hijack-4'), InvalidTokenError)
  })

  test('garbage token is InvalidTokenError', async () => {
    await rejectsWith(() => h.auth.confirmPasswordReset!('garbage', 'pw-x'), InvalidTokenError)
  })
})

// ─── email verification ───────────────────────────────────────────────────

describe('email verification', () => {
  test('verifyEmail flips emailVerified and drops the verifiedAt objection', async () => {
    const u    = await freshUser('ev-happy')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })

    // Before: emailVerified false → verifiedAt null → grades VISITOR
    const before = await h.auth.verifySession((await h.auth.login(u.email, u.password)).token)
    expect(before!.verifiedAt).toBeNull()

    await h.auth.requestEmailVerification!(user.id)
    const ctx = await h.auth.verifyEmail!(h.verifyToken())

    // After: no verifiedAt key at all — "nothing holding this user back"
    expect('verifiedAt' in ctx).toBe(false)
    expect(ctx.authMethod).toBe('verified')
  })

  test('a verification token is single-use', async () => {
    const u    = await freshUser('ev-reuse')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    await h.auth.requestEmailVerification!(user.id)
    const token = h.verifyToken()

    await h.auth.verifyEmail!(token)
    await rejectsWith(() => h.auth.verifyEmail!(token), InvalidTokenError)
  })

  test('requestEmailVerification on an unknown user is UserNotFoundError', async () => {
    await rejectsWith(() => h.auth.requestEmailVerification!('no-such-id'), UserNotFoundError)
  })

  test('requesting for an already-verified user is a no-op', async () => {
    const u    = await freshUser('ev-noop')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    await h.auth.requestEmailVerification!(user.id)
    await h.auth.verifyEmail!(h.verifyToken())

    await expect(h.auth.requestEmailVerification!(user.id)).resolves.toBeUndefined()
  })
})

// ─── cross-protocol token confusion ───────────────────────────────────────

describe('tokens do not cross protocols', () => {
  // Both lookups match on `value` alone, so nothing structurally stops a
  // verification token being spent as a password reset. Today they fail
  // because the identifier prefix makes the follow-up email lookup miss.
  // These pin the BEHAVIOUR so a refactor of either lookup can't quietly
  // open the door.

  test('a password-reset token cannot verify an email', async () => {
    const u = await freshUser('x-reset')
    await h.auth.requestPasswordReset!(u.email)
    await rejectsWith(() => h.auth.verifyEmail!(h.resetToken()), UserNotFoundError)
  })

  test('an email-verification token cannot reset a password', async () => {
    const u    = await freshUser('x-verify')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    await h.auth.requestEmailVerification!(user.id)

    await rejectsWith(
      () => h.auth.confirmPasswordReset!(h.verifyToken(), 'pw-hijack-5'),
      UserNotFoundError,
    )
    // and the real password still works
    expect((await h.auth.login(u.email, u.password)).token).toBeTruthy()
  })
})

// ─── api keys ─────────────────────────────────────────────────────────────

describe('api keys', () => {
  test('a fresh key verifies and carries authMethod apiKey', async () => {
    const u    = await freshUser('ak-ok')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key } = await h.auth.createApiKey!(user.id, { name: 'ci' })

    const ctx = await h.auth.verifyApiKey!(key)
    expect(ctx!.userId).toBe(user.id)
    expect(ctx!.authMethod).toBe('apiKey')
  })

  test('the raw key is never stored — only its HMAC', async () => {
    const u    = await freshUser('ak-storage')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key } = await h.auth.createApiKey!(user.id)

    const creds = await h.sys.credential.findMany({ where: { userId: user.id, type: 'apiKey' } })
    expect(creds.length).toBe(1)
    expect(creds[0].value).not.toBe(key)
    expect(creds[0].value).not.toContain(key.replace('fjs_', ''))
  })

  test('garbage returns null', async () => {
    expect(await h.auth.verifyApiKey!('fjs_bogus')).toBeNull()
  })

  test('a revoked key stops verifying', async () => {
    const u    = await freshUser('ak-revoke')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key, id } = await h.auth.createApiKey!(user.id)

    await h.auth.revokeApiKey!(id)
    expect(await h.auth.verifyApiKey!(key)).toBeNull()
  })

  test('an EXPIRED key does not verify', async () => {
    const u    = await freshUser('ak-expired')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key } = await h.auth.createApiKey!(user.id, { expiresAt: new Date(Date.now() - 60_000) })

    expect(await h.auth.verifyApiKey!(key)).toBeNull()
  })

  test('api key operations without an encryptionKey raise AuthConfigError', async () => {
    // Config failure, not a user failure — this one is meant to stay a 500.
    const bare = await makeAuth({ encryptionKey: undefined })
    try {
      await rejectsWith(() => bare.auth.verifyApiKey!('fjs_x'), AuthConfigError)
    } finally {
      bare.cleanup()
    }
  })
})

// ─── deleteUser ───────────────────────────────────────────────────────────

describe('deleteUser', () => {
  test('removes the user and every credential, session and pending token', async () => {
    const u    = await freshUser('del')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    await h.auth.login(u.email, u.password)
    await h.auth.requestPasswordReset!(u.email)
    await h.auth.createApiKey!(user.id)

    await h.auth.deleteUser!(user.id)

    expect(await h.sys.user.findUnique({ where: { id: user.id } })).toBeNull()
    expect((await h.sys.session.findMany({ where: { userId: user.id } })).length).toBe(0)
    expect((await h.sys.credential.findMany({ where: { userId: user.id } })).length).toBe(0)
    expect((await h.sys.verification.findMany({ where: { identifier: `reset:${u.email}` } })).length).toBe(0)
  })
})

// ─── the Data boundary ────────────────────────────────────────────────────

describe('gate("8") walls the auth tables off from non-system callers', () => {
  // VERIFYING.md's headline failure is a gate that looks enforced and isn't.
  // asSystem() is this package's deliberate bypass; everything else must bounce.
  const models = ['user', 'credential', 'session', 'verification'] as const

  for (const m of models) {
    test(`anonymous db.${m}.findMany() is refused`, async () => {
      await expect(h.db[m].findMany()).rejects.toThrow(/SYSTEM access/)
    })
  }

  test('a logged-in normal user is still refused', async () => {
    const scoped = h.db.$setAuth({ id: 'someone', role: 'user' })
    await expect(scoped.user.findMany()).rejects.toThrow(/SYSTEM access/)
    await expect(scoped.credential.findMany()).rejects.toThrow(/SYSTEM access/)
  })
})
