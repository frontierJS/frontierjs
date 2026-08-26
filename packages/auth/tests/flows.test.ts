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
import { createClient, parse, generateDDLForDatabase } from '@frontierjs/litestone'
import { splitStatements } from '@frontierjs/litestone/migrate'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLitestoneAuth } from '../auth.ts'
import { BCRYPT_COST, DUMMY_HASH } from '../crypto.ts'
import { TEST_KEY, makeAuth, rejectsWith, type Harness } from './harness.ts'
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

  // FJS-063. The error message was already identical; the clock was not. An
  // absent user returned before the bcrypt and answered ~100× faster, so a
  // caller with a stopwatch could read off which addresses have accounts.
  //
  // MIN of several runs, not a mean: the floor is what an attacker samples for
  // and it is the measure least disturbed by whatever else the machine is doing.
  // The band is deliberately loose — the two paths differ by a database read,
  // and a test that pins the ratio tightly fails on a loaded CI box for no
  // reason. Before the fix the ratio was ~0.01, so anything near 1 catches it.
  test('a refusal costs the same whichever branch refuses it', async () => {
    const u = await freshUser('login-timing')
    await h.auth.createUser({ email: email('timing-no-cred') })   // no password

    const floorOf = async (fn: () => Promise<unknown>) => {
      let min = Infinity
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await fn().catch(() => {})
        min = Math.min(min, performance.now() - t0)
      }
      return min
    }

    const wrongPassword = await floorOf(() => h.auth.login(u.email, 'not-the-password'))
    const unknownEmail  = await floorOf(() => h.auth.login(email('timing-ghost'), 'x'))
    const noCredential  = await floorOf(() => h.auth.login(email('timing-no-cred'), 'x'))

    expect(unknownEmail).toBeGreaterThan(wrongPassword * 0.5)
    expect(noCredential).toBeGreaterThan(wrongPassword * 0.5)
  })

  // The dummy hash is a literal, so it carries its own cost and cannot follow
  // hashPassword's. Raise BCRYPT_COST without regenerating it and the gap
  // reopens, narrower and silent — this is what makes that loud instead.
  test('the dummy hash is written at the cost every password is', () => {
    expect(DUMMY_HASH.startsWith(`$2b$${BCRYPT_COST}$`)).toBe(true)
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

    const row = await h.sys.verification.findFirst({ where: { purpose: 'passwordReset', identifier: u.email } })
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
  // These two used to expect UserNotFoundError, which is what the door being
  // open looks like from outside: both lookups matched on `value` alone, so a
  // token DID cross, and what refused it was the follow-up address lookup
  // missing on a prefix two steps later. The test name was right and the
  // assertion pinned the coincidence (FJS-476).
  //
  // `purpose` is now in both queries, so the refusal is the query's and the
  // error says what actually happened. Asserting the error IS the assertion
  // here — UserNotFoundError passing would mean the token had been accepted.

  test('a password-reset token cannot verify an email', async () => {
    const u = await freshUser('x-reset')
    await h.auth.requestPasswordReset!(u.email)
    await rejectsWith(() => h.auth.verifyEmail!(h.resetToken()), InvalidTokenError)
  })

  test('an email-verification token cannot reset a password', async () => {
    const u    = await freshUser('x-verify')
    const user = await h.sys.user.findFirst({ where: { email: u.email } })
    await h.auth.requestEmailVerification!(user.id)

    await rejectsWith(
      () => h.auth.confirmPasswordReset!(h.verifyToken(), 'pw-hijack-5'),
      InvalidTokenError,
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
    expect((await h.sys.verification.findMany({ where: { purpose: 'passwordReset', identifier: u.email } })).length).toBe(0)
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

// ─── the audit trail ─────────────────────────────────────────────────────────
//
// `@@log(audit)` covers writes, so it covered exactly the auth events that ARE
// writes and none of the ones an app most wants (FJS-276, FJS-277). A failed
// login performs no write and left no trace at all; a successful one left
// `create:session` with `actorId: null`, because the write goes through
// asSystem() and a system context names no principal.
//
// These go through litestone's `db.$audit` — the one owner of putting a row in
// the trail — beside the @@log rows rather than instead of them: that one
// records the WRITE and cannot name the actor, this one records the EVENT.

describe('auth records what @@log(audit) cannot see', () => {

  const settle = () => new Promise(r => setImmediate(r))

  async function trail(h: any, run: () => Promise<unknown>) {
    await settle()
    const before = (await h.sys.auditLogs.findMany({})).length
    try { await run() } catch { /* a refusal is the case under test */ }
    await settle()
    return (await h.sys.auditLogs.findMany({})).slice(before)
  }

  test('a successful sign-in is recorded WITH the actor', async () => {
    const h = await makeAuth()
    const u: any = await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })

    const rows = await trail(h, () => h.auth.login('a@b.co', 'correct-horse-1'))
    const row  = rows.find((r: any) => r.operation === 'login.succeeded')

    expect(row).toBeDefined()
    expect(row.actorId).toBe(u.userId)

    // Beside the @@log row, not instead of it.
    expect(rows.some((r: any) => r.operation === 'create' && r.model === 'session')).toBe(true)
    h.cleanup()
  })

  // The whole of FJS-277: this left nothing at all, and it is the event an app
  // most wants — rate-limiting, lockout, alerting.
  test('a failed sign-in is recorded, with why and against whom', async () => {
    const h = await makeAuth()
    const u: any = await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })

    const rows = await trail(h, () => h.auth.login('a@b.co', 'wrong-password'))
    const row  = rows.find((r: any) => r.operation === 'login.failed')

    expect(row).toBeDefined()
    expect(row.actorId).toBe(u.userId)
    expect(JSON.parse(row.meta).reason).toBe('bad-password')
    h.cleanup()
  })

  // An attempt against an address that does not exist has no user to name, and
  // the attempted address is the only identifier it has — a spray across many
  // addresses is invisible without it.
  test('an attempt on an unknown address records the address', async () => {
    const h = await makeAuth()
    const rows = await trail(h, () => h.auth.login('ghost@b.co', 'whatever'))
    const row  = rows.find((r: any) => r.operation === 'login.failed')

    expect(row).toBeDefined()
    expect(row.actorId).toBe(null)
    expect(JSON.parse(row.meta)).toEqual({ reason: 'no-such-user', email: 'ghost@b.co' })
    h.cleanup()
  })

  test('the attempted password is never written anywhere', async () => {
    const h = await makeAuth()
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })

    const rows = await trail(h, () => h.auth.login('a@b.co', 'hunter2-do-not-log-me'))
    expect(JSON.stringify(rows)).not.toContain('hunter2-do-not-log-me')
    h.cleanup()
  })

  test('logout names the session that ended and who owned it', async () => {
    const h = await makeAuth()
    const u: any = await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })
    const { token } = await h.auth.login('a@b.co', 'correct-horse-1')

    const rows = await trail(h, () => h.auth.logout(token))
    const row  = rows.find((r: any) => r.operation === 'logout')

    expect(row).toBeDefined()
    expect(row.actorId).toBe(u.userId)
    expect(JSON.parse(row.records)).toHaveLength(1)
    h.cleanup()
  })

  // An unknown token is what a replayed or already-expired one looks like, so it
  // is recorded rather than passed over in silence.
  test('logging out an unknown session is still recorded', async () => {
    const h = await makeAuth()
    const rows = await trail(h, () => h.auth.logout('not-a-real-token'))
    const row  = rows.find((r: any) => r.operation === 'logout')

    expect(row).toBeDefined()
    expect(JSON.parse(row.meta).reason).toBe('unknown-session')
    h.cleanup()
  })
})

// ─── an app with no audit database ───────────────────────────────────────────
//
// The guard that matters most, because it sits on the login path. Auth's own
// schema fragment declares `database audit`, but an app may bring its own User
// model and no logger database at all — and `db.$audit` THROWS when there is
// nowhere to write, which is right for a caller whose purpose is the record and
// wrong for one whose purpose is the login. Get this backwards and every such
// app can no longer sign anybody in.

describe('an app that declares no logger database', () => {

  async function plainAuth() {
    const dir  = mkdtempSync(join(tmpdir(), 'fjs-auth-noaudit-'))
    const path = join(dir, 'app.db')

    // The shipped fragment carries @@log(audit); this is the other shape — an
    // app's own identity models, no audit database anywhere.
    const source = `
database main { path "${path}" }

model User {
  id             String    @id @default(uuid())
  email          String    @email @unique @lower
  name           String?
  emailVerified  Boolean   @default(false)
  role           String    @default("user")
  createdAt      DateTime  @default(now())
}

model Credential {
  id        Int       @id
  userId    String
  type      String
  value     String    @guarded(all)
  createdAt DateTime  @default(now())
}

model Session {
  id         String    @id @default(uuid())
  userId     String
  token      String    @unique @guarded(all)
  expiresAt  DateTime
  createdAt  DateTime  @default(now())
}

model Verification {
  id          Int       @id
  identifier  String
  value       String    @guarded(all)
  expiresAt   DateTime
  createdAt   DateTime  @default(now())
}
`
    const parsed = parse(source)
    if (!parsed.valid) throw new Error(parsed.errors.join('\n'))

    const raw = new Database(path)
    for (const stmt of splitStatements(generateDDLForDatabase(parsed.schema, 'main')))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
    raw.close()

    const db = await createClient({ parsed, encryptionKey: TEST_KEY })
    return { db, auth: createLitestoneAuth(db, {}) }
  }

  // Two separate things hold this up and only one of them is obvious. The
  // try/catch means a failed audit write never fails a login — so removing the
  // `hasAuditLog` guard leaves every test green while printing a warning on
  // every sign-in an app makes, forever. The quiet is the assertion.
  test('sign-in works, refusals still refuse, and nothing is warned about', async () => {
    const { auth } = await plainAuth()
    const warnings: unknown[][] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }

    try {
      await auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })

      const { token } = await auth.login('a@b.co', 'correct-horse-1')
      expect(token).toBeTruthy()

      await expect(auth.login('a@b.co', 'wrong')).rejects.toThrow()
      await expect(auth.login('ghost@b.co', 'wrong')).rejects.toThrow()
      await auth.logout(token)
    } finally {
      console.warn = realWarn
    }

    expect(warnings.filter(w => String(w[0]).includes('[auth]'))).toEqual([])
  })
})

// ─── acting on an auth event ─────────────────────────────────────────────────
//
// `FJS-042`: the package emitted nothing, so an app could not rate-limit,
// lock out or notify without wrapping the routes. Four awaited callbacks now —
// the same shape `onPasswordResetRequested` already had, so no new vocabulary.
//
// A THROW REFUSES. That is what makes lockout possible at the auth layer rather
// than only in a Junction hook in front of the route, and it is the cost too: an
// app handler is now a failure mode on the login path.
//
// ONE ORDERING RULE: a hook runs before the thing it can refuse. So no hook
// receives what its refusal would have prevented — the gate cannot also be the
// report. What happened afterwards is the audit trail's job.

describe('the auth hooks', () => {

  const settle = () => new Promise(r => setImmediate(r))

  test('onLogin runs before a session exists, and refusing leaves none', async () => {
    const seen: any[] = []
    const h = await makeAuth({
      onLogin: (e) => { seen.push(e); throw new Error('locked out') },
    })
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })

    await expect(h.auth.login('a@b.co', 'correct-horse-1')).rejects.toThrow('locked out')

    // The credentials were right, so the refusal is the hook's alone.
    expect(seen).toHaveLength(1)
    expect(seen[0].user.email).toBe('a@b.co')

    // Nothing issued. A hook that refuses after the session is written would
    // leave one behind for a login that never happened.
    expect(await h.sys.session.count()).toBe(0)
    h.cleanup()
  })

  // A veto that leaves no trace is the class of defect FJS-277 was.
  test('a refused login is still recorded', async () => {
    const h = await makeAuth({ onLogin: () => { throw new Error('locked out') } })
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })
    await settle()

    const before = (await h.sys.auditLogs.findMany({})).length
    await expect(h.auth.login('a@b.co', 'correct-horse-1')).rejects.toThrow()
    await settle()

    const row = (await h.sys.auditLogs.findMany({})).slice(before)
      .find((r: any) => r.operation === 'login.failed')
    expect(JSON.parse(row.meta)).toMatchObject({ reason: 'refused-by-app', message: 'locked out' })
    h.cleanup()
  })

  // The headline use case in the issue: a lockout answers 429, not 401.
  test('onLoginFailed can replace the error a caller sees', async () => {
    const attempts: string[] = []
    const h = await makeAuth({
      onLoginFailed: ({ email, reason }) => {
        attempts.push(reason)
        if (attempts.length >= 2) throw new Error('Too many attempts')
      },
    })
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })

    await expect(h.auth.login('a@b.co', 'wrong')).rejects.toThrow(/credentials/i)
    await expect(h.auth.login('a@b.co', 'wrong')).rejects.toThrow('Too many attempts')
    expect(attempts).toEqual(['bad-password', 'bad-password'])
    h.cleanup()
  })

  // The record is what happened; the hook only decides what the caller is told.
  // A hook that replaces the error must not also erase the attempt.
  test('onLoginFailed cannot erase the attempt from the trail', async () => {
    const h = await makeAuth({ onLoginFailed: () => { throw new Error('nope') } })
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })
    await settle()

    const before = (await h.sys.auditLogs.findMany({})).length
    await expect(h.auth.login('a@b.co', 'wrong')).rejects.toThrow('nope')
    await settle()

    expect((await h.sys.auditLogs.findMany({})).slice(before)
      .some((r: any) => r.operation === 'login.failed')).toBe(true)
    h.cleanup()
  })

  test('onRegister runs before anything is written, so refusing makes no user', async () => {
    const h = await makeAuth({
      onRegister: ({ email }) => { if (email.endsWith('@blocked.co')) throw new Error('domain not allowed') },
    })

    await expect(h.auth.createUser({ email: 'x@blocked.co', password: 'correct-horse-1' }))
      .rejects.toThrow('domain not allowed')
    expect(await h.sys.user.count()).toBe(0)
    expect(await h.sys.credential.count()).toBe(0)

    await h.auth.createUser({ email: 'ok@fine.co', password: 'correct-horse-1' })
    expect(await h.sys.user.count()).toBe(1)
    h.cleanup()
  })

  test('onLogout runs before the delete, so refusing keeps the session', async () => {
    const h = await makeAuth({ onLogout: () => { throw new Error('not now') } })
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })
    const { token } = await h.auth.login('a@b.co', 'correct-horse-1')

    await expect(h.auth.logout(token)).rejects.toThrow('not now')
    expect(await h.sys.session.count()).toBe(1)
    h.cleanup()
  })

  test('no hooks configured is the behaviour that already existed', async () => {
    const h = await makeAuth()
    await h.auth.createUser({ email: 'a@b.co', password: 'correct-horse-1', name: 'A' })
    const { token } = await h.auth.login('a@b.co', 'correct-horse-1')
    expect(token).toBeTruthy()
    await h.auth.logout(token)
    expect(await h.sys.session.count()).toBe(0)
    h.cleanup()
  })
})
