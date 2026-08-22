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
 * cleanup job, when a prune answers with a fresh `usage` snapshot — the outpost has
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
