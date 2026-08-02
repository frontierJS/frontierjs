// auth/providers/better-auth.ts
// Better Auth adapter — the ONLY file that imports from better-auth.
// Implements the IAuth interface from auth/types.ts.
// Everything else in the framework imports from auth/types.ts only.

import type {
  IAuth, SessionContext,
  CreateUserInput, ApiKeyOptions
} from '../types.ts'

// ─── Better Auth options ──────────────────────────────────────────────────

export interface BetterAuthAdapterOptions {
  // The Better Auth app instance
  auth:        BetterAuthInstance

  // How to map Better Auth's session/user shape to SessionContext.
  // Provide if your user model has custom fields.
  mapSession?: (session: BetterAuthSession) => SessionContext
}

// ─── Better Auth internal types ───────────────────────────────────────────
// Minimal types — we don't import @better-auth/core types directly
// to keep the adapter loosely coupled.

interface BetterAuthSession {
  session: {
    id:        string
    userId:    string
    expiresAt: string
    token:     string
  }
  user: {
    id:        string
    email:     string
    name?:     string
    role?:     string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
}

interface BetterAuthInstance {
  api: {
    getSession:  (opts: { headers: Headers }) => Promise<BetterAuthSession | null>
    signInEmail: (opts: { body: { email: string; password: string } }) => Promise<{ token?: string; session?: BetterAuthSession }>
    signOut:     (opts: { headers: Headers }) => Promise<void>
    createUser:  (opts: { body: CreateUserInput }) => Promise<BetterAuthSession>
    deleteUser:  (opts: { body: { userId: string } }) => Promise<void>
  }
  handler: (req: Request) => Promise<Response>
  options: Record<string, unknown>
}

// ─── Default session mapper ───────────────────────────────────────────────

function defaultMapSession(session: BetterAuthSession): SessionContext {
  return {
    userId:      session.user.id,
    userType:    (session.user.role as string) ?? 'user',
    email:       session.user.email,
    name:        session.user.name ?? undefined,
    accountId:   (session.user.metadata?.accountId as string)   ?? undefined,
    workspaceId: (session.user.metadata?.workspaceId as string) ?? undefined,
    role:        session.user.role ?? undefined,
    scopes:      (session.user.metadata?.scopes as string[])    ?? undefined,
    authMethod:  'session',
  }
}

// ─── Adapter factory ──────────────────────────────────────────────────────

export function createBetterAuthAdapter(opts: BetterAuthAdapterOptions): IAuth {

  const { auth, mapSession = defaultMapSession } = opts

  return {

    // ── verifySession ─────────────────────────────────────────
    // Called by the bridge on every request with a Bearer token.
    // Handles both session tokens and API keys transparently.

    async verifySession(token: string): Promise<SessionContext | null> {

      // Try as API key first (if it has the API key prefix pattern)
      if (isApiKeyFormat(token)) {
        return this.verifyApiKey(token)
      }

      // Try as session token
      const headers = new Headers({ cookie: `better-auth.session_token=${token}` })

      try {
        const session = await auth.api.getSession({ headers })
        if (!session) return null
        return mapSession(session)
      } catch {
        return null
      }
    },

    // ── login ─────────────────────────────────────────────────

    async login(email: string, password: string): Promise<{ token: string; user: SessionContext }> {
      const result = await auth.api.signInEmail({
        body: { email, password }
      })

      if (!result.session || !result.token) {
        throw new Error('Login failed — invalid credentials')
      }

      return {
        token: result.token,
        user:  mapSession(result.session)
      }
    },

    // ── logout ────────────────────────────────────────────────

    async logout(token: string): Promise<void> {
      const headers = new Headers({ authorization: `Bearer ${token}` })
      await auth.api.signOut({ headers })
    },

    // ── createUser ────────────────────────────────────────────

    async createUser(data: CreateUserInput): Promise<SessionContext> {
      const result = await auth.api.createUser({ body: data })
      return mapSession(result)
    },

    // ── deleteUser ────────────────────────────────────────────

    async deleteUser(userId: string): Promise<void> {
      await auth.api.deleteUser({ body: { userId } })
    },

    // ── createApiKey ──────────────────────────────────────────
    // Delegates to Better Auth's API key plugin (if enabled).

    async createApiKey(
      userId: string,
      opts_?: ApiKeyOptions
    ): Promise<{ key: string; id: string }> {
      const apiKeyApi = (auth.api as Record<string, Function>).createApiKey
      if (!apiKeyApi)
        throw new Error('Better Auth apiKey plugin not enabled')

      const result = await apiKeyApi({
        body: { userId, name: opts_?.name, expiresAt: opts_?.expiresAt }
      }) as { key: string; id: string }

      return result
    },

    // ── revokeApiKey ──────────────────────────────────────────

    async revokeApiKey(keyId: string): Promise<void> {
      const revokeApi = (auth.api as Record<string, Function>).revokeApiKey
      if (!revokeApi)
        throw new Error('Better Auth apiKey plugin not enabled')
      await revokeApi({ body: { keyId } })
    },

    // ── verifyApiKey ──────────────────────────────────────────

    async verifyApiKey(key: string): Promise<SessionContext | null> {
      const verifyApi = (auth.api as Record<string, Function>).verifyApiKey
      if (!verifyApi) return null

      try {
        const result = await verifyApi({ body: { key } }) as BetterAuthSession | null
        if (!result) return null
        return { ...mapSession(result), authMethod: 'apiKey' }
      } catch {
        return null
      }
    },

    // ── TOTP ──────────────────────────────────────────────────

    async setupTotp(userId: string): Promise<{ secret: string; qr: string }> {
      const totpApi = (auth.api as Record<string, Function>).totpSetup
      if (!totpApi)
        throw new Error('Better Auth TOTP plugin not enabled')
      return totpApi({ body: { userId } })
    },

    async verifyTotp(userId: string, code: string): Promise<boolean> {
      const totpApi = (auth.api as Record<string, Function>).totpVerify
      if (!totpApi) return false
      try {
        await totpApi({ body: { userId, code } })
        return true
      } catch {
        return false
      }
    },

    // ── OAuth ─────────────────────────────────────────────────

    async getOAuthUrl(provider: string, redirectUri: string): Promise<string> {
      const oauthApi = (auth.api as Record<string, Function>).getAuthorizationUrl
      if (!oauthApi)
        throw new Error('Better Auth OAuth plugin not enabled')
      const result = await oauthApi({ body: { provider, redirectUri } }) as { url: string }
      return result.url
    },

    async handleOAuthCallback(
      provider: string,
      code:     string,
      state:    string
    ): Promise<SessionContext> {
      const callbackApi = (auth.api as Record<string, Function>).handleCallback
      if (!callbackApi)
        throw new Error('Better Auth OAuth plugin not enabled')
      const result = await callbackApi({ body: { provider, code, state } }) as BetterAuthSession
      return mapSession(result)
    },

    // ── Multi-tenancy ─────────────────────────────────────────

    async addMember(workspaceId: string, userId: string, role: string): Promise<void> {
      const addApi = (auth.api as Record<string, Function>).addMember
      if (!addApi)
        throw new Error('Better Auth organization plugin not enabled')
      await addApi({ body: { workspaceId, userId, role } })
    },

    async removeMember(workspaceId: string, userId: string): Promise<void> {
      const removeApi = (auth.api as Record<string, Function>).removeMember
      if (!removeApi)
        throw new Error('Better Auth organization plugin not enabled')
      await removeApi({ body: { workspaceId, userId } })
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// FJS API keys use the 'fjs_' prefix pattern.
// BetterAuth session tokens are UUIDs — no prefix.
function isApiKeyFormat(token: string): boolean {
  return /^[a-z]{2,8}_[a-z0-9_]{8,}$/i.test(token)
}

// ─── Auth plugin for the framework ────────────────────────────────────────
// Mounts Better Auth's own HTTP handler at /auth/* routes.
// Lets Better Auth handle its own login/oauth/session endpoints.

export function createBetterAuthPlugin(auth: BetterAuthInstance): import('../../core/app.ts').Plugin {
  return {
    name: 'better-auth',

    // Uses the real App/RouteHandler types — this plugin previously defined
    // its own ad-hoc structural app type ({ get: Function; ... }).
    register(app: import('../../core/app.ts').App) {

      // Mount Better Auth's handler on all /auth/* routes.
      // Better Auth handles: /auth/sign-in, /auth/sign-up, /auth/callback, etc.
      const handler: import('../../transport/types.ts').RouteHandler = async (ctx) => {
        return auth.handler((ctx.$raw as { $req: Request }).$req)
      }

      app.get   ('/auth/{path}', handler)
      app.post  ('/auth/{path}', handler)
      app.put   ('/auth/{path}', handler)
      app.patch ('/auth/{path}', handler)
      app.delete('/auth/{path}', handler)
    }
  }
}
