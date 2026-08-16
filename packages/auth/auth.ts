// auth.ts
// createLitestoneAuth(db, opts): IAuth
//
// The data layer. Implements every IAuth method using db.asSystem() directly.
// Never touches HTTP — that is the plugin's job.
// Never sends email — that is the caller's job via the onX callbacks in opts.

import type { IAuth, SessionContext, CreateUserInput, ApiKeyOptions, AuthSessionInfo, ApiKeyInfo } from '@frontierjs/junction'
import {
  hashPassword,
  verifyPassword,
  payPasswordCost,
  generateApiKey,
  hashApiKey,
  generateToken,
  generateSessionToken,
  expiresAt,
  API_KEY_PREFIX,
} from './crypto.ts'
import type { LitestoneAuthOptions } from './types.ts'
import {
  InvalidCredentialsError, EmailTakenError, InvalidTokenError,
  UserNotFoundError, AuthConfigError,
} from './errors.ts'

// Minimal interface — avoids a hard import of @frontierjs/litestone types
// while still getting type-safe asSystem() usage.
//
// `$databases` is OPTIONAL because reading it is feature detection: an older
// client may not have the property, and a Litestone proxy THROWS on an unknown
// one rather than answering undefined, so the read is guarded at runtime too.
interface LitestoneClient {
  asSystem(): any
  $databases?: Record<string, { driver?: string } | undefined>
}

export function createLitestoneAuth(
  db:   LitestoneClient,
  opts: LitestoneAuthOptions = {}
): IAuth & { _sessionTtl: string } {

  const {
    encryptionKey,
    sessionTtl           = '30 days',
    passwordResetTtl     = '1 hour',
    emailVerificationTtl = '24 hours',
    onPasswordResetRequested,
    onEmailVerificationRequested,
    sessionFields,
    onLogin,
    onLoginFailed,
    onLogout,
    onRegister,
  } = opts

  const sys = db.asSystem()

  // ─── The audit trail ──────────────────────────────────────────────────────
  //
  // `@@log(audit)` covers writes, so it covered exactly the auth events that ARE
  // writes and none of the ones an app most wants: a failed login performs no
  // write and left no trace at all, and a successful one left `create:session`
  // with `actorId: null`, because the write goes through `asSystem()` and a
  // system context names no principal (`FJS-276`, `FJS-277`).
  //
  // `db.$audit` is litestone's one owner of "put a row in the audit trail" — the
  // log model is an ordinary accessor and could be written directly, but two
  // writers with no shared definition is how a second `operation` vocabulary
  // starts drifting from the first.
  //
  // TWO deliberate softenings, because this is on the login path:
  //
  //   · An app is not required to declare a logger database. Auth's own schema
  //     fragment does, but an app may bring its own User model — and a login
  //     that throws because there is nowhere to write the record would be a
  //     worse failure than the missing record.
  //   · A failed WRITE does not fail the request. $audit throws by design, and
  //     that is right for a caller whose whole purpose is the record; here the
  //     caller's purpose is the login. It is reported rather than swallowed.
  //
  // An app that wants a sign-in refused when it cannot be recorded has to say so
  // itself — that is a policy decision this package should not make quietly.

  const hasAuditLog = (() => {
    try {
      return Object.values(db.$databases ?? {}).some((d: any) => d?.driver === 'logger')
    } catch {
      // A Litestone client THROWS on an unknown property, so feature-detection
      // is itself a throwing expression on an older client.
      return false
    }
  })()

  async function audit(operation: string, entry: Record<string, unknown> = {}): Promise<void> {
    if (!hasAuditLog) return
    try {
      await sys.$audit({ operation, ...entry })
    } catch (err) {
      console.warn(`[auth] could not record '${operation}' in the audit trail:`, (err as Error)?.message)
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  function toContext(user: any, authMethod: SessionContext['authMethod']): SessionContext {
    return {
      userId:    user.id,
      userType:  user.role ?? 'user',
      // The User model's role was written to userType and then dropped, so
      // SessionContext.role — the field consumers actually read, including
      // anything grading a caller for @@gate — was always undefined.
      role:      user.role ?? undefined,
      email:     user.email,
      name:      user.name ?? undefined,
      // accountId stored as Integer in DB — stringify for SessionContext compatibility.
      // Services convert back with Number(user.accountId) when needed.
      accountId: user.accountId != null ? String(user.accountId) : undefined,

      // Verification standing, in the vocabulary sessionGateLevel() grades on.
      // The User model carries a boolean, not a timestamp, so this is
      // deliberately null-or-absent rather than a fabricated date:
      //   emailVerified false → null      → VISITOR (1)
      //   emailVerified true  → undefined → no objection; grades USER (4)
      // Absence means "nothing holding this user back", never "not yet".
      ...(user.emailVerified === false ? { verifiedAt: null } : {}),

      authMethod,

      // Last: an app that states a field wins. Spreading it first would mean
      // adding any key above here silently overrides what the app asked for,
      // which is a breaking change nobody would see.
      ...(sessionFields ? sessionFields(user) : {}),
    }
  }

  // Guards for API key operations — encryptionKey is required for these.
  // Using a lazy check so apps that never use API keys don't need to provide it.
  function requireEncryptionKey(operation: string): string {
    if (!encryptionKey) {
      throw new AuthConfigError(
        `LitestoneAuthOptions.encryptionKey is required for ${operation}. ` +
        `Pass { encryptionKey: process.env.ENCRYPTION_KEY } to createLitestoneAuth().`
      )
    }
    return encryptionKey
  }

  // A named function rather than only a method, because verifySession has to
  // call it: the transport resolves every Bearer token through verifySession,
  // so a key that is only reachable via auth.verifyApiKey() is a key nothing
  // ever presents.
  async function verifyApiKeyImpl(rawKey: string): Promise<SessionContext | null> {
    // Issuing is the loud path — createApiKey throws AuthConfigError without a
    // key, which is where a developer finds out. Verifying is the quiet one: it
    // runs on attacker-supplied input on every request, so a missing config
    // answers "not authenticated" rather than throwing a 500 anyone can
    // trigger. verifySession also reaches here as a fallback for any token that
    // missed, and an app with no API keys at all must not pay a throw for that.
    if (!encryptionKey) return null
    const hash = hashApiKey(rawKey, encryptionKey)

    const cred = await sys.credential.findFirst({
      where: { type: 'apiKey', value: hash }
    })
    if (!cred) return null

    // Check credential-level expiry if set
    if (cred.tokenExpiresAt && new Date(cred.tokenExpiresAt) < new Date()) return null

    const user = await sys.user.findUnique({ where: { id: cred.userId } })
    if (!user) return null

    return {
      ...toContext(user, 'apiKey'),
      // createApiKey stores the scopes and this dropped them, so a key issued
      // with `servers:read` authenticated with the full standing of its owner
      // and nothing downstream could tell the difference. `scope` is stored
      // space-joined, the same shape OAuth uses.
      ...(cred.scope ? { scopes: cred.scope.split(/\s+/).filter(Boolean) } : {}),
      // Which key this was. An app that records per-key usage, or revokes one
      // key without touching the others, has no other way to ask.
      credentialId: String(cred.id),
    }
  }

  // ─── IAuth ────────────────────────────────────────────────────────────────

  return {

    // Exposed so createAuthPlugin can read it without requiring the caller
    // to pass sessionTtl to both createLitestoneAuth and createAuthPlugin.
    _sessionTtl: sessionTtl,

    // ── verifySession ────────────────────────────────────────────────────
    // Hot path — called on every authenticated request.
    // Two db lookups maximum: session → user.
    // Sessions are not extended on access (no sliding expiry) — the expiresAt
    // set at login is final. Intentional: avoids a write on every request.

    async verifySession(token: string): Promise<SessionContext | null> {
      // An API key is a Bearer token too, and the transport has one door:
      // http.ts calls verifySession and nothing else. Without this branch
      // createApiKey() succeeds and every request carrying the key it returned
      // is anonymous — a key that can be issued and never used. The prefix is
      // ours (crypto.ts), so it routes without costing a session lookup.
      if (token.startsWith(API_KEY_PREFIX)) return verifyApiKeyImpl(token)

      const session = await sys.session.findFirst({
        where: {
          token,
          expiresAt: { gt: new Date() },
        }
      })
      if (session) {
        const user = await sys.user.findUnique({ where: { id: session.userId } })
        // The session id travels on the context so a service can tell which of
        // the caller's sessions is the one asking — without ever being handed
        // the token that would let it answer by comparison.
        return user ? { ...toContext(user, 'session'), sessionId: String(session.id) } : null
      }

      // A key issued before the prefix existed, or by an app that generates its
      // own. One extra query, and only on a token that already missed.
      return verifyApiKeyImpl(token)
    },

    // ── sessionFor ───────────────────────────────────────────────────────
    //
    // A session for a caller who is presenting nothing, because there is
    // nothing left to present: deferred work runs long after the request that
    // asked for it, so `app.runAs(userId, …)` has an id and no token.
    //
    // It goes through `toContext` like every other path, which is the point —
    // the standing a job is graded at is built by the same function, from the
    // same row, with the app's own `sessionFields` applied. A parallel builder
    // here would be a second answer to "what standing does this user hold",
    // diverging exactly where it matters least visibly.
    //
    // `authMethod: 'created'` says how this session came to exist: not a
    // session row, not a key, no credential proved. Anything auditing *how* a
    // caller authenticated can tell it apart from one that did.
    //
    // Read fresh, never restored. A user demoted since enqueue is graded at the
    // standing they hold now, and a deleted one answers null.

    async sessionFor(userId: string): Promise<SessionContext | null> {
      const user = await sys.user.findUnique({ where: { id: userId } })
      return user ? toContext(user, 'created') : null
    },

    // ── login ────────────────────────────────────────────────────────────

    async login(email: string, password: string): Promise<{ token: string; user: SessionContext }> {
      // Every refusal records the same way and answers the same error. The three
      // branches are distinguishable in the trail by `reason` and nowhere else —
      // telling a caller whether the address exists is an enumeration oracle.
      // Recorded FIRST, then the hook runs. A hook that replaces the error must
      // not also be able to erase the attempt from the trail — the record is
      // what happened, the hook only decides what the caller is told.
      const refuse = async (reason: string, userId: string | null) => {
        await audit('login.failed', {
          model:   'User',
          records: userId ? [userId] : [],
          actorId: userId,
          // The attempted address, on purpose: a spray across many addresses is
          // invisible without it, and it is the only identifier a failed attempt
          // for an unknown user has. Never the attempted password.
          meta:    { reason, email },
        })
        // A throw here REPLACES InvalidCredentialsError — a lockout answers 429,
        // not 401. Returned rather than thrown so the call sites read `throw
        // await refuse(...)` and cannot forget to.
        if (onLoginFailed) await onLoginFailed({ email, userId, reason })
        return new InvalidCredentialsError()
      }

      // The two branches that never reach the real comparison pay its cost
      // anyway. Same error, same trail shape, and now the same clock — an early
      // return here answers in a millisecond where a wrong password takes ~220ms,
      // which enumerates users through a message that says nothing.
      const user = await sys.user.findFirst({ where: { email } })
      if (!user) {
        await payPasswordCost(password)
        throw await refuse('no-such-user', null)
      }

      const cred = await sys.credential.findFirst({
        where: { userId: user.id, type: 'password' }
      })
      if (!cred) {
        await payPasswordCost(password)
        throw await refuse('no-password-credential', user.id)
      }

      const valid = await verifyPassword(password, cred.value)
      if (!valid) throw await refuse('bad-password', user.id)

      // Before the session is issued, so a refusal leaves nothing behind. The
      // hook therefore has no session id to be given — what happened after this
      // point is the trail's to report, not the gate's.
      if (onLogin) {
        try {
          await onLogin({ user: toContext(user, 'session') })
        } catch (err) {
          // A veto that leaves no trace is the class of defect FJS-277 was.
          await audit('login.failed', {
            model: 'User', records: [user.id], actorId: user.id,
            meta:  { reason: 'refused-by-app', email, message: (err as Error)?.message },
          })
          throw err
        }
      }

      const token = generateSessionToken()

      const session = await sys.session.create({
        data: {
          userId:    user.id,
          token,
          expiresAt: expiresAt(sessionTtl),
        }
      })

      // Beside the `create:session` row @@log(audit) already writes, not instead
      // of it: that one records the WRITE and cannot name the actor, this one
      // records the EVENT and does.
      await audit('login.succeeded', {
        model: 'Session', records: [session.id], actorId: user.id, actorType: 'user',
      })

      return { token, user: { ...toContext(user, 'session'), sessionId: String(session.id) } }
    },

    // ── logout ───────────────────────────────────────────────────────────

    async logout(token: string): Promise<void> {
      // Read before the delete — afterwards there is nothing left to name, and a
      // logout that says which session ended is the half that makes a trail
      // followable. An unknown token is still recorded: it is what a replayed or
      // already-expired token looks like.
      const session = await sys.session.findFirst({ where: { token } })

      // Before the delete, per the ordering rule — a refusal that has already
      // destroyed the session it refused to destroy is not a refusal.
      if (onLogout) await onLogout({ userId: session?.userId ?? null, sessionId: session?.id ?? null })

      await sys.session.deleteMany({ where: { token } })

      await audit('logout', {
        model:   'Session',
        records: session ? [session.id] : [],
        actorId: session?.userId ?? null,
        meta:    session ? undefined : { reason: 'unknown-session' },
      })
    },

    // ── createUser ───────────────────────────────────────────────────────
    // Admin operation — creates user + password credential.
    // No session is issued here — call login() after to get one.
    // authMethod is 'created' to reflect that: a user record was created,
    // not that a session exists.

    async createUser(data: CreateUserInput): Promise<SessionContext> {
      const existing = await sys.user.findFirst({ where: { email: data.email } })
      if (existing) throw new EmailTakenError()

      // Before anything is written, so a refusal — a blocked domain, a closed
      // list — leaves no half-made account behind. It has no user row to be
      // given for the same reason.
      if (onRegister) await onRegister({ email: data.email, name: data.name ?? null })

      const user = await sys.user.create({
        data: {
          email: data.email,
          name:  data.name  ?? null,
          role:  data.role  ?? 'user',
        }
      })

      if (data.password) {
        await sys.credential.create({
          data: {
            userId: user.id,
            type:   'password',
            value:  await hashPassword(data.password),
          }
        })
      }

      return toContext(user, 'created')
    },

    // ── deleteUser ───────────────────────────────────────────────────────

    async deleteUser(userId: string): Promise<void> {
      // Fetch the user first so we can clean up email-scoped verification tokens
      const user = await sys.user.findUnique({ where: { id: userId } })

      await sys.credential.deleteMany({ where: { userId } })
      await sys.session.deleteMany({ where: { userId } })

      // Clean up any pending password-reset / email-verify tokens for this email
      if (user?.email) {
        await sys.verification.deleteMany({
          where: { identifier: { endsWith: `:${user.email}` } }
        })
      }

      await sys.user.delete({ where: { id: userId } })
    },

    // ── requestPasswordReset ─────────────────────────────────────────────
    // Always resolves — never reveals whether the email is registered.

    async requestPasswordReset(email: string): Promise<void> {
      const user = await sys.user.findFirst({ where: { email } })
      if (!user) return   // silent — don't reveal email existence

      await sys.verification.deleteMany({
        where: { identifier: `reset:${email}` }
      })

      const token = generateToken()

      await sys.verification.create({
        data: {
          identifier: `reset:${email}`,
          value:      token,
          expiresAt:  expiresAt(passwordResetTtl),
        }
      })

      // Token is still in memory — pass to callback before it becomes @guarded
      await onPasswordResetRequested?.(email, token)
    },

    // ── confirmPasswordReset ─────────────────────────────────────────────

    async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
      const verification = await sys.verification.findFirst({
        where: {
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!verification) throw new InvalidTokenError('Invalid or expired reset token')

      const email = verification.identifier.replace(/^reset:/, '')
      const user  = await sys.user.findFirst({ where: { email } })
      if (!user) throw new UserNotFoundError()

      const hash = await hashPassword(newPassword)

      await sys.credential.updateMany({
        where: { userId: user.id, type: 'password' },
        data:  { value: hash },
      })

      // Token consumed — delete it
      await sys.verification.delete({ where: { id: verification.id } })

      // Revoke all sessions — force re-login after password change
      await sys.session.deleteMany({ where: { userId: user.id } })
    },

    // ── requestEmailVerification ─────────────────────────────────────────

    async requestEmailVerification(userId: string): Promise<void> {
      const user = await sys.user.findUnique({ where: { id: userId } })
      if (!user) throw new UserNotFoundError()
      if (user.emailVerified) return   // already verified — no-op

      await sys.verification.deleteMany({
        where: { identifier: `verify:${user.email}` }
      })

      const token = generateToken()

      await sys.verification.create({
        data: {
          identifier: `verify:${user.email}`,
          value:      token,
          expiresAt:  expiresAt(emailVerificationTtl),
        }
      })

      // Token is still in memory — pass to callback before it becomes @guarded
      await onEmailVerificationRequested?.(user.email, token)
    },

    // ── verifyEmail ──────────────────────────────────────────────────────

    async verifyEmail(token: string): Promise<SessionContext> {
      const verification = await sys.verification.findFirst({
        where: {
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!verification) throw new InvalidTokenError('Invalid or expired verification token')

      const email = verification.identifier.replace(/^verify:/, '')
      const user  = await sys.user.findFirst({ where: { email } })
      if (!user) throw new UserNotFoundError()

      await sys.user.update({
        where: { id: user.id },
        data:  { emailVerified: true },
      })

      await sys.verification.delete({ where: { id: verification.id } })

      return toContext({ ...user, emailVerified: true }, 'verified')
    },

    // ── createApiKey ─────────────────────────────────────────────────────
    // Raw key returned once — never stored.
    // HMAC of the raw key (keyed on encryptionKey) stored in credentials.value.

    async createApiKey(userId: string, opts?: ApiKeyOptions): Promise<{ key: string; id: string }> {
      const secret = requireEncryptionKey('createApiKey')
      const rawKey = generateApiKey()
      const hash   = hashApiKey(rawKey, secret)

      const cred = await sys.credential.create({
        data: {
          userId,
          type:           'apiKey',
          value:          hash,
          label:          opts?.name      ?? null,
          tokenExpiresAt: opts?.expiresAt ?? null,
          scope:          opts?.scopes?.join(' ') ?? null,
        }
      })

      return { key: rawKey, id: String(cred.id) }
    },

    // ── listApiKeys ──────────────────────────────────────────────────────
    // Never the stored value: it is the HMAC a presented key is matched
    // against, and a list that carried it would be a list of working keys.

    async listApiKeys(userId: string): Promise<ApiKeyInfo[]> {
      const creds = await sys.credential.findMany({
        where:   { userId, type: 'apiKey' },
        orderBy: { createdAt: 'desc' },
      })
      return creds.map((c: any) => ({
        id:        String(c.id),
        name:      c.label ?? null,
        scopes:    c.scope ? String(c.scope).split(/\s+/).filter(Boolean) : [],
        createdAt: c.createdAt ?? null,
        expiresAt: c.tokenExpiresAt ?? null,
      }))
    },

    // ── revokeApiKey ─────────────────────────────────────────────────────

    async revokeApiKey(keyId: string, opts?: { userId?: string }): Promise<void> {
      // Not Number(keyId). schema.ts ships `Credential.id Int`, but the
      // fragments are a starting point apps edit, and an app whose ids are
      // uuids got Number(uuid) === NaN — a delete that matches nothing and
      // does not throw. Revoke reported success and the key kept working.
      // Litestone coerces a where-value to the column type either way, so
      // passing it through is correct for both shapes.
      // `type: 'apiKey'` as well as the id: revoke must not be able to delete
      // somebody's password because a caller passed the wrong id.
      //
      // `userId` scopes it to one owner, and the api-keys service always passes
      // it: the caller supplies the id, so a delete matching on the id alone
      // revokes any key in the system whose id you can guess. The refusal is
      // the same "no such key" either way — whose key it is is not the
      // caller's to learn.
      const where: Record<string, unknown> = { id: keyId, type: 'apiKey' }
      if (opts?.userId) where.userId = opts.userId
      const { count } = await sys.credential.deleteMany({ where })
      if (!count) throw new InvalidTokenError(`No API key with id ${keyId}`)
    },

    // ── changePassword ───────────────────────────────────────────────────
    // The current password is verified here rather than trusted from a
    // service: this is the one call that can turn a stolen session into a
    // stolen account, and the check belongs beside the hash it compares.

    async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
      const cred = await sys.credential.findFirst({ where: { userId, type: 'password' } })
      // Same refusal for "no password set" as for "wrong password". An account
      // with only an OAuth credential is a fact about that account, and this is
      // reachable by anyone holding a session for it.
      if (!cred) throw new InvalidCredentialsError()
      if (!await verifyPassword(currentPassword, cred.value)) throw new InvalidCredentialsError()

      await sys.credential.update({
        where: { id: cred.id },
        data:  { value: await hashPassword(newPassword) },
      })

      await audit('password.changed', {
        model: 'Credential', records: [String(cred.id)], actorId: userId, actorType: 'user',
      })
    },

    // ── listSessions ─────────────────────────────────────────────────────
    // Expired rows are left out rather than shown as expired: the question a
    // caller is asking is "where am I signed in", and cleanup.ts is what
    // eventually removes them.

    async listSessions(userId: string): Promise<AuthSessionInfo[]> {
      const rows = await sys.session.findMany({
        where:   { userId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      })
      // `current` is decided by the caller — this layer is not told which token
      // presented. The service fills it in; false here means "not known to be".
      return rows.map((s: any) => ({
        id:        String(s.id),
        createdAt: s.createdAt ?? null,
        expiresAt: s.expiresAt ?? null,
        current:   false,
      }))
    },

    // ── revokeSession ────────────────────────────────────────────────────

    async revokeSession(userId: string, sessionId: string): Promise<void> {
      // userId in the where, not checked after the read: a delete keyed on the
      // id alone ends anyone's session whose id is guessable, and the id is
      // what a UI hands back from listSessions.
      const { count } = await sys.session.deleteMany({ where: { id: sessionId, userId } })
      if (!count) throw new InvalidTokenError(`No session with id ${sessionId}`)

      await audit('session.revoked', {
        model: 'Session', records: [String(sessionId)], actorId: userId, actorType: 'user',
      })
    },

    // ── revokeSessions ───────────────────────────────────────────────────

    async revokeSessions(userId: string, opts?: { exceptSessionId?: string }): Promise<number> {
      const where: Record<string, unknown> = { userId }
      if (opts?.exceptSessionId) where.id = { not: opts.exceptSessionId }

      const { count } = await sys.session.deleteMany({ where })

      await audit('session.revoked', {
        model: 'Session', records: [], actorId: userId, actorType: 'user',
        meta:  { count, keptCurrent: Boolean(opts?.exceptSessionId) },
      })
      return count
    },

    // ── verifyApiKey ─────────────────────────────────────────────────────

    verifyApiKey: verifyApiKeyImpl,
  }
}
