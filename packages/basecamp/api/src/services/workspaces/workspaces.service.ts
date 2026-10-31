import { $ } from '@frontierjs/junction'
// src/services/workspaces/workspaces.service.ts
// Workspaces — the multi-tenancy boundary. Every other resource belongs to one.
//
// Mounted at /workspaces. Custom methods dispatch on X-Service-Method:
//   members · addMember · setMemberRole · removeMember · leave
//   push · testPing
//
// This service is the one exception to the workspace-scoped pattern: it does
// not live INSIDE a workspace, it is the workspace. So it does not use
// sessionScope()'s requireWorkspace — the id IS the workspace, and
// workspaceOrKeys (core/hooks.ts) names it as the tenant, so the gate and the
// standing are both read against the workspace addressed.

import { createService, NotFound, Conflict, Forbidden, BadRequest, Unauthorized } from '@frontierjs/junction'
import { authenticate } from '@frontierjs/junction/hooks'
import { LEVELS } from '@frontierjs/litestone'
import { refuseGrantAboveOwn, roleOf, getPagination, WORKSPACE_QUERY, WORKSPACES_SERVICE } from '../../core/hooks.ts'
import { grantsFor } from '../../core/capabilities.ts'
import { db, actor, slugify, narrowPatch, changesNothing, callerOrder } from '../../core/resource.ts'
import type { WorkspaceRole }  from '#db/schema.d.ts'
// The roles are graded in core/gate.ts and the enum lives in schema.lite; the
// map's KEYS are the one place this app already states the vocabulary, and a
// data test holds it to the enum. Reading it here rather than restating the
// five names is what keeps a role added tomorrow from being accepted by an API
// that cannot grade it.
import { WORKSPACE_ROLE_LEVEL } from '../../core/gate.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { pushTopicFor } from '../../domain/notification/push-topic.ts'
import pushTest from '../../domain/notification/push-test.ts'
import { env } from '../../core/env.ts'

/**
 * Put the session-derived columns on $.data BEFORE validation sees it.
 *
 * `accountId` is required and NOT the caller's to send — create() takes it
 * from the session, which is the whole point: a client that could name it
 * could create a workspace inside another tenant. But `autoValidate` runs
 * against the model's field rules and does not know that, so it rejected
 * every create with `accountId is required` and the method never ran.
 *
 * Order is what makes this work: user hooks run BEFORE the derived
 * gateAuth/autoValidate pair (junction core/service.ts ~688), so a
 * before/create hook is the documented place to shape $.data. Found by the
 * UI — POST /workspaces was unreachable over HTTP entirely.
 */
function stampOwnership(): void {
  const user = sessionOf()
  if (!user.accountId) throw new Unauthorized('Session carries no account')

  const data = ($.data ?? {}) as Record<string, unknown>
  // Assigned, not defaulted: whatever a client sent is discarded.
  data.accountId = user.accountId
  // Derived, not assigned — a caller may name their own slug. It has to
  // happen HERE for the same reason the one above does: `slug` is required and
  // autoValidate runs after this hook and before the method, so deriving it
  // in create() 400s with `slug is required` on every caller that did not
  // send one. The browser sends one, which is why nothing caught it.
  data.slug ??= slugify(String(data.name ?? ''))
  $.data = data
}

function sessionOf() {
  const user = $.user as { id?: string; accountId?: string } | undefined
  if (!user?.id) throw new Unauthorized('Not authenticated')
  return user
}

/** Membership decides access, so it is read as system, not through the caller.
 *  `any` for the reason every sibling service says it: `$.db` is the request's
 *  client and Litestone's accessors exist only at runtime, so a typed handle
 *  would be a fiction maintained by hand until `litestone types` lands. */
function members(): any {
  return $.db.asSystem().workspaceMember
}

/** A member who outranks you is not yours to move or remove. `refuseGrantAboveOwn`
 *  grades what is being HANDED OUT and this grades who is being acted on — an
 *  admin demoting an owner is the same inversion pointed the other way, and the
 *  last-owner guard only catches it where there happens to be exactly one. */
function refuseOutranked(member: { role: string }, verb: string): void {
  const myRole = roleOf($) ?? ''
  if ((WORKSPACE_ROLE_LEVEL[member.role] ?? 0) > (WORKSPACE_ROLE_LEVEL[myRole] ?? 0))
    throw new Forbidden(
      `You cannot ${verb} ${member.role === 'owner' || member.role === 'admin' ? 'an' : 'a'} ${member.role} — you hold ${myRole || 'none'}.`
    )
}

/** A workspace with no owner is one nobody can administer or delete. */
async function refuseLastOwner(wsId: string, verb: string): Promise<void> {
  const owners = await members().count({ where: { workspaceId: wsId, role: 'owner' } })
  if (owners <= 1)
    throw new Forbidden(`Cannot ${verb} the last owner of a workspace. Make another member an owner first.`)
}

/** The person a roster write names, read as the app: `User` reads self-only. */
function people(): any {
  return $.db.asSystem().user
}

/** The three roster writes go through the caller's own client, claimed to
 *  the workspace being addressed, so the schema's
 *  gate, `@@allow` and `@@deny(update, userId == auth().id)` hold them and not
 *  a restatement here. `leave` stays system: it deletes the caller's own
 *  row, which that deny exists to refuse. */
function memberWrites(): any {
  return $.db.workspaceMember
}

export default createService({
  name:  WORKSPACES_SERVICE,
  scope: keyScope('workspaces'),
  model: 'Workspace',
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

  // The member verbs write a WorkspaceMember row by hand, so autoValidate
  // never sees their payload: each names a `type` in db/schema.lite instead,
  // and a role outside WorkspaceRole is a 400 naming the field before the
  // method runs.
  methods: ['find', 'get', 'create', 'patch', 'remove', 'restore',
            'members',
            { method: 'addMember',     input: 'WorkspaceMemberAdd',  gate: LEVELS.ADMINISTRATOR },
            { method: 'setMemberRole', input: 'WorkspaceMemberRole', gate: LEVELS.ADMINISTRATOR },
            { method: 'removeMember',  gate: LEVELS.ADMINISTRATOR },
            'leave',
            // The topic is the secret on the public rung: an admin's to read and to ring.
            { method: 'push',          gate: LEVELS.ADMINISTRATOR },
            { method: 'testPing',      gate: LEVELS.ADMINISTRATOR }],

  // Only workspaces the caller belongs to. The old version did this with a
  // JOIN; `memberships: { some: { userId } }` is the relation the schema
  // already declares.
  async find() {
    const user = $.user as { id?: string } | undefined
    if (!user?.id) return { total: 0, limit: 20, offset: 0, data: [] }

    const { limit, offset } = getPagination()
    const mine = await members().findMany({ where: { userId: user.id } })
    const ids  = mine.map((m: any) => m.workspaceId)
    if (!ids.length) return { total: 0, limit, offset, data: [] }

    const { rows, total } = await db().workspace.findManyAndCount({
      where:   { id: { in: ids } },
      orderBy: callerOrder({ createdAt: 'desc' }),
      limit, offset,
    })
    // The caller's role in each, off the rows already read. A person's list of
    // workspaces is also where they read what they hold in each, and a
    // Workspace row has no column that says it.
    const roleIn = new Map(mine.map((m: any) => [m.workspaceId, m.role]))
    return { total, limit, offset, data: rows.map((w: any) => ({ ...w, role: roleIn.get(w.id) })) }
  },

  // Non-membership is reported as 404, not 403 — a workspace you cannot see
  // should not be confirmable by id.
  async get() {
    const user = sessionOf()
    const ws   = await db().workspace.findUnique({ where: { id: $.id as string } })
    if (!ws) throw new NotFound(`Workspace '${$.id}' not found`)

    const member = await members().findFirst({ where: { workspaceId: $.id as string, userId: user.id } })
    if (!member) throw new NotFound(`Workspace '${$.id}' not found`)

    return ws
  },

  async create() {
    const user = sessionOf()
    if (!user.accountId) throw new Unauthorized('Session carries no account')

    const data = $.data as Record<string, unknown>
    data.slug ??= slugify(String(data.name ?? ''))

    // One transaction: a workspace whose creator is not a member of it is
    // unreachable by its own owner.
    const ws = await ($.db.asSystem() as any).$transaction(async (tx: any) => {
      const ws = await tx.workspace.create({
        data: { ...data, accountId: user.accountId },
      })
      await tx.workspaceMember.create({
        data: { workspaceId: ws.id, userId: user.id, role: 'owner',
                capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() },
      })
      return ws
    })

    return ws
  },

  async patch() {
    const ws   = await db().workspace.findUnique({ where: { id: $.id as string } })
    if (!ws) throw new NotFound(`Workspace '${$.id}' not found`)

    const data = $.data as Record<string, unknown>
    // accountId is not a client's to change: it moves the workspace between
    // tenants, which does not belong on a general PATCH.
    const patch = narrowPatch(data)
    if (changesNothing(patch)) return ws
    return db().workspace.update({ where: { id: $.id as string }, data: patch })
  },

  async remove() {
    const ws = await db().workspace.findUnique({ where: { id: $.id as string } })
    if (!ws) throw new NotFound(`Workspace '${$.id}' not found`)

    // @@softDelete(cascade) — projects, servers, secrets and jobs are stamped
    // with it rather than left live under a deleted parent.
    const removed = await db().workspace.remove({ where: { id: $.id as string } })
    return Array.isArray(removed) ? removed[0] : removed
  },

  // ── members ───────────────────────────────────────────────────────
  // asSystem: membership is what decides access, so it is not read through
  // the caller it is deciding about.
  //
  // The read is a system one for ANY id, so membership is checked first and
  // answers like `get` does — without it any signed-in account read another
  // workspace's roster, whole User rows included (`FJS-1087`).
  //
  // A colleague is shown by name, address and face and nothing more
  // (`FJS-D619`). The read is a system one, so the User read policy that
  // keeps a viewer to their own row never runs, and a whole row handed every
  // viewer `isSystemAdmin`, `status` and `accountId` of everybody in the team.
  async members() {
    $.dispatch = false          // a read — do not announce it on a channel
    const user = sessionOf()
    const mine = await members().findFirst({ where: { workspaceId: $.id as string, userId: user.id } })
    if (!mine) throw new NotFound(`Workspace '${$.id}' not found`)

    const rows = await members().findMany({
      where:   { workspaceId: $.id as string },
      include: { user: { select: { id: true, name: true, displayName: true, email: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return { total: rows.length, data: rows }
  },

  async addMember() {
    const { userId: target, role } = $.data as { userId: string; role?: WorkspaceRole }

    const wsId = $.id as string
    if (await members().exists({ where: { workspaceId: wsId, userId: target } }))
      throw new Conflict('User is already a member of this workspace')

    // `User` reads self-only, so the person being added is a parent the
    // caller cannot read, and graded as the caller's own guess the create
    // answered 422 "names no User" (FJS-D576). The service reads them as the
    // app first, and names the key under `system:` as its own statement
    // (FJS-1953) — the write stays the caller's, so the gate, the
    // `Capability[]` guard and the audit actor are theirs.
    if (!await people().exists({ where: { id: target } }))
      throw new NotFound(`User '${target}' not found`)

    const next = role ?? 'developer'
    return memberWrites().create({
      data: { workspaceId: wsId, userId: target, role: next, capabilities: grantsFor(next),
              invitedBy: actor(), invitedAt: new Date().toISOString() },
      system: ['userId'],
    })
  },

  async setMemberRole() {
    const { userId: target, role } = $.data as { userId: string; role: WorkspaceRole }

    // FJS-410. `role` is what core/gate.ts grades every gate from, so naming
    // your OWN userId with `role: 'owner'` granted level 6. The write below
    // is the caller's own client, so `WorkspaceMember`'s
    // `@@deny(update, userId == auth().id)` refuses it; the read stays
    // system because standing cannot be read through the caller it grades.
    const wsId   = $.id as string
    const member = await members().findFirst({ where: { workspaceId: wsId, userId: target } })
    if (!member) throw new NotFound('Member not found')

    refuseOutranked(member, 'change the role of')
    if (member.role === 'owner' && role !== 'owner') await refuseLastOwner(wsId, 'demote')

    // Re-stamped, not merged. A role IS a default set (core/capabilities.ts),
    // so leaving the old grants behind would make a demotion change the word
    // on the screen and nothing about what the person may actually do.
    //
    // A deny on update FILTERS the row out rather than throwing, so a refused
    // write answers null — and a 200 carrying null reads as a role changed.
    const updated = await memberWrites().update({
      where: { id: member.id },
      data:  { role, capabilities: grantsFor(role) },
    })
    if (!updated)
      throw new Forbidden(
        'You cannot change your own role in a workspace. Ask another owner or administrator.'
      )
    return updated
  },

  async removeMember() {
    const target = ($.query.userId ?? $.query.user_id ??
                    ($.data as Record<string, string> | null)?.userId) as string | undefined
    if (!target) throw new BadRequest('userId is required')

    const wsId   = $.id as string
    const member = await members().findFirst({ where: { workspaceId: wsId, userId: target } })
    if (!member) throw new NotFound('Member not found')
    refuseOutranked(member, 'remove')
    if (member.role === 'owner') await refuseLastOwner(wsId, 'remove')

    // Hard delete: WorkspaceMember has no @@softDelete — a revoked membership
    // should stop matching, not linger as a tombstone the role hooks read.
    await memberWrites().delete({ where: { id: member.id } })
    return { workspace_id: wsId, user_id: target, removed: true }
  },

  // ── leave ─────────────────────────────────────────────────────────
  // The one act on your OWN membership. Owner is a role and a workspace may
  // hold several (`FJS-D1669`), so handing it over is `setMemberRole` naming
  // somebody else `owner`; you step down by leaving, or a co-owner demotes you.

  /** End your own membership. Any role may; the last owner may not. */
  async leave() {
    const me     = sessionOf().id as string
    const wsId   = $.id as string
    const mine   = await members().findFirst({ where: { workspaceId: wsId, userId: me } })
    if (!mine) throw new NotFound(`Workspace '${wsId}' not found`)
    if (mine.role === 'owner') await refuseLastOwner(wsId, 'leave as')

    await db().asSystem().workspaceMember.delete({ where: { id: mine.id } })
    return { workspace_id: wsId, user_id: me, left: true }
  },

  // ── push · testPing ───────────────────────────────────────────────
  // The workspace's phone-ping topic, for the Workspace card. The topic is the
  // SECRET on public ntfy.sh (`domain/notification/push-topic.ts`), so it is an
  // admin's to see, and reading it mints it: a phone has to subscribe BEFORE
  // the first outage, so the first view is what creates the name. Which server,
  // and on which rung, is `app.push`'s answer (`push.ts`); the card restates
  // neither.
  async push() {
    $.dispatch = false
    const wsId  = $.id as string
    const topic = await pushTopicFor($.app, wsId)
    if (!topic) throw new NotFound(`Workspace '${wsId}' not found`)
    const { url, rung } = $.app.push
    return { topic, url, rung, subscribeUrl: `${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}` }
  },

  /** One ping to the topic, at default priority, through the same recipient
   *  shape `notifyPeople()` builds -- the real builder, driver and ladder, so a
   *  phone that rings proves the whole path and a throw names which server
   *  refused. Answers the ntfy message id when the server gives one. */
  async testPing() {
    const wsId  = $.id as string
    const sys   = $.db.asSystem() as any
    const ws    = await sys.workspace.findFirst({ where: { id: wsId } })
    if (!ws) throw new NotFound(`Workspace '${wsId}' not found`)
    const topic = await pushTopicFor($.app, wsId)
    const user  = sessionOf() as { id?: string; name?: string; email?: string }
    const receipts = await $.app.notify(
      { pushTopic: topic, transports: ['push'] } as any,
      pushTest({ workspaceName: ws.name, by: user.name || user.email || 'Somebody', url: `${env.FRONTIER_APP_URL.replace(/\/+$/, '')}/admin/workspace/` }) as any,
    )
    return { topic, sent: true, receipts }
  },

  hooks: {
    before: {
      all:           [authenticate],
      create:        [stampOwnership],
      // refuseGrantAboveOwn is the other half of FJS-410: the gate says *may
      // you manage the team*, this says *not a role above your own*. Without
      // it an admin still mints an owner, on somebody else's row.
      addMember:     [refuseGrantAboveOwn()],
      setMemberRole: [refuseGrantAboveOwn()],
    },
  },
})
