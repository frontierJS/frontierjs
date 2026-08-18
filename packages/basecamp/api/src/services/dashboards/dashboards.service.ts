// src/services/dashboards/dashboards.service.ts
// Saved arrangements of widgets over data this app already answers.
//
// Mounted at /dashboards. Custom methods dispatch on X-Service-Method:
//   kinds        — the widget vocabulary, addressing the COLLECTION
//   addWidget · updateWidget · removeWidget · reorder — one dashboard's layout
//
// **A widget names a kind, never a query.** `enum WidgetKind` in the schema is
// the whole vocabulary and `kinds.ts` says what each kind needs; a widget holds
// a subject and a few knobs. Nothing here reads a row on the browser's behalf:
// the SCREEN renders a widget by asking the service that owns that data, with
// the caller's own session, so a dashboard can show exactly what its reader
// could have opened for themselves. A stored `{ accessor, where }` would have
// been the opposite — a read in a row, run by the server for whoever opened the
// page, graded against nothing. Ruled 2026-08-10, `DECISIONS.md`.
//
// **Widgets are managed through this service, not their own.** Same shape as
// FlagOverride and the alert-channel join: a widget has no meaning outside its
// dashboard, and putting the layout behind one owner is what keeps "is this
// kind placeable with this subject" a single answer.
//
// **A widget's subject is a relation.** `serverId` / `appId` are real foreign
// keys, so a hard delete nulls them and this service can say the machine is
// gone rather than rendering a card that 404s forever. Both models are
// @@softDelete, so the ordinary case is a row that still exists and is excluded
// from every read — `get` resolves that to the same answer.

import { createService, NotFound, BadRequest, Conflict, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, narrowPatch, changesNothing, assertSlugFree, slugify, dbOf, wsOf, actorOf }
  from '../../core/resource.ts'
import { WIDGET_KINDS, WIDGET_KIND_BY_NAME, STAT_SOURCES } from './kinds.ts'
import { PORTAL_SERVICE_IDS } from '../portal/portal.service.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

interface WidgetInput {
  widgetId?: string
  kind?:     string
  serverId?: string | null
  appId?:    string | null
  config?:   Record<string, unknown>
  cols?:     number
}

export function createDashboardsService(app: BasecampApp) {

  /**
   * A dashboard with its widgets, in order, each carrying the name of what it
   * points at.
   *
   * The name is resolved HERE rather than by the browser, the same call
   * `volumes.find` makes for its server: a widget carrying only `serverId`
   * forces every screen that renders one to fan out a request per card before
   * it can draw a title. A subject that no longer resolves comes back as
   * `subjectMissing`, which is a state the card renders — never an empty
   * string that reads as a widget with no subject at all.
   */
  async function withWidgets(ctx: ServiceContext, dashboard: Record<string, unknown>) {
    const widgets = await dbOf(ctx).dashboardWidget.findMany({
      where:   { dashboardId: dashboard.id },
      orderBy: { position: 'asc' },
      limit:   200,
    })

    const serverIds = [...new Set(widgets.map((w: any) => w.serverId).filter(Boolean))] as string[]
    const appIds    = [...new Set(widgets.map((w: any) => w.appId).filter(Boolean))] as string[]

    // Two queries for the whole board rather than two per card. Scoped, so a
    // widget pointing at another workspace's server resolves to nothing here
    // and renders as missing — which is also the refusal, one layer down.
    const servers = serverIds.length
      ? await dbOf(ctx).server.findMany({
          where: { id: { in: serverIds }, workspaceId: wsOf(ctx) }, select: { id: true, name: true }, limit: 200 })
      : []
    const apps = appIds.length
      ? await dbOf(ctx).app.findMany({
          where: { id: { in: appIds }, workspaceId: wsOf(ctx) }, select: { id: true, name: true }, limit: 200 })
      : []

    const serverName = new Map(servers.map((s: any) => [s.id, s.name]))
    const appName    = new Map(apps.map((a: any) => [a.id, a.name]))

    return {
      ...dashboard,
      widgets: widgets.map((w: any) => {
        const spec = WIDGET_KIND_BY_NAME[w.kind]
        const name = w.serverId ? serverName.get(w.serverId)
                   : w.appId    ? appName.get(w.appId)
                   : null
        return {
          ...w,
          subjectType: spec?.subject ?? null,
          subjectName: name ?? null,
          // A widget that names a subject the caller can no longer see. Told
          // apart from "this kind takes no subject", which is the null above.
          subjectMissing: !!(w.serverId || w.appId) && !name,
        }
      }),
    }
  }

  /**
   * Validate a widget against the vocabulary, and answer the columns to write.
   *
   * The one owner of "may this widget be placed": both `addWidget` and
   * `updateWidget` go through it, so a rule enforced on creation cannot be
   * walked around by editing afterwards.
   */
  async function resolveWidget(
    ctx: ServiceContext, kind: string, input: WidgetInput,
  ): Promise<Record<string, unknown>> {
    const spec = WIDGET_KIND_BY_NAME[kind]
    if (!spec)
      throw new BadRequest(`Unknown widget kind '${kind}' — one of: ${WIDGET_KINDS.map(k => k.kind).join(', ')}`)

    const serverId = input.serverId ?? null
    const appId    = input.appId    ?? null

    // A subject the kind does not take is refused rather than ignored. Storing
    // it would be a column nothing reads that looks like it works.
    if (spec.subject !== 'server' && serverId)
      throw new BadRequest(`A ${spec.label} widget takes no server`)
    if (spec.subject !== 'app' && appId)
      throw new BadRequest(`A ${spec.label} widget takes no app`)

    if (spec.subject === 'server') {
      if (!serverId && spec.required) throw new BadRequest(`A ${spec.label} widget needs a server`)
      if (serverId && !await dbOf(ctx).server.exists({ where: { id: serverId, workspaceId: wsOf(ctx) } }))
        throw new NotFound(`Server '${serverId}' not found in this workspace`)
    }
    if (spec.subject === 'app') {
      if (!appId && spec.required) throw new BadRequest(`A ${spec.label} widget needs an app`)
      if (appId && !await dbOf(ctx).app.exists({ where: { id: appId, workspaceId: wsOf(ctx) } }))
        throw new NotFound(`App '${appId}' not found in this workspace`)
    }

    const config = validateConfig(spec.kind, spec.config, input.config ?? {})

    // Bounded here as well as in the schema: @gte/@lte are validators at the
    // boundary and this payload is a custom method's, which the model's own
    // create schema never sees.
    const cols = Math.min(3, Math.max(1, Math.round(Number(input.cols ?? spec.cols) || spec.cols)))

    return { kind: spec.kind, serverId, appId, config, cols }
  }

  /** Config is knobs. An unknown key is refused by name, and the two kinds that
   *  take one have a declared vocabulary behind it. */
  function validateConfig(kind: string, allowed: string[], config: Record<string, unknown>) {
    const unknown = Object.keys(config).filter(k => !allowed.includes(k))
    if (unknown.length)
      throw new BadRequest(
        `A ${kind} widget does not read ${unknown.join(', ')}` +
        (allowed.length ? ` — it takes ${allowed.join(', ')}` : ' — it takes no configuration'))

    if (kind === 'stat_counter') {
      const source = config.source as string | undefined
      if (!source) throw new BadRequest(`A counter needs a source — one of: ${STAT_SOURCES.join(', ')}`)
      if (!STAT_SOURCES.includes(source as typeof STAT_SOURCES[number]))
        throw new BadRequest(`'${source}' is not countable here — one of: ${STAT_SOURCES.join(', ')}`)
    }

    if (kind === 'service_health') {
      const serviceId = config.serviceId as string | undefined
      if (!serviceId) throw new BadRequest(`A service health widget needs a serviceId — one of: ${PORTAL_SERVICE_IDS.join(', ')}`)
      if (!PORTAL_SERVICE_IDS.includes(serviceId))
        throw new NotFound(`Portal service '${serviceId}' not found — one of: ${PORTAL_SERVICE_IDS.join(', ')}`)
    }

    return config
  }

  /** One widget on one of the caller's dashboards, or 404. Reached only
   *  through a dashboard that `getScoped` has already put inside the
   *  workspace, so a widget id from another tenant answers the same 404 as one
   *  that never existed. */
  async function widgetOf(ctx: ServiceContext, dashboardId: string, widgetId?: string) {
    if (!widgetId) throw new BadRequest('widgetId is required')
    const widget = await dbOf(ctx).dashboardWidget.findFirst({ where: { id: widgetId, dashboardId } })
    if (!widget) throw new NotFound(`Widget '${widgetId}' not found on this dashboard`)
    return widget
  }

  return createService({
    name:  'dashboards',
    model: 'Dashboard',

    // The whole surface, declared. `model:` brings Junction's Litestone base,
    // which answers every CRUD verb this service leaves out — including PUT,
    // which would replace a whole row from the wire and take `workspaceId`
    // with it. Naming the six means the absence is real; it also throws at
    // construction on a method this service does not have.
    methods: ['find', 'get', 'create', 'patch', 'remove',
              'kinds', 'addWidget', 'updateWidget', 'removeWidget', 'reorder'],

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      // Pinned first, then newest — in SQL, not in JavaScript afterwards. A
      // sort applied to the page puts a pinned board at the top of page two
      // and leaves it there, which reads as a pin that stopped working.
      const page = await findScoped(ctx, 'dashboard', {
        limit, offset,
        orderBy: { isPinned: 'desc', createdAt: 'desc' },
      })

      // A count per row rather than the widgets themselves: the list says how
      // full a board is, and `get` is the read that pays for the layout.
      const counts = await Promise.all(page.data.map((d: any) =>
        dbOf(ctx).dashboardWidget.count({ where: { dashboardId: d.id } })))

      return { ...page, data: page.data.map((d: any, i: number) => ({ ...d, widget_count: counts[i] })) }
    },

    async get(ctx: ServiceContext) {
      return withWidgets(ctx, await getScoped(ctx, 'dashboard', 'Dashboard'))
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      await assertSlugFree(ctx, 'dashboard', { workspaceId: wsOf(ctx), slug: data.slug },
        `A dashboard called '${data.name}' already exists in this workspace`)

      const created = await dbOf(ctx).dashboard.create({ data })
      // The same shape `get` answers, so a screen that navigates straight to
      // the new board renders it rather than a record with no widgets key.
      return withWidgets(ctx, created)
    },

    async patch(ctx: ServiceContext) {
      const dashboard = await getScoped(ctx, 'dashboard', 'Dashboard')
      const data      = ctx.data as Record<string, unknown>

      // The slug follows the name, because a dashboard's handle is not in
      // anyone else's source code — unlike a flag key or a network slug, which
      // are immutable for exactly that reason.
      const patch = narrowPatch(data, ['slug', 'createdBy'])
      if (typeof patch.name === 'string' && patch.name !== dashboard.name) {
        patch.slug = slugify(patch.name as string)
        await assertSlugFree(ctx, 'dashboard',
          { workspaceId: wsOf(ctx), slug: patch.slug, id: { not: dashboard.id } },
          `A dashboard called '${patch.name}' already exists in this workspace`)
      }

      if (changesNothing(patch)) return withWidgets(ctx, dashboard)
      return withWidgets(ctx, await dbOf(ctx).dashboard.update({ where: { id: dashboard.id }, data: patch }))
    },

    async remove(ctx: ServiceContext) {
      return removeScoped(ctx, 'dashboard', 'Dashboard')
    },

    // ── kinds — POST /dashboards  X-Service-Method: kinds ─────────────
    // The widget vocabulary, fetched rather than shipped in the bundle.
    //
    // Addresses the COLLECTION: there is no subject dashboard, which neither
    // client could express until `FJS-122`. The screen builds its picker from
    // this, so a kind cannot be offered that the service would refuse — and the
    // `needs` sentence reaches the card from the same place, rather than being
    // retyped into the UI where it would drift from what is actually missing.
    // **Not the list envelope.** `{ total, data, … }` is recognised as a list
    // and rebuilt from those two keys alone — `statSources` and
    // `portalServices` were dropped by `wrapResult` with no error and no
    // warning, so the picker offered kinds and then had nothing to configure
    // them with. Three answers in one call means an object with three named
    // keys, which unwraps whole. Same trap `volumes.usage` documents from the
    // other side.
    async kinds(ctx: ServiceContext) {
      ctx.dispatch = false   // read-shaped
      return {
        kinds:          WIDGET_KINDS,
        statSources:    [...STAT_SOURCES],
        portalServices: PORTAL_SERVICE_IDS,
      }
    },

    // ── addWidget — POST /dashboards/:id  X-Service-Method: addWidget ─
    async addWidget(ctx: ServiceContext) {
      const dashboard = await getScoped(ctx, 'dashboard', 'Dashboard')
      const input     = (ctx.data ?? {}) as WidgetInput
      if (!input.kind) throw new BadRequest('kind is required')

      const columns = await resolveWidget(ctx, input.kind, input)

      // Appended. Position is dense only by convention — `reorder` rewrites the
      // whole set — so the next one goes after the last, not at count+1, which
      // collides the moment anything was removed from the middle.
      const last = await dbOf(ctx).dashboardWidget.findMany({
        where: { dashboardId: dashboard.id }, orderBy: { position: 'desc' }, limit: 1,
      })
      const position = last.length ? (last[0].position as number) + 1 : 0

      // A board nothing can lay out is worse than a refusal: 200 cards is a
      // page that never finishes rendering, and the layout is thirds of a row.
      const count = await dbOf(ctx).dashboardWidget.count({ where: { dashboardId: dashboard.id } })
      if (count >= 60) throw new Conflict('A dashboard holds at most 60 widgets')

      await dbOf(ctx).dashboardWidget.create({ data: { dashboardId: dashboard.id, position, ...columns } })

      // The DASHBOARD, not the widget. A custom method's return shape is
      // load-bearing (junction FJS-020): the screen assigns this over the
      // record it is rendering, and a widget row has neither the board's id nor
      // its other cards.
      return withWidgets(ctx, dashboard)
    },

    // ── updateWidget ─────────────────────────────────────────────────
    async updateWidget(ctx: ServiceContext) {
      const dashboard = await getScoped(ctx, 'dashboard', 'Dashboard')
      const input     = (ctx.data ?? {}) as WidgetInput
      const widget    = await widgetOf(ctx, dashboard.id as string, input.widgetId)

      // The kind is immutable. Changing it changes what the card is, and every
      // subject and config key it validated against — that is a new widget, and
      // saying so is cheaper than a half-migrated one.
      if (input.kind && input.kind !== widget.kind)
        throw new BadRequest('A widget cannot change kind — remove it and add the one you want')

      // Key presence, not `??` (Invariant 9): an explicit null clears the
      // subject, which is how a deploy feed goes back to the whole workspace.
      const columns = await resolveWidget(ctx, widget.kind as string, {
        serverId: 'serverId' in input ? input.serverId : (widget.serverId as string | null),
        appId:    'appId'    in input ? input.appId    : (widget.appId    as string | null),
        config:   'config'   in input ? input.config   : (widget.config as Record<string, unknown>),
        cols:     'cols'     in input ? input.cols     : (widget.cols as number),
      })

      await dbOf(ctx).dashboardWidget.update({ where: { id: widget.id }, data: columns })
      return withWidgets(ctx, dashboard)
    },

    // ── removeWidget ─────────────────────────────────────────────────
    async removeWidget(ctx: ServiceContext) {
      const dashboard = await getScoped(ctx, 'dashboard', 'Dashboard')
      const widget    = await widgetOf(ctx, dashboard.id as string, (ctx.data as WidgetInput)?.widgetId)

      // Hard delete: DashboardWidget declares no @@softDelete. A card taken off
      // a board is not history — it is a layout decision, and the audit trail
      // already records that it was taken off.
      await dbOf(ctx).dashboardWidget.delete({ where: { id: widget.id } })
      return withWidgets(ctx, dashboard)
    },

    // ── reorder ──────────────────────────────────────────────────────
    // The whole order, not one move. A "move up" that writes two rows leaves a
    // board half-ordered when the second write fails, and two people dragging
    // at once produce an order neither chose. Sending the sequence makes the
    // last writer's intent the one on screen.
    async reorder(ctx: ServiceContext) {
      const dashboard = await getScoped(ctx, 'dashboard', 'Dashboard')
      const ids       = ((ctx.data ?? {}) as { ids?: string[] }).ids
      if (!Array.isArray(ids) || !ids.length) throw new BadRequest('ids must be a non-empty array of widget ids')

      const widgets = await dbOf(ctx).dashboardWidget.findMany({
        where: { dashboardId: dashboard.id }, select: { id: true }, limit: 200,
      })
      const known = new Set(widgets.map((w: any) => w.id))

      // Every widget, exactly once. A partial list would silently leave the
      // rest wherever they were, which reads as a reorder that half worked.
      const unknown = ids.filter(id => !known.has(id))
      if (unknown.length)    throw new NotFound(`Not a widget on this dashboard: ${unknown.join(', ')}`)
      if (new Set(ids).size !== ids.length) throw new BadRequest('ids contains the same widget twice')
      if (ids.length !== known.size)
        throw new BadRequest(`ids must name every widget on this dashboard — ${known.size} of them, got ${ids.length}`)

      for (const [position, id] of ids.entries())
        await dbOf(ctx).dashboardWidget.update({ where: { id }, data: { position } })

      return withWidgets(ctx, dashboard)
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // A dashboard is a view over what the reader may already open, so it
        // sits at the developer bar rather than admin: the person who needs a
        // board is the person doing the work, and holding it higher means
        // asking an owner to arrange somebody else's screen.
        create:       [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampDashboard],
        patch:        [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:       [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        addWidget:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        updateWidget: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        removeWidget: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        reorder:      [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}

/**
 * before/create: stamp what the client does not send.
 *
 * A HOOK rather than the first lines of `create`, because `model:` brings
 * autoValidate('create') and Junction runs user hooks first — done inside the
 * method, every request 400s on a `workspaceId` the browser was never meant to
 * supply.
 */
function stampDashboard(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  data.workspaceId = wsOf(ctx)
  data.createdBy   = actorOf(ctx)
  if (typeof data.name === 'string' && !data.slug) data.slug = slugify(data.name)
}
