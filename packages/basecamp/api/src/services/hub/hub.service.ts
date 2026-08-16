// src/services/hub/hub.service.ts
// The hub tier — the one service in this app that is NOT scoped to a workspace.
//
// Mounted at /hub. GET /hub is the runtime overview; everything else dispatches
// on X-Service-Method, all collection-level:
//   workspaces · users · flags            reads across every tenant
//   setWorkspaceStatus · setUserStatus    suspend and restore
//   setSystemAdmin                        who else may be here
//   createBot · setFlag
//
// ─── Why a separate service ───────────────────────────────────────────────
//
// Every other service here takes X-Workspace-Id and refuses without it, which
// is the tenancy boundary doing its job. The alternative to this file was to
// widen those nineteen with a `scope=hub` parameter — which puts the decision
// "may this caller see every tenant" in a query string, on nineteen services,
// each of which would have to get it right. One service behind one
// requireSystemAdmin hook is one place to be wrong.
//
// ─── Why asSystem() ───────────────────────────────────────────────────────
//
// Not a convenience. `User` is the model auth's own schema fragment declares
// `@@gate("8")` on — a level even SYSADMIN(7) does not reach — so once FJS-007
// lands there is NO caller-scoped client that can read a user list. Writing
// these reads against the caller's client today would mean rewriting them
// then. They are written the way they will have to be.
//
// The cost, stated: nothing below is graded at the Data boundary. The gate is
// requireSystemAdmin on the way in, and every write here is in the application
// audit trail because the app-level after hook covers custom methods.
//
// ─── What this deliberately does not do ───────────────────────────────────
//
// **Impersonation.** Both mock screens offer it. It means minting a session as
// somebody else, and the three hard parts are not the button: an audit trail
// that keeps saying who is really acting, a way back that cannot be forgotten,
// and a rule for what an impersonator may not do (change the password, issue a
// key). A half-built one is a credential-sharing feature. FJS-142.
//
// **Invitations.** Creating a HUMAN user from here would be an admin minting
// an account with a password only they know. The route to a human is
// invite → accept, which needs a token model and a signed-out acceptance page
// (FJS-032). A bot is different and is built: it has no password and no way to
// sign in, so nothing is being handed to anyone.

import { createService, BadRequest, Conflict, Forbidden, NotFound } from '@frontierjs/junction'
import { requireSystemAdmin, getPagination } from '../../core/hooks.ts'
import { slugify } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

// ─── Vocabularies ─────────────────────────────────────────────────────────
// The words are declared in db/schema.lite, where the column gets its CHECK.
// These are the API's copy of the same two lists, and they are a copy on
// purpose: a caller sending an unknown status must get a sentence naming what
// is allowed, not a SQLite constraint message from three layers down.
//
// Two homes need a test that names both — db/test/schema.test.ts imports these
// and asserts they match the enums the schema declares, in both directions.
// That is the only thing keeping them one list.

export const USER_STATUSES      = ['pending_verification', 'active', 'suspended']
export const WORKSPACE_STATUSES = ['active', 'suspended']

/** A bot's address. `.invalid` is reserved by RFC 2606 and resolves nowhere,
 *  which is the point: `User.email` is required and unique, a bot has no
 *  inbox, and a plausible-looking address would eventually be mailed. */
const BOT_EMAIL_DOMAIN = 'bots.invalid'

/** A bot may not be the owner of a workspace. An owner is the one member
 *  `removeMember` refuses to remove and the one role that can delete the
 *  tenant — held by something with no password and no inbox, that is a
 *  workspace with no recoverable human. */
const BOT_ROLES = ['viewer', 'billing', 'developer', 'admin']

/** Uptime is measured from when this service was registered, which is during
 *  start()'s autoload — within milliseconds of the process. Not read from
 *  healthPlugin: it keeps its own `startedAt` in a closure and exposes it
 *  nowhere, so asking it would mean parsing /health's own answer. */
const STARTED_AT = Date.now()

export function createHubService(app: BasecampApp) {

  /** Every read here is a hub read. Stated once so no method can forget it.
   *  `any` for the same reason `dbOf()` is: a Litestone client is a proxy and
   *  its accessors exist only at runtime, so a typed handle would be a fiction
   *  maintained by hand. */
  const sys = (): any => app.data.asSystem()

  /** The acting sysadmin, for the two self-lockout guards. */
  function actor(ctx: ServiceContext): string {
    return (ctx.auth?.user as { userId?: string } | undefined)?.userId as string
  }

  async function userOr404(id: unknown) {
    if (typeof id !== 'string' || !id) throw new BadRequest('userId is required')
    const user = await sys().user.findUnique({ where: { id } })
    if (!user) throw new NotFound(`User '${id}' not found`)
    return user
  }

  async function workspaceOr404(id: unknown) {
    if (typeof id !== 'string' || !id) throw new BadRequest('workspaceId is required')
    const ws = await sys().workspace.findUnique({ where: { id } })
    if (!ws) throw new NotFound(`Workspace '${id}' not found`)
    return ws
  }

  /**
   * How many system administrators can still act.
   *
   * Both `isSystemAdmin` and an unsuspended status, because either one alone
   * is a way to lock everyone out of the hub: revoking the last flag and
   * suspending the last holder of it produce exactly the same unreachable app,
   * and a guard that only counted the flag would allow the second.
   */
  function liveAdmins() {
    return sys().user.count({ where: { isSystemAdmin: true, status: 'active' } })
  }

  return createService({
    name: 'hub',

    // `methods:` matters more here than anywhere else in this app: without it
    // the base service answers every CRUD verb it was not given, and on a
    // service with no model that is a 500 rather than a refusal. It also
    // throws at construction on a name that does not exist below.
    methods: [
      'overview', 'workspaces', 'users', 'flags',
      'setWorkspaceStatus', 'setUserStatus', 'setSystemAdmin', 'createBot', 'setFlag',
    ],

    // ── overview — the runtime, as one object ─────────────────────────
    // An ACTION and not `find`, which was the obvious first shape and is not
    // one this can take: `find` promises a list, and an object is refused at
    // both ends (`FJS-144`). It used to be worse than refused — the browser
    // turned it into an EMPTY list with a 200 and no warning, which is a screen
    // that renders nothing while the API is right.
    //
    // Named keys and no `data`, so it wraps as a `single` and unwraps whole.
    async overview(ctx: ServiceContext) {
      ctx.dispatch = false
      const raw     = (app.db as { db: { query: (s: string) => { get: () => any } } }).db
      const dbPath  = (app.config as { database?: { url?: string } }).database?.url
        || process.env.DATABASE_URL || './db/basecamp.db'
      const mem     = process.memoryUsage()

      const [workspaces, users, servers, apps, projects] = await Promise.all([
        sys().workspace.count(), sys().user.count(), sys().server.count(),
        sys().app.count(),       sys().project.count(),
      ])

      return {
        runtime: {
          uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
          pid:           process.pid,
          nodeEnv:       process.env.NODE_ENV ?? 'development',
          bunVersion:    (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
          sqliteVersion: raw.query('select sqlite_version() as v').get()?.v ?? null,
          dbPath,
          // The main file PLUS the write-ahead log. In WAL mode a database
          // that has never checkpointed reports 4096 bytes for the same tree
          // that has half a megabyte sitting in `-wal`, so the honest-looking
          // single-file read is the one that is wrong. Bun.file().size is 0
          // for a path that does not exist, which is what a database with no
          // pending WAL correctly contributes.
          dbSizeBytes:   Bun.file(dbPath).size + Bun.file(`${dbPath}-wal`).size,
          memoryMb:      +(mem.rss / 1024 / 1024).toFixed(1),
          heapUsedMb:    +(mem.heapUsed / 1024 / 1024).toFixed(1),
        },
        // Live WebSocket clients, counted off the channel manager rather than
        // off `authenticated`'s membership: a connection joins that channel
        // only once it carries a session, so the channel's own length under-
        // reports anyone still connecting.
        wsConnections:   app.channels?.connections.size ?? 0,
        // AWAITED. `list()` is async, and `.length` on the promise is
        // undefined, which `?? 0` then turns into a confident zero — a stat
        // tile that reads "no targets registered" on a hub with twelve. Found
        // by the typechecker, not by the browser: both answers render.
        conduitTargets:  (await app.conduit?.list())?.length ?? 0,
        // Subscribers, by event. `stats()` answers the count the mock's
        // "Event subscribers" tile always wanted; the bus used to expose
        // hasListeners() and nothing else, so the card stated the gap rather
        // than printing a number it could not measure (FJS-143, closed).
        // `eventBusActive` is kept because it is the question the badge asks,
        // and deriving it here means one shape reaches the screen.
        eventBusActive:  app.events.hasListeners(),
        eventBus:        app.events.stats(),
        queues:          app.jobs.stats(),
        counts:          { workspaces, users, servers, apps, projects },
      }
    },

    // ── workspaces — every tenant ─────────────────────────────────────
    // A pure list envelope: total/limit/offset/data and nothing beside it.
    async workspaces(ctx: ServiceContext) {
      ctx.dispatch = false                     // a read, not an announcement
      const { limit, offset } = getPagination(ctx, { limit: 50, max: 200 })
      const q = (ctx.query.q as string | undefined)?.trim().toLowerCase()

      const { rows, total } = await sys().workspace.findManyAndCount({
        orderBy: { createdAt: 'desc' }, limit, offset,
      })

      // Filtered in memory, like the flags service's tag filter and for the
      // same reason: it is a substring match SQLite cannot do through the
      // accessor, the page is already here, and pretending the where-clause
      // did it would make `total` a lie about a different query.
      const page = q
        ? rows.filter((w: any) => `${w.name} ${w.slug}`.toLowerCase().includes(q))
        : rows

      const data = await Promise.all(page.map(async (w: any) => {
        const [members, servers, projects, owner] = await Promise.all([
          sys().workspaceMember.count({ where: { workspaceId: w.id } }),
          sys().server.count({ where: { workspaceId: w.id } }),
          sys().project.count({ where: { workspaceId: w.id } }),
          sys().user.findUnique({ where: { id: w.ownerId } }),
        ])
        return {
          ...w, members, servers, projects,
          owner: owner ? { id: owner.id, email: owner.email, name: owner.displayName ?? owner.name } : null,
        }
      }))

      return { total: q ? data.length : total, limit, offset, data }
    },

    // ── users — every actor ───────────────────────────────────────────
    async users(ctx: ServiceContext) {
      ctx.dispatch = false
      const { limit, offset } = getPagination(ctx, { limit: 50, max: 200 })
      const kind = ctx.query.kind as string | undefined

      const { rows, total } = await sys().user.findManyAndCount({
        where:   { ...(kind && kind !== 'all' ? { kind } : {}) },
        orderBy: { createdAt: 'desc' }, limit, offset,
      })

      const data = await Promise.all(rows.map(async (u: any) => {
        const memberships = await sys().workspaceMember.findMany({
          where: { userId: u.id }, include: { workspace: true },
        })
        return {
          id: u.id, email: u.email, name: u.displayName ?? u.name,
          kind: u.kind, status: u.status, isSystemAdmin: !!u.isSystemAdmin,
          emailVerified: !!u.emailVerified, createdAt: u.createdAt,
          // Never the Credential rows themselves — `value` is @guarded(all) and
          // a list of what proves an identity is not a list to render. The
          // count answers the only question the screen asks: can this actor
          // sign in at all, or is it a bot reachable through an API key.
          memberships: memberships.map((m: any) => ({
            workspaceId: m.workspaceId, role: m.role, workspace: m.workspace?.name ?? null,
          })),
        }
      }))

      return { total, limit, offset, data }
    },

    // ── flags — every tenant's flags ──────────────────────────────────
    // The hub view of a workspace-scoped model. It exists because a killswitch
    // is the one flag whose audience is the operator of the platform rather
    // than the team that shipped the feature.
    async flags(ctx: ServiceContext) {
      ctx.dispatch = false
      const { limit, offset } = getPagination(ctx, { limit: 100, max: 300 })

      const { rows, total } = await sys().featureFlag.findManyAndCount({
        include: { workspace: true }, orderBy: { key: 'asc' }, limit, offset,
      })

      const data = rows.map((f: any) => ({
        id: f.id, key: f.key, description: f.description, type: f.type,
        isEnabled: !!f.isEnabled, rollout: f.rollout, tags: f.tags,
        createdAt: f.createdAt,
        workspaceId: f.workspaceId, workspace: f.workspace?.name ?? null,
      }))

      return { total, limit, offset, data }
    },

    // ── setWorkspaceStatus ────────────────────────────────────────────
    // One method rather than suspend/restore, because the two would be one
    // rule written twice and the vocabulary is already a declared enum.
    async setWorkspaceStatus(ctx: ServiceContext) {
      const { workspaceId, status } = (ctx.data ?? {}) as Record<string, unknown>
      if (!WORKSPACE_STATUSES.includes(status as string))
        throw new BadRequest(`status must be one of ${WORKSPACE_STATUSES.join(', ')}`)

      const ws = await workspaceOr404(workspaceId)
      return sys().workspace.update({ where: { id: ws.id }, data: { status } })
    },

    // ── setUserStatus ─────────────────────────────────────────────────
    async setUserStatus(ctx: ServiceContext) {
      const { userId, status } = (ctx.data ?? {}) as Record<string, unknown>
      if (!USER_STATUSES.includes(status as string))
        throw new BadRequest(`status must be one of ${USER_STATUSES.join(', ')}`)

      const user = await userOr404(userId)

      if (status === 'suspended') {
        // Suspending yourself signs you out of the screen you did it on, with
        // no way back in — this app has no console and no env allowlist.
        if (user.id === actor(ctx))
          throw new Forbidden('You cannot suspend your own account')
        if (user.isSystemAdmin && await liveAdmins() <= 1)
          throw new Forbidden('Cannot suspend the last system administrator')
      }

      const updated = await sys().user.update({ where: { id: user.id }, data: { status } })

      // Suspension refuses at the door on the NEXT request (core/session-auth),
      // so a live session keeps a token that no longer resolves. Deleting the
      // rows is not what makes suspension work — it is what makes it immediate
      // for the websocket, which authenticated once at upgrade time and is not
      // re-checked per frame.
      if (status === 'suspended') await sys().session.deleteMany({ where: { userId: user.id } })

      return updated
    },

    // ── setSystemAdmin ────────────────────────────────────────────────
    async setSystemAdmin(ctx: ServiceContext) {
      const { userId, isSystemAdmin } = (ctx.data ?? {}) as Record<string, unknown>
      if (typeof isSystemAdmin !== 'boolean')
        throw new BadRequest('isSystemAdmin must be true or false')

      const user = await userOr404(userId)

      if (!isSystemAdmin) {
        if (user.id === actor(ctx))
          throw new Forbidden('You cannot revoke your own system administrator access')
        if (user.isSystemAdmin && await liveAdmins() <= 1)
          throw new Forbidden('Cannot revoke the last system administrator')
      }

      // A bot with the run of every tenant is a credential, not a person, and
      // the whole reason `isSystemAdmin` is a revocable human is that somebody
      // can be asked why they used it.
      if (isSystemAdmin && user.kind !== 'human')
        throw new Forbidden('Only a human account can be a system administrator')

      return sys().user.update({ where: { id: user.id }, data: { isSystemAdmin } })
    },

    // ── createBot ─────────────────────────────────────────────────────
    // The account an API key belongs to when the key is not a person's.
    //
    // It closes the gap api-keys.service.ts records in its own comment: a key
    // was always minted for the caller, because this app could not create
    // anything else to own one. So CI's key was somebody's key, and revoking
    // it when they left broke the pipeline.
    async createBot(ctx: ServiceContext) {
      const { workspaceId, name, role } = (ctx.data ?? {}) as Record<string, unknown>
      const label = typeof name === 'string' ? name.trim() : ''
      if (!label) throw new BadRequest('name is required')

      const wsRole = (role as string) ?? 'developer'
      if (!BOT_ROLES.includes(wsRole))
        throw new BadRequest(`role must be one of ${BOT_ROLES.join(', ')} — a bot cannot own a workspace`)

      const ws    = await workspaceOr404(workspaceId)
      const email = `${slugify(label)}@${BOT_EMAIL_DOMAIN}`

      if (await sys().user.exists({ where: { email } }))
        throw new Conflict(`A bot account already holds '${email}' — pick another name`)

      // One transaction: a bot with no membership is an account nothing can
      // reach and nothing can clean up, and it holds the unique email.
      return sys().$transaction(async (tx: any) => {
        const bot = await tx.user.create({
          data: {
            email, name: label, displayName: label,
            kind: 'bot', status: 'active', accountId: ws.accountId,
            // No password Credential is written, here or anywhere: a bot has
            // no way to sign in, and an API key is issued to it separately
            // through /api-keys. That is what makes it safe to create one from
            // an admin screen when creating a human from here would not be.
            emailVerified: false, isSystemAdmin: false,
          },
        })
        await tx.workspaceMember.create({
          data: { workspaceId: ws.id, userId: bot.id, role: wsRole,
                  invitedBy: actor(ctx), invitedAt: new Date().toISOString(),
                  acceptedAt: new Date().toISOString() },
        })
        return bot
      })
    },

    // ── setFlag ───────────────────────────────────────────────────────
    // The flag's own default, across tenants. NOT an override: an override
    // belongs to an environment inside a workspace, and a hub screen has no
    // environment in hand. Flipping the default is what a killswitch is.
    async setFlag(ctx: ServiceContext) {
      const { flagId, isEnabled } = (ctx.data ?? {}) as Record<string, unknown>
      if (typeof isEnabled !== 'boolean') throw new BadRequest('isEnabled must be true or false')
      if (typeof flagId !== 'string' || !flagId) throw new BadRequest('flagId is required')

      const flag = await sys().featureFlag.findUnique({ where: { id: flagId } })
      if (!flag) throw new NotFound(`Flag '${flagId}' not found`)

      return sys().featureFlag.update({ where: { id: flag.id }, data: { isEnabled } })
    },

    hooks: {
      before: {
        all: [requireSystemAdmin()],
      },
    },
  })
}
