// src/jobs/app-backup-run.job.ts
// Takes one archive of an app's data volume on the machine that holds it, and
// is the one place that asks a machine for one (`POST /backup`, Invariant 4).
// Dispatched as `app-backup:run` by an App's schedule; called inline by
// `app-backups.take` (a person) and by a release's `Back up volume` step.
//
// ─── Three doors, one taking ──────────────────────────────────────────────
//
// A person names the app, the machine and a bucket, and the service has read
// all three in their scope before `takeAppBackup` runs. A schedule and a
// release read the app's own `backupDestinationId` at SYSTEM, at fire time, so
// a changed bucket needs no re-registration — `destinationFor` is that read,
// and it refuses a pointer that crossed a workspace rather than minting for it.
//
// ─── The archive is taken on the machine, and leaves it by a URL ──────────
//
// No bytes cross the command port. With no destination the archive stays on
// THAT machine and `location` is a path there. With one, this mints a
// pre-signed PUT for one object key and the machine uploads what it just
// wrote (`FJS-D1485`): no bucket key is ever on the machine, and the signature
// expires. A landed upload makes the key `location`; a refused one keeps the
// path, finishes `success` and says why in `error`, as `backup:run` does — the
// archive is real, it is only on the disk it was meant to leave.
//
// A stub executor answers the protocol and does nothing. That is recorded as
// a failure: a row reading `success` over an archive nobody took is the worst
// answer a backup can give.
//
// ─── runsAsApp ────────────────────────────────────────────────────────────
//
// The schedule's fire is nobody's work but the app's (`FJS-384`); the
// dispatch states `actor: null` to match. `kind` and `requestedBy` are what
// say who asked, on the row.

import { defineJob }                                 from '@frontierjs/caravan'
import { BadRequest, Conflict, NotFound }            from '@frontierjs/junction'
import { runsAsApp }                                 from './context.ts'
import { resolveExecutor, isExecutor }               from '../providers/executor.ts'
import type { Executor }                             from '../providers/executor.ts'
import { createSecretResolver, secretRef }           from '../core/credentials.ts'
import { keyUnder }                                  from '../providers/storage/index.ts'
import { objectPath, presign }                       from '../providers/storage/s3.ts'
import { refuseHubVolume }                           from '../domain/host/host-machine.ts'
import type { App }                                  from '@frontierjs/junction'
import type { App as AppRow, AppBackup, BackupDestination, BackupKind } from '../../../db/schema.d.ts'

/** Outpost's tar is bounded at an hour; this outlasts it by a minute, as the
 *  volume restore does, so a slow archive reads as slow rather than as failed. */
export const BACKUP_TIMEOUT_MS = 61 * 60_000

/** A row still pending or running past the timeout belongs to a process that
 *  died; counting it would refuse every later backup of that app. */
const STALE_AFTER_MS = BACKUP_TIMEOUT_MS + 60_000

/** The pre-signed PUT outlives the tar's hour, then the upload's own. A URL
 *  that expired mid-upload is a 403 the machine reports as a kept archive. */
const UPLOAD_URL_TTL_S = 3 * 3600

type Target = Pick<AppRow, 'id' | 'workspaceId' | 'backupDestinationId'>

/** The pre-signed GET a restore fetches by. The fetch is bounded at an hour
 *  on the machine; the URL outlives it so a slow one does not read as a 403. */
const DOWNLOAD_URL_TTL_S = 2 * 3600

/**
 * A URL for one object under a destination. The credential is read once,
 * here, and leaves only as a signature.
 */
async function presignFor(app: App, dest: BackupDestination, method: 'PUT' | 'GET', key: string, expiresIn: number): Promise<string> {
  if (!dest.secretId) throw new BadRequest(`Destination '${dest.name}' holds no credential`)
  const credential = await createSecretResolver(app.db as any).get(secretRef(dest.secretId))
  if (typeof credential !== 'string' || !credential) throw new BadRequest(`Destination '${dest.name}' has a credential nothing can read`)
  return presign({
    method, url: `${dest.endpoint.replace(/\/$/, '')}${objectPath(dest.bucket, key)}`,
    credential, region: dest.region, expiresIn,
  })
}

/** One object key and the URL that writes it. */
async function mintUpload(app: App, dest: BackupDestination, appId: string, stamp: string): Promise<{ key: string; url: string }> {
  const key = keyUnder(dest, `${appId}-${stamp}.tar.gz`)
  return { key, url: await presignFor(app, dest, 'PUT', key, UPLOAD_URL_TTL_S) }
}

/** The URL that reads one backup's archive back out of its bucket (`FJS-D1521`). */
export function mintDownload(app: App, dest: BackupDestination, key: string): Promise<string> {
  return presignFor(app, dest, 'GET', key, DOWNLOAD_URL_TTL_S)
}

/**
 * The bucket an app's schedule and releases send to, read at SYSTEM. The
 * pointer is `SetNull`, so a deleted bucket reads as none; one that names
 * another workspace's row is refused, since `apps.patch` only admits the
 * app's own and nothing else writes the column.
 */
export async function destinationFor(app: App, target: Target): Promise<BackupDestination | null> {
  if (!target.backupDestinationId) return null
  const dest = await app.db!.asSystem().backupDestination.findFirst({ where: { id: target.backupDestinationId } })
  if (!dest) return null
  if (dest.workspaceId !== target.workspaceId) throw new NotFound(`No backup destination '${target.backupDestinationId}'`)
  return dest
}

/**
 * Take one archive and answer the finished row. Never throws past the row's
 * creation — a throw would leave it `running` until the staleness window
 * passes — but refuses BEFORE writing one when an archive of this app on this
 * machine is still in flight: two back to back are the same bytes twice.
 */
export async function takeAppBackup(app: App, opts: {
  target:       Target
  executor:     Executor
  destination:  BackupDestination | null
  kind:         BackupKind
  requestedBy:  string | null
  deploymentId?: string | null
}): Promise<AppBackup> {
  const { target, executor, destination, kind, requestedBy } = opts
  const serverId = executor.serverId
  const sys      = app.db!.asSystem() as any

  await refuseHubVolume(sys, target.id)

  const inFlight = await sys.appBackup.findFirst({
    where: {
      appId: target.id, serverId, status: { in: ['pending', 'running'] },
      createdAt: { gt: new Date(Date.now() - STALE_AFTER_MS).toISOString() },
    },
  })
  if (inFlight) throw new Conflict(`A backup of this app on that server is already ${inFlight.status}`)

  const startedAt = new Date().toISOString()
  // `:` is legal in a filename and awkward everywhere else; the machine
  // flattens its own stamp the same way.
  const upload = destination ? await mintUpload(app, destination, target.id, startedAt.replace(/[:.]/g, '-')) : null
  const row = await sys.appBackup.create({
    data: {
      appId: target.id, serverId, destinationId: destination?.id ?? null, kind,
      deploymentId: opts.deploymentId ?? null, status: 'running', requestedBy, startedAt,
    },
  })

  const finish = async (outcome: Record<string, unknown>): Promise<AppBackup> => {
    const finishedAt = new Date().toISOString()
    return sys.appBackup.update({
      where: { id: row.id },
      data:  { ...outcome, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) },
    })
  }

  const reply = await executor.call('/backup', { app_id: target.id, ...(upload ? { upload_url: upload.url } : {}) }, { timeoutMs: BACKUP_TIMEOUT_MS })
    .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
  if (reply.error)
    return finish({ status: 'failed', error: reply.error.message.slice(0, 2000) })
  if (executor.kind === 'stub')
    return finish({ status: 'failed', error: 'stub executor — no backup was taken' })

  const { path, bytes, files, sha256, uploaded, upload_error } = reply.data ?? {}
  if (typeof path !== 'string')
    return finish({ status: 'failed', error: 'the outpost answered no archive path' })
  const taken = {
    status: 'success', sizeBytes: bytes as number, fileCount: files as number,
    sha256: typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null,
  }
  if (!upload) return finish({ ...taken, location: path, error: null })
  if (uploaded === true) return finish({ ...taken, location: upload.key, error: null })
  // The machine says why in its own words; a reply with neither is a machine
  // running an Outpost from before uploads, which took the archive and
  // ignored the URL.
  const why = typeof upload_error === 'string' ? upload_error : 'the outpost took the archive and did not upload it'
  return finish({ ...taken, location: path, error: `Upload failed: ${why}. The archive is on the machine at ${path}.`.slice(0, 2000) })
}

// ─── The scheduled fire ───────────────────────────────────────────────────
//
// The app is read at fire time: a schedule cleared or an app deleted since
// the clock was set takes nothing, and `restoreSchedules` skips both at boot.
// The machine is whichever online placement can be reached, the same answer a
// release gets, so a scheduled copy and a pre-deploy copy come off one disk.

export async function fireAppBackup(app: App, appId: string): Promise<void> {
  const log = app.logger.child('app-backup-run')
  const target = await app.db!.asSystem().app.findFirst({ where: { id: appId } })
  if (!target || target.deletedAt || !target.backupCron) return

  const executor = await resolveExecutor(app, appId)
  if (!isExecutor(executor)) { log.warn('scheduled app backup skipped', { app_id: appId, reason: executor.reason }); return }

  try {
    const row = await takeAppBackup(app, {
      target, executor, destination: await destinationFor(app, target), kind: 'scheduled', requestedBy: null,
    })
    if (row.status !== 'success') log.warn('scheduled app backup failed', { app_id: appId, error: row.error })
    else if (row.error) log.warn('scheduled app backup kept on the machine', { app_id: appId, error: row.error })
  } catch (err) {
    log.warn('scheduled app backup skipped', { app_id: appId, reason: (err as Error).message })
  }
}

// ─── The job ──────────────────────────────────────────────────────────────
// One attempt: a tar that failed is recorded on its row, and the next fire is
// an interval away.

const appBackupRun = defineJob<{ appId: string }>({
  name:        'app-backup:run',
  queue:       'fleet',
  maxAttempts: 1,
  timeout:     BACKUP_TIMEOUT_MS + 60_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'app-backup:run')
    await fireAppBackup(app, ctx.data.appId)
  },
})

export default appBackupRun
