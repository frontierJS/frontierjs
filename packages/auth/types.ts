// types.ts
// LitestoneAuthOptions  — passed to createLitestoneAuth(db, opts)
// AuthPluginOptions — passed to createAuthPlugin(auth, opts)

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

  // ─── OAuth ──────────────────────────────────────────────────────────────
  //
  // Providers live here rather than on the plugin because `clientSecret` is
  // credential material and this is already where `encryptionKey` goes —
  // splitting them would put half the app's secrets in each constructor. The
  // plugin names a provider and never holds one, which is what keeps it to its
  // own contract: it calls IAuth and touches no database.

  /**
   * Keyed by the name that appears in the URL and in `Credential.type`
   * (`oauth:<name>`). Build them with `defineProvider`.
   *
   *   oauthProviders: {
   *     google: defineProvider('google', 'google', { clientId, clientSecret }),
   *   }
   *
   * Absent means the app does no OAuth, and the routes refuse by name.
   */
  oauthProviders?: Record<string, import('./oauth.ts').OAuthProvider>

  /**
   * How long a person has between being sent to the provider and coming back.
   * Default '10 minutes' — long enough for a password manager and a second
   * factor, short enough that an abandoned flow is not a row somebody can come
   * back to tomorrow.
   */
  oauthFlowTtl?: string

  /**
   * Where the browser may be sent after a flow. Same-origin paths only; an
   * entry ending in `/` covers what is under it.
   *
   * Checked when the flow STARTS, so the value stored on the row is already
   * known good and the callback has nothing left to decide. Empty means no
   * `returnTo` is ever honoured, which is the safe default: an open redirector
   * is how an authorization code leaves the building, and RFC 9700 states that
   * as a MUST rather than as hardening.
   */
  oauthReturnToAllow?: string[]

  /**
   * How long a pending link invitation is good for. Default '1 hour' — the same
   * order as a password reset, because it is the same act: proving you control
   * an address.
   */
  oauthLinkTtl?: string

  /**
   * An OAuth identity wants to attach to an account that has NOT proved it owns
   * this address, so the address is being asked to prove itself. Send the link.
   *
   * The token is the raw value; build a URL to `/auth/oauth/link/confirm`.
   *
   * REQUIRED for the recovery path to exist at all. Without it the rule still
   * holds — the identity is refused and nothing unsafe happens — but there is
   * no way through, and a person whose address collides can never sign in. This
   * is the same shape as `onPasswordResetRequested`: optional to the type
   * system, a required performer in practice.
   *
   *   onOAuthLinkRequested: async ({ email, token, provider }) => {
   *     await mailer.send({
   *       to:      email,
   *       subject: `Connect ${provider} to your account`,
   *       html:    `<a href="${APP_URL}/auth/oauth/link/confirm?token=${token}">Connect</a>`,
   *     })
   *   }
   */
  onOAuthLinkRequested?: (event: {
    email:    string
    token:    string
    provider: string
  }) => Promise<void> | void
}

// ─── createAuthServices options ───────────────────────────────────────

export interface AuthServicesOptions {
  /** Rename the service, or `false` to not register it at all. */
  account?:  string | false
  sessions?: string | false
  apiKeys?:  string | false
  /** Which providers are attached, and detaching one. */
  connections?: string | false

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

  /**
   * Mount the OAuth routes. Absent = no OAuth surface at all.
   *
   * The providers themselves are `LitestoneAuthOptions.oauthProviders`, not
   * here — `clientSecret` is credential material and belongs beside
   * `encryptionKey`. This block is only what the TRANSPORT needs to know.
   */
  oauth?: OAuthRouteOptions
}

export interface OAuthRouteOptions {
  /**
   * This app's public origin — `https://shop.test`, no trailing slash.
   *
   * Stated rather than derived, and there is no way around that: behind a proxy
   * the server sees neither its own hostname nor its scheme, and a provider
   * matches the redirect URI as an EXACT string — RFC 9700 removed pattern
   * matching from the acceptable set. A derived value that is wrong fails 100%
   * of the time and is visible only at the provider, never in these logs.
   */
  publicUrl: string

  /**
   * Where a FAILED callback sends the browser. Default `/`.
   *
   * The callback is a browser navigation, not an XHR — every other route in
   * this plugin answers JSON to a `fetch()`, and this one arrives as a redirect
   * from the provider into somebody's address bar. So a refusal cannot be a 400
   * with a JSON body: a person who clicks *Deny*, or comes back to an expired
   * flow, would be looking at `{"error":...}` in the URL bar.
   *
   * The path is sent `?oauth_error=<code>`, where the code is one of
   * `denied` · `state` · `exchange` · `unavailable` · `link_required` —
   * deliberately coarse, and never the provider's own message, which is
   * attacker-influenced text headed for a screen.
   *
   * `link_required` is the one that says something specific: an account holds
   * this address and has not proved it owns it. That discloses the address
   * exists — which `POST /auth/register` already discloses by answering 409,
   * so hiding it here would buy nothing and leave somebody who cannot sign in
   * with no idea why.
   */
  errorRedirect?: string

  /**
   * Starting a flow WRITES A ROW, unauthenticated, once per click. Default
   * `{ max: 20, window: '15 minutes' }`.
   */
  rateLimit?: RateLimitHookOptions
}
