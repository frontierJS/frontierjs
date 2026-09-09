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
// `jobs/cleanup-run.job.ts` asks the outpost and records what came back. A sweep
// that deletes forty gigabytes is not an HTTP request, and one that dies
// mid-fleet leaves half the machines done with nothing saying which half.
//
// No `workspaceId` on either model — a disk is meaningless without its server,
// so the scope is the join, the same one `volumes` and `servers.feed` make.

import { createService, NotFound, BadRequest, $, seriesKey } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, internalOnly, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, actor }  from '../../core/resource.ts'
import {
  RECLAIM_TARGETS, RECLAIM_TARGET_NAMES, RECLAIM_TARGET_BY_NAME, estimateTarget,
} from './targets.ts'
import type { ReclaimFigures } from './targets.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

import { applyDiskReport } from './disk-report.ts'
import { DISK_READINGS, readingOf } from '../../core/server-metrics.ts'
import type { DiskReport } from './disk-report.ts'
import cleanupRun from '../../jobs/cleanup-run.job.ts'
import { announce } from '../../channels.ts'
import type { ServerEventKind } from '../../../../db/schema.d.ts'

export function createCleanupService(app: BasecampApp) {

  /** The system client, typed once — the accessors have no generated types yet. */
  const sys = (): any => $.db.asSystem()

  /** A machine, as this service needs it. `fullness` is how full the MOUNT is —
   *  the outpost's `statfs('/')` reading off the heartbeat — where every other
   *  figure on this screen comes from `docker system df` and is about Docker.
   *  The two answer different questions and the screen needs both: bytes a
   *  sweep would free mean nothing without the disk they would be freed on. */
  interface FleetMember {
    name:     string
    fullness: number | null
    /** When the machine last spoke. A percentage with no instant beside it is
     *  read as current, and this one is as old as the last check-in. */
    at:       string | null
  }

  /** The caller's fleet, as id → machine. The tenancy boundary for this whole
   *  service: neither model carries a workspace, so a query that skipped this
   *  would answer another workspace's disks to anyone holding an id. */
  async function fleetOf(): Promise<Map<string, FleetMember>> {
    const rows = await db().server.findMany({
      where:  { workspaceId: ws() },
      select: { id: true, name: true, health: true, lastHeartbeatAt: true },
      limit:  500,
    })
    return new Map(rows.map((s: any) => [s.id as string, {
      name:     s.name as string,
      // Absent rather than zero, which is why this goes through the reading
      // rule instead of reading the key: a machine that sent no disk figure and
      // a disk with nothing on it are different facts, and 0% is the one that
      // reads as *there is room here*.
      fullness: readingOf(s.health as Record<string, unknown> | null, 'disk'),
      at:       (s.lastHeartbeatAt as string | null) ?? null,
    }]))
  }

  async function recordEvent(
    serverId: string, kind: ServerEventKind, message: string,
    metadata: Record<string, unknown> = {},
  ) {
    await db().serverEvent.create({ data: { serverId, kind, message, metadata } })
  }


  /**
   * The run this call is about, read through the CALLER's client.
   *
   * The refusal `asSystem()` cannot make: `CleanupRun` reaches its tenant
   * through its Server, so a run in another workspace answers nothing here and
   * the system write below it never happens (`FJS-384`).
   */
  async function runInScope(runId: string) {
    const run = await db().cleanupRun.findUnique({ where: { id: runId } })
    if (!run) throw new NotFound(`Cleanup run '${runId}' not found`)
    return run as Record<string, any>
  }

  /** How far back the sweep graph looks. Seven days, because the question this
   *  answers is *did last Tuesday's sweep help* and a `CleanupRun` is the thing
   *  it is read against. */
  const TREND_DAYS = 7

  /**
   * The disk trend for a fleet, read from the HOURLY FOLD.
   *
   * Not the raw tier, and that is the whole reason this is a separate read from
   * the figures above it: raw points are kept for 48 hours and the question here
   * spans a week, so a raw read would answer *nothing happened before Tuesday*
   * for every machine. The current figure on the screen comes from `DiskUsage`
   * and is live; this is the history behind it, and the newest hour is still
   * being folded, so the line stops up to an hour short of the badge beside it.
   *
   * `max`, not the mean: a disk graph is read for its high-water mark, and the
   * spike a person is looking for is exactly what averaging an hour removes.
   *
   * ─── The access decision ──────────────────────────────────────────────
   *
   * `MetricSeries` and `MetricHour` are `@@gate("8")` and `@@tenant(none)`, so
   * this reads at SYSTEM — and the confinement is `fleetOf()` one line up,
   * which ran at the caller's own standing. The ids reaching this function are
   * machines this caller may already read, which is the same shape
   * `servers.metrics` takes and the same reason: a policy over the label would
   * be fail-open for every app that installs junction and writes none.
   */
  async function diskTrend(ids: string[]): Promise<Map<string, Record<string, number[]>>> {
    const out = new Map<string, Record<string, number[]>>()
    if (!ids.length) return out

    // The series' identity is `seriesKey`'s and is never spelled here: a second
    // spelling is a second series, and each then holds half the readings.
    const wanted = new Map<string, { serverId: string; name: string }>()
    for (const id of ids)
      for (const r of DISK_READINGS) wanted.set(seriesKey(r.name, { serverId: id }), { serverId: id, name: r.name })

    const series = await sys().metricSeries.findMany({
      where: { labelsKey: { in: [...wanted.keys()] } }, limit: wanted.size,
    })
    if (!series.length) return out

    const of = new Map<string, { serverId: string; name: string }>(
      series.map((row: any) => [row.id as string, wanted.get(row.labelsKey as string)!]))

    // DESC and reversed, never ASC: this is bounded, and a bound that truncates
    // has to drop the OLDEST hours. Ascending with a limit drops the newest,
    // which is a graph that silently stops days ago.
    const hours = await sys().metricHour.findMany({
      where:   { seriesId: { in: [...of.keys()] }, hour: { gte: Date.now() - TREND_DAYS * 24 * 3_600_000 } },
      orderBy: { hour: 'desc' },
      limit:   ids.length * DISK_READINGS.length * 24 * TREND_DAYS,
    })

    for (const row of hours.reverse() as any[]) {
      const where = of.get(row.seriesId as string)
      if (!where) continue
      const forServer = out.get(where.serverId) ?? {}
      ;(forServer[where.name] ??= []).push(row.max as number)
      out.set(where.serverId, forServer)
    }
    return out
  }

  // The gated half is the file's own `sys()` above: `CleanupRun` is
  // update-at-SYSTEM, `DiskUsage` is write-at-SYSTEM and a `Volume` delete is
  // ADMINISTRATOR — a developer may sweep a disk and none of the three is
  // theirs to write.

  return createService({
    name:  'cleanup',
    model: 'CleanupRun',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // The whole surface, declared. A cleanup run is written by `run` and
    // updated by the job; `create` and `patch` from the wire would let a
    // caller record a sweep that never happened, which is the one thing this
    // model exists to rule out.
    // `report` is the outpost's: no session, HMAC at the transport, so it
    // states gate 0 rather than taking a custom method's read-gate floor
    // (`FJS-826`).
    methods: ['find', 'get', 'usage', 'targets', 'run', 'startRun', 'finishRun',
              { method: 'report', gate: 0 }],


    // ── startRun / finishRun — the engine's writes ───────────────────
    //
    // `cleanup:run` used to open `asSystem()` and write these itself. It runs
    // as the caller who asked for the sweep now (`FJS-384`), and what that
    // buys is the read in `runInScope` — the confinement — because the writes
    // themselves are above any standing a workspace grants.
    //
    // `internalOnly`: a person recording a sweep that never happened is the one
    // thing this model exists to rule out, and `methods:` already says so about
    // create and patch.

    async startRun() {
      const run = await runInScope(String($.id))

      const startedAt = new Date().toISOString()
      const updated = await sys().cleanupRun.update({
        where: { id: run.id },
        data:  { status: 'running', startedAt },
      })
      announce(app, ws(), 'cleanup patched', updated)

      return {
        runId:       run.id,
        serverId:    run.serverId,
        targets:     run.targets,
        keepImages:  run.keepImages,
        requestedBy: run.requestedBy,
        startedAt,
      }
    },

    async finishRun() {
      const run   = await runInScope(String($.id))
      const patch = ($.data ?? {}) as Record<string, unknown>

      // Named, not spread wholesale: what the outpost REPORTED reaches this
      // method as three keys, and everything else on the payload is the
      // handler's own bookkeeping.
      const { volumesRemoved, usage, ...runPatch } = patch as {
        volumesRemoved?: string[]
        usage?:          DiskReport
      } & Record<string, unknown>

      // Exactly the volumes the outpost says it removed, never the ones it was
      // asked about: an outpost that could delete three of five leaves the
      // fourth on disk, and forgetting the row is how that disk goes invisible.
      if (volumesRemoved?.length)
        await sys().volume.deleteMany({
          where: { serverId: run.serverId, name: { in: volumesRemoved } },
        })

      // The outpost has just run `docker system df` to work out what it freed,
      // so its answer is fresher than the last report. Same function the report
      // endpoint uses, so the two cannot disagree about which key means what.
      if (usage) await applyDiskReport(app, sys(), run.serverId as string, usage)

      const finishedAt = Date.now()
      const startedMs  = run.startedAt ? Date.parse(String(run.startedAt)) : finishedAt

      const updated = await sys().cleanupRun.update({
        where: { id: run.id },
        data:  {
          ...runPatch,
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedMs,
        },
      })
      announce(app, ws(), 'cleanup patched', updated)

      return updated
    },

    // ── find — the history ────────────────────────────────────────────
    async find() {
      const { limit, offset } = getPagination({ limit: 25, max: 100 })
      const serverId = $.query.serverId as string | undefined

      const fleet = await fleetOf()
      if (!fleet.size) return { total: 0, limit, offset, data: [] }
      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      const { rows, total } = await db().cleanupRun.findManyAndCount({
        where:   { serverId: { in: serverId ? [serverId] : [...fleet.keys()] } },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })

      return {
        total, limit, offset,
        data: rows.map((r: Record<string, unknown>) => ({
          ...r, serverName: fleet.get(r.serverId as string)?.name ?? null,
        })),
      }
    },

    async get() {
      const fleet = await fleetOf()
      const row   = await db().cleanupRun.findFirst({ where: { id: $.id as string } })
      if (!row || !fleet.has(row.serverId as string)) throw new NotFound(`Cleanup run '${$.id}' not found`)
      return { ...row, serverName: fleet.get(row.serverId as string)?.name ?? null }
    },

    // ── targets — POST /cleanup  X-Service-Method: targets ────────────
    // The vocabulary, fetched rather than copied into the bundle. Addresses the
    // COLLECTION: there is no subject run, which neither client could express
    // until `FJS-122`. A named key rather than `data`, so `wrapResult` treats it
    // as a single and hands it over whole.
    async targets() {
      $.dispatch = false   // read-shaped
      return { targets: RECLAIM_TARGETS }
    },

    // ── usage — POST /cleanup  X-Service-Method: usage ────────────────
    // What could be reclaimed, per server, with an estimate per target.
    //
    // The estimates are computed HERE and handed over, rather than the figures
    // being handed over for the screen to combine: the sweep and the number
    // beside the button have to come from one place, or they disagree the first
    // time a figure is renamed.
    async usage() {
      $.dispatch = false   // read-shaped
      const fleet = await fleetOf()
      if (!fleet.size) return { servers: [], reported: 0, totalReclaimableBytes: 0 }

      const ids = [...fleet.keys()]

      const [disks, volumes, runs, trendBy] = await Promise.all([
        db().diskUsage.findMany({ where: { serverId: { in: ids } }, limit: 500 }),
        // Unused volumes come from `Volume`, which already owns per-disk sizes.
        // A count on DiskUsage would be a second answer, and the two would part
        // company the first time a report was missed.
        db().volume.findMany({
          where: { serverId: { in: ids }, inUse: false },
          select: { serverId: true, sizeBytes: true },
          limit: 5_000,
        }),
        // Newest first, so the first row seen for a server is its last sweep.
        db().cleanupRun.findMany({
          where: { serverId: { in: ids } }, orderBy: { createdAt: 'desc' }, limit: 500,
        }),
        diskTrend(ids),
      ])

      // `any` for the same reason `db()` is: the Litestone accessors have no
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
        const box  = fleet.get(id)
        return {
          serverId:   id,
          serverName: box?.name ?? id,
          // How full the MOUNT is, which is the denominator every other figure
          // on this screen is missing: 12 GB reclaimable is not worth a sweep on
          // a disk at 40% and is tonight's incident on one at 96%. Null when the
          // machine has never sent one — a bar at zero would say the opposite of
          // what an unheard-from machine means.
          fullness:   box?.fullness ?? null,
          fullnessAt: box?.at ?? null,
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
          // Series name → the hourly high-water marks, oldest first. Absent
          // rather than empty for a machine that has never reported, the same
          // distinction `reported` makes one line up.
          trend: trendBy.get(id) ?? {},
        }
      })

      // The DECLARATION beside the figures, the shape `servers.metrics` answers
      // in: a screen holding its own list of what each series is called is a
      // second place for it to be wrong (`FJS-1027`). `of` does not travel — it
      // is a function, and what it computes is already in the numbers.
      const readings = DISK_READINGS.map(({ name, unit, label }) => ({ name, unit, label }))

      return { servers, readings, reported: disks.length, totalReclaimableBytes }
    },

    // ── report — POST /cleanup  X-Service-Method: report ──────────────
    // The outpost's endpoint, and the only way a DiskUsage row gets here.
    //
    // It addresses the COLLECTION and names the server in the body, the same
    // shape `volumes.report` takes: the outpost knows which machine it is and not
    // which rows Basecamp holds. Exempted from sessionScope by NAME below — a
    // comment claiming exemption is not one, and that mistake 401'd every
    // server check-in once.
    async report() {
      const data     = $.data as DiskReport
      const serverId = data?.server_id
      if (!serverId) throw new BadRequest('server_id is required')

      // asSystem(): an outpost holds no session and there is no user to scope to.
      const server = await sys().server.findUnique({ where: { id: serverId } })
      if (!server) throw new NotFound(`Server '${serverId}' not found`)

      // The event belongs to the MACHINE's workspace, not the caller's — and
      // sessionScope skips this method, so nothing else has stamped one.
      // Without it the after-hook publishes to `workspace:undefined` and an
      // open cleanup screen never hears that the picture changed.
      $.locals.workspaceId = server.workspaceId

      return applyDiskReport(app, sys(), serverId, data)
    },

    // ── run — POST /cleanup  X-Service-Method: run ────────────────────
    // Queue a sweep. `{ serverId }` names one machine, omitting it means every
    // machine an outpost has registered for; `{ targets }` is a subset of the
    // vocabulary and defaults to the ones marked on in `targets.ts`.
    async run() {
      const data     = ($.data ?? {}) as { serverId?: string; targets?: string[]; keepImages?: number }
      const fleet    = await fleetOf()
      const serverId = data.serverId

      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      // Refused by NAME, never quietly dropped. A target nothing recognizes is
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
        else unreachable.push(fleet.get(id)?.name as string)
      }

      if (!reachable.length)
        throw new BadRequest(
          `No outpost is registered for ${unreachable.join(', ') || 'any server in this workspace'} — ` +
          'nothing was swept. An outpost registers itself on its first heartbeat.'
        )

      const runs  = []
      for (const id of reachable) {
        const run = await db().cleanupRun.create({
          data: { serverId: id, targets, keepImages, requestedBy: actor(), status: 'pending' },
        })
        // The actor and the tenant are carried by the dispatch: caravan reads
        // both off the request in scope, and the handler declares
        // `runsAsCaller` — so this work runs as the person who asked for it,
        // in the workspace they asked in (`FJS-384`).
        await app.jobs.dispatch(cleanupRun,
          { runId: run.id, workspaceId: ws() },
          { queue: 'fleet', priority: 5 })
        await recordEvent(id, 'cleanup_queued',
          `Disk cleanup queued (${targets.join(', ')})`, { requested_by: actor() })
        runs.push({ ...run, serverName: fleet.get(id)?.name ?? null })
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
        // The engine's two. The standing that matters was graded when `run`
        // queued the work; the queue runs as that same actor.
        startRun:  [internalOnly()],
        finishRun: [internalOnly()],
      },
    },
  })
}
