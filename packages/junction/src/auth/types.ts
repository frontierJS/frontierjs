// auth/types.ts
// The IAuth interface — every auth provider must implement this.
// Better Auth lives ONLY in auth/providers/better-auth.ts
// The rest of the framework imports from here only.

export interface SessionContext {
  userId:       string
  userType:     string        // 'user' | 'admin' | 'service'
  email?:       string
  name?:        string
  accountId?:   string
  workspaceId?: string
  role?:        string
  scopes?:      string[]
  authMethod:   'session' | 'apiKey' | 'oauth' | 'created' | 'verified'

  /**
   * Which session row this token is — set on the `session` path.
   * A caller listing where they are signed in has to be told which row is the
   * one they are asking from, and comparing raw tokens to work that out would
   * mean putting a bearer token in front of application code.
   */
  sessionId?: string

  /**
   * Which credential proved this session — set on the `apiKey` path.
   * An app that records per-key usage, or shows a key's last-used time, has no
   * other way to ask: two keys belonging to one user produce two sessions that
   * are otherwise identical.
   */
  credentialId?: string

  // ── Standing, for @@gate ──────────────────────────────────────────────
  // Read by sessionGateLevel() (core/litestone.ts) to grade a caller on
  // Litestone's 0–7 scale. All optional, and the distinction between
  // `undefined` and `null` is the whole design:
  //
  //   undefined → the app does not model this stage. Not an objection.
  //   null      → the app models it and this user has not reached it.
  //
  // So an app with no verification flow leaves verifiedAt unset and its
  // sessions grade as USER; an app that has one sets it to null until the
  // user verifies, and those sessions grade as VISITOR. Absence never means
  // "not yet" — otherwise every app would have to restate a lifecycle it
  // does not have in order to make @@gate usable at all.

  /** When the user verified (email, phone, …). null = modelled, not verified. */
  verifiedAt?:     Date | string | null
  /** When the account became active (plan chosen, invite accepted, …). */
  activatedAt?:    Date | string | null
  /** App-level administrator → ADMINISTRATOR (5). */
  isAdmin?:        boolean
  /** Account/tenant owner → OWNER (6). */
  isOwner?:        boolean
  /** Global super-admin, a real revocable human → SYSADMIN (7). */
  isSystemAdmin?:  boolean
}

// ─── Full auth interface ──────────────────────────────────────────────────

export interface IAuth {
  // Session
  verifySession(token: string):              Promise<SessionContext | null>
  login(email: string, password: string):    Promise<{ token: string; user: SessionContext }>
  logout(token: string):                     Promise<void>

  // Users
  createUser(data: CreateUserInput):         Promise<SessionContext>
  deleteUser(userId: string):                Promise<void>

  /**
   * Build a session for a user who is not presenting a credential.
   *
   * The re-resolution `app.runAs(userId, …)` needs, and the only way deferred
   * work can run as the caller who asked for it: a job outlives the request, so
   * by the time it runs there is no token to verify and no session to inherit —
   * only an id that was recorded when it was enqueued.
   *
   * Deliberately not a stored snapshot of the original session. A caller demoted
   * between asking and running must be graded at the standing they hold NOW;
   * replaying yesterday's session is a captured privilege that outlives its own
   * revocation. So this reads the user afresh and grades them afresh.
   *
   * Returns null for a user who no longer exists. **This proves no credential**
   * — it is reached only from code that has already decided whose behalf it acts
   * on, and it must never be wired to anything a request can name.
   */
  sessionFor?(userId: string):               Promise<SessionContext | null>

  // Registration flow (optional — provider may handle differently)
  requestPasswordReset?(email: string):                Promise<void>
  confirmPasswordReset?(token: string, newPassword: string): Promise<void>
  requestEmailVerification?(userId: string):           Promise<void>
  verifyEmail?(token: string):                         Promise<SessionContext>

  // API Keys
  createApiKey(userId: string, opts?: ApiKeyOptions):  Promise<{ key: string; id: string }>
  revokeApiKey(keyId: string, opts?: { userId?: string }): Promise<void>
  verifyApiKey(key: string):                           Promise<SessionContext | null>

  // ── The caller acting on their own credentials ────────────────────────
  //
  // Optional, because a provider may hold none of it — the services in
  // @frontierjs/auth answer 400 by name for the ones their provider lacks,
  // the same way the /auth routes already do for password reset.
  //
  // Every one takes the userId as its FIRST argument and scopes to it. That is
  // the ownership boundary: these are reached from a service where the caller
  // supplies the id of the thing, and a revoke that only matched on that id
  // would revoke somebody else's.

  /** Verify the current password, then replace it. Throws if it does not verify. */
  changePassword?(userId: string, currentPassword: string, newPassword: string): Promise<void>

  /** The user's live sessions. Never carries the token — see AuthSessionInfo. */
  listSessions?(userId: string):                       Promise<AuthSessionInfo[]>

  /** Revoke one session of this user's. Throws if it is not theirs. */
  revokeSession?(userId: string, sessionId: string):   Promise<void>

  /** Revoke every session of this user's, optionally keeping the one presenting. */
  revokeSessions?(userId: string, opts?: { exceptSessionId?: string }): Promise<number>

  /** The user's API keys. Never carries the key — it exists once, at creation. */
  listApiKeys?(userId: string):                        Promise<ApiKeyInfo[]>

  // TOTP (optional — provider may not support)
  setupTotp?(userId: string):                Promise<{ secret: string; qr: string }>
  verifyTotp?(userId: string, code: string): Promise<boolean>

  // OAuth (optional)
  getOAuthUrl?(provider: string, redirectUri: string):                   Promise<string>
  handleOAuthCallback?(provider: string, code: string, state: string):  Promise<SessionContext>

  // Multi-tenancy (optional)
  addMember?(workspaceId: string, userId: string, role: string): Promise<void>
  removeMember?(workspaceId: string, userId: string):            Promise<void>
}

/**
 * What JUNCTION requires of an auth provider — which is what Junction CALLS.
 *
 * `verifySession` and nothing else. It is invoked on both inbound paths
 * (`transport/http.ts`, HTTP and the WS upgrade); `sessionFor` is reached only
 * from `app.runAs`, which throws by name when a provider lacks it rather than
 * downgrading the caller to STRANGER(0).
 *
 * `IAuth` declares six required methods and this package invokes two of them —
 * `login`, `logout`, `createUser` and `deleteUser` are called by
 * `@frontierjs/auth`'s own `/auth/*` routes and by nothing here. So an app
 * authenticating against something it already has had to stub four methods
 * that would never run, and a stub that throws cannot be told apart from a
 * provider that works until the day something calls it. `FJS-D10`.
 *
 *   createApp({ auth: { verifySession: t => lookup(t) } })
 *
 * DERIVED from `IAuth` rather than declared beside it, and that is load-bearing
 * twice over. A hand-written member list would drift the moment `IAuth` gained
 * a method. And `Partial<IAuth>` is what makes a FULLER provider assignable:
 * TypeScript's excess-property check rejects an object literal carrying a key
 * the target does not name, so a narrow interface listing only `verifySession`
 * would refuse `{ verifySession, login, … }` — the very providers this exists
 * to accept.
 */
export type SessionVerifier = Pick<IAuth, 'verifySession'> & Partial<IAuth>

// ─── Supporting input types ───────────────────────────────────────────────

export interface CreateUserInput {
  email:        string
  password?:    string
  name?:        string
  role?:        string
  workspaceId?: string
  metadata?:    Record<string, unknown>
}

export interface ApiKeyOptions {
  name?:      string
  expiresAt?: Date
  scopes?:    string[]
}

// ─── What the caller may be shown about their own credentials ─────────────
//
// Both are deliberately not the row. A session row holds the bearer token and
// a credential row holds the API key's hash; either one on the wire turns a
// list into a way to take over the account it describes, and a service that
// selected columns by hand would be one `select` away from doing it.

export interface AuthSessionInfo {
  id:         string
  createdAt?: Date | string | null
  expiresAt?: Date | string | null
  /** True for the session that made this request — the one a UI must not offer to revoke without saying so. */
  current:    boolean
}

export interface ApiKeyInfo {
  id:         string
  /** The name the key was issued with — `label` on the Credential row. */
  name:       string | null
  scopes:     string[]
  createdAt?: Date | string | null
  expiresAt?: Date | string | null
}

// ─── Rate limit hook options ──────────────────────────────────────────────
// Lives here so @frontierjs/auth can import it without a circular dep.
// The implementation lives in core/hooks.ts.

export interface RateLimitHookOptions {
  max:      number
  window:   string    // human-readable: '15 minutes', '1 hour', '30 seconds'
  key?:     (ctx: import('../transport/bridge.ts').ServiceContext) => string
  message?: string
}
