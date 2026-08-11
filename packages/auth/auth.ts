// auth.ts
// createLitestoneAuth(db, opts): IAuth
//
// The data layer. Implements every IAuth method using db.asSystem() directly.
// Never touches HTTP — that is the plugin's job.
// Never sends email — that is the caller's job via the onX callbacks in opts.

import type { IAuth, SessionContext, CreateUserInput, ApiKeyOptions } from '@frontierjs/junction'
import {
  hashPassword,
  verifyPassword,
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
interface LitestoneClient {
  asSystem(): any
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
  } = opts

  const sys = db.asSystem()

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
        return user ? toContext(user, 'session') : null
      }

      // A key issued before the prefix existed, or by an app that generates its
      // own. One extra query, and only on a token that already missed.
      return verifyApiKeyImpl(token)
    },

    // ── login ────────────────────────────────────────────────────────────

    async login(email: string, password: string): Promise<{ token: string; user: SessionContext }> {
      const user = await sys.user.findFirst({ where: { email } })
      if (!user) throw new InvalidCredentialsError()

      const cred = await sys.credential.findFirst({
        where: { userId: user.id, type: 'password' }
      })
      if (!cred) throw new InvalidCredentialsError()

      const valid = await verifyPassword(password, cred.value)
      if (!valid) throw new InvalidCredentialsError()

      const token = generateSessionToken()

      await sys.session.create({
        data: {
          userId:    user.id,
          token,
          expiresAt: expiresAt(sessionTtl),
        }
      })

      return { token, user: toContext(user, 'session') }
    },

    // ── logout ───────────────────────────────────────────────────────────

    async logout(token: string): Promise<void> {
      await sys.session.deleteMany({ where: { token } })
    },

    // ── createUser ───────────────────────────────────────────────────────
    // Admin operation — creates user + password credential.
    // No session is issued here — call login() after to get one.
    // authMethod is 'created' to reflect that: a user record was created,
    // not that a session exists.

    async createUser(data: CreateUserInput): Promise<SessionContext> {
      const existing = await sys.user.findFirst({ where: { email: data.email } })
      if (existing) throw new EmailTakenError()

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

    // ── revokeApiKey ─────────────────────────────────────────────────────

    async revokeApiKey(keyId: string): Promise<void> {
      // Not Number(keyId). schema.ts ships `Credential.id Int`, but the
      // fragments are a starting point apps edit, and an app whose ids are
      // uuids got Number(uuid) === NaN — a delete that matches nothing and
      // does not throw. Revoke reported success and the key kept working.
      // Litestone coerces a where-value to the column type either way, so
      // passing it through is correct for both shapes.
      // `type: 'apiKey'` as well as the id: revoke must not be able to delete
      // somebody's password because a caller passed the wrong id.
      const { count } = await sys.credential.deleteMany({ where: { id: keyId, type: 'apiKey' } })
      if (!count) throw new InvalidTokenError(`No API key with id ${keyId}`)
    },

    // ── verifyApiKey ─────────────────────────────────────────────────────

    verifyApiKey: verifyApiKeyImpl,
  }
}
