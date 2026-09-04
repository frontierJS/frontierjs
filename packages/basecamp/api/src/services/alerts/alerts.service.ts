// src/services/alerts/alerts.service.ts
// Alert rules and the events they fire.
//
// Mounted at /alerts. Custom methods dispatch on X-Service-Method:
//   events · attachChannel · detachChannel · acknowledge · resolve
//
// `AlertRule` and `AlertEvent` have been in db/schema.lite since the Data realm
// was rebuilt and had **no API surface at all** — two models nothing could
// read. This is the service, not the evaluator: nothing here decides that a
// rule has been breached. That belongs with whatever measures (an outpost
// heartbeat, an observability adapter), and is deliberately not invented here,
// because a rule that fires from the browser's idea of the truth is theater.
// `AlertEvent` rows are therefore written by the system today and read here.
//
// The split in the schema is the split in the hooks: a rule is authored by a
// person (admin), an event is FIRED by the system and ACKNOWLEDGED by a person.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, deriveSlug, narrowPatch, changesNothing, ws, actor }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

export function createAlertsService(app: BasecampApp) {

  /** An event belongs to a rule, and the rule carries the workspace — so the
   *  tenancy check is one join away and must never be skipped. AlertEvent has
   *  no workspaceId column of its own; that is the schema saying an event is
   *  meaningless without its rule. */
  async function eventInWorkspace(eventId: string) {
    const event = await db().alertEvent.findFirst({ where: { id: eventId } })
    if (!event) throw new NotFound(`Alert event '${eventId}' not found`)
    if (!await db().alertRule.exists({ where: { id: event.ruleId, workspaceId: ws() } }))
      throw new NotFound(`Alert event '${eventId}' not found`)
    return event
  }

  /** A rule with its firing history and where it delivers — the shape `get`
   *  answers, so attach/detach can return the same record rather than a
   *  projection of it. A plain function, not `this.get(ctx)`: a service's
   *  methods are collected into a definition object and calling one through
   *  `this` binds to whatever the pipeline happened to invoke it with, which
   *  is not a contract. */
  async function ruleWithDelivery(rule: Record<string, unknown>) {
    const recent_events = await db().alertEvent.findMany({
      where:   { ruleId: rule.id },
      orderBy: { firedAt: 'desc' },
      limit:   10,
    })
    // A rule with no channel reaches nobody, which is a thing the screen has to
    // be able to say — and could not while `channels` was a Json array of ids
    // pointing at rows no model declared.
    const channels = await db().alertRuleChannel.findMany({
      where:   { ruleId: rule.id },
      include: { channel: true },
      orderBy: { createdAt: 'asc' },
    })
    return { ...rule, recent_events, channels }
  }

  return createService({
    name:  'alerts',
    model: 'AlertRule',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const severity = $.query.severity as string | undefined
      // The wire carries strings; the column is a boolean. Comparing them raw
      // matches nothing and reports an empty list rather than an error — so the
      // coercion is explicit, and `?isActive=false` means false rather than
      // "any non-empty string is truthy".
      const isActive = $.query.isActive as string | boolean | undefined

      return findScoped('alertRule', {
        where: {
          ...(severity ? { severity } : {}),
          ...(isActive !== undefined ? { isActive: isActive === true || isActive === 'true' } : {}),
        },
        limit, offset,
      })
    },

    async get() {
      // The firing history is what makes a rule legible — a rule with no events
      // and a rule that fires nightly look identical without it.
      return ruleWithDelivery(await getScoped('alertRule', 'Alert rule'))
    },

    async create() {
      // No severity check here. `AlertSeverity` is an enum in db/schema.lite as
      // of 2026-08-06, so the column carries a CHECK, `autoValidate` refuses a
      // bad value before this runs, and the UI builds its options from the same
      // declaration. This service used to own that list — and disagreed with
      // the schema's own `@default("medium")`, which it would have rejected.
      const data = $.data as Record<string, unknown>
      if (!data.metricName) throw new BadRequest('metricName is required')

      return db().alertRule.create({ data })
    },

    async patch() {
      await getScoped('alertRule', 'Alert rule')
      const data  = $.data as Record<string, unknown>
      const patch = narrowPatch(data)
      if (changesNothing(patch)) return getScoped('alertRule', 'Alert rule')
      return db().alertRule.update({ where: { id: $.id as string }, data: patch })
    },

    async remove() {
      const rule = await getScoped('alertRule', 'Alert rule')
      // AlertRule declares no @@softDelete, so this is a real delete — and the
      // schema cascades its events with it. That is the right shape: an event
      // is a firing OF a rule, not a record that outlives it. The audit trail
      // keeps the fact that the rule was deleted.
      await db().alertRule.remove({ where: { id: rule.id } })
      return rule
    },

    // ── events ────────────────────────────────────────────────────────
    // Read-shaped: it changes nothing, so it opts out of the announcement the
    // after-hook makes for every other method (junction's own rule — only
    // find/get are excluded automatically).
    async events() {
      const rule = await getScoped('alertRule', 'Alert rule')
      const { limit, offset } = getPagination()
      $.dispatch = false

      const { rows, total } = await db().alertEvent.findManyAndCount({
        where:   { ruleId: rule.id },
        orderBy: { firedAt: 'desc' },
        limit, offset,
      })
      return { total, limit, offset, data: rows }
    },

    // ── attachChannel / detachChannel ─────────────────────────────────
    // Where this rule delivers. Both answer the RULE, not the join row: a
    // custom method's return shape is load-bearing (junction FJS-020), and a
    // client assigning the answer over the record it is rendering must get
    // that record back.
    async attachChannel() {
      const rule = await getScoped('alertRule', 'Alert rule')
      const { channelId } = ($.data ?? {}) as Record<string, string>
      if (!channelId) throw new BadRequest('channelId is required')

      // Scoped to the workspace, not merely to existence — an id from another
      // workspace would otherwise route this workspace's pages elsewhere.
      const channel = await db().notificationChannel.findFirst({
        where: { id: channelId, workspaceId: ws() },
      })
      if (!channel) throw new NotFound(`Channel '${channelId}' not found in this workspace`)

      if (await db().alertRuleChannel.exists({ where: { ruleId: rule.id, channelId } }))
        throw new Conflict('That channel is already attached to this rule')

      await db().alertRuleChannel.create({ data: { ruleId: rule.id, channelId } })
      return ruleWithDelivery(rule)
    },

    async detachChannel() {
      const rule = await getScoped('alertRule', 'Alert rule')
      const { channelId } = ($.data ?? {}) as Record<string, string>
      if (!channelId) throw new BadRequest('channelId is required')

      const link = await db().alertRuleChannel.findFirst({ where: { ruleId: rule.id, channelId } })
      if (!link) throw new NotFound('That channel is not attached to this rule')

      await db().alertRuleChannel.remove({ where: { id: link.id } })
      return ruleWithDelivery(rule)
    },

    // ── acknowledge ───────────────────────────────────────────────────
    // A person says "seen". The event stays firing — acknowledging is not
    // resolving, and collapsing the two would let a page-out be silenced by
    // someone who only looked at it.
    async acknowledge() {
      const eventId = ($.data as Record<string, string>)?.eventId ?? $.id as string
      const event   = await eventInWorkspace(eventId)
      if (event.acknowledgedAt) throw new BadRequest('Already acknowledged')

      return db().alertEvent.update({
        where: { id: event.id },
        data:  { acknowledgedBy: actor(), acknowledgedAt: new Date().toISOString() },
      })
    },

    // ── resolve ───────────────────────────────────────────────────────
    async resolve() {
      const eventId = ($.data as Record<string, string>)?.eventId ?? $.id as string
      const event   = await eventInWorkspace(eventId)
      if (event.status === 'resolved') throw new BadRequest('Already resolved')

      return db().alertEvent.update({
        where: { id: event.id },
        data:  { status: 'resolved', resolvedAt: new Date().toISOString() },
      })
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Authoring a rule is an admin act: a rule decides who gets woken up.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), deriveSlug],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Where a rule delivers is part of authoring it — changing it decides
        // who gets woken up, which is the same call as writing the rule.
        attachChannel: [requireWorkspaceRole(app, 'admin', 'owner')],
        detachChannel: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Acknowledging is not authoring — anyone carrying a pager can do it.
        acknowledge: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        resolve:     [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
