// types.ts
// LitestoneAuthOptions  — passed to createLitestoneAuth(db, opts)
// AuthPluginOptions — passed to createLitestoneAuthPlugin(auth, opts)

import type { RateLimitHookOptions } from '@frontierjs/junction'

// ─── createLitestoneAuth options ────────────────────────────────────────────────

export interface LitestoneAuthOptions {
  // Required for API key operations — used as the HMAC secret when hashing
  // API keys before storage. Should be the same as your ENCRYPTION_KEY env var.
  // If not provided, createApiKey() and verifyApiKey() will throw at call time.
  encryptionKey?: string

  // How long a session token lives. Default: '30 days'
  sessionTtl?: string

  // How long a password reset token lives. Default: '1 hour'
  passwordResetTtl?: string

  // How long an email verification token lives. Default: '24 hours'
  emailVerificationTtl?: string

  // Called immediately after a password reset token is created.
  // The token is the raw value — use it to build a reset link.
  // Called in the same stack as token creation so errors are catchable.
  //
  // Example:
  //   onPasswordResetRequested: async (email, token) => {
  //     await mailer.send({
  //       to:      email,
  //       subject: 'Reset your password',
  //       html:    `<a href="${APP_URL}/auth/password-reset/confirm?token=${token}">Reset</a>`,
  //     })
  //   }
  onPasswordResetRequested?: (email: string, token: string) => Promise<void>

  // Called immediately after an email verification token is created.
  //
  // Example:
  //   onEmailVerificationRequested: async (email, token) => {
  //     await mailer.send({
  //       to:      email,
  //       subject: 'Verify your email',
  //       html:    `<a href="${APP_URL}/auth/email/verify?token=${token}">Verify</a>`,
  //     })
  //   }
  onEmailVerificationRequested?: (email: string, token: string) => Promise<void>

  // Extra fields to put on every SessionContext this instance issues, read off
  // the User row that produced it.
  //
  // The gap it closes: auth OWNS the User model but an app EXTENDS it, and
  // until this existed there was no way to get an app's own column onto the
  // session. The workaround is a wrapper around verifySession that re-reads the
  // user — a third query on the hottest path in the app, forever, for a row
  // this function already has in hand.
  //
  // It is called from one place (toContext), so it covers every path that
  // issues a session: login, verifySession, an API key, createUser.
  //
  // Two kinds of thing belong here:
  //   • STANDING sessionGateLevel() grades on — isAdmin / isOwner /
  //     isSystemAdmin / activatedAt / verifiedAt. This is how an app whose
  //     privileged bit is its own column reaches @@gate at all.
  //   • The app's own keys. They travel on the session object untouched;
  //     nothing in the framework reads them, and an app's hooks can.
  //
  // Returning a key auth itself sets (userId, email, authMethod, …) overwrites
  // it. Don't — the caller identity is not the app's to restate.
  sessionFields?: (user: Record<string, any>) => Record<string, unknown>
}

// ─── createAuthPlugin options ─────────────────────────────────────────

export interface AuthPluginOptions {
  // Route prefix. Default: '/auth'
  prefix?: string

  // Set session token as an httpOnly cookie instead of returning it in the
  // response body. Default: false — Bearer token in response body.
  cookieAuth?: boolean

  // Session TTL override — only needed if you want the cookie maxAge to differ
  // from the sessionTtl passed to createLitestoneAuth. In most setups you can omit
  // this: the plugin reads _sessionTtl directly from the auth instance.
  // Default: matches createLitestoneAuth sessionTtl, or '30 days' if not set.
  sessionTtl?: string

  // Override default rate limits.
  // Login default:    { max: 10, window: '15 minutes' }
  // Register default: { max: 5,  window: '15 minutes' }
  loginRateLimit?:    RateLimitHookOptions
  registerRateLimit?: RateLimitHookOptions
}
