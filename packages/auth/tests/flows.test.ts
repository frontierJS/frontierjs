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

  test('ISSUING a key without an encryptionKey raises AuthConfigError', async () => {
    // Config failure, not a user failure — this one is meant to stay a 500.
    // It is the ISSUE path deliberately: that is where a developer is, and
    // where being told loudly is worth a 500.
    const bare = await makeAuth({ encryptionKey: undefined })
    try {
      await rejectsWith(() => bare.auth.createApiKey!('someone'), AuthConfigError)
    } finally {
      bare.cleanup()
    }
  })

  test('VERIFYING without an encryptionKey answers null, it does not throw', async () => {
    // Verification runs on attacker-supplied input on every request, so a
    // missing config must not be a 500 anyone can trigger by sending a
    // Bearer token. verifySession also falls through to here for any token
    // that missed, so an app with no API keys at all would have paid a throw
    // for every expired session.
    const bare = await makeAuth({ encryptionKey: undefined })
    try {
      expect(await bare.auth.verifyApiKey!('fjs_x')).toBeNull()
      expect(await bare.auth.verifySession('fjs_x')).toBeNull()
      expect(await bare.auth.verifySession('not-a-real-session')).toBeNull()
    } finally {
      bare.cleanup()
    }
  })

  // ─── the transport only ever calls verifySession ────────────────────────
  // http.ts resolves every Bearer token through auth.verifySession() and calls
  // verifyApiKey nowhere. Until this landed, createApiKey() succeeded and the
  // key it returned authenticated nothing: a key that could be issued and
  // never used.

  test('an API key authenticates through verifySession', async () => {
    const u    = await freshUser('ak-session')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key } = await h.auth.createApiKey!(user.id, { name: 'ci' })

    const ctx = await h.auth.verifySession(key)
    expect(ctx).not.toBeNull()
    expect(ctx!.userId).toBe(user.id)
    expect(ctx!.authMethod).toBe('apiKey')
  })

  test('a revoked key stops authenticating through verifySession too', async () => {
    const u    = await freshUser('ak-session-revoke')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key, id } = await h.auth.createApiKey!(user.id)

    await h.auth.revokeApiKey!(id)
    expect(await h.auth.verifySession(key)).toBeNull()
  })

  test('a session token still authenticates, and is not an api key', async () => {
    const u = await freshUser('ak-not-session')
    const { token } = await h.auth.login(u.email, u.password)

    const ctx = await h.auth.verifySession(token)
    expect(ctx!.authMethod).toBe('session')
    expect(ctx!.credentialId).toBeUndefined()
    expect(await h.auth.verifyApiKey!(token)).toBeNull()
  })

  // ─── what the key carries ───────────────────────────────────────────────

  test('the scopes a key was issued with reach the session', async () => {
    const u    = await freshUser('ak-scopes')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key } = await h.auth.createApiKey!(user.id, {
      scopes: ['servers:read', 'projects:read'],
    })

    // createApiKey stores them space-joined and verifyApiKey used to drop them,
    // so a key issued read-only authenticated with its owner's full standing
    // and nothing downstream could tell.
    const ctx = await h.auth.verifySession(key)
    expect(ctx!.scopes).toEqual(['servers:read', 'projects:read'])
  })

  test('a key issued with no scopes carries none, rather than an empty list', async () => {
    const u    = await freshUser('ak-noscopes')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const { key } = await h.auth.createApiKey!(user.id)

    expect((await h.auth.verifySession(key))!.scopes).toBeUndefined()
  })

  test('the session names WHICH key proved it', async () => {
    const u    = await freshUser('ak-which')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const a = await h.auth.createApiKey!(user.id, { name: 'one' })
    const b = await h.auth.createApiKey!(user.id, { name: 'two' })

    // Two keys on one user produce sessions that are otherwise identical, so
    // per-key usage and per-key revocation have nothing else to key on.
    const ctxA = await h.auth.verifySession(a.key)
    const ctxB = await h.auth.verifySession(b.key)
    expect(ctxA!.credentialId).toBe(String(a.id))
    expect(ctxB!.credentialId).toBe(String(b.id))
    expect(ctxA!.credentialId).not.toBe(ctxB!.credentialId)
  })

  // ─── revoke ─────────────────────────────────────────────────────────────

  test('revoking an id that is not a key is refused, not silently accepted', async () => {
    // revokeApiKey did Number(keyId) because this package's own schema
    // fragment declares Credential.id as Int — but the fragments are a
    // starting point apps edit, and an app with uuid ids got
    // Number(uuid) === NaN: a delete matching nothing, throwing nothing.
    // Revoke reported success and the key kept working.
    await expect(h.auth.revokeApiKey!('9999999')).rejects.toThrow(/No API key/)
  })

  test('revoke cannot delete a password credential by id', async () => {
    const u    = await freshUser('ak-wrongid')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    const pw   = await h.sys.credential.findFirst({ where: { userId: user.id, type: 'password' } })

    await expect(h.auth.revokeApiKey!(String(pw.id))).rejects.toThrow(/No API key/)
    expect(await h.sys.credential.findUnique({ where: { id: pw.id } })).not.toBeNull()
    // and the password still works
    expect((await h.auth.login(u.email, u.password)).token).toBeTruthy()
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

describe('the gate walls the credential tables off, and User is readable by a user', () => {
  // VERIFYING.md's headline failure is a gate that looks enforced and isn't.
  // asSystem() is this package's deliberate bypass; everything else is graded.
  //
  // The three credential-material models are @@gate("8") — above every level a
  // request can reach. User is "4.5.5.6": an app's own screens legitimately list
  // its people, so read is USER, while writing identity stays privileged.
  // Registration is unaffected because every write this package makes is
  // asSystem(), which is above the ladder — the test below proves that rather
  // than assuming it.
  const walled = ['credential', 'session', 'verification'] as const

  for (const m of walled) {
    test(`anonymous db.${m}.findMany() is refused`, async () => {
      await expect(h.db[m].findMany()).rejects.toThrow(/SYSTEM access/)
    })
  }

  test('a logged-in normal user is still refused the credential tables', async () => {
    const scoped = h.db.$setAuth({ id: 'someone', role: 'user' })
    await expect(scoped.credential.findMany()).rejects.toThrow(/SYSTEM access/)
    await expect(scoped.session.findMany()).rejects.toThrow(/SYSTEM access/)
  })

  test('anonymous db.user.findMany() is refused — read is USER, not STRANGER', async () => {
    await expect(h.db.user.findMany()).rejects.toThrow(/requires level 4/)
  })

  test('a logged-in normal user CAN read User', async () => {
    const scoped = h.db.$setAuth({ id: 'someone', role: 'user' })
    expect(Array.isArray(await scoped.user.findMany())).toBe(true)
  })

  test('a logged-in normal user cannot DELETE a user', async () => {
    const scoped = h.db.$setAuth({ id: 'someone', role: 'user' })
    const victim = await h.sys.user.create({ data: { email: `victim-${Date.now()}@example.com` } })
    await expect(scoped.user.delete({ where: { id: victim.id } }))
      .rejects.toThrow(/requires level 5/)
  })

  test('an ADMINISTRATOR can delete a user', async () => {
    // No GatePlugin is configured here, so litestone's own default resolver
    // grades the principal — it reads standing (isAdmin/isOwner/isSystemAdmin),
    // not an app's `role` string, which is a column auth does not interpret.
    const scoped = h.db.$setAuth({ id: 'boss', isAdmin: true })
    const victim = await h.sys.user.create({ data: { email: `deleted-${Date.now()}@example.com` } })
    await scoped.user.delete({ where: { id: victim.id } })
    expect(await h.sys.user.findUnique({ where: { id: victim.id } })).toBeNull()
  })

  // The gate is a floor on the MODEL, not an ownership rule on the row — so
  // update at USER would mean any signed-in caller writes any user row. The
  // policy is what makes it their own, and these four tests are the reason it
  // is declared here rather than left to each app: the fragment ships the level
  // AND what bounds it. A policy FILTERS, so the refused write matches no row
  // and answers rather than throwing — every assertion reads the row back.
  test('a user may not write ANOTHER user\'s row', async () => {
    const other  = await h.sys.user.create({ data: { email: `other-${Date.now()}@example.com`, name: 'Other' } })
    const scoped = h.db.$setAuth({ id: 'someone-else', role: 'user' })
    await scoped.user.update({ where: { id: other.id }, data: { name: 'written by a stranger' } })
    expect((await h.sys.user.findUnique({ where: { id: other.id } }))!.name).toBe('Other')
  })

  test('…and may write their own', async () => {
    const me     = await h.sys.user.create({ data: { email: `me-${Date.now()}@example.com`, name: 'Me' } })
    const scoped = h.db.$setAuth({ id: me.id, role: 'user' })
    await scoped.user.update({ where: { id: me.id }, data: { name: 'renamed' } })
    expect((await h.sys.user.findUnique({ where: { id: me.id } }))!.name).toBe('renamed')
  })

  test('a user cannot promote themselves — `role` and `emailVerified` are dropped', async () => {
    const me     = await h.sys.user.create({ data: { email: `climb-${Date.now()}@example.com`, name: 'Me' } })
    const scoped = h.db.$setAuth({ id: me.id, role: 'user' })
    await scoped.user.update({ where: { id: me.id }, data: {
      role: 'admin', emailVerified: true, name: 'still lands',
    } })
    const after = await h.sys.user.findUnique({ where: { id: me.id } })
    // A field write policy drops the field and keeps the rest of the write,
    // which is why the name assertion is here: it proves the update ran.
    expect(after!.role).toBe('user')
    expect(after!.emailVerified).toBe(false)
    expect(after!.name).toBe('still lands')
  })

  test('an ADMINISTRATOR writes another user\'s row, and their role', async () => {
    const target = await h.sys.user.create({ data: { email: `target-${Date.now()}@example.com`, name: 'Target' } })
    const scoped = h.db.$setAuth({ id: 'boss', isAdmin: true })
    await scoped.user.update({ where: { id: target.id }, data: { name: 'by admin', role: 'editor' } })
    const after = await h.sys.user.findUnique({ where: { id: target.id } })
    expect(after!.name).toBe('by admin')
    expect(after!.role).toBe('editor')
  })

  test('registration is unaffected by the ladder — it writes asSystem()', async () => {
    const ctx = await h.auth.createUser!({ email: `gate-${Date.now()}@example.com`, password: 'hunter22!' })
    expect(ctx.userId).toBeTruthy()
  })
})
