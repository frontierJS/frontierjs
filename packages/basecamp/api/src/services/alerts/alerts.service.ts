// src/services/alerts/alerts.service.ts
// The alerts a rule fired: read them, acknowledge them, resolve them.
//
// Mounted at /alerts. Custom methods dispatch on X-Service-Method:
//   acknowledge · resolve
//
// An `Alert` is FIRED by `jobs/alert-evaluate.job.ts` and never created here —
// `methods` names find and the two verbs, so the create/update/remove the model
// would bring are not mounted. The rule that fired it is authored through
// `services/alert-rules/`.

import { createService, NotFound, BadRequest, parseWhere, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, actor } from '../../core/resource.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'

/** An Alert belongs to a rule, and the rule carries the workspace — so the
 *  tenancy check is one join away and must never be skipped. Alert has no
 *  workspaceId column of its own; that is the schema saying an alert is
 *  meaningless without its rule. */
async function alertInWorkspace(alertId: string) {
  const alert = await db().alert.findFirst({ where: { id: alertId } })
  if (!alert) throw new NotFound(`Alert '${alertId}' not found`)
  if (!await db().alertRule.exists({ where: { id: alert.ruleId, workspaceId: ws() } }))
    throw new NotFound(`Alert '${alertId}' not found`)
  return alert
}

export default createService({
  name:  'alerts',
  scope: keyScope('alerts'),
  model: 'Alert',
  // Announced by the service DEFINITION, not by an after hook (FJS-031): see
  // `alert-rules.service.ts`.
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
  methods: ['find', 'acknowledge', 'resolve'],

  // Newest first, optionally one rule's (`?ruleId=`), which is what a rule's
  // History reads.
  async find() {
    const { limit, offset } = getPagination()
    const { rows, total } = await db().alert.findManyAndCount({
      where:   parseWhere($.query),
      orderBy: { firedAt: 'desc' },
      limit, offset,
    })
    return { total, limit, offset, data: rows }
  },

  // ── acknowledge ───────────────────────────────────────────────────
  // A person says "seen". The alert stays firing — acknowledging is not
  // resolving, and collapsing the two would let a page-out be silenced by
  // someone who only looked at it.
  async acknowledge() {
    const alert = await alertInWorkspace($.id as string)
    if (alert.acknowledgedAt) throw new BadRequest('Already acknowledged')

    return db().alert.update({
      where: { id: alert.id },
      data:  { acknowledgedBy: actor(), acknowledgedAt: new Date().toISOString() },
    })
  },

  // ── resolve ───────────────────────────────────────────────────────
  async resolve() {
    const alert = await alertInWorkspace($.id as string)
    if (alert.status === 'resolved') throw new BadRequest('Already resolved')

    return db().alert.update({
      where: { id: alert.id },
      data:  { status: 'resolved', resolvedAt: new Date().toISOString() },
    })
  },

  hooks: {
    before: {
      all: [sessionScope()],
      // No hook on the custom methods: each writes through the caller's own
      // client, so the model's gate grades it (acknowledging and resolving are
      // an `Alert` update: developer, anyone carrying a pager).
    },
  },
})
