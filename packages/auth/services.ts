// services.ts
// createAuthServices(auth, opts): Service[]
//
// The half of auth that is NOT a route.
//
// `/auth/*` is where a session is established, and it bypasses the Service
// abstraction because login cannot be gated by login. Everything a caller does
// to their own credentials AFTERWARDS can be refused for want of a session —
// so it is an ordinary service, and gets hooks, the audit trail, both
// transports and the browser client for free (DECISIONS.md § API design).
//
//   account    GET  /account/me            who this token is
//              POST /account/me            X-Service-Method: changePassword
//   sessions   GET  /sessions              where else am I signed in
//              DEL  /sessions/{id}         end one of them
//              POST /sessions              X-Service-Method: revokeOthers
//   api-keys   GET/POST /api-keys · DEL /api-keys/{id}
//   connections GET /connections      which providers are attached
//               DEL /connections/{id} detach one
//
// Three nouns rather than one grab-bag service, and each one is the caller's
// OWN: every method here scopes to `ctx.auth.user.userId` and nothing takes a
// user id from the caller. An operator acting on somebody else's account is a
// different service with a different gate, and this is not it.
//
// A provider that implements none of the optional IAuth methods still loads:
// each method answers 400 by name, the way the /auth routes already do for
// password reset.

import { createService, BadRequest, Unauthorized, Forbidden, NotFound } from '@frontierjs/junction'
import type { IAuth, SessionContext, ServiceContext, Service } from '@frontierjs/junction'
import type { AuthServicesOptions } from './types.ts'
import type { AuthOAuth }           from './oauth.ts'

// The OAuth half is not on IAuth and must not be — junction knows nothing about
// a redirect flow (`FJS-D10`). It is Partial here for the same reason every
// optional IAuth method is: a third-party provider has none of it, and the
// service says so by name rather than by 500.
type AuthSurface = IAuth & Partial<AuthOAuth>

/** Defaults, in one place — the plugin and the browser client both name them. */
export const DEFAULT_SERVICE_NAMES = {
  account:  'account',
  sessions: 'sessions',
  apiKeys:  'api-keys',
  connections: 'connections',
} as const

export function createAuthServices(auth: AuthSurface, opts: AuthServicesOptions = {}): Service[] {

  const level = opts.level

  const names = {
    account:  opts.account  ?? DEFAULT_SERVICE_NAMES.account,
    sessions: opts.sessions ?? DEFAULT_SERVICE_NAMES.sessions,
    apiKeys:  opts.apiKeys  ?? DEFAULT_SERVICE_NAMES.apiKeys,
    connections: opts.connections ?? DEFAULT_SERVICE_NAMES.connections,
  }

  for (const [key, name] of Object.entries(names)) {
    if (name === false) continue
    // A service name is one path segment — `{service}` in the route pattern
    // matches exactly one, so a name with a slash registers fine and then 404s
    // forever with nothing saying why. Conduit's management path learned this
    // the same way.
    if (typeof name !== 'string' || !name || name.includes('/')) {
      throw new Error(
        `[auth] services.${key} must be a single path segment or false, got ${JSON.stringify(name)}`
      )
    }
  }

  /** The caller, or a 401. Every method below starts here. */
  function caller(ctx: ServiceContext): SessionContext {
    const user = ctx.auth?.user as SessionContext | null | undefined
    if (!user?.userId) throw new Unauthorized('Authentication required')
    return user
  }

  /**
   * SUPPORT MODE — the refusals, and they are what makes an episode bounded.
   *
   * An operator inside an episode resolves as the subject, so every method here
   * would act on the subject's own account, which is mostly the point: reading
   * their sessions and their connections is how you see what they see. What is
   * NOT the point is the door out of the episode — a password changed, an API
   * key minted, a session revoked — because each of those outlives the episode
   * that produced it. Mint a key while impersonating and the ceiling has been
   * escaped permanently, with the trail showing an ordinary key issue.
   *
   * A caller with no episode is unaffected, which is what every test of this
   * asserts beside the refusal: a guard that refused everybody would look
   * identical from the refused side (`FJS-351`).
   *
   * The subject is named in the message, because the operator has to know whose
   * account they are being kept out of.
   */
  function refuseInSupport(user: SessionContext, what: string): void {
    if (!user.support) return
    throw new Forbidden(
      `Cannot ${what} while acting as another user. End the support session first ` +
      `(POST /auth/support/end) — this account's credentials are not yours to change.`
    )
  }

  /** A provider that does not implement this one says so by name, not by 500. */
  function need<K extends keyof AuthSurface>(method: K): NonNullable<AuthSurface[K]> {
    const fn = auth[method]
    if (typeof fn !== 'function') {
      throw new BadRequest(`${String(method)} is not supported by this auth provider`)
    }
    return fn.bind(auth) as NonNullable<AuthSurface[K]>
  }

  const services: Service[] = []

  // ─── account ──────────────────────────────────────────────────────────────

  if (names.account !== false) services.push(createService({
    name: names.account as string,

    // Without `methods` the base service answers every CRUD verb it was not
    // given, and on a service with no model that is a 500 rather than a
    // refusal. It also throws at construction on a name not defined below.
    methods: ['get', 'changePassword'],

    // GET /account/me — the SessionContext the server built, not a User row.
    // A UI needs what the request will be graded as, which is the session; the
    // row is the `users` service's answer and is a different question.
    async get(ctx: ServiceContext) {
      const user = caller(ctx)
      // `me` is the address, and the caller's own id is accepted because a
      // link built from `session.userId` is the obvious second spelling.
      // Anything else is a 404 rather than a 403: whether that id exists is
      // not this service's to disclose.
      if (ctx.id !== 'me' && String(ctx.id) !== user.userId) {
        throw new NotFound(`No account '${ctx.id}' — this service answers for the caller ('me')`)
      }
      // `level` is opt-in and absent by default. The app owns the role→level
      // mapping (its own getLevel), and a default answer here would be a
      // SECOND mapping that disagrees with the one every request is graded by.
      return level ? { ...user, level: level(user) } : { ...user }
    },

    // The current password is sent and verified, so a stolen session cannot
    // become a stolen account. IAuth does the verifying — the check belongs
    // beside the hash it compares against.
    async changePassword(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseInSupport(user, 'change a password')
      const { currentPassword, newPassword } = (ctx.data ?? {}) as Record<string, string>
      if (!currentPassword) throw new BadRequest('currentPassword is required')
      if (!newPassword)     throw new BadRequest('newPassword is required')

      await need('changePassword')(user.userId, currentPassword, newPassword)
      return { ok: true }
    },
  }))

  // ─── sessions ─────────────────────────────────────────────────────────────

  if (names.sessions !== false) services.push(createService({
    name: names.sessions as string,
    methods: ['find', 'remove', 'revokeOthers'],

    // An array is a list, which is what `find` must answer. No token on any
    // row — see AuthSessionInfo.
    async find(ctx: ServiceContext) {
      const user = caller(ctx)
      const rows = await need('listSessions')(user.userId)
      // The one row the caller is asking FROM. Marked here rather than in the
      // data layer, which is not told which token presented.
      return rows.map(s => ({ ...s, current: Boolean(user.sessionId) && s.id === user.sessionId }))
    },

    async remove(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseInSupport(user, 'revoke a session')
      const id   = String(ctx.id)
      await need('revokeSession')(user.userId, id)
      // Ending the session that is asking is allowed — "sign out this device"
      // from a device list is the same operation as logging out — but it is
      // said in the answer, because the next request from this token is a 401
      // and a UI that did not expect it reads as the app breaking.
      return { id, current: id === user.sessionId }
    },

    async revokeOthers(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseInSupport(user, 'revoke sessions')
      const revoked = await need('revokeSessions')(user.userId, { exceptSessionId: user.sessionId })
      return { revoked }
    },
  }))

  // ─── api-keys ─────────────────────────────────────────────────────────────

  if (names.apiKeys !== false) services.push(createService({
    name: names.apiKeys as string,
    methods: ['find', 'create', 'remove'],

    async find(ctx: ServiceContext) {
      const user = caller(ctx)
      return need('listApiKeys')(user.userId)
    },

    // The raw key exists in this response and nowhere else — what is stored is
    // an HMAC of it, so there is no second chance to read it.
    async create(ctx: ServiceContext) {
      const user = caller(ctx)
      // The sharpest one. A key minted here authenticates as the subject for as
      // long as it lives, which is the episode's ceiling escaped for good.
      refuseInSupport(user, 'create an API key')
      const { name, scopes, expiresAt } = (ctx.data ?? {}) as {
        name?: string; scopes?: string[]; expiresAt?: string
      }
      if (scopes !== undefined && !Array.isArray(scopes)) throw new BadRequest('scopes must be an array')

      // Scopes NARROW: a key authenticates as its owner and a scope list is
      // subtractive at the app's own check, so a caller cannot mint themselves
      // standing they do not have by asking for it here.
      const { id, key } = await auth.createApiKey(user.userId, {
        ...(name      ? { name }   : {}),
        ...(scopes    ? { scopes } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      })
      return { id, key, name: name ?? null, scopes: scopes ?? [] }
    },

    async remove(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseInSupport(user, 'revoke an API key')
      const id   = String(ctx.id)
      // The owner goes into the delete rather than being checked after a read:
      // the id comes from the caller, and matching on it alone revokes any key
      // in the system whose id can be guessed.
      await auth.revokeApiKey(id, { userId: user.userId })
      return { id }
    },
  }))

  // ─── connections ──────────────────────────────────────────────────────────
  //
  // The providers attached to this account. A SERVICE and not a route, and the
  // line is `FJS-D20`'s: `/auth/oauth/*` establishes a session, and nothing
  // here does — a caller managing what can sign them in is already signed in.

  if (names.connections !== false) services.push(createService({
    name: names.connections as string,
    methods: ['find', 'remove'],

    async find(ctx: ServiceContext) {
      const user = caller(ctx)
      return need('listConnections')(user.userId)
    },

    async remove(ctx: ServiceContext) {
      const user = caller(ctx)
      // Detaching a provider is a way somebody signs in, so it is the same
      // class as the two above it.
      refuseInSupport(user, 'remove a connection')
      // The caller's own id, never one from the payload — the same rule the
      // three services above hold to.
      return need('removeConnection')(user.userId, String(ctx.id))
    },
  }))

  return services
}
