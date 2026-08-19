// src/core/hooks.ts
// Basecamp-specific hooks — used across Basecamp services.
// Framework hooks (authenticate, requireRole, etc.) imported from '@frontierjs/junction'.

import { BadRequest, Forbidden, NotFound, authenticate, toDataPrincipal } from '@frontierjs/junction'
import type { Hook, AroundHook, ServiceContext }  from '@frontierjs/junction'
import type { BasecampApp }                from '../basecamp.types.ts'

// ─── The session ─────────────────────────────────────────────────────────
// Junction puts the caller on ctx.auth.user as a SessionContext — camelCase
// (userId, authMethod), not the snake_case user_id these hooks used to read.
// Every one of those reads was undefined, which is why role checks silently
// passed for everyone.

interface Session {
  userId?: string; authMethod?: string; workspaceId?: string
  // Put here by basecampSessionFields (core/session-auth.ts) off this app's own
  // User columns, not by @frontierjs/auth.
  isSystemAdmin?: boolean; status?: string; kind?: string
  // Put here by applyStanding() below, per request, off the WorkspaceMember row
  // for the workspace being addressed. Never a column on `user`.
  memberRole?: string
}

interface MemberRow { role?: string; workspace?: { status?: string } }

function userOf(ctx: ServiceContext): Session | undefined {
  return ctx.auth?.user as Session | undefined
}

// ─── requireWorkspace ────────────────────────────────────────────────────
// Ensures ctx.locals.workspaceId is populated before the service method.
//
// Precedence:
//   1. X-Workspace-Id header
//   2. ?workspace_id= query param
//   3. the session's own default workspace

/**
 * Which workspace a request is for.
 *
 * Exported because two hooks need the answer and they must not each work it
 * out: apiKeyGuard runs at app level, before any service hook has stamped
 * ctx.locals, and a second copy of this precedence is a second thing to keep
 * in step.
 *
 * Headers live on ctx.client.headers — Junction splits the context into
 * auth / client / route / locals. There is NO ctx.params: the previous version
 * read ctx.params.headers and wrote ctx.params.workspace_id, and both threw
 * "undefined is not an object" on the first call.
 */
export function resolveWorkspaceId(ctx: ServiceContext): string | undefined {
  return (ctx.client?.headers?.['x-workspace-id'] as string | undefined) ||
         (ctx.reserved?.workspace_id as string | undefined)              ||
         (userOf(ctx)?.workspaceId as string | undefined)
}

/**
 * The query key the fallback above reads, declared where a service can claim it.
 *
 * `?workspace_id=` is not a filter — no model has that column — so junction
 * graded it against the model and answered a 400 naming it, before this hook
 * ever ran. Every workspace-scoped service reserves it, which moves it to
 * `ctx.reserved` and leaves `ctx.query` as columns alone.
 *
 * One constant rather than twenty literals: the spelling is read here and
 * declared there, and those must not drift.
 */
export const WORKSPACE_QUERY = ['workspace_id'] as const

export function requireWorkspace(): Hook {
  return (ctx: ServiceContext): void => {
    const workspaceId = resolveWorkspaceId(ctx)

    if (!workspaceId)
      throw new BadRequest(
        'workspace_id required — pass X-Workspace-Id header or ?workspace_id= query param'
      )

    ctx.locals.workspaceId = workspaceId
  }
}

// ─── Standing ────────────────────────────────────────────────────────────
// Who the caller is IN THE WORKSPACE this request is for — resolved once, and
// put where both halves of access control can read it.
//
// Two readers, and they are not the same reader:
//
//   the hooks below      read ctx.locals.memberRole and answer 403 with a
//                        sentence naming the role you would need.
//   @@gate               reads `memberRole` off the PRINCIPAL, through
//                        core/gate.ts, at the Data boundary — which is where
//                        Invariant 6 says access is decided, and which also
//                        covers every path a hook does not: an engine calling
//                        a service in-process, a custom method nobody wired a
//                        role hook onto, a query built by hand in a method.
//
// The principal is where the interesting part is. Junction scopes the client
// from `ctx.auth.user` in an around hook installed by createApp({ db }) — which
// runs before any hook can know which workspace is being addressed — so the
// standing has to be put ON the principal and the client re-scoped from it.
// Doing that on the client alone is not enough: junction's getTable() re-derives
// its own scoped copy from ctx.auth.user, so a standing that lives only on
// ctx.locals.db is dropped the moment a service touches a model.
//
// A fresh object, never a mutation. Over WebSocket the session is resolved
// once at upgrade and the same object is handed to every frame — and the
// internal-call path freezes it. Mutating it would either throw or leak one
// call's workspace role into the next call on that socket.

const STANDING_FOR = '__standingFor'

/**
 * Resolve the caller's standing in `workspaceId` and apply it to this call.
 *
 * Idempotent per workspace: called from the around hook with the header's
 * workspace, and again by any service that addresses a different one (the
 * workspaces service, where the workspace IS the id). Re-resolving is what
 * keeps a caller who is admin of workspace A from carrying that level into a
 * request against workspace B.
 */
export async function applyStanding(
  app:         BasecampApp,
  ctx:         ServiceContext,
  workspaceId: string | undefined
): Promise<MemberRow | null> {
  const user = userOf(ctx)
  if (!user?.userId || !workspaceId) return null
  if (ctx.locals[STANDING_FOR] === workspaceId) return (ctx.locals.member as MemberRow | null) ?? null

  // asSystem(): membership is what DECIDES the caller's access, so it cannot be
  // read through a client already scoped by that access — and with @@gate live,
  // WorkspaceMember is not readable at the level a caller with no standing yet
  // holds. `include`, not a second findUnique: this runs on every request to
  // every workspace-scoped service, and the workspace's status is one join away
  // from a row already being read.
  const sys: any = app.data.asSystem()
  const member: MemberRow | null = await sys.workspaceMember.findFirst({
    where:   { workspaceId, userId: user.userId },
    include: { workspace: true },
  })

  ctx.locals[STANDING_FOR] = workspaceId
  ctx.locals.member        = member
  ctx.locals.memberRole    = member?.role

  const principal = { ...user, memberRole: member?.role, workspaceId }
  ctx.auth.user   = principal as unknown as typeof ctx.auth.user
  ctx.locals.db   = (app.data as any).$setAuth(toDataPrincipal(principal))

  return member
}

/**
 * App-level around hook: every service call starts with the caller's standing.
 *
 * Registered in app.ts, so it composes INSIDE junction's own withLitestoneDb —
 * which is the order that works, since this replaces the client that one
 * installed with a copy scoped to a principal carrying the workspace role.
 *
 * It refuses nothing. A request naming a workspace the caller is not in gets a
 * principal with no role, which @@gate grades VISITOR(1) and scopeToWorkspace
 * turns into a sentence. Refusing here would 403 the services that legitimately
 * run with no workspace at all — /workspaces, /hub, the outpost endpoints.
 */
export function withWorkspaceStanding(app: BasecampApp): AroundHook {
  return async (ctx, next) => {
    await applyStanding(app, ctx, resolveWorkspaceId(ctx))
    await next()
  }
}

// ─── scopeToWorkspace ────────────────────────────────────────────────────
// Verifies the authenticated user is a member of the requested workspace.
// The membership row is already in hand — the around hook read it.

export function scopeToWorkspace(app: BasecampApp): Hook {
  return async (ctx: ServiceContext): Promise<void> => {
    const userId      = userOf(ctx)?.userId
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || !workspaceId) return

    const member = await applyStanding(app, ctx, workspaceId)

    if (!member) throw new Forbidden('You are not a member of this workspace')

    // Suspension is enforced HERE, not in each service, because this is the one
    // hook every workspace-scoped service already runs — nineteen of the
    // twenty. A suspended workspace that only looked suspended on the hub
    // screen would be a button that reports success and revokes nothing.
    //
    // Checked after membership, so a stranger still gets "not a member" rather
    // than learning that a workspace they cannot see is suspended.
    if (member.workspace?.status === 'suspended')
      throw new Forbidden('This workspace is suspended. Ask a system administrator to restore it.')
  }
}

// ─── requireWorkspaceRole ────────────────────────────────────────────────
// Enforces a minimum role level in the current workspace.
//
// Role hierarchy: viewer(1) = billing(1) < developer(2) < admin(3) < owner(4)
//
// A SECOND ladder, and it is not the gate's. This one exists to answer with a
// sentence — *requires admin or owner role in this workspace (you have:
// developer)* — which a 403 out of the Data boundary cannot say, since @@gate
// knows levels and not the words a person picked in a members screen. It is
// derived from the same WorkspaceMember row, so the two cannot disagree about
// WHO the caller is; they can only differ in what they say when refusing.
//
// Reads ctx.locals.memberRole, stamped by applyStanding — no extra query.

const ROLE_LEVEL: Record<string, number> = {
  viewer: 1, billing: 1, developer: 2, admin: 3, owner: 4,
}

export function requireWorkspaceRole(app: BasecampApp, ...roles: string[]): Hook {
  const minLevel = Math.min(...roles.map(r => ROLE_LEVEL[r] ?? 99))

  return async (ctx: ServiceContext): Promise<void> => {
    const userId      = userOf(ctx)?.userId
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || !workspaceId) return

    await applyStanding(app, ctx, workspaceId)
    const role = ctx.locals.memberRole as string | undefined

    const userLevel = ROLE_LEVEL[role ?? ''] ?? 0
    if (userLevel < minLevel)
      throw new Forbidden(
        `Requires ${roles.join(' or ')} role in this workspace (you have: ${role ?? 'none'})`
      )
  }
}

// ─── requireSystemAdmin ──────────────────────────────────────────────────
// The hub tier. One hook, one service — deliberately not a role a workspace
// can grant.
//
// It reads `isSystemAdmin` off the session, which core/session-auth.ts puts
// there from the User column of the same name. That name is the one
// sessionGateLevel() grades SYSADMIN(7) on, so this hook and the @@gate that
// eventually replaces it are asking the same question of the same field.
//
// 404, not 403: the hub is not a screen a workspace member is being refused,
// it is a surface they have no business knowing exists. Same reason the
// workspaces service answers 404 for a workspace you are not in.

export function requireSystemAdmin(): Hook {
  return (ctx: ServiceContext): void => {
    authenticate(ctx)
    if (userOf(ctx)?.isSystemAdmin !== true) throw new NotFound('Not found')
  }
}

// ─── sessionScope ────────────────────────────────────────────────────────
// authenticate + requireWorkspace + scopeToWorkspace as one named hook, with
// an escape hatch for methods that are not called by a person.
//
// This exists because `before: { all: [authenticate, ...] }` applies to EVERY
// method, outpost endpoints included. servers.heartbeat carried a comment saying
// it was exempt ("HMAC auth at Conduit transport level — no session hook")
// while sitting behind that `all`, so the outpost could never check in: every
// heartbeat 401'd. A comment is not an exemption.

export function sessionScope(app: BasecampApp, opts: { except?: string[] } = {}): Hook {
  const except = new Set(opts.except ?? [])
  const workspace = requireWorkspace()
  const scope     = scopeToWorkspace(app)

  return async (ctx: ServiceContext): Promise<void> => {
    if (except.has(ctx.method)) return
    authenticate(ctx)
    workspace(ctx)
    await scope(ctx)
  }
}

// ─── workspaceChannel ────────────────────────────────────────────────────
// Returns the channel publish target for the current workspace.
// Used with publishToChannels() in after hooks for real-time push.
//
//   after: { all: [publishToChannels(workspaceChannel(app))] }

export function workspaceChannel(app: BasecampApp): import('@frontierjs/junction').PublishFn {
  return (_data, ctx) => {
    const wsId    = ctx.locals.workspaceId as string | undefined
    if (!wsId) return null
    const manager = (app as unknown as Record<string, unknown>).channels as
      { channel: (name: string) => unknown } | undefined
    if (!manager?.channel) return null
    return manager.channel(`workspace:${wsId}`) as unknown
  }
}

// ─── basecampAuditLog ─────────────────────────────────────────────────────────
// Writes a record to audit_event after any mutation.
// Registered as a global `after: { all: [...] }` hook in app.ts.
// Failures are swallowed — audit log must never break the request.
//
// `except` is `service.method` names that mutate but must not be recorded. The
// one entry today is `servers.heartbeat`: an outpost checks in on a timer, so a
// fleet of fifty would write six figures of rows a day and bury every action a
// person took. It is deliberately NOT `ctx.dispatch = false` — that would also
// silence the channel, and the live status pill on the server screen is fed by
// exactly that publish.

export function basecampAuditLog(app: BasecampApp, { except = [] }: { except?: string[] } = {}): Hook {
  const skip = new Set(except)

  return async (ctx: ServiceContext): Promise<void> => {
    if (skip.has(`${ctx.service}.${ctx.method}`)) return
    // What counts as a mutation is decided the same way Junction decides what
    // to announce on a channel: everything except `find`/`get`, and a
    // read-shaped custom method opts out with `ctx.dispatch = false`.
    //
    // It used to be a literal `['create','patch','remove']`, which meant the
    // trail recorded a server being CREATED and not a server being DRAINED —
    // and drain, cancel, deploy, trigger and heartbeat are most of what an
    // operator actually does here. An audit trail that misses the verbs is
    // worse than none, because it reads as complete.
    if (ctx.method === 'find' || ctx.method === 'get') return
    if (ctx.dispatch === false) return

    // Two result shapes reach here. CRUD answers the envelope, so the row is
    // under `.data`; a custom method answers the row itself. Reading only the
    // first recorded every action against subjectId 'unknown', which is a trail
    // entry that cannot be joined back to the thing it happened to.
    const raw     = ctx.result as Record<string, unknown> | null
    const result  = (raw?.data as Record<string, unknown> | undefined) ?? raw
    const session = userOf(ctx)

    try {
      // asSystem(): the trail must record actions the actor could not write
      // for themselves. AuditEvent create is a system-only concern.
      await app.data.asSystem().auditEvent.create({
        data: {
          workspaceId: (ctx.locals.workspaceId as string | undefined) ?? null,
          actorId:     session?.userId ?? null,
          // No session is not an anonymous user — it is the engine, a job or an
          // outpost acting for itself. `AuditEvent.actorType` defaults to 'user',
          // so leaving it unstated would file every machine write under people.
          actorType:   session ? (session.authMethod === 'api_key' ? 'api_key' : 'user') : 'system',
          action:      `${ctx.service}.${ctx.method}`,
          subjectType: ctx.service,
          subjectId:   (result?.id as string | undefined) ?? 'unknown',
        },
      })
    } catch {
      // Intentionally swallowed — the audit write must never break the request.
      // Note this is the APPLICATION trail; @@log(audit) captures row-level
      // changes separately and does not depend on this hook running.
    }
  }
}

// ─── getPagination ───────────────────────────────────────────────────────
// `$limit` / `$offset` are TRANSPORT syntax. The bridge parses them off the
// query string and puts them on ctx.directives; nothing past the bridge ever
// sees a `$` (Invariant 10). ctx.query is filters only, so the old
// `q.$limit ?? ctx.$raw.query.$limit` chain read fields that are never there.
// ctx.query.limit is still honoured for internal callers that pass it plainly.

export function getPagination(
  ctx:      ServiceContext,
  defaults: { limit?: number; max?: number } = {}
): { limit: number; offset: number } {
  const q = ctx.query as Record<string, unknown>
  const d = (ctx.directives ?? {}) as { limit?: number; offset?: number }

  const limit  = Math.min(
    parseInt(String(d.limit ?? q.limit ?? defaults.limit ?? 20), 10),
    defaults.max ?? 200
  )
  const offset = parseInt(String(d.offset ?? q.offset ?? 0), 10)

  return {
    limit:  isNaN(limit)  ? (defaults.limit ?? 20)  : Math.max(1, limit),
    offset: isNaN(offset) ? 0 : Math.max(0, offset),
  }
}
