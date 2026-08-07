// src/services/alerts/alerts.service.ts
// Alert rules and the events they fire.
//
// Mounted at /alerts. Custom methods dispatch on X-Service-Method:
//   events · acknowledge · resolve
//
// `AlertRule` and `AlertEvent` have been in db/schema.lite since the Data realm
// was rebuilt and had **no API surface at all** — two models nothing could
// read. This is the service, not the evaluator: nothing here decides that a
// rule has been breached. That belongs with whatever measures (an agent
// heartbeat, an observability adapter), and is deliberately not invented here,
// because a rule that fires from the browser's idea of the truth is theatre.
// `AlertEvent` rows are therefore written by the system today and read here.
//
// The split in the schema is the split in the hooks: a rule is authored by a
// person (admin), an event is FIRED by the system and ACKNOWLEDGED by a person.

import { createService, NotFound, BadRequest, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { findScoped, getScoped, stampWorkspace, narrowPatch, dbOf, wsOf, actorOf }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

const SEVERITIES = ['info', 'warning', 'critical']

export function createAlertsService(app: BasecampApp) {

  /** An event belongs to a rule, and the rule carries the workspace — so the
   *  tenancy check is one join away and must never be skipped. AlertEvent has
   *  no workspaceId column of its own; that is the schema saying an event is
   *  meaningless without its rule. */
  async function eventInWorkspace(ctx: ServiceContext, eventId: string) {
    const event = await dbOf(ctx).alertEvent.findFirst({ where: { id: eventId } })
    if (!event) throw new NotFound(`Alert event '${eventId}' not found`)
    if (!await dbOf(ctx).alertRule.exists({ where: { id: event.ruleId, workspaceId: wsOf(ctx) } }))
      throw new NotFound(`Alert event '${eventId}' not found`)
    return event
  }

  return createService({
    name:  'alerts',
    model: 'AlertRule',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const severity = ctx.query.severity as string | undefined
      const isActive = ctx.query.isActive as string | undefined

      return findScoped(ctx, 'alertRule', {
        where: {
          ...(severity ? { severity } : {}),
          // The wire carries strings; the column is a boolean. Comparing them
          // raw matches nothing and reports an empty list rather than an error.
          ...(isActive !== undefined ? { isActive: isActive === 'true' || isActive === true } : {}),
        },
        limit, offset,
      })
    },

    async get(ctx: ServiceContext) {
      const rule = await getScoped(ctx, 'alertRule', 'Alert rule')
      // The firing history is what makes a rule legible — a rule with no events
      // and a rule that fires nightly look identical without it.
      const recent_events = await dbOf(ctx).alertEvent.findMany({
        where:   { ruleId: rule.id },
        orderBy: { firedAt: 'desc' },
        limit:   10,
      })
      return { ...rule, recent_events }
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      if (data.severity && !SEVERITIES.includes(data.severity as string))
        throw new BadRequest(`severity must be one of ${SEVERITIES.join(', ')}`)
      if (!data.metricName) throw new BadRequest('metricName is required')

      return dbOf(ctx).alertRule.create({ data })
    },

    async patch(ctx: ServiceContext) {
      await getScoped(ctx, 'alertRule', 'Alert rule')
      const data = ctx.data as Record<string, unknown>

      if (data.severity && !SEVERITIES.includes(data.severity as string))
        throw new BadRequest(`severity must be one of ${SEVERITIES.join(', ')}`)

      const patch = narrowPatch(data)
      if (!Object.keys(patch).length) return getScoped(ctx, 'alertRule', 'Alert rule')
      return dbOf(ctx).alertRule.update({ where: { id: ctx.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      const rule = await getScoped(ctx, 'alertRule', 'Alert rule')
      // AlertRule declares no @@softDelete, so this is a real delete — and the
      // schema cascades its events with it. That is the right shape: an event
      // is a firing OF a rule, not a record that outlives it. The audit trail
      // keeps the fact that the rule was deleted.
      await dbOf(ctx).alertRule.remove({ where: { id: rule.id } })
      return rule
    },

    // ── events ────────────────────────────────────────────────────────
    // Read-shaped: it changes nothing, so it opts out of the announcement the
    // after-hook makes for every other method (junction's own rule — only
    // find/get are excluded automatically).
    async events(ctx: ServiceContext) {
      const rule = await getScoped(ctx, 'alertRule', 'Alert rule')
      const { limit, offset } = getPagination(ctx)
      ctx.dispatch = false

      const { rows, total } = await dbOf(ctx).alertEvent.findManyAndCount({
        where:   { ruleId: rule.id },
        orderBy: { firedAt: 'desc' },
        limit, offset,
      })
      return { total, limit, offset, data: rows }
    },

    // ── acknowledge ───────────────────────────────────────────────────
    // A person says "seen". The event stays firing — acknowledging is not
    // resolving, and collapsing the two would let a page-out be silenced by
    // someone who only looked at it.
    async acknowledge(ctx: ServiceContext) {
      const eventId = (ctx.data as Record<string, string>)?.eventId ?? ctx.id as string
      const event   = await eventInWorkspace(ctx, eventId)
      if (event.acknowledgedAt) throw new BadRequest('Already acknowledged')

      return dbOf(ctx).alertEvent.update({
        where: { id: event.id },
        data:  { acknowledgedBy: actorOf(ctx), acknowledgedAt: new Date().toISOString() },
      })
    },

    // ── resolve ───────────────────────────────────────────────────────
    async resolve(ctx: ServiceContext) {
      const eventId = (ctx.data as Record<string, string>)?.eventId ?? ctx.id as string
      const event   = await eventInWorkspace(ctx, eventId)
      if (event.status === 'resolved') throw new BadRequest('Already resolved')

      return dbOf(ctx).alertEvent.update({
        where: { id: event.id },
        data:  { status: 'resolved', resolvedAt: new Date().toISOString() },
      })
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Authoring a rule is an admin act: a rule decides who gets woken up.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampWorkspace],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Acknowledging is not authoring — anyone carrying a pager can do it.
        acknowledge: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        resolve:     [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
