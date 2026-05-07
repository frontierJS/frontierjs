// auth.ts
// createLitestoneAuth(db, opts): IAuth
//
// The data layer. Implements every IAuth method using db.asSystem() directly.
// Never touches HTTP — that is the plugin's job.
// Never sends email — that is the caller's job via the onX callbacks in opts.

import type { IAuth, SessionContext, CreateUserInput, ApiKeyOptions } from '../junction/index.ts'
import {
  hashPassword,
  verifyPassword,
  generateApiKey,
  hashApiKey,
  generateToken,
  generateSessionToken,
  expiresAt,
} from './crypto.ts'
import type { LitestoneAuthOptions } from './types.ts'

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
  } = opts

  const sys = db.asSystem()

  // ─── Internal helpers ─────────────────────────────────────────────────────

  function toContext(user: any, authMethod: SessionContext['authMethod']): SessionContext {
    return {
      userId:    user.id,
      userType:  user.role ?? 'user',
      email:     user.email,
      name:      user.name ?? undefined,
      // accountId stored as Integer in DB — stringify for SessionContext compatibility.
      // Services convert back with Number(user.accountId) when needed.
      accountId: user.accountId != null ? String(user.accountId) : undefined,
      authMethod,
    }
  }

  // Guards for API key operations — encryptionKey is required for these.
  // Using a lazy check so apps that never use API keys don't need to provide it.
  function requireEncryptionKey(operation: string): string {
    if (!encryptionKey) {
      throw new Error(
        `LitestoneAuthOptions.encryptionKey is required for ${operation}. ` +
        `Pass { encryptionKey: process.env.ENCRYPTION_KEY } to createLitestoneAuth().`
      )
    }
    return encryptionKey
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
      const session = await sys.sessions.findFirst({
        where: {
          token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!session) return null

      const user = await sys.users.get(session.userId)
      if (!user) return null

      return toContext(user, 'session')
    },

    // ── login ────────────────────────────────────────────────────────────

    async login(email: string, password: string): Promise<{ token: string; user: SessionContext }> {
      const user = await sys.users.findFirst({ where: { email } })
      if (!user) throw new Error('Invalid credentials')

      const cred = await sys.credentials.findFirst({
        where: { userId: user.id, type: 'password' }
      })
      if (!cred) throw new Error('Invalid credentials')

      const valid = await verifyPassword(password, cred.value)
      if (!valid) throw new Error('Invalid credentials')

      const token = generateSessionToken()

      await sys.sessions.create({
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
      await sys.sessions.deleteMany({ where: { token } })
    },

    // ── createUser ───────────────────────────────────────────────────────
    // Admin operation — creates user + password credential.
    // No session is issued here — call login() after to get one.
    // authMethod is 'created' to reflect that: a user record was created,
    // not that a session exists.

    async createUser(data: CreateUserInput): Promise<SessionContext> {
      const existing = await sys.users.findFirst({ where: { email: data.email } })
      if (existing) throw new Error('Email already registered')

      const user = await sys.users.create({
        data: {
          email: data.email,
          name:  data.name  ?? null,
          role:  data.role  ?? 'user',
        }
      })

      if (data.password) {
        await sys.credentials.create({
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
      const user = await sys.users.get(userId)

      await sys.credentials.deleteMany({ where: { userId } })
      await sys.sessions.deleteMany({ where: { userId } })

      // Clean up any pending password-reset / email-verify tokens for this email
      if (user?.email) {
        await sys.verifications.deleteMany({
          where: { identifier: { endsWith: `:${user.email}` } }
        })
      }

      await sys.users.delete({ where: { id: userId } })
    },

    // ── requestPasswordReset ─────────────────────────────────────────────
    // Always resolves — never reveals whether the email is registered.

    async requestPasswordReset(email: string): Promise<void> {
      const user = await sys.users.findFirst({ where: { email } })
      if (!user) return   // silent — don't reveal email existence

      await sys.verifications.deleteMany({
        where: { identifier: `reset:${email}` }
      })

      const token = generateToken()

      await sys.verifications.create({
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
      const verification = await sys.verifications.findFirst({
        where: {
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!verification) throw new Error('Invalid or expired reset token')

      const email = verification.identifier.replace(/^reset:/, '')
      const user  = await sys.users.findFirst({ where: { email } })
      if (!user) throw new Error('User not found')

      const hash = await hashPassword(newPassword)

      await sys.credentials.updateMany({
        where: { userId: user.id, type: 'password' },
        data:  { value: hash },
      })

      // Token consumed — delete it
      await sys.verifications.delete({ where: { id: verification.id } })

      // Revoke all sessions — force re-login after password change
      await sys.sessions.deleteMany({ where: { userId: user.id } })
    },

    // ── requestEmailVerification ─────────────────────────────────────────

    async requestEmailVerification(userId: string): Promise<void> {
      const user = await sys.users.get(userId)
      if (!user) throw new Error('User not found')
      if (user.emailVerified) return   // already verified — no-op

      await sys.verifications.deleteMany({
        where: { identifier: `verify:${user.email}` }
      })

      const token = generateToken()

      await sys.verifications.create({
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
      const verification = await sys.verifications.findFirst({
        where: {
          value:     token,
          expiresAt: { gt: new Date() },
        }
      })
      if (!verification) throw new Error('Invalid or expired verification token')

      const email = verification.identifier.replace(/^verify:/, '')
      const user  = await sys.users.findFirst({ where: { email } })
      if (!user) throw new Error('User not found')

      await sys.users.update({
        where: { id: user.id },
        data:  { emailVerified: true },
      })

      await sys.verifications.delete({ where: { id: verification.id } })

      return toContext({ ...user, emailVerified: true }, 'verified')
    },

    // ── createApiKey ─────────────────────────────────────────────────────
    // Raw key returned once — never stored.
    // HMAC of the raw key (keyed on encryptionKey) stored in credentials.value.

    async createApiKey(userId: string, opts?: ApiKeyOptions): Promise<{ key: string; id: string }> {
      const secret = requireEncryptionKey('createApiKey')
      const rawKey = generateApiKey()
      const hash   = hashApiKey(rawKey, secret)

      const cred = await sys.credentials.create({
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
      await sys.credentials.delete({ where: { id: Number(keyId) } })
    },

    // ── verifyApiKey ─────────────────────────────────────────────────────

    async verifyApiKey(rawKey: string): Promise<SessionContext | null> {
      const secret = requireEncryptionKey('verifyApiKey')
      const hash   = hashApiKey(rawKey, secret)

      const cred = await sys.credentials.findFirst({
        where: { type: 'apiKey', value: hash }
      })
      if (!cred) return null

      // Check credential-level expiry if set
      if (cred.tokenExpiresAt && new Date(cred.tokenExpiresAt) < new Date()) return null

      const user = await sys.users.get(cred.userId)
      if (!user) return null

      return toContext(user, 'apiKey')
    },
  }
}
