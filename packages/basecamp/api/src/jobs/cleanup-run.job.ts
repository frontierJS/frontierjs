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
import { outbound, outpostFor } from '../providers/outpost.ts'
import type { DiskReport } from '../services/cleanup/disk-report.ts'
import { recordServerEvent } from './outpost-run.ts'
import { runsAsCaller } from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

async function runCleanup(app: BasecampApp, runId: string): Promise<void> {
  const log = app.logger.child('cleanup-run')

  // No client here (`FJS-384`). The sweep runs as whoever asked for it, so the
  // service call below resolves their membership in the workspace the queue
  // recorded — and a run in another one answers nothing rather than being
  // written by id. The row writes stay system, because `CleanupRun` is
  // update-at-SYSTEM and a `Volume` delete is ADMINISTRATOR.
  const cleanup = app.service('cleanup')

  let run: { runId: string; serverId: string; targets: string[]; keepImages: number | null
             requestedBy: string | null; startedAt: string }
  try {
    run = await cleanup.call('startRun', runId) as typeof run
  } catch (err) {
    // A run whose server has gone, or that this actor may no longer reach, is
    // a no-op rather than a crash loop.
    log.warn('cleanup run not startable', { id: runId, error: (err as Error).message })
    return
  }

  async function finish(data: Record<string, unknown>) {
    return await cleanup.call('finishRun', runId, data) as Record<string, unknown>
  }

  const target = await outpostFor(app, run.serverId)
  if (!target) {
    await finish({ status: 'failed', error: 'No outpost is registered for this server' })
    return
  }

  const res = await outbound(app).send<{
    freed_bytes?: number
    removed?:     Record<string, unknown>
    volumes?:     string[]
    usage?:       DiskReport
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
    await recordServerEvent(app, run.serverId, 'cleanup_failed',
      `Disk cleanup did not complete (${res.error.kind})`, { run_id: runId })
    throw new Error(res.error.message)
  }

  const freedBytes = Math.max(0, Math.round(Number(res.data?.freed_bytes ?? 0)))

  // What the outpost REPORTED travels to the service, which owns every write
  // it implies — the volume rows for the disks it actually removed (never the
  // ones it was asked about) and the fresh `docker system df` picture it took
  // on the way. Three system writes that used to be three lines here.
  const gone = Array.isArray(res.data?.volumes) ? res.data!.volumes! : []

  await finish({
    status:     'success',
    freedBytes,
    detail:     { removed: res.data?.removed ?? {}, volumes: gone },
    volumesRemoved: gone,
    usage:          res.data?.usage,
  })

  await recordServerEvent(app, run.serverId, 'cleanup_ran',
    `Disk cleanup freed ${freedBytes} bytes`,
    { run_id: runId, targets: run.targets, requested_by: run.requestedBy })

  log.info('cleanup run finished', { run_id: runId, freed_bytes: freedBytes })
}

// ── The job ───────────────────────────────────────────────────────
// Two attempts, not three. A sweep that timed out may well have freed the disk and
// lost the answer, and the second attempt covers a transport failure only.

export default defineJob<{ runId: string; workspaceId: string }>('cleanup:run', async (ctx) => {
  // Somebody asked for this sweep. The queue recorded them and the workspace.
  const { app } = runsAsCaller(ctx, 'cleanup:run')
  await runCleanup(app, ctx.data.runId)
}, {
  queue:       'fleet',
  maxAttempts: 2,
  retryDelay:  [10_000],
})
