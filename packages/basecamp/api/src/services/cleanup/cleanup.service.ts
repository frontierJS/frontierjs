// src/services/cleanup/cleanup.service.ts
// Reclaiming disk across the fleet — the DECLARED way to act on a machine.
//
// Mounted at /cleanup. Custom methods dispatch on X-Service-Method:
//   usage   — per-server reclaim candidates, read-shaped, addresses the COLLECTION
//   targets — the vocabulary, fetched rather than shipped in the bundle
//   report  — the outpost's, no session, replaces that server's picture
//   run     — queue a sweep on one server or on every reachable one
//
// The pair this completes is `/recipes/`: a recipe is arbitrary code and needs
// a role to author, a cleanup names targets from `targets.ts` and can be run by
// anyone holding the pager. Same machines, same outpost, opposite safeguards —
// which is the whole reason both exist rather than one screen that runs
// `docker system prune` as a saved script.
//
// **What is here is a picture, not a record**, exactly like `Volume`: a
// `DiskUsage` row exists because an outpost reported it, and the numbers are
// `docker system df`'s own. Nothing estimates: the mock multiplied a count by
// an average and printed gigabytes, and an invented figure beside a measured
// one is worse than no figure, because nothing on screen says which is which.
//
// **A run is not carried out here.** `run` writes rows and queues them;
// `engine/fleet.engine.ts` asks the outpost and records what came back. A sweep
// that deletes forty gigabytes is not an HTTP request, and one that dies
// mid-fleet leaves half the machines done with nothing saying which half.
//
// No `workspaceId` on either model — a disk is meaningless without its server,
// so the scope is the join, the same one `volumes` and `servers.feed` make.

import { createService, NotFound, BadRequest, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { dbOf, wsOf, actorOf }  from '../../core/resource.ts'
import {
  RECLAIM_TARGETS, RECLAIM_TARGET_NAMES, RECLAIM_TARGET_BY_NAME, estimateTarget,
} from './targets.ts'
import type { ReclaimFigures } from './targets.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

// ─── The outpost's wire contract ───────────────────────────────────────────
// snake_case, like the heartbeat and the volume report and unlike every other
// call into this app: the schema's camelCase applies to MODEL fields, and these
// are `docker system df`'s words relayed. A mis-spelled key here does not
// error — it reports a machine with nothing to reclaim.

export interface DiskReport {
  server_id?: string
  images?:     { total?: number; unused?: number; dangling?: number; size_bytes?: number; reclaimable_bytes?: number }
  containers?: { running?: number; stopped?: number; reclaimable_bytes?: number }
  build_cache?: { size_bytes?: number; reclaimable_bytes?: number }
}

const int = (n: unknown): number => Math.max(0, Math.round(Number(n) || 0))

/**
 * Write what an outpost reported about one machine's disk.
 *
 * Exported because two callers have it: this service's `report` method, and the
 * engine, when a prune answers with a fresh `usage` snapshot — the outpost has
 * just run `docker system df` to work out what it freed, so asking it again a
 * second later would be a second answer to the same question. One owner, so the
 * two cannot disagree about which key means what.
 */
export async function applyDiskReport(sys: any, serverId: string, data: DiskReport) {
  const row = {
    imagesTotal:                int(data.images?.total),
    imagesUnused:               int(data.images?.unused),
    imagesDangling:             int(data.images?.dangling),
    imageBytes:                 int(data.images?.size_bytes),
    imagesReclaimableBytes:     int(data.images?.reclaimable_bytes),
    containersRunning:          int(data.containers?.running),
    containersStopped:          int(data.containers?.stopped),
    containersReclaimableBytes: int(data.containers?.reclaimable_bytes),
    buildCacheBytes:            int(data.build_cache?.size_bytes),
    buildCacheReclaimableBytes: int(data.build_cache?.reclaimable_bytes),
    reportedAt:                 new Date().toISOString(),
  }

  // @@unique([serverId]) makes this an upsert rather than an append — without
  // it a machine checking in every minute would grow a row a minute and the
  // screen would show the first one it found.
  const existing = await sys.diskUsage.findFirst({ where: { serverId } })
  return existing
    ? sys.diskUsage.update({ where: { id: existing.id }, data: row })
    : sys.diskUsage.create({ data: { serverId, ...row } })
}

export function createCleanupService(app: BasecampApp) {

  /** The system client, typed once — the accessors have no generated types yet. */
  const sys = (): any => (app.data as any).asSystem()

  /** The caller's fleet, as id → name. The tenancy boundary for this whole
   *  service: neither model carries a workspace, so a query that skipped this
   *  would answer another workspace's disks to anyone holding an id. */
  async function fleetOf(ctx: ServiceContext): Promise<Map<string, string>> {
    const rows = await dbOf(ctx).server.findMany({
      where:  { workspaceId: wsOf(ctx) },
      select: { id: true, name: true },
      limit:  500,
    })
    return new Map(rows.map((s: { id: string; name: string }) => [s.id, s.name]))
  }

  async function recordEvent(
    ctx: ServiceContext, serverId: string, kind: string, message: string,
    metadata: Record<string, unknown> = {},
  ) {
    await dbOf(ctx).serverEvent.create({ data: { serverId, kind, message, metadata } })
  }

  return createService({
    name:  'cleanup',
    model: 'CleanupRun',

    // The whole surface, declared. A cleanup run is written by `run` and
    // updated by the engine; `create` and `patch` from the wire would let a
    // caller record a sweep that never happened, which is the one thing this
    // model exists to rule out.
    methods: ['find', 'get', 'usage', 'targets', 'report', 'run'],

    // ── find — the history ────────────────────────────────────────────
    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx, { limit: 25, max: 100 })
      const serverId = ctx.query.serverId as string | undefined

      const fleet = await fleetOf(ctx)
      if (!fleet.size) return { total: 0, limit, offset, data: [] }
      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      const { rows, total } = await dbOf(ctx).cleanupRun.findManyAndCount({
        where:   { serverId: { in: serverId ? [serverId] : [...fleet.keys()] } },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })

      return {
        total, limit, offset,
        data: rows.map((r: Record<string, unknown>) => ({
          ...r, serverName: fleet.get(r.serverId as string) ?? null,
        })),
      }
    },

    async get(ctx: ServiceContext) {
      const fleet = await fleetOf(ctx)
      const row   = await dbOf(ctx).cleanupRun.findFirst({ where: { id: ctx.id as string } })
      if (!row || !fleet.has(row.serverId as string)) throw new NotFound(`Cleanup run '${ctx.id}' not found`)
      return { ...row, serverName: fleet.get(row.serverId as string) ?? null }
    },

    // ── targets — POST /cleanup  X-Service-Method: targets ────────────
    // The vocabulary, fetched rather than copied into the bundle. Addresses the
    // COLLECTION: there is no subject run, which neither client could express
    // until `FJS-122`. A named key rather than `data`, so `wrapResult` treats it
    // as a single and hands it over whole.
    async targets(ctx: ServiceContext) {
      ctx.dispatch = false   // read-shaped
      return { targets: RECLAIM_TARGETS }
    },

    // ── usage — POST /cleanup  X-Service-Method: usage ────────────────
    // What could be reclaimed, per server, with an estimate per target.
    //
    // The estimates are computed HERE and handed over, rather than the figures
    // being handed over for the screen to combine: the sweep and the number
    // beside the button have to come from one place, or they disagree the first
    // time a figure is renamed.
    async usage(ctx: ServiceContext) {
      ctx.dispatch = false   // read-shaped
      const fleet = await fleetOf(ctx)
      if (!fleet.size) return { servers: [], reported: 0, totalReclaimableBytes: 0 }

      const ids = [...fleet.keys()]

      const [disks, volumes, runs] = await Promise.all([
        dbOf(ctx).diskUsage.findMany({ where: { serverId: { in: ids } }, limit: 500 }),
        // Unused volumes come from `Volume`, which already owns per-disk sizes.
        // A count on DiskUsage would be a second answer, and the two would part
        // company the first time a report was missed.
        dbOf(ctx).volume.findMany({
          where: { serverId: { in: ids }, inUse: false },
          select: { serverId: true, sizeBytes: true },
          limit: 5_000,
        }),
        // Newest first, so the first row seen for a server is its last sweep.
        dbOf(ctx).cleanupRun.findMany({
          where: { serverId: { in: ids } }, orderBy: { createdAt: 'desc' }, limit: 500,
        }),
      ])

      // `any` for the same reason `dbOf` is: the Litestone accessors have no
      // generated types yet (`litestone types` is pending), so every column
      // read off a row is otherwise its own diagnostic.
      const diskBy = new Map<string, any>(disks.map((d: any) => [d.serverId as string, d]))
      const volBy  = new Map<string, { count: number; bytes: number }>()
      for (const v of volumes as { serverId: string; sizeBytes: number }[]) {
        const acc = volBy.get(v.serverId) ?? { count: 0, bytes: 0 }
        volBy.set(v.serverId, { count: acc.count + 1, bytes: acc.bytes + (v.sizeBytes ?? 0) })
      }
      const lastBy = new Map<string, any>()
      for (const r of runs as any[]) if (!lastBy.has(r.serverId)) lastBy.set(r.serverId, r)

      let totalReclaimableBytes = 0
      const servers = ids.map(id => {
        const disk = diskBy.get(id)
        const vol  = volBy.get(id) ?? { count: 0, bytes: 0 }
        const figures: ReclaimFigures = {
          images:      disk?.imagesReclaimableBytes     ?? 0,
          containers:  disk?.containersReclaimableBytes ?? 0,
          build_cache: disk?.buildCacheReclaimableBytes ?? 0,
          volumes:     vol.bytes,
        }

        // The fleet total counts each figure once. `dangling_images` is a
        // subset of the images figure with no separate number behind it, so
        // adding both targets would count the same bytes twice.
        totalReclaimableBytes += figures.images + figures.containers + figures.build_cache + figures.volumes

        const reclaimable = Object.fromEntries(
          RECLAIM_TARGET_NAMES.map(t => [t, estimateTarget(t, figures)]))

        const last = lastBy.get(id)
        return {
          serverId:   id,
          serverName: fleet.get(id) ?? id,
          // Absent, not zeroed. A machine whose outpost has never reported is not
          // a machine with nothing to reclaim, and the screen says so.
          reported:   !!disk,
          reportedAt: disk?.reportedAt ?? null,
          images:     disk ? {
            total: disk.imagesTotal, unused: disk.imagesUnused,
            dangling: disk.imagesDangling, sizeBytes: disk.imageBytes,
          } : null,
          containers: disk ? { running: disk.containersRunning, stopped: disk.containersStopped } : null,
          buildCacheBytes: disk?.buildCacheBytes ?? 0,
          unusedVolumes:   vol,
          reclaimable,
          lastCleanup: last
            ? { id: last.id, status: last.status, freedBytes: last.freedBytes, finishedAt: last.finishedAt }
            : null,
        }
      })

      return { servers, reported: disks.length, totalReclaimableBytes }
    },

    // ── report — POST /cleanup  X-Service-Method: report ──────────────
    // The outpost's endpoint, and the only way a DiskUsage row gets here.
    //
    // It addresses the COLLECTION and names the server in the body, the same
    // shape `volumes.report` takes: the outpost knows which machine it is and not
    // which rows Basecamp holds. Exempted from sessionScope by NAME below — a
    // comment claiming exemption is not one, and that mistake 401'd every
    // server check-in once.
    async report(ctx: ServiceContext) {
      const data     = ctx.data as DiskReport
      const serverId = data?.server_id
      if (!serverId) throw new BadRequest('server_id is required')

      // asSystem(): an outpost holds no session and there is no user to scope to.
      const server = await sys().server.findUnique({ where: { id: serverId } })
      if (!server) throw new NotFound(`Server '${serverId}' not found`)

      // The event belongs to the MACHINE's workspace, not the caller's — and
      // sessionScope skips this method, so nothing else has stamped one.
      // Without it the after-hook publishes to `workspace:undefined` and an
      // open cleanup screen never hears that the picture changed.
      ctx.locals.workspaceId = server.workspaceId

      return applyDiskReport(sys(), serverId, data)
    },

    // ── run — POST /cleanup  X-Service-Method: run ────────────────────
    // Queue a sweep. `{ serverId }` names one machine, omitting it means every
    // machine an outpost has registered for; `{ targets }` is a subset of the
    // vocabulary and defaults to the ones marked on in `targets.ts`.
    async run(ctx: ServiceContext) {
      const data     = (ctx.data ?? {}) as { serverId?: string; targets?: string[]; keepImages?: number }
      const fleet    = await fleetOf(ctx)
      const serverId = data.serverId

      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      // Refused by NAME, never quietly dropped. A target nothing recognises is
      // a target nothing deletes, and a sweep that silently did four of the
      // five things asked of it reads as a sweep that did all five.
      const targets = data.targets?.length
        ? data.targets
        : RECLAIM_TARGETS.filter(t => t.defaultOn).map(t => t.target)

      const unknown = targets.filter(t => !RECLAIM_TARGET_BY_NAME[t])
      if (unknown.length)
        throw new BadRequest(
          `Unknown reclaim target(s): ${unknown.join(', ')}. ` +
          `This service knows ${RECLAIM_TARGET_NAMES.join(', ')}`)

      const keepImages = Math.max(0, Math.min(50, Math.round(Number(data.keepImages ?? 3))))

      if (!app.conduit)
        throw new BadRequest('Outbound delivery is not configured on this server — no conduit plugin')

      const candidates = serverId ? [serverId] : [...fleet.keys()]
      const reachable: string[] = []
      const unreachable: string[] = []
      for (const id of candidates) {
        if (await app.conduit.resolve(`outpost:${id}`)) reachable.push(id)
        else unreachable.push(fleet.get(id) as string)
      }

      if (!reachable.length)
        throw new BadRequest(
          `No outpost is registered for ${unreachable.join(', ') || 'any server in this workspace'} — ` +
          'nothing was swept. An outpost registers itself on its first heartbeat.'
        )

      const actor = actorOf(ctx)
      const runs  = []
      for (const id of reachable) {
        const run = await dbOf(ctx).cleanupRun.create({
          data: { serverId: id, targets, keepImages, requestedBy: actor, status: 'pending' },
        })
        await app.jobs.dispatch('cleanup:run',
          { runId: run.id, workspaceId: wsOf(ctx) },
          { queue: 'fleet', priority: 5 })
        await recordEvent(ctx, id, 'cleanup_queued',
          `Disk cleanup queued (${targets.join(', ')})`, { requested_by: actor })
        runs.push({ ...run, serverName: fleet.get(id) ?? null })
      }

      return { runs, queued: runs.length, unreachable, targets, keepImages }
    },

    hooks: {
      before: {
        // `report` is the outpost's endpoint — no session, no workspace header.
        all:    [sessionScope(app, { except: ['report'] })],
        // A sweep deletes data on a machine, but it deletes only what the
        // vocabulary allows, which is why it sits at the developer bar rather
        // than at the admin one `recipes.create` needs. Unused volumes are the
        // sharp edge and they are off by default.
        run:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
