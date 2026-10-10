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
//   account-recovery POST /account-recovery/{userId}  X-Service-Method: resetTotp
//   people     GET  /people/{userId}               their sessions and API keys
//              POST /people/{userId}               X-Service-Method: revokeSession ·
//                                                  revokeApiKey · signOut
//              DEL  /people/{userId}               the account and its credentials
//              POST /people                        X-Service-Method: invite
//
// Four nouns are the caller's OWN: every method on them scopes to
// `ctx.auth.user.userId` and nothing takes a user id from the caller.
// `account-recovery` is the exception and is a service of its own for that
// reason — an operator acting on somebody else's account, where the id IS the
// person, behind a floor none of the other four have.
//
// A provider that implements none of the optional IAuth methods still loads:
// each method answers 400 by name, the way the /auth routes already do for
// password reset.

import { createService, rateLimitHook, BadRequest, Unauthorized, Forbidden, NotFound, LEVELS } from '@frontierjs/junction'
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
  accountRecovery: 'account-recovery',
  people:   'people',
} as const

export function createAuthServices(auth: AuthSurface, opts: AuthServicesOptions = {}): Service[] {

  const level = opts.level
  // Recovery grades the operator AND the person, which `account.me`'s level
  // need not answer — an app whose level is per tenant has none for a bare
  // session, and `account.me` is what a browser gates its buttons on.
  const standingLevel = opts.standingLevel ?? opts.level

  // ─── The password, asked again ─────────────────────────────────────────
  //
  // Every method that verifies the CURRENT password is an oracle for it, to
  // whoever holds the session — and a stolen session is exactly the caller
  // these methods exist to stop. `/auth/login` is limited and these were not,
  // so the side door answered as many guesses as it was sent (four doors, one
  // bucket, or a guesser spreads the attempts across them).
  //
  // Keyed by the account, which is the limiter's own default for a caller with
  // a session. The default is login's own budget, so this is no wider than the
  // front door. The sweep timer lives as long as the services, which is
  // junction's stated position for a service-level limiter.
  const reauthenticate = rateLimitHook(opts.reauthenticationRateLimit ?? {
    max:     10,
    window:  '15 minutes',
    message: 'Too many password attempts on this account. Wait a few minutes and try again.',
  })

  const names = {
    account:  opts.account  ?? DEFAULT_SERVICE_NAMES.account,
    sessions: opts.sessions ?? DEFAULT_SERVICE_NAMES.sessions,
    apiKeys:  opts.apiKeys  ?? DEFAULT_SERVICE_NAMES.apiKeys,
    connections: opts.connections ?? DEFAULT_SERVICE_NAMES.connections,
    accountRecovery: opts.accountRecovery ?? DEFAULT_SERVICE_NAMES.accountRecovery,
    people:   opts.people   ?? DEFAULT_SERVICE_NAMES.people,
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

  /** The caller, or a 401 — whatever credential presented. Only `account.get` stops here. */
  function identify(ctx: ServiceContext): SessionContext {
    const user = ctx.auth?.user as SessionContext | null | undefined
    if (!user?.userId) throw new Unauthorized('Authentication required')
    return user
  }

  /**
   * The caller, or a 401 — and a 403 for any API key, scoped or not. Every
   * method on the caller's own credentials except `account.get` starts here.
   *
   * Managing credentials takes a session (`FJS-D615`). A key that reaches
   * these services mints itself another key, signs its owner out of every
   * session — it has no `sessionId`, so *others* is all of them — and revokes
   * the owner's other keys (`FJS-1446`), so revoking a leaked key does not
   * contain it: the key it minted is still live. A scope does not help here,
   * since no scope an app declares names these services. Reading is refused
   * too: a session list is IPs and devices, which is not what a key was
   * handed out for.
   */
  function caller(ctx: ServiceContext): SessionContext {
    const user = identify(ctx)
    if (user.authMethod === 'apiKey') {
      throw new Forbidden(
        `An API key cannot manage this account's credentials — sign in to do it.`
      )
    }
    return user
  }

  /**
   * The caller acting on somebody ELSE's account — `people` and
   * `account-recovery`. An unscoped key passes, because an agent reaches
   * `/mcp` with one and reading people is what an admin agent is for; its
   * writes are `refuseDelegated`'s. A scoped key is refused, since no scope an
   * app declares names these services. `FJS-D615` ruled the caller's OWN
   * credentials and not these.
   */
  function operatorOf(ctx: ServiceContext): SessionContext {
    const user = identify(ctx)
    if (user.scopes?.length) {
      throw new Forbidden(
        `An API key with scopes (${user.scopes.join(', ')}) cannot manage accounts — sign in to do it.`
      )
    }
    return user
  }

  /**
   * A scope list a key can be minted with, or a 400 naming the bad entry.
   *
   * A scope is stored space-joined and read back split, so a blank entry
   * vanishes on the way back and the key is unscoped — `['']` asked for a
   * narrowed key and got its owner's whole standing (`FJS-1850`). An entry
   * holding whitespace comes back as two scopes the caller never named.
   */
  function scopeList(scopes: unknown): string[] | undefined {
    if (scopes === undefined) return undefined
    if (!Array.isArray(scopes)) throw new BadRequest('scopes must be an array')
    for (const s of scopes) {
      if (typeof s !== 'string' || !s || /\s/.test(s)) {
        throw new BadRequest(`scopes must be non-blank strings without spaces, got ${JSON.stringify(s)}`)
      }
    }
    return scopes
  }

  /**
   * DELEGATION — the refusals, and they are what makes a delegated caller
   * bounded.
   *
   * Two callers act for somebody without being them. An operator inside a
   * support episode resolves as the subject, and an agent over `/mcp` holds the
   * person's session (`FJS-D258`). Reading through either is the point —
   * seeing what somebody sees is what an episode is for, and an agent reading
   * its person's sessions is the person reading them. What is NOT the point is
   * the door out: a password changed, an API key minted, a session revoked —
   * each outlives the episode or the session that produced it. Mint a key from
   * either and the ceiling has been escaped permanently, with the trail showing
   * an ordinary key issue (`FJS-1795`).
   *
   * A caller who is neither is unaffected, which is what every test of this
   * asserts beside the refusal: a guard that refused everybody would look
   * identical from the refused side (`FJS-351`).
   *
   * The operator is told whose account they are kept out of, and the agent is
   * told where the person can do it themselves.
   */
  function refuseDelegated(ctx: ServiceContext, user: SessionContext, what: string): void {
    if (user.support) throw new Forbidden(
      `Cannot ${what} while acting as another user. End the support session first ` +
      `(POST /auth/support/end) — this account's credentials are not yours to change.`
    )
    if (ctx.transport === 'mcp') throw new Forbidden(
      `Cannot ${what} from an agent's tool call — it would outlive the session the agent ` +
      `was handed. The person signed in to the app can do it there.`
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

  /**
   * A method's declared level: a session the app grades at all.
   *
   * Every service here is over no model, so a bare method name is graded by
   * nothing and `/mcp` lists it as `ungraded` — permissive, and named in the
   * boot warning of every app that mounts it (`FJS-D408`, `FJS-1795`). VISITOR
   * is the floor and not a role: an unverified person still manages their own
   * credentials, and one the app grades STRANGER — suspended — does not.
   * `account-recovery`'s SYSADMIN floor is graded in its body by
   * `standingLevel`, which is not the resolver a declared level is graded by.
   *
   * Every service here says `model: null`. Its name is not a model: `sessions`
   * reaches this package's own `model Session` and `account` an app's
   * `model Account`, and a name that reaches a model is graded by its
   * `@@gate` — which refuses a declared level on a CRUD verb (`FJS-D408`).
   */
  const signedIn = (...methods: string[]) => methods.map(method => ({ method, gate: LEVELS.VISITOR }))

  /**
   * The operator and the person they are acting on. A write passes `what` and is
   * refused when delegated; a read does not. Not the operator themselves —
   * `sessions` and `api-keys` are that — and, where a resolver is given, not
   * anybody standing at or above them.
   */
  async function aim(ctx: ServiceContext, what?: string): Promise<{ operator: SessionContext; person: SessionContext }> {
    const operator = operatorOf(ctx)
    if (what) refuseDelegated(ctx, operator, what)
    const userId = String(ctx.id ?? '')
    if (!userId || userId === 'me' || userId === operator.userId) {
      throw new Forbidden('That is your own account — manage it from sessions and api-keys')
    }
    const person = await need('sessionFor')(userId)
    if (!person) throw new NotFound(`No user '${userId}'`)
    if (standingLevel) {
      const mine = standingLevel(operator)
      const theirs = standingLevel(person)
      if (!Number.isFinite(mine) || !Number.isFinite(theirs) || !(theirs < mine)) {
        throw new Forbidden('That account stands at or above yours — it cannot be managed from here')
      }
    }
    return { operator, person }
  }

  const services: Service[] = []

  // ─── account ──────────────────────────────────────────────────────────────

  if (names.account !== false) services.push(createService({
    name: names.account as string,
    model: null,

    // Without `methods` the base service answers every CRUD verb it was not
    // given, and on a service with no model that is a 500 rather than a
    // refusal. It also throws at construction on a name not defined below.
    methods: signedIn(
      'get', 'changePassword',
      // The second factor. On `account` rather than a service of its own for the
      // reason `changePassword` is here: it is a credential this account
      // authenticates with, not a collection the account owns — which is what
      // `sessions` and `api-keys` are. A fourth service would also be a fourth
      // configurable name, a fourth collision check and a fourth thing to
      // document, for one fact about one account.
      'totpStatus', 'setupTotp', 'confirmTotp', 'disableTotp', 'regenerateRecoveryCodes',
    ),

    // GET /account/me — the SessionContext the server built, not a User row.
    // A UI needs what the request will be graded as, which is the session; the
    // row is the `users` service's answer and is a different question.
    async get(ctx: ServiceContext) {
      // A key may still ask who holds it — how a page opened from a key
      // learns whose link it is.
      const user = identify(ctx)
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
      refuseDelegated(ctx, user, 'change a password')
      const { currentPassword, newPassword } = (ctx.data ?? {}) as Record<string, string>
      if (!currentPassword) throw new BadRequest('currentPassword is required')
      if (!newPassword)     throw new BadRequest('newPassword is required')

      reauthenticate(ctx)
      await need('changePassword')(user.userId, currentPassword, newPassword, { exceptSessionId: user.sessionId })
      return { ok: true }
    },

    // ── The second factor ────────────────────────────────────────────────
    //
    // Every method here is named exactly as the provider names it, so there is
    // no translation to keep in step — `need()` reads the same key a caller
    // typed. The three that change what the account REQUIRES take the password
    // again and are refused inside a support episode; reading whether it is on
    // is neither, for `sessions.find`'s reason: seeing what somebody sees is
    // what an episode is for.

    /** Is it on, and how many ways back are left. What a settings screen reads. */
    async totpStatus(ctx: ServiceContext) {
      const user = caller(ctx)
      return need('totpStatus')(user.userId)
    },

    /**
     * Begin enrollment. Answers the secret and the URI to render as a QR code.
     *
     * Enables nothing — `confirmTotp` does. A screen that treated this as *on*
     * would be describing an account that still signs in with a password alone.
     */
    async setupTotp(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseDelegated(ctx, user, 'enroll a second factor')
      const { currentPassword } = (ctx.data ?? {}) as Record<string, string>
      if (!currentPassword) throw new BadRequest('currentPassword is required')

      reauthenticate(ctx)
      return need('setupTotp')(user.userId, currentPassword)
    },

    /**
     * Prove the enrollment works, and switch it on. Answers the recovery codes.
     *
     * Refused in a support episode although it takes no password: the SUBJECT
     * may have an enrollment in flight, and an operator finishing it would be
     * putting a factor on an account it outlives the episode on.
     *
     * The codes are answered ONCE and are unreadable afterwards, so a caller
     * that drops this response has dropped them.
     */
    async confirmTotp(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseDelegated(ctx, user, 'enable a second factor')
      const { code } = (ctx.data ?? {}) as Record<string, string>
      if (!code) throw new BadRequest('code is required')

      return need('confirmTotp')(user.userId, code)
    },

    /** Switch it off and forget the secret and every recovery code. */
    async disableTotp(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseDelegated(ctx, user, 'disable a second factor')
      const { currentPassword } = (ctx.data ?? {}) as Record<string, string>
      if (!currentPassword) throw new BadRequest('currentPassword is required')

      reauthenticate(ctx)
      await need('disableTotp')(user.userId, currentPassword)
      return { ok: true }
    },

    /** Fresh recovery codes; the old ones stop working. Answered once. */
    async regenerateRecoveryCodes(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseDelegated(ctx, user, 'regenerate recovery codes')
      const { currentPassword } = (ctx.data ?? {}) as Record<string, string>
      if (!currentPassword) throw new BadRequest('currentPassword is required')

      reauthenticate(ctx)
      return need('regenerateRecoveryCodes')(user.userId, currentPassword)
    },
  }))

  // ─── sessions ─────────────────────────────────────────────────────────────

  if (names.sessions !== false) services.push(createService({
    name: names.sessions as string,
    model: null,
    methods: signedIn('find', 'remove', 'revokeOthers'),

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
      refuseDelegated(ctx, user, 'revoke a session')
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
      refuseDelegated(ctx, user, 'revoke sessions')
      const revoked = await need('revokeSessions')(user.userId, { exceptSessionId: user.sessionId })
      return { revoked }
    },
  }))

  // ─── api-keys ─────────────────────────────────────────────────────────────

  if (names.apiKeys !== false) services.push(createService({
    name: names.apiKeys as string,
    model: null,
    methods: signedIn('find', 'create', 'remove'),

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
      refuseDelegated(ctx, user, 'create an API key')
      const { name, scopes: asked, expiresAt } = (ctx.data ?? {}) as {
        name?: string; scopes?: unknown; expiresAt?: string
      }
      const scopes = scopeList(asked)

      // Scopes NARROW: a key authenticates as its owner and a scope list is
      // subtractive at the app's own check. A caller cannot mint themselves
      // standing they do not have by asking for it here, because no key
      // reaches this line (`caller`).
      const { id, key } = await auth.createApiKey(user.userId, {
        ...(name      ? { name }   : {}),
        ...(scopes    ? { scopes } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      })
      return { id, key, name: name ?? null, scopes: scopes ?? [] }
    },

    async remove(ctx: ServiceContext) {
      const user = caller(ctx)
      refuseDelegated(ctx, user, 'revoke an API key')
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
    model: null,
    methods: signedIn('find', 'remove'),

    async find(ctx: ServiceContext) {
      const user = caller(ctx)
      return need('listConnections')(user.userId)
    },

    async remove(ctx: ServiceContext) {
      const user = caller(ctx)
      // Detaching a provider is a way somebody signs in, so it is the same
      // class as the two above it.
      refuseDelegated(ctx, user, 'remove a connection')
      // The caller's own id, never one from the payload — the same rule the
      // three services above hold to.
      return need('removeConnection')(user.userId, String(ctx.id))
    },
  }))

  // ─── account-recovery ─────────────────────────────────────────────────────
  //
  // An operator acting on somebody else's credentials, for the person who has
  // lost the way back themselves. Removing a second factor takes off the one
  // thing standing between a stolen password and the account, and a help desk
  // is how that password's owner gets talked past — so the floor is SYSADMIN(7)
  // and it is not an option (`FJS-D264`). `startSupport` takes a guard instead
  // because who may act AS somebody varies by app; who may strip a protection
  // off somebody does not.
  //
  // Both people are graded by the app's own resolver — `standingLevel`, else
  // `level` — so this states a floor and never a second role→level mapping.
  // The person must grade BELOW the operator: a sysadmin cannot reset a peer,
  // which is also what keeps the reset from being the way one sysadmin's
  // compromise becomes two.

  if (names.accountRecovery !== false) services.push(createService({
    name: names.accountRecovery as string,
    model: null,
    methods: signedIn('resetTotp'),

    async resetTotp(ctx: ServiceContext) {
      const operator = operatorOf(ctx)
      // An episode resolves as the subject, so the operator would be graded as
      // somebody else — and a reset outlives the episode that made it.
      refuseDelegated(ctx, operator, "reset somebody's second factor")

      if (!standingLevel) {
        throw new Forbidden(
          'Account recovery needs the app\'s level resolver — pass services: { standingLevel } ' +
          'or services: { level } to createAuthPlugin'
        )
      }
      // Positive tests, and a number required. `undefined < 7` is false, so a
      // floor written as `level < SYSADMIN` let a resolver that answered no
      // number through, and the peer test beside it failed open the same way
      // (`FJS-1559`).
      const mine = standingLevel(operator)
      if (!Number.isFinite(mine) || !(mine >= LEVELS.SYSADMIN)) {
        throw new Forbidden('Resetting a second factor requires SYSADMIN (7)')
      }

      const userId = String(ctx.id ?? '')
      if (!userId || userId === 'me' || userId === operator.userId) {
        throw new Forbidden('Resetting your own second factor is account.disableTotp, which asks for your password')
      }

      const person = await need('sessionFor')(userId)
      if (!person) throw new NotFound(`No user '${userId}'`)
      const theirs = standingLevel(person)
      if (!Number.isFinite(theirs) || !(theirs < mine)) {
        throw new Forbidden('That account stands at or above yours — it cannot be reset from here')
      }

      return need('resetTotp')(userId, { actorId: operator.userId })
    },
  }))


  // ─── people ───────────────────────────────────────────────────────────────
  //
  // An operator looking at, and ending, the ways OTHER people are signed in —
  // the half of `sessions` and `api-keys` that is deliberately not the caller's
  // own — and inviting somebody in. The floor is ADMINISTRATOR(5), DECLARED, so
  // the app's own gate grades it and this states no second role→level mapping.
  // Where `standingLevel` (else `level`) is given the person must also grade
  // BELOW the operator, the rule `account-recovery` holds to: an administrator
  // cannot sign out a peer. Where it is absent that one check is skipped and
  // the floor is all there is.
  //
  // Reading is open to an agent over `/mcp`, as it is on `sessions`. Every write
  // is refused there and in a support episode: a signed-out person, a revoked
  // key and an invitation are each a way in or out that outlives the call. An
  // invitation also returns the token that sets a first password, which is a
  // credential in a response — so it is the sharpest of them.

  if (names.people !== false) services.push(createService({
    name: names.people as string,
    model: null,
    methods: ['get', 'revokeSession', 'revokeApiKey', 'signOut', 'remove', 'invite']
      .map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),

    async get(ctx: ServiceContext) {
      const { person } = await aim(ctx)
      const [sessions, apiKeys] = await Promise.all([
        need('listSessions')(person.userId),
        need('listApiKeys')(person.userId),
      ])
      return { userId: person.userId, sessions, apiKeys }
    },

    async revokeSession(ctx: ServiceContext) {
      const { operator, person } = await aim(ctx, 'sign somebody out')
      const sessionId = String((ctx.data as { sessionId?: unknown } | undefined)?.sessionId ?? '')
      if (!sessionId) throw new BadRequest('sessionId is required')
      await need('revokeSession')(person.userId, sessionId, { actorId: operator.userId })
      return { id: sessionId }
    },

    async revokeApiKey(ctx: ServiceContext) {
      const { operator, person } = await aim(ctx, "revoke somebody's API key")
      const keyId = String((ctx.data as { keyId?: unknown } | undefined)?.keyId ?? '')
      if (!keyId) throw new BadRequest('keyId is required')
      await auth.revokeApiKey(keyId, { userId: person.userId, actorId: operator.userId })
      return { id: keyId }
    },

    async signOut(ctx: ServiceContext) {
      const { operator, person } = await aim(ctx, 'sign somebody out')
      const revoked = await need('revokeSessions')(person.userId, { actorId: operator.userId })
      return { revoked }
    },

    // The account, its credentials and its sessions. `users.remove` deletes the
    // row alone, which leaves a password hash with no one to belong to.
    async remove(ctx: ServiceContext) {
      const { operator, person } = await aim(ctx, 'remove somebody')
      await need('deleteUser')(person.userId, { actorId: operator.userId })
      return { id: person.userId }
    },

    // POST /people — no id: the person does not exist yet.
    async invite(ctx: ServiceContext) {
      const operator = operatorOf(ctx)
      refuseDelegated(ctx, operator, 'invite somebody')
      const { email, name } = (ctx.data ?? {}) as { email?: unknown; name?: unknown }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequest('email must be an address')
      if (name !== undefined && name !== null && typeof name !== 'string') throw new BadRequest('name must be text')
      return need('createInvitation')(email.trim().toLowerCase(), {
        ...(name ? { name: name as string } : {}), actorId: operator.userId,
      })
    },
  }))

  return services
}
