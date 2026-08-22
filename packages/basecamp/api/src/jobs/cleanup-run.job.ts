import { $ } from '@frontierjs/junction'
// src/jobs/cleanup-run.job.ts
// Sweeps one machine's disk. Dispatched as `cleanup:run`.
//
// The handler takes a run ID and nothing else. The row is the queue's payload:
// re-reading it means a retry acts on the current state rather than on a
// snapshot taken when the click happened, and a run that vanished (its recipe
// deleted, its server destroyed) is a no-op instead of a crash loop.
//
// Caravan owns retry and crash recovery. This is the execution logic for one
// run, and it throws so the queue can apply its own backoff.

import { defineJob } from '@frontierjs/caravan'
import { applyDiskReport } from '../services/cleanup/disk-report.ts'
import { announce }   from '../channels.ts'
import { outbound, outpostFor } from '../providers/outpost.ts'
import { tail, recordServerEvent } from './outpost-run.ts'
import { appFrom }    from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

async function runCleanup(app: BasecampApp, runId: string, workspaceId: string): Promise<void> {
  // asSystem(): a job runs on the queue's thread, not a request's. There is
  // no caller to scope to, and it legitimately writes any workspace's rows.
  const db  = app.data.asSystem() as any
  const log = app.logger.child('cleanup-run')

  const run = await db.cleanupRun.findUnique({ where: { id: runId } })
  if (!run) { log.warn('cleanup run not found', { id: runId }); return }

  const startedAt  = Date.now()
  const startedIso = new Date(startedAt).toISOString()

  await db.cleanupRun.update({ where: { id: runId }, data: { status: 'running', startedAt: startedIso } })
  announce(app, workspaceId, 'cleanup patched', run)

  async function finish(data: Record<string, unknown>) {
    const finishedAt = Date.now()
    const updated = await db.cleanupRun.update({
      where: { id: runId },
      data: {
        ...data,
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
      },
    })
    announce(app, workspaceId, 'cleanup patched', updated)
    return updated
  }

  const target = await outpostFor(app, run.serverId as string)
  if (!target) {
    await finish({ status: 'failed', error: 'No outpost is registered for this server' })
    return
  }

  const res = await outbound(app).send<{
    freed_bytes?: number
    removed?:     Record<string, unknown>
    volumes?:     string[]
    usage?:       Parameters<typeof applyDiskReport>[2]
  }>({
    target,
    method:     'POST',
    path:       '/system/prune',
    body:       { targets: run.targets, keep_images: run.keepImages, cleanup_run_id: runId },
    // A sweep of a build-runner's cache is minutes, not seconds. Conduit's
    // default is 10s, which would report every real cleanup as a timeout.
    timeout_ms: 300_000,
  })

  if (res.error) {
    const status = res.error.kind === 'timeout' ? 'timeout' : 'failed'
    await finish({ status, error: `${res.error.kind}: ${res.error.message}` })
    await recordServerEvent(app, run.serverId as string, 'cleanup_failed',
      `Disk cleanup did not complete (${res.error.kind})`, { run_id: runId })
    throw new Error(res.error.message)
  }

  const freedBytes = Math.max(0, Math.round(Number(res.data?.freed_bytes ?? 0)))

  // Exactly the volumes the outpost says it removed, never the ones it was
  // asked about. Same rule `volumes.prune` follows: an outpost that could
  // delete three of five leaves the fourth on disk, and forgetting the row
  // is how that disk becomes invisible.
  const gone = Array.isArray(res.data?.volumes) ? res.data!.volumes! : []
  if (gone.length)
    await db.volume.deleteMany({ where: { serverId: run.serverId, name: { in: gone } } })

  // The outpost has just run `docker system df` to work out what it freed, so
  // its answer is a fresher picture than the last report. Written through the
  // same function the report endpoint uses, so the two cannot disagree about
  // which key means what.
  if (res.data?.usage) await applyDiskReport(db, run.serverId as string, res.data.usage)

  await finish({
    status:     'success',
    freedBytes,
    detail:     { removed: res.data?.removed ?? {}, volumes: gone },
  })

  await recordServerEvent(app, run.serverId as string, 'cleanup_ran',
    `Disk cleanup freed ${freedBytes} bytes`,
    { run_id: runId, targets: run.targets, requested_by: run.requestedBy })

  log.info('cleanup run finished', { run_id: runId, freed_bytes: freedBytes })
}

// ── The job ───────────────────────────────────────────────────────
// Two attempts, not three. A sweep that timed out may well have freed the disk and
// lost the answer, and the second attempt covers a transport failure only.

export default defineJob<{ runId: string; workspaceId: string }>('cleanup:run', async (ctx) => {
  const app = appFrom(ctx, 'cleanup:run')
  await runCleanup(app, ctx.data.runId, ctx.data.workspaceId)
}, {
  queue:       'fleet',
  maxAttempts: 2,
  retryDelay:  [10_000],
})
