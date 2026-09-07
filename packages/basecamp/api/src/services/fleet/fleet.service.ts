// src/services/fleet/fleet.service.ts
// The fleet, counted — servers by provider and region, for this workspace.
//
// `FJS-D228` phase 2. The first REPORT surface in this app, and it is a `view`
// in `db/schema.lite` rather than anything written here: declared columns, a
// SQL body that groups, and the access attributes a model carries. Nothing in
// this file counts anything.
//
// **Read-only because a projection has nothing to write to.** A view's write
// verbs exist on the client and refuse by name at the Data boundary; declaring
// the set here turns that into a 405 the router answers, which is the
// difference between a method this service does not have and an error out of
// the database.
//
// **There is no where-clause, and its absence is the assertion.** Tenancy is
// declared once at the top of `schema.lite` — `strategy row`, column and claim
// both `workspaceId` — and the parser gives a scoped view a generated READ
// deny against the column it declares. `membershipClaim` puts the claim on the
// principal per request, off the `WorkspaceMember` row for the workspace the
// request NAMES, and the Data boundary compiles the deny into the SQL. So the
// projection narrows to the caller's own fleet with nothing in this file
// saying so, which is what declaring tenancy is FOR: a `where` here would work
// and would make the declaration untested.
//
// The claim is fail-closed in the direction that matters. An absent one is
// NULL, a deny fires on TRUE and UNKNOWN alike, and the caller reads nothing —
// where an `@@allow` written by hand would have admitted everybody.

import { createService } from '@frontierjs/junction'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db } from '../../core/resource.ts'
import type { BasecampApp } from '../../basecamp.types.ts'

export function createFleetService(_app: BasecampApp) {
  return createService({
    name:    'fleet',
    model:   'fleetByProvider',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
    methods: 'readOnly',

    // The whole projection, every time. A report over a fleet is tens of rows
    // — one per provider and region a workspace runs in — so there is nothing
    // to page, and a limit here would reintroduce the truncation this view
    // exists to end: the screen used to tally `find({ limit: 200 })` and was
    // silently wrong from the 201st machine.
    async find() {
      const data = await db().fleetByProvider.findMany({
        orderBy: [{ providerKind: 'asc' }, { region: 'asc' }],
      })
      return { data, total: data.length }
    },

    hooks: {
      // No role check beyond membership. `Server` reads at 2 and so does the
      // projection; a member who can open every machine can read the shape of
      // them.
      before: { all: [sessionScope(_app)] },
    },
  })
}
