// src/services/audit/audit.service.ts
// The application audit trail — who did what, in this workspace.
//
// Mounted at /audit. READ ONLY, and it has to say so out loud.
//
// `createService({ model })` gives a service the full CRUD set for free, which
// is the right default everywhere except here: declaring only find() left
// create/patch/remove answered by the BASE service, so an admin could POST a
// row into the audit trail and did — verified, a forged `forged.event` landed
// with a real id. A trail anyone can write to answers no question worth asking.
//
// The schema records the intent (`AuditEvent` update/delete are meant to be
// LOCKED, which not even asSystem() passes), but no `@@gate` is installed yet,
// so today the service is the only thing enforcing it.
//
// There are TWO trails and they answer different questions. This one is the
// APPLICATION trail: `servers.create` by a named actor, written by the
// basecampAuditLog hook in core/hooks.ts. The other is Litestone's row-level
// `@@log(audit)` JSONL, which records every column change with before/after
// snapshots and redacts protected fields. This service exposes the first;
// the second is a file an operator reads on the host.
//
// Access is admin/owner. A trail that every member can read is a list of what
// their colleagues have been doing.

import { createService, MethodNotAllowed } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, getPagination } from '../../core/hooks.ts'
import { dbOf, wsOf } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

export function createAuditService(app: BasecampApp) {
  return createService({
    name:  'audit',
    model: 'AuditEvent',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx, { limit: 50 })

      // Filters are declared here rather than passed through: `ctx.query` is
      // whatever a caller sent, and handing it to the client verbatim would let
      // one filter on columns this service does not mean to expose.
      const action      = ctx.query.action      as string | undefined
      const subjectType = ctx.query.subjectType as string | undefined
      const actorId     = ctx.query.actorId     as string | undefined

      const { rows, total } = await dbOf(ctx).auditEvent.findManyAndCount({
        where: {
          workspaceId: wsOf(ctx),
          ...(action      ? { action }      : {}),
          ...(subjectType ? { subjectType } : {}),
          ...(actorId     ? { actorId }     : {}),
        },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })

      return { total, limit, offset, data: rows }
    },

    // 405, not 403: the method does not exist on this resource for anybody,
    // which is a different statement from "you may not".
    async create() { throw new MethodNotAllowed('The audit trail is append-only, and only the app appends to it') },
    async patch()  { throw new MethodNotAllowed('Audit events cannot be edited') },
    async update() { throw new MethodNotAllowed('Audit events cannot be edited') },
    async remove() { throw new MethodNotAllowed('Audit events cannot be deleted') },

    hooks: {
      before: {
        all: [sessionScope(app), requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
