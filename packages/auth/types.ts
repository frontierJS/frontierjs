// types.ts
// LitestoneAuthOptions  — passed to createLitestoneAuth(db, opts)
// AuthPluginOptions — passed to createLitestoneAuthPlugin(auth, opts)

import type { RateLimitHookOptions, SessionContext } from '@frontierjs/junction'

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

  // ─── Acting on an auth event ────────────────────────────────────────────
  //
  // Awaited, and A THROW REFUSES — which is what makes lockout and rate
  // limiting possible at the auth layer rather than only in front of the route
  // (`FJS-042`). The cost is stated rather than hidden: an app handler is now a
  // failure mode on the login path, and a slow one slows every sign-in.
  //
  // ONE ORDERING RULE, and it is the whole contract: **a hook runs before the
  // thing it can refuse.** So none of them receives what its refusal would have
  // prevented — `onLogin` has no session id, `onRegister` has no user row —
  // because a hook that both refuses and reports the result of the thing it
  // refused cannot exist. What happened afterwards is the audit trail's job:
  // **the hook is the gate, `db.$audit` is the record.**
  //
  // These are single handlers, not a bus: one owner per decision. A second
  // listener that wants to observe rather than decide belongs on Junction's
  // `app.events`, which is a different question and is not answered here.

  /** After the password verifies, BEFORE a session is issued. Throw to refuse. */
  onLogin?: (event: { user: SessionContext }) => Promise<void> | void

  /**
   * Before the refusal is raised. Throw to replace `InvalidCredentialsError`
   * with your own — a lockout answers 429, not 401.
   *
   * `reason` is 'no-such-user' | 'no-password-credential' | 'bad-password'.
   * `userId` is null when the address matched nobody. Do not leak which:
   * telling a caller whether an address exists is an enumeration oracle.
   */
  onLoginFailed?: (event: {
    email: string
    userId: string | null
    reason: string
  }) => Promise<void> | void

  /** Before the session row is deleted. `sessionId` is null for an unknown token. */
  onLogout?: (event: {
    userId:    string | null
    sessionId: string | null
  }) => Promise<void> | void

  /** Before the user is created. Throw to refuse — a blocked domain, a closed list. */
  onRegister?: (event: {
    email: string
    name:  string | null
  }) => Promise<void> | void
}

// ─── createAuthServices options ───────────────────────────────────────

export interface AuthServicesOptions {
  /** Rename the service, or `false` to not register it at all. */
  account?:  string | false
  sessions?: string | false
  apiKeys?:  string | false

  /**
   * Grade the caller onto the app's own 0–7 ladder for `account.me`.
   *
   * Opt-in and absent by default, and that is the design rather than an
   * omission: the app owns the role→level mapping (whatever it passed to
   * `GatePlugin({ getLevel })`), and answering with the framework's default
   * resolver would put a SECOND mapping on the wire that disagrees with the
   * one every request is actually graded by — silently, and only for callers
   * near a gate boundary.
   *
   *   level: shopGateLevel
   *
   * A UI reads the answer to decide what to offer. It is never a boundary.
   */
  level?: (session: SessionContext) => number
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

  // The three services this plugin registers — `account`, `sessions`,
  // `api-keys`. On by default: they are the other half of the auth surface,
  // and an app that has to opt in to reading its own session has no surface
  // at all until it does.
  //
  //   services: false                     register none of them
  //   services: { apiKeys: false }        the app has its own
  //   services: { sessions: 'devices' }   its own word for it
  //
  // A name already taken by another service is refused at boot, naming this
  // option — the registry is a Map, so the alternative is one of the two
  // silently replacing the other depending on registration order.
  services?: false | AuthServicesOptions
}
