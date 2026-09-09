// src/services/cleanup/disk-report.ts
// What an outpost says about one machine's disk, and the one place it is
// written down.
//
// Two callers have it: this service's `report` method, and the cleanup job,
// when a prune answers with a fresh `usage` snapshot — the outpost has just run
// `docker system df` to work out what it freed, so asking it again a second
// later would be a second answer to the same question. One owner, so the two
// cannot disagree about which key means what.
//
// It sits beside the service rather than inside it because the job imports it
// and the service imports the job's definition to dispatch: one module both can
// reach is what keeps that from being a cycle.
//
// It is also where the disk picture is KEPT over time. The row is a snapshot —
// `@@unique([serverId])`, overwritten every report — so the trend has to be
// written at the same moment from the same numbers, or the two answer
// differently about the same instant. `core/server-metrics.ts` owns what the
// series are called; this file owns when they are written.

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

import { recordDiskUsage } from '../../core/server-metrics.ts'
import type { BasecampApp } from '../../basecamp.types.ts'

const int = (n: unknown): number => Math.max(0, Math.round(Number(n) || 0))

/**
 * Write what an outpost reported about one machine's disk.
 *
 * Exported because two callers have it: this service's `report` method, and the
 * cleanup job, when a prune answers with a fresh `usage` snapshot — the outpost has
 * just run `docker system df` to work out what it freed, so asking it again a
 * second later would be a second answer to the same question. One owner, so the
 * two cannot disagree about which key means what.
 */
export async function applyDiskReport(app: BasecampApp, sys: any, serverId: string, data: DiskReport) {
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
  const written  = existing
    ? await sys.diskUsage.update({ where: { id: existing.id }, data: row })
    : await sys.diskUsage.create({ data: { serverId, ...row } })

  // AFTER the row, and from the same `row` rather than from `written`: the
  // series is a second reading of what this report said, and re-reading the
  // database for it would let a column default or a coercion put a different
  // number on the graph from the one on the screen.
  await recordDiskUsage(app, serverId, row, row.reportedAt)
  return written
}
