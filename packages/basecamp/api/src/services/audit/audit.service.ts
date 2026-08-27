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

import { createService, findWindow, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

export function createAuditService(app: BasecampApp) {
  return createService({
    name:    'audit',
    model:   'AuditEvent',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
    methods: 'readOnly',

    // A trail is the shape a numbered page is worst for. It only grows, and it
    // grows at the end a reader starts from, so between asking for page 1 and
    // page 2 every offset has moved by however many things happened in between
    // — which is a row served twice and another one skipped, silently, on the
    // one screen in the app whose whole job is to be complete.
    //
    // So the answer here is a WINDOW THAT GROWS (`FJS-D145`): the browser holds
    // what it has read and asks for what is past the far edge of it, by the
    // sort keys of the last row rather than by a count of rows before it.
    // `findWindow` owns both paths — junction's derived find calls the same
    // function — because a hand-written find restating them is how the
    // tiebreaker and the absent total end up with two answers.
    async find() {
      const { limit, offset, after } = getPagination({ limit: 50 })

      // Filters are declared here rather than passed through: `$.query` is
      // whatever a caller sent, and handing it to the client verbatim would let
      // one filter on columns this service does not mean to expose.
      const action      = $.query.action      as string | undefined
      const subjectType = $.query.subjectType as string | undefined
      const actorId     = $.query.actorId     as string | undefined

      return await findWindow(db().auditEvent, {
        where: {
          workspaceId: ws(),
          ...(action      ? { action }      : {}),
          ...(subjectType ? { subjectType } : {}),
          ...(actorId     ? { actorId }     : {}),
        },
        // `createdAt` is not unique — a burst of writes inside one millisecond
        // shares a timestamp — so the cursor cannot be built from it alone.
        // Litestone appends the model's own id to the sort keys and refuses
        // where there is nothing to append; the tiebreaker is the schema's, and
        // is not restated here.
        orderBy: { createdAt: 'desc' },
        limit, offset,
      }, after, 'The audit trail')
    },

    hooks: {
      before: {
        all: [sessionScope(app), requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
