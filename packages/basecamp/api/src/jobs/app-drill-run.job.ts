// src/jobs/app-drill-run.job.ts
// Drills one app's Litestream replica and records the answer as an `AppDrill`
// row, and is the one place that asks a machine for one (`POST
// /replica/drill`, Invariant 4). Dispatched as `app-drill:run` by an App's
// `drillCron`; called inline by `appDrills.run` (a person).
//
// ─── Beside the app, proven by its own image ──────────────────────────────
//
// The machine restores every database the bucket lists into a staging
// directory and runs the app's LIVE release image over it, with no network,
// running `litestone restore --verify-only` (`FJS-D1524`). The schema is the
// one that image ships and the key is the release's own, so a drill proves
// the copy that release could open. The app's volume is never touched, so a
// drill needs no stopped app.
//
// A stub executor answers the protocol and does nothing; that is recorded as
// a failure, as `app-backup:run` records it — a drill reading `success` over
// a copy nobody checked is the answer a drill exists to prevent.

import { defineJob }                       from '@frontierjs/caravan'
import { BadRequest }                      from '@frontierjs/junction'
import { runsAsApp }                       from './context.ts'
import { resolveExecutor, isExecutor }     from '../providers/executor.ts'
import type { Executor }                   from '../providers/executor.ts'
import { replicaOf, replicaDatabases }     from './replicate-sync.job.ts'
import { releaseEnv }                      from '../core/variables.ts'
import type { App }                        from '@frontierjs/junction'
import type { App as AppRow, AppDrill, DrillKind } from '../../../db/schema.d.ts'

/** Outpost bounds the restore at an hour and the verify at half of one; this
 *  outlasts both, so a slow drill reads as slow rather than as failed. */
export const DRILL_TIMEOUT_MS = 92 * 60_000

type Target = Pick<AppRow, 'id' | 'slug' | 'name' | 'workspaceId' | 'replicaDestinationId'>

/**
 * Drill once and answer the finished row. Refuses BEFORE writing one when
 * there is nothing to drill — no replica destination, or no release whose
 * image could prove it — and never throws past the row's creation.
 */
export async function drillApp(app: App, opts: {
  target:      Target
  executor:    Executor
  kind:        DrillKind
  requestedBy: string | null
  at?:         string | null
}): Promise<AppDrill> {
  const { target, executor, kind, requestedBy } = opts
  const sys = app.db!.asSystem() as any

  const replica = await replicaOf(app, { ...target, replicaDestinationId: target.replicaDestinationId ?? null }).catch((err: Error) => { throw new BadRequest(err.message) })
  if (!replica) throw new BadRequest(`App '${target.name}' names no replica destination, so there is nothing to drill`)
  const release = await sys.deployment.findFirst({
    where: { appId: target.id, status: 'success' }, orderBy: { finishedAt: 'desc' },
  })
  if (!release?.toImage) throw new BadRequest(`App '${target.name}' has no successful release, so no image can prove a copy`)

  const at        = opts.at ? new Date(opts.at).toISOString() : null
  const startedAt = new Date().toISOString()
  const row = await sys.appDrill.create({
    data: {
      appId: target.id, serverId: executor.serverId, deploymentId: release.id, kind,
      status: 'running', at, requestedBy, startedAt,
    },
  })
  const finish = async (outcome: Record<string, unknown>): Promise<AppDrill> => {
    const finishedAt = new Date().toISOString()
    return sys.appDrill.update({
      where: { id: row.id },
      data:  { ...outcome, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) },
    })
  }
  const failed = (why: string) => finish({ status: 'failed', error: why.slice(0, 2000) })

  let databases: string[], env: Record<string, string>
  try {
    databases = await replicaDatabases(app, replica.dest, replica.entry.path)
    env       = await releaseEnv(app.db as never, (release.configSnapshot ?? {}) as never)
  } catch (err) { return failed((err as Error).message) }
  if (!databases.length) return failed(`The replica at ${replica.dest.bucket}/${replica.entry.path} holds no database yet`)

  const { app_id, ...entry } = replica.entry
  const reply = await executor.call('/replica/drill', {
    app_id, replica: entry, databases, ...(at ? { at } : {}),
    image: release.toImage, ...(release.builtImage ? { digest: release.builtImage } : {}), env,
  }, { timeoutMs: DRILL_TIMEOUT_MS })
    .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
  if (reply.error) return failed(reply.error.message)
  if (executor.kind === 'stub') return failed('stub executor — no drill was run')

  const { verified, verify, databases: restored } = reply.data ?? {}
  if (typeof verified !== 'boolean') return failed('the outpost answered no verify report')
  return finish({
    status: verified ? 'success' : 'failed', databases: restored ?? null, report: verify ?? null,
    error: verified ? null : 'the restored copy failed its checks — see the report',
  })
}

// ─── The scheduled fire ───────────────────────────────────────────────────
//
// The app is read at fire time, as `fireAppBackup` reads it: a schedule
// cleared or an app deleted since the clock was set drills nothing.

export async function fireAppDrill(app: App, appId: string): Promise<void> {
  const log    = app.logger.child('app-drill-run')
  const target = await app.db!.asSystem().app.findFirst({ where: { id: appId } })
  if (!target || target.deletedAt || !target.drillCron) return

  const executor = await resolveExecutor(app, appId)
  if (!isExecutor(executor)) { log.warn('scheduled drill skipped', { app_id: appId, reason: executor.reason }); return }
  try {
    const row = await drillApp(app, { target, executor, kind: 'scheduled', requestedBy: null })
    if (row.status !== 'success') log.warn('scheduled drill failed', { app_id: appId, error: row.error })
  } catch (err) {
    log.warn('scheduled drill skipped', { app_id: appId, reason: (err as Error).message })
  }
}

// ─── The job ──────────────────────────────────────────────────────────────
// One attempt: a failed drill is recorded on its row, and the next fire is an
// interval away.

const appDrillRun = defineJob<{ appId: string }>({
  name:        'app-drill:run',
  queue:       'fleet',
  maxAttempts: 1,
  timeout:     DRILL_TIMEOUT_MS + 60_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'app-drill:run')
    await fireAppDrill(app, ctx.data.appId)
  },
})

export default appDrillRun
