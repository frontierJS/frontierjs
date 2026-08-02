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

  // Registration flow (optional — provider may handle differently)
  requestPasswordReset?(email: string):                Promise<void>
  confirmPasswordReset?(token: string, newPassword: string): Promise<void>
  requestEmailVerification?(userId: string):           Promise<void>
  verifyEmail?(token: string):                         Promise<SessionContext>

  // API Keys
  createApiKey(userId: string, opts?: ApiKeyOptions):  Promise<{ key: string; id: string }>
  revokeApiKey(keyId: string):                         Promise<void>
  verifyApiKey(key: string):                           Promise<SessionContext | null>

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

// ─── Rate limit hook options ──────────────────────────────────────────────
// Lives here so @frontierjs/auth can import it without a circular dep.
// The implementation lives in core/hooks.ts.

export interface RateLimitHookOptions {
  max:      number
  window:   string    // human-readable: '15 minutes', '1 hour', '30 seconds'
  key?:     (ctx: import('../transport/bridge.ts').ServiceContext) => string
  message?: string
}
