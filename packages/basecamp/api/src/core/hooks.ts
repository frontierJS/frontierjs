// src/core/hooks.ts
// Basecamp-specific hooks — used across Basecamp services.
// Framework hooks (authenticate, requireRole, etc.) imported from '@frontierjs/junction'.

import { BadRequest, Forbidden, authenticate } from '@frontierjs/junction'
import type { Hook, ServiceContext }  from '@frontierjs/junction'
import type { BasecampApp }                from '../basecamp.types.ts'

// ─── The session ─────────────────────────────────────────────────────────
// Junction puts the caller on ctx.auth.user as a SessionContext — camelCase
// (userId, authMethod), not the snake_case user_id these hooks used to read.
// Every one of those reads was undefined, which is why role checks silently
// passed for everyone.

interface Session { userId?: string; authMethod?: string; workspaceId?: string }

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

export function requireWorkspace(): Hook {
  return (ctx: ServiceContext): void => {
    // Headers live on ctx.client.headers — Junction splits the context into
    // auth / client / route / locals. There is NO ctx.params: the previous
    // version read ctx.params.headers and wrote ctx.params.workspace_id, and
    // both threw "undefined is not an object" on the first call.
    const workspaceId =
      (ctx.client?.headers?.['x-workspace-id'] as string | undefined) ||
      (ctx.query.workspace_id as string | undefined)          ||
      (userOf(ctx)?.workspaceId as string | undefined)

    if (!workspaceId)
      throw new BadRequest(
        'workspace_id required — pass X-Workspace-Id header or ?workspace_id= query param'
      )

    ctx.locals.workspaceId = workspaceId
  }
}

// ─── scopeToWorkspace ────────────────────────────────────────────────────
// Verifies the authenticated user is a member of the requested workspace.
// Stamps ctx.locals.memberRole so requireWorkspaceRole avoids a second query.

export function scopeToWorkspace(app: BasecampApp): Hook {
  return async (ctx: ServiceContext): Promise<void> => {
    const userId      = userOf(ctx)?.userId
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || !workspaceId) return

    // asSystem(): membership is what DECIDES the caller's access, so it cannot
    // be read through a client already scoped by that access.
    const member = await app.data.asSystem().workspaceMember.findFirst({
      where: { workspaceId, userId },
    })

    if (!member) throw new Forbidden('You are not a member of this workspace')

    ctx.locals.memberRole = member.role
  }
}

// ─── requireWorkspaceRole ────────────────────────────────────────────────
// Enforces a minimum role level in the current workspace.
//
// Role hierarchy: viewer(1) = billing(1) < developer(2) < admin(3) < owner(4)
//
// Reads ctx.locals.memberRole stamped by scopeToWorkspace — no extra query.

const ROLE_LEVEL: Record<string, number> = {
  viewer: 1, billing: 1, developer: 2, admin: 3, owner: 4,
}

export function requireWorkspaceRole(app: BasecampApp, ...roles: string[]): Hook {
  const minLevel = Math.min(...roles.map(r => ROLE_LEVEL[r] ?? 99))

  return async (ctx: ServiceContext): Promise<void> => {
    const userId      = userOf(ctx)?.userId
    const workspaceId = ctx.locals.workspaceId as string | undefined

    if (!userId || !workspaceId) return

    let role = ctx.locals.memberRole as string | undefined

    if (!role) {
      const member = await app.data.asSystem().workspaceMember.findFirst({
        where: { workspaceId, userId },
      })
      role = member?.role
      if (role) ctx.locals.memberRole = role
    }

    const userLevel = ROLE_LEVEL[role ?? ''] ?? 0
    if (userLevel < minLevel)
      throw new Forbidden(
        `Requires ${roles.join(' or ')} role in this workspace (you have: ${role ?? 'none'})`
      )
  }
}

// ─── sessionScope ────────────────────────────────────────────────────────
// authenticate + requireWorkspace + scopeToWorkspace as one named hook, with
// an escape hatch for methods that are not called by a person.
//
// This exists because `before: { all: [authenticate, ...] }` applies to EVERY
// method, agent endpoints included. servers.heartbeat carried a comment saying
// it was exempt ("HMAC auth at Conduit transport level — no session hook")
// while sitting behind that `all`, so the agent could never check in: every
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
// Registered as a global after hook in app.ts.
// Failures are swallowed — audit log must never break the request.

export function basecampAuditLog(app: BasecampApp): Hook {
  return async (ctx: ServiceContext): Promise<void> => {
    const mutating = ['create', 'patch', 'remove']
    if (!mutating.includes(ctx.method)) return

    const result  = (ctx.result as { data?: Record<string, unknown> } | null)?.data as Record<string, unknown> | null
    const session = userOf(ctx)

    try {
      // asSystem(): the trail must record actions the actor could not write
      // for themselves. AuditEvent create is a system-only concern.
      await app.data.asSystem().auditEvent.create({
        data: {
          workspaceId: (ctx.locals.workspaceId as string | undefined) ?? null,
          actorId:     session?.userId ?? null,
          actorType:   session?.authMethod === 'api_key' ? 'api_key' : 'user',
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
