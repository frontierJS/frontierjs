// src/services/dashboards/dashboards.service.ts
// Saved arrangements of tiles over data this app already answers.
//
// Mounted at /dashboards. Custom methods dispatch on X-Service-Method:
//   kinds        — the tile vocabulary, addressing the COLLECTION
//   addTile · updateTile · removeTile · reorder — one dashboard's layout
//
// **A tile names a kind, never a query.** `enum TileKind` in the schema is
// the whole vocabulary and `kinds.ts` says what each kind needs; a tile holds
// a subject and a few knobs. Nothing here reads a row on the browser's behalf:
// the SCREEN renders a tile by asking the service that owns that data, with
// the caller's own session, so a dashboard can show exactly what its reader
// could have opened for themselves. A stored `{ accessor, where }` would have
// been the opposite — a read in a row, run by the server for whoever opened the
// page, graded against nothing. Ruled 2026-08-10, `DECISIONS.md`.
//
// **Tiles are managed through this service, not their own.** Same shape as
// FlagOverride and the alert-channel join: a tile has no meaning outside its
// dashboard, and putting the layout behind one owner is what keeps "is this
// kind placeable with this subject" a single answer.
//
// **A tile's subject is a relation.** `serverId` / `appId` are real foreign
// keys, so a hard delete nulls them and this service can say the machine is
// gone rather than rendering a card that 404s forever. Both models are
// @@softDelete, so the ordinary case is a row that still exists and is excluded
// from every read — `get` resolves that to the same answer.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, narrowPatch, changesNothing, slugify, ws, actor }
  from '../../core/resource.ts'
import { TILE_KINDS, TILE_KIND_BY_NAME, STAT_SOURCES } from './kinds.ts'
import { PORTAL_SERVICE_IDS } from '../portal/portal.service.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'

interface TileInput {
  tileId?: string
  kind?:     string
  serverId?: string | null
  appId?:    string | null
  config?:   Record<string, unknown>
  cols?:     number
}

/**
 * A dashboard with its tiles, in order, each carrying the name of what it
 * points at.
 *
 * The name is resolved HERE rather than by the browser, the same call
 * `volumes.find` makes for its server: a tile carrying only `serverId`
 * forces every screen that renders one to fan out a request per card before
 * it can draw a title. A subject that no longer resolves comes back as
 * `subjectMissing`, which is a state the card renders — never an empty
 * string that reads as a tile with no subject at all.
 */
async function withTiles(dashboard: Record<string, unknown>) {
  const tiles = await db().dashboardTile.findMany({
    where:   { dashboardId: dashboard.id },
    orderBy: { position: 'asc' },
    limit:   200,
  })

  const serverIds = [...new Set(tiles.map((w: any) => w.serverId).filter(Boolean))] as string[]
  const appIds    = [...new Set(tiles.map((w: any) => w.appId).filter(Boolean))] as string[]

  // Two queries for the whole board rather than two per card. Scoped, so a
  // tile pointing at another workspace's server resolves to nothing here
  // and renders as missing — which is also the refusal, one layer down.
  const servers = serverIds.length
    ? await db().server.findMany({
        where: { id: { in: serverIds }, workspaceId: ws() }, select: { id: true, name: true }, limit: 200 })
    : []
  const apps = appIds.length
    ? await db().app.findMany({
        where: { id: { in: appIds }, workspaceId: ws() }, select: { id: true, name: true }, limit: 200 })
    : []

  const serverName = new Map(servers.map((s: any) => [s.id, s.name]))
  const appName    = new Map(apps.map((a: any) => [a.id, a.name]))

  return {
    ...dashboard,
    tiles: tiles.map((w: any) => {
      const spec = TILE_KIND_BY_NAME[w.kind]
      const name = w.serverId ? serverName.get(w.serverId)
                 : w.appId    ? appName.get(w.appId)
                 : null
      return {
        ...w,
        subjectType: spec?.subject ?? null,
        subjectName: name ?? null,
        // A tile that names a subject the caller can no longer see. Told
        // apart from "this kind takes no subject", which is the null above.
        subjectMissing: !!(w.serverId || w.appId) && !name,
      }
    }),
  }
}

/**
 * Validate a tile against the vocabulary, and answer the columns to write.
 *
 * The one owner of "may this tile be placed": both `addTile` and
 * `updateTile` go through it, so a rule enforced on creation cannot be
 * walked around by editing afterwards.
 */
async function resolveTile(
  kind: string, input: TileInput,
): Promise<Record<string, unknown>> {
  const spec = TILE_KIND_BY_NAME[kind]
  if (!spec)
    throw new BadRequest(`Unknown tile kind '${kind}' — one of: ${TILE_KINDS.map(k => k.kind).join(', ')}`)

  const serverId = input.serverId ?? null
  const appId    = input.appId    ?? null

  // A subject the kind does not take is refused rather than ignored. Storing
  // it would be a column nothing reads that looks like it works.
  if (spec.subject !== 'server' && serverId)
    throw new BadRequest(`A ${spec.label} tile takes no server`)
  if (spec.subject !== 'app' && appId)
    throw new BadRequest(`A ${spec.label} tile takes no app`)

  if (spec.subject === 'server') {
    if (!serverId && spec.required) throw new BadRequest(`A ${spec.label} tile needs a server`)
    if (serverId && !await db().server.exists({ where: { id: serverId, workspaceId: ws() } }))
      throw new NotFound(`Server '${serverId}' not found in this workspace`)
  }
  if (spec.subject === 'app') {
    if (!appId && spec.required) throw new BadRequest(`A ${spec.label} tile needs an app`)
    if (appId && !await db().app.exists({ where: { id: appId, workspaceId: ws() } }))
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
      `A ${kind} tile does not read ${unknown.join(', ')}` +
      (allowed.length ? ` — it takes ${allowed.join(', ')}` : ' — it takes no configuration'))

  if (kind === 'stat_counter') {
    const source = config.source as string | undefined
    if (!source) throw new BadRequest(`A counter needs a source — one of: ${STAT_SOURCES.join(', ')}`)
    if (!STAT_SOURCES.includes(source as typeof STAT_SOURCES[number]))
      throw new BadRequest(`'${source}' is not countable here — one of: ${STAT_SOURCES.join(', ')}`)
  }

  if (kind === 'service_health') {
    const serviceId = config.serviceId as string | undefined
    if (!serviceId) throw new BadRequest(`A service health tile needs a serviceId — one of: ${PORTAL_SERVICE_IDS.join(', ')}`)
    if (!PORTAL_SERVICE_IDS.includes(serviceId))
      throw new NotFound(`Portal service '${serviceId}' not found — one of: ${PORTAL_SERVICE_IDS.join(', ')}`)
  }

  return config
}

/** One tile on one of the caller's dashboards, or 404. Reached only
 *  through a dashboard that `getScoped` has already put inside the
 *  workspace, so a tile id from another tenant answers the same 404 as one
 *  that never existed. */
async function tileOf(dashboardId: string, tileId: string) {
  const tile = await db().dashboardTile.findFirst({ where: { id: tileId, dashboardId } })
  if (!tile) throw new NotFound(`Tile '${tileId}' not found on this dashboard`)
  return tile
}

export default createService({
  name:  'dashboards',
  scope: keyScope('dashboards'),
  model: 'Dashboard',
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

  // The whole surface, declared. `model:` brings Junction's Litestone base,
  // which answers every CRUD verb this service leaves out — including PUT,
  // which would replace a whole row from the wire and take `workspaceId`
  // with it. Naming the six means the absence is real; it also throws at
  // construction on a method this service does not have.
  methods: ['find', 'get', 'create', 'patch', 'remove', 'restore',
            'kinds',
            { method: 'addTile',    input: 'TileAdd' },
            { method: 'updateTile', input: 'TileUpdate' },
            { method: 'removeTile', input: 'TileRemove' },
            { method: 'reorder',      input: 'DashboardReorder' }],

  async find() {
    const { limit, offset } = getPagination()
    // Pinned first, then newest — in SQL, not in JavaScript afterwards. A
    // sort applied to the page puts a pinned board at the top of page two
    // and leaves it there, which reads as a pin that stopped working.
    const page = await findScoped('dashboard', {
      limit, offset,
      orderBy: { isPinned: 'desc', createdAt: 'desc' },
    })

    // A count per row rather than the tiles themselves: the list says how
    // full a board is, and `get` is the read that pays for the layout.
    const counts = await Promise.all(page.data.map((d: any) =>
      db().dashboardTile.count({ where: { dashboardId: d.id } })))

    return { ...page, data: page.data.map((d: any, i: number) => ({ ...d, tile_count: counts[i] })) }
  },

  async get() {
    return withTiles(await getScoped('dashboard', 'Dashboard'))
  },

  async create() {
    const data = $.data as Record<string, unknown>
    const created = await db().dashboard.create({ data })
    // The same shape `get` answers, so a screen that navigates straight to
    // the new board renders it rather than a record with no tiles key.
    return withTiles(created)
  },

  async patch() {
    const dashboard = await getScoped('dashboard', 'Dashboard')
    const data      = $.data as Record<string, unknown>

    // The slug follows the name and nothing else (`FJS-D1517`): a slug sent
    // beside no rename would leave the two disagreeing.
    const patch = narrowPatch(data)
    delete patch.slug
    if (typeof patch.name === 'string' && patch.name !== dashboard.name) {
      patch.slug = slugify(patch.name as string)
    }

    if (changesNothing(patch)) return withTiles(dashboard)
    return withTiles(await db().dashboard.update({ where: { id: dashboard.id }, data: patch }))
  },

  async remove() {
    return removeScoped('dashboard', 'Dashboard')
  },

  // ── kinds — POST /dashboards  X-Service-Method: kinds ─────────────
  // The tile vocabulary, fetched rather than shipped in the bundle.
  //
  // Addresses the COLLECTION: there is no subject dashboard, which neither
  // client could express until `FJS-122`. The screen builds its picker from
  // this, so a kind cannot be offered that the service would refuse — and the
  // `needs` sentence reaches the card from the same place, rather than being
  // retyped into the UI where it would drift from what is actually missing.
  // **Not the list envelope.** `{ total, data, … }` is recognized as a list
  // and rebuilt from those two keys alone — `statSources` and
  // `portalServices` were dropped by `wrapResult` with no error and no
  // warning, so the picker offered kinds and then had nothing to configure
  // them with. Three answers in one call means an object with three named
  // keys, which unwraps whole. Same trap `volumes.usage` documents from the
  // other side.
  async kinds() {
    $.dispatch = false   // read-shaped
    return {
      kinds:          TILE_KINDS,
      statSources:    [...STAT_SOURCES],
      portalServices: PORTAL_SERVICE_IDS,
    }
  },

  // ── addTile — POST /dashboards/:id  X-Service-Method: addTile ─
  async addTile() {
    const dashboard = await getScoped('dashboard', 'Dashboard')
    const input     = ($.data ?? {}) as TileInput

    const columns = await resolveTile(input.kind as string, input)

    // Appended. Position is dense only by convention — `reorder` rewrites the
    // whole set — so the next one goes after the last, not at count+1, which
    // collides the moment anything was removed from the middle.
    const last = await db().dashboardTile.findMany({
      where: { dashboardId: dashboard.id }, orderBy: { position: 'desc' }, limit: 1,
    })
    const position = last.length ? (last[0].position as number) + 1 : 0

    // A board nothing can lay out is worse than a refusal: 200 cards is a
    // page that never finishes rendering, and the layout is thirds of a row.
    const count = await db().dashboardTile.count({ where: { dashboardId: dashboard.id } })
    if (count >= 60) throw new Conflict('A dashboard holds at most 60 tiles')

    await db().dashboardTile.create({ data: { dashboardId: dashboard.id, position, ...columns } })

    // The DASHBOARD, not the tile. A custom method's return shape is
    // load-bearing (junction FJS-020): the screen assigns this over the
    // record it is rendering, and a tile row has neither the board's id nor
    // its other cards.
    return withTiles(dashboard)
  },

  // ── updateTile ─────────────────────────────────────────────────
  async updateTile() {
    const dashboard = await getScoped('dashboard', 'Dashboard')
    const input     = ($.data ?? {}) as TileInput
    const tile    = await tileOf(dashboard.id as string, input.tileId as string)

    // The kind is immutable. Changing it changes what the card is, and every
    // subject and config key it validated against — that is a new tile, and
    // saying so is cheaper than a half-migrated one.
    if (input.kind && input.kind !== tile.kind)
      throw new BadRequest('A tile cannot change kind — remove it and add the one you want')

    // Key presence, not `??` (Invariant 9): an explicit null clears the
    // subject, which is how a deploy feed goes back to the whole workspace.
    const columns = await resolveTile(tile.kind as string, {
      serverId: 'serverId' in input ? input.serverId : (tile.serverId as string | null),
      appId:    'appId'    in input ? input.appId    : (tile.appId    as string | null),
      config:   'config'   in input ? input.config   : (tile.config as Record<string, unknown>),
      cols:     'cols'     in input ? input.cols     : (tile.cols as number),
    })

    await db().dashboardTile.update({ where: { id: tile.id }, data: columns })
    return withTiles(dashboard)
  },

  // ── removeTile ─────────────────────────────────────────────────
  async removeTile() {
    const dashboard = await getScoped('dashboard', 'Dashboard')
    const tile    = await tileOf(dashboard.id as string, ($.data as TileInput).tileId as string)

    // Hard delete: DashboardTile declares no @@softDelete. A card taken off
    // a board is not history — it is a layout decision, and the audit trail
    // already records that it was taken off.
    await db().dashboardTile.delete({ where: { id: tile.id } })
    return withTiles(dashboard)
  },

  // ── reorder ──────────────────────────────────────────────────────
  // The whole order, not one move. A "move up" that writes two rows leaves a
  // board half-ordered when the second write fails, and two people dragging
  // at once produce an order neither chose. Sending the sequence makes the
  // last writer's intent the one on screen.
  async reorder() {
    const dashboard = await getScoped('dashboard', 'Dashboard')
    const ids       = ($.data as { ids?: string[] }).ids
    if (!Array.isArray(ids) || !ids.length) throw new BadRequest('ids must be a non-empty array of tile ids')

    const tiles = await db().dashboardTile.findMany({
      where: { dashboardId: dashboard.id }, select: { id: true }, limit: 200,
    })
    const known = new Set(tiles.map((w: any) => w.id))

    // Every tile, exactly once. A partial list would silently leave the
    // rest wherever they were, which reads as a reorder that half worked.
    const unknown = ids.filter(id => !known.has(id))
    if (unknown.length)    throw new NotFound(`Not a tile on this dashboard: ${unknown.join(', ')}`)
    if (new Set(ids).size !== ids.length) throw new BadRequest('ids contains the same tile twice')
    if (ids.length !== known.size)
      throw new BadRequest(`ids must name every tile on this dashboard — ${known.size} of them, got ${ids.length}`)

    for (const [position, id] of ids.entries())
      await db().dashboardTile.update({ where: { id }, data: { position } })

    return withTiles(dashboard)
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      // A dashboard is a view over what the reader may already open, so it
      // sits at the developer bar rather than admin: the person who needs a
      // board is the person doing the work, and holding it higher means
      // asking an owner to arrange somebody else's screen.
      create:       [stampDashboard],
      // The tile methods write `DashboardTile` through the caller's
      // client, whose gate is the same developer bar.
    },
  },
})

/**
 * before/create: stamp what the client does not send.
 *
 * A HOOK rather than the first lines of `create`, because `model:` brings
 * autoValidate('create') and Junction runs user hooks first — done inside the
 * method, every request 400s on a `workspaceId` the browser was never meant to
 * supply.
 */
function stampDashboard(): void {
  const data = $.data as Record<string, unknown>
  if (!data) return
  data.createdBy   = actor()
  if (typeof data.name === 'string' && !data.slug) data.slug = slugify(data.name)
}
