// src/services/workspaces/workspaces.service.ts
// Workspaces — the multi-tenancy boundary. Every other resource belongs to one.
//
// Mounted at /workspaces. Custom methods dispatch on X-Service-Method:
//   members · addMember · setMemberRole · removeMember
//
// This service is the one exception to the workspace-scoped pattern: it does
// not live INSIDE a workspace, it is the workspace. So it does not use
// sessionScope()'s requireWorkspace — the id IS the workspace, and
// stampSelfAsWorkspace below makes the role hooks work on that basis.

import { createService, NotFound, Conflict, Forbidden, BadRequest, Unauthorized, authenticate }
  from '@frontierjs/junction'
import { requireWorkspaceRole, applyStanding, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { dbOf, actorOf, slugify, narrowPatch, changesNothing } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'
import type { WorkspaceRole }  from '../../../../db/schema.d.ts'
// The roles are graded in core/gate.ts and the enum lives in schema.lite; the
// map's KEYS are the one place this app already states the vocabulary, and a
// data test holds it to the enum. Reading it here rather than restating the
// five names is what keeps a role added tomorrow from being accepted by an API
// that cannot grade it.
import { WORKSPACE_ROLE_LEVEL } from '../../core/gate.ts'

export function createWorkspacesService(app: BasecampApp) {

  /**
   * Point the role hooks at the workspace being addressed.
   *
   * requireWorkspaceRole reads ctx.locals.workspaceId, which sessionScope's
   * requireWorkspace() normally stamps from the X-Workspace-Id header. This
   * service has no such header — the workspace is ctx.id. Without this the
   * hook found no workspaceId, hit its `if (!userId || !workspaceId) return`
   * guard and **enforced nothing**: any authenticated user could rename or
   * delete any workspace, or promote themselves inside it.
   */
  async function stampSelfAsWorkspace(ctx: ServiceContext): Promise<void> {
    if (!ctx.id) return
    ctx.locals.workspaceId = String(ctx.id)
    // Re-resolve the standing against THIS workspace. The around hook already
    // resolved one from X-Workspace-Id — the workspace the UI is currently
    // showing — and that is a different workspace from the one being addressed
    // whenever a person renames or leaves one from a list. Without this an
    // admin of the workspace they are LOOKING AT would carry ADMINISTRATOR(5)
    // into a patch of any other workspace they can name.
    await applyStanding(app, ctx, String(ctx.id))
  }

  /**
   * Put the session-derived columns on ctx.data BEFORE validation sees it.
   *
   * `accountId` and `ownerId` are required and NOT the caller's to send —
   * create() takes both from the session, which is the whole point: a client
   * that could name them could create a workspace inside another tenant or
   * owned by someone else. But `autoValidate` runs against the model's field
   * rules and does not know that, so it rejected every create with
   * `accountId is required, ownerId is required` and the method never ran.
   *
   * Order is what makes this work: user hooks run BEFORE the derived
   * gateAuth/autoValidate pair (junction core/service.ts ~688), so a
   * before/create hook is the documented place to shape ctx.data. Found by the
   * UI — POST /workspaces was unreachable over HTTP entirely.
   */
  function stampOwnership(ctx: ServiceContext): void {
    const user = sessionOf(ctx)
    if (!user.accountId) throw new Unauthorized('Session carries no account')

    const data = (ctx.data ?? {}) as Record<string, unknown>
    // Assigned, not defaulted: whatever a client sent for these is discarded.
    data.accountId = user.accountId
    data.ownerId   = user.userId
    // Derived, not assigned — a caller may name their own slug. It has to
    // happen HERE for the same reason the two above do: `slug` is required and
    // autoValidate runs after this hook and before the method, so deriving it
    // in create() 400s with `slug is required` on every caller that did not
    // send one. The browser sends one, which is why nothing caught it.
    data.slug ??= slugify(String(data.name ?? ''))
    ctx.data = data
  }

  function sessionOf(ctx: ServiceContext) {
    const user = ctx.auth?.user as { userId?: string; accountId?: string } | undefined
    if (!user?.userId) throw new Unauthorized('Not authenticated')
    return user
  }

  /**
   * A role off the wire, refused BY NAME rather than by a CHECK constraint.
   *
   * addMember and setMemberRole write a WorkspaceMember row by hand — this
   * service's own model is Workspace, so autoValidate never sees the payload
   * and an unknown role reached SQLite as a constraint failure at the end of
   * the write rather than a 400 naming the field. The vocabulary is read from
   * the map core/gate.ts grades on, which a data test holds to the enum: a role
   * this app cannot grade is a role it must not accept.
   */
  function toRole(value: unknown): WorkspaceRole {
    const roles = Object.keys(WORKSPACE_ROLE_LEVEL)
    if (typeof value !== 'string' || !roles.includes(value))
      throw new BadRequest(`role must be one of: ${roles.join(', ')}`)
    return value as WorkspaceRole
  }

  /** Membership decides access, so it is read as system, not through the caller. */
  function members(ctx: ServiceContext) {
    return app.data.asSystem().workspaceMember
  }

  return createService({
    name:  'workspaces',
    model: 'Workspace',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // Only workspaces the caller belongs to. The old version did this with a
    // JOIN; `memberships: { some: { userId } }` is the relation the schema
    // already declares.
    async find(ctx: ServiceContext) {
      const user = ctx.auth?.user as { userId?: string } | undefined
      if (!user?.userId) return { total: 0, limit: 20, offset: 0, data: [] }

      const { limit, offset } = getPagination(ctx)
      const mine = await members(ctx).findMany({ where: { userId: user.userId } })
      const ids  = mine.map((m: any) => m.workspaceId)
      if (!ids.length) return { total: 0, limit, offset, data: [] }

      const { rows, total } = await dbOf(ctx).workspace.findManyAndCount({
        where:   { id: { in: ids } },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })
      return { total, limit, offset, data: rows }
    },

    // Non-membership is reported as 404, not 403 — a workspace you cannot see
    // should not be confirmable by id.
    async get(ctx: ServiceContext) {
      const user = sessionOf(ctx)
      const ws   = await dbOf(ctx).workspace.findUnique({ where: { id: ctx.id as string } })
      if (!ws) throw new NotFound(`Workspace '${ctx.id}' not found`)

      const member = await members(ctx).findFirst({ where: { workspaceId: ctx.id as string, userId: user.userId } })
      if (!member) throw new NotFound(`Workspace '${ctx.id}' not found`)

      return ws
    },

    async create(ctx: ServiceContext) {
      const user = sessionOf(ctx)
      if (!user.accountId) throw new Unauthorized('Session carries no account')

      const data = ctx.data as Record<string, unknown>
      data.slug ??= slugify(String(data.name ?? ''))

      if (await dbOf(ctx).workspace.exists({ where: { slug: data.slug } }))
        throw new Conflict(`Slug '${data.slug}' is already taken`)

      // One transaction: a workspace whose creator is not a member of it is
      // unreachable by its own owner.
      const ws = await app.data.asSystem().$transaction(async (tx: any) => {
        const ws = await tx.workspace.create({
          data: { ...data, accountId: user.accountId, ownerId: user.userId },
        })
        await tx.workspaceMember.create({
          data: { workspaceId: ws.id, userId: user.userId, role: 'owner', acceptedAt: new Date().toISOString() },
        })
        return ws
      })

      app.events.emit('workspace:created', { id: ws.id, slug: ws.slug, owner_id: user.userId })
      return ws
    },

    async patch(ctx: ServiceContext) {
      const ws   = await dbOf(ctx).workspace.findUnique({ where: { id: ctx.id as string } })
      if (!ws) throw new NotFound(`Workspace '${ctx.id}' not found`)

      const data = ctx.data as Record<string, unknown>
      if (data.slug && data.slug !== ws.slug &&
          await dbOf(ctx).workspace.exists({ where: { slug: data.slug } }))
        throw new Conflict(`Slug '${data.slug}' is already taken`)

      // accountId and ownerId are not a client's to change: one moves the
      // workspace between tenants, the other hands over ownership, and neither
      // belongs on a general PATCH.
      const patch = narrowPatch(data, ['accountId', 'ownerId'])
      if (changesNothing(patch)) return ws
      return dbOf(ctx).workspace.update({ where: { id: ctx.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      const ws = await dbOf(ctx).workspace.findUnique({ where: { id: ctx.id as string } })
      if (!ws) throw new NotFound(`Workspace '${ctx.id}' not found`)

      // @@softDelete(cascade) — projects, servers, secrets and jobs are stamped
      // with it rather than left live under a deleted parent.
      const removed = await dbOf(ctx).workspace.remove({ where: { id: ctx.id as string } })
      app.events.emit('workspace:deleted', { id: ctx.id })
      return Array.isArray(removed) ? removed[0] : removed
    },

    // ── members ───────────────────────────────────────────────────────
    // asSystem: User is auth's model. Even with gates absent today, member
    // listing is a membership question and reads as one.
    async members(ctx: ServiceContext) {
      const rows = await members(ctx).findMany({
        where:   { workspaceId: ctx.id as string },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      })
      return { total: rows.length, data: rows }
    },

    async addMember(ctx: ServiceContext) {
      const { userId, user_id, role } = (ctx.data ?? {}) as Record<string, string>
      const target = userId ?? user_id
      if (!target) throw new BadRequest('userId is required')

      const wsId = ctx.id as string
      if (await members(ctx).exists({ where: { workspaceId: wsId, userId: target } }))
        throw new Conflict('User is already a member of this workspace')

      return members(ctx).create({
        data: { workspaceId: wsId, userId: target, role: toRole(role ?? 'developer'),
                invitedBy: actorOf(ctx), invitedAt: new Date().toISOString() },
      })
    },

    async setMemberRole(ctx: ServiceContext) {
      const { userId, user_id, role } = (ctx.data ?? {}) as Record<string, string>
      const target = userId ?? user_id
      if (!target) throw new BadRequest('userId is required')
      if (!role)   throw new BadRequest('role is required')

      const wsId   = ctx.id as string
      const member = await members(ctx).findFirst({ where: { workspaceId: wsId, userId: target } })
      if (!member) throw new NotFound('Member not found')

      // Demoting the last owner would leave the workspace unadministrable.
      if (member.role === 'owner' && role !== 'owner') {
        const owners = await members(ctx).count({ where: { workspaceId: wsId, role: 'owner' } })
        if (owners <= 1) throw new Forbidden('Cannot demote the last owner of a workspace')
      }

      return members(ctx).update({ where: { id: member.id }, data: { role: toRole(role) } })
    },

    async removeMember(ctx: ServiceContext) {
      const target = (ctx.query.userId ?? ctx.query.user_id ??
                      (ctx.data as Record<string, string> | null)?.userId) as string | undefined
      if (!target) throw new BadRequest('userId is required')

      const wsId   = ctx.id as string
      const member = await members(ctx).findFirst({ where: { workspaceId: wsId, userId: target } })
      if (!member) throw new NotFound('Member not found')
      if (member.role === 'owner') throw new Forbidden('Cannot remove the workspace owner')

      // Hard delete: WorkspaceMember has no @@softDelete — a revoked membership
      // should stop matching, not linger as a tombstone the role hooks read.
      await members(ctx).delete({ where: { id: member.id } })
      return { workspace_id: wsId, user_id: target, removed: true }
    },

    hooks: {
      before: {
        // stampSelfAsWorkspace must run BEFORE the role hooks — they read the
        // workspaceId it sets.
        all:           [authenticate, stampSelfAsWorkspace],
        create:        [stampOwnership],
        patch:         [requireWorkspaceRole(app, 'admin', 'owner')],
        remove:        [requireWorkspaceRole(app, 'owner')],
        addMember:     [requireWorkspaceRole(app, 'admin', 'owner')],
        setMemberRole: [requireWorkspaceRole(app, 'admin', 'owner')],
        removeMember:  [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
