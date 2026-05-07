// types.ts
// LitestoneAuthOptions  — passed to createLitestoneAuth(db, opts)
// AuthPluginOptions — passed to createLitestoneAuthPlugin(auth, opts)

import type { RateLimitHookOptions } from '../junction/index.ts'

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
