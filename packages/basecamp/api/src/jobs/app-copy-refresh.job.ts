// src/jobs/app-copy-refresh.job.ts
// Re-stages one app's read-only copy and records the answer on its `AppCopy`
// row, and is the one place that asks a machine to serve one (`POST
// /replica/serve`, Invariant 4). Dispatched as `app-copy:refresh` by the
// row's `cron`.
//
// ─── One step, and the old copy stays on failure ──────────────────────────
//
// Outpost stages into a fresh directory, starts the new copy beside the old
// one and removes the old one only once the new one answers read-only
// (`FJS-D1996`), so a reader never sees half of two days. A refresh that
// fails leaves the old copy serving: the row records `error` and keeps the
// `asOf` of the copy that is still up, because that is the staleness a
// reader is actually getting.
//
// Outpost runs no timer of its own for this: the replica key rides in the
// body, and a machine holds nothing it was not handed (`FJS-D2001`).
//
// A release whose image reached the bucket (`imageSha256`) rides with a
// pre-signed GET, so any machine can load it. Without one only a machine
// already holding the digest can serve, and anywhere else Outpost's refusal
// lands on the row.

import { defineJob }                   from '@frontierjs/caravan'
import { runsAsApp }                   from '../domain/job/job-context.ts'
import { noticeScheduledRunFailed }    from '../domain/backup/run-failure.ts'
import { executorOn, isExecutor }      from '../providers/executor.ts'
import type { Executor }               from '../providers/executor.ts'
import { replicaOf, replicaDatabases } from './replicate-sync.job.ts'
import { releaseEnv }                  from '../domain/release/variables.ts'
import { runtimeFor }                  from '../domain/release/runtime.ts'
import { DRILL_TIMEOUT_MS }            from './app-drill-run.job.ts'
import { mintDownload }                from './app-backup-run.job.ts'
import { imageKey }                    from '../domain/release/image-export.ts'
import type { App }                    from '@frontierjs/junction'
import type { App as AppRow, AppCopy } from '#db/schema.d.ts'

/** A serve is a drill's restore plus a boot; it gets the drill's bound. */
export const COPY_TIMEOUT_MS = DRILL_TIMEOUT_MS

/**
 * Re-stage the copy once and answer the updated row. Never throws past the
 * row: every refusal is a `failed` refresh with its reason.
 */
export async function refreshCopy(app: App, opts: {
  copy:     AppCopy
  target:   AppRow
  executor: Executor
}): Promise<AppCopy> {
  const { copy, target, executor } = opts
  const sys = app.db!.asSystem() as any

  await sys.appCopy.update({ where: { id: copy.id }, data: { status: 'running' } })
  const finish = (outcome: Record<string, unknown>): Promise<AppCopy> =>
    sys.appCopy.update({ where: { id: copy.id }, data: { ...outcome, refreshedAt: new Date().toISOString() } })
  const failed = (why: string) => finish({ status: 'failed', error: why.slice(0, 2000) })

  let replica: Awaited<ReturnType<typeof replicaOf>>
  try { replica = await replicaOf(app, { ...target, replicaDestinationId: target.replicaDestinationId ?? null }) } catch (err) { return failed((err as Error).message) }
  if (!replica) return failed(`App '${target.name}' names no replica destination, so there is nothing to copy`)
  const release = await sys.deployment.findFirst({
    where: { appId: target.id, status: 'success' }, orderBy: { finishedAt: 'desc' },
  })
  if (!release?.toImage) return failed(`App '${target.name}' has no successful release, so no image can serve a copy`)

  let databases: string[], env: Record<string, string>, imageUrl: string | null = null
  try {
    databases = await replicaDatabases(app, replica.dest, replica.entry.path)
    env       = await releaseEnv(app.db as never, (release.configSnapshot ?? {}) as never)
    if (release.imageSha256) imageUrl = await mintDownload(app, replica.dest, imageKey(replica.entry.path, release.id))
  } catch (err) { return failed((err as Error).message) }
  if (!databases.length) return failed(`The replica at ${replica.dest.bucket}/${replica.entry.path} holds no database yet`)

  const { app_id, ...entry } = replica.entry
  const reply = await executor.call('/replica/serve', {
    app_id, replica: entry, databases,
    image: release.toImage, ...(release.builtImage ? { digest: release.builtImage } : {}),
    ...(imageUrl ? { image_url: imageUrl, image_sha256: release.imageSha256 } : {}),
    config: { ...runtimeFor((release.configSnapshot ?? {}) as Record<string, unknown>, target as never), env },
  }, { timeoutMs: COPY_TIMEOUT_MS })
    .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
  if (reply.error) return failed(reply.error.message)
  if (executor.kind === 'stub') return failed('stub executor — no copy was served')

  const asOf = reply.data?.as_of
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) return failed('the outpost answered no as_of for the copy')
  return finish({ status: 'success', asOf, error: null })
}

// ─── The scheduled fire ───────────────────────────────────────────────────
//
// Both rows are read at fire time: a copy turned off or an app deleted since
// the clock was set serves nothing.

export async function fireAppCopy(app: App, appId: string): Promise<void> {
  const log  = app.logger.child('app-copy-refresh')
  const sys  = app.db!.asSystem() as any
  const copy = await sys.appCopy.findFirst({ where: { appId }, include: { server: true } })
  const target = copy && await sys.app.findFirst({ where: { id: appId } })
  if (!copy || !target || target.deletedAt) return

  const executor = await executorOn(app, copy.serverId, copy.server?.name)
  const row = isExecutor(executor)
    ? await refreshCopy(app, { copy, target, executor })
    : await sys.appCopy.update({
        where: { id: copy.id },
        data:  { status: 'failed', error: executor.reason.slice(0, 2000), refreshedAt: new Date().toISOString() },
      })
  if (row.status !== 'success') {
    log.warn('scheduled copy refresh failed', { appId, error: row.error })
    await noticeScheduledRunFailed(app, target, 'copy', row.error)
  }
}

// ─── The job ──────────────────────────────────────────────────────────────
// One attempt: the old copy keeps serving, and the next fire is a cron away.

const appCopyRefresh = defineJob<{ appId: string }>({
  name:        'app-copy:refresh',
  queue:       'fleet',
  maxAttempts: 1,
  timeout:     COPY_TIMEOUT_MS + 60_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'app-copy:refresh')
    await fireAppCopy(app, ctx.data.appId)
  },
})

export default appCopyRefresh
