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
// `methods: 'readOnly'` is now the whole statement. It used to be four
// hand-written MethodNotAllowed stubs, one per verb — which worked, but only
// for the verbs somebody remembered to write, and said nothing to /manifest or
// the OpenAPI spec, both of which went on advertising create/patch/remove.
// Junction FJS-004 / FJS-D07.
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

import { createService, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

export function createAuditService(app: BasecampApp) {
  return createService({
    name:    'audit',
    model:   'AuditEvent',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
    methods: 'readOnly',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination({ limit: 50 })

      // Filters are declared here rather than passed through: `$.query` is
      // whatever a caller sent, and handing it to the client verbatim would let
      // one filter on columns this service does not mean to expose.
      const action      = $.query.action      as string | undefined
      const subjectType = $.query.subjectType as string | undefined
      const actorId     = $.query.actorId     as string | undefined

      const { rows, total } = await db().auditEvent.findManyAndCount({
        where: {
          workspaceId: ws(),
          ...(action      ? { action }      : {}),
          ...(subjectType ? { subjectType } : {}),
          ...(actorId     ? { actorId }     : {}),
        },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })

      return { total, limit, offset, data: rows }
    },

    hooks: {
      before: {
        all: [sessionScope(app), requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
