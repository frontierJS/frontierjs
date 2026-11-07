// src/jobs/app-copy-refresh.job.ts
// Re-stages one app's read-only copy and records the answer on its `AppCopy`
// row, and is the one place that asks a machine to serve one or to stop
// (`POST /replica/serve`, `/replica/unserve`, Invariant 4). Dispatched as
// `app-copy:refresh` by the row's `cron` and by `appCopies` turning one on.
//
// ─── One step, and the old copy stays on failure ──────────────────────────
//
// Outpost stages into a fresh directory, starts the new copy beside the old
// one and removes the old one only once the new one answers read-only
// (`FJS-D1996`), so a reader never sees half of two days. A refresh that
// fails leaves the old copy serving: the row records `error` and keeps the
// `asOf` and `refreshedAt` of the copy that is still up, because that is the
// staleness a reader is actually getting and what `backup.copy-age` grades.
//
// Outpost runs no timer of its own for this: the replica key rides in the
// body, and a machine holds nothing it was not handed (`FJS-D2001`).
//
// A release whose image reached the bucket (`imageSha256`) rides with a
// pre-signed GET, so any machine can load it. Without one only a machine
// already holding the digest can serve, and anywhere else Outpost's refusal
// lands on the row.
//
// Once the workspace holds its wildcard, the copy answers at `<appId>-copy.<zone>`
// (`FJS-D1982`): the serve carries the name and Outpost routes it to the copy
// container, and `app-copy:dns` points the record at this machine.
//
// While the copy serves the App's main address (`isServingMainAddress`,
// `IDEAS/read-only-copy.md` 3.1), the serve carries the App's routed hostnames
// as well, so a refresh during an outage keeps answering them. `routeCopyHosts`
// sends the same pair to a copy already up, for the switch and for a Domain
// written while it is on (`routeApp`).

import { defineJob }                   from '@frontierjs/caravan'
import { runsAsApp }                   from '../domain/job/job-context.ts'
import { noticeScheduledRunFailed }    from '../domain/backup/run-failure.ts'
import { executorOn, isExecutor }      from '../providers/executor.ts'
import type { Executor }               from '../providers/executor.ts'
import { replicaOf, replicaDatabases } from './replicate-sync.job.ts'
import { releaseEnv }                  from '../domain/release/variables.ts'
import { runtimeFor, copyAddressOf, routedHosts } from '../domain/release/runtime.ts'
import { pushIngressCert }             from './ingress-cert.job.ts'
import appCopyDns                      from './app-copy-dns.job.ts'
import { dropCopyCerts }               from './app-copy-cert.job.ts'
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
    sys.appCopy.update({ where: { id: copy.id }, data: outcome })
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

  // The copy's machine may run nothing of the App's, so no release put the
  // wildcard there; without it Caddy would order a certificate for the name.
  const { host, hosts } = await copyHostsOf(app, target.id, copy.isServingMainAddress)
  if (host) {
    const cert = await pushIngressCert(app, executor, target.workspaceId)
    if (typeof cert === 'object') return failed(`The workspace's wildcard certificate did not reach the machine: ${cert.failed}`)
  }

  const { app_id, ...entry } = replica.entry
  const reply = await executor.call('/replica/serve', {
    app_id, replica: entry, databases, ...(host ? { host } : {}), ...(hosts.length ? { hosts } : {}),
    image: release.toImage, ...(release.builtImage ? { digest: release.builtImage } : {}),
    ...(imageUrl ? { image_url: imageUrl, image_sha256: release.imageSha256 } : {}),
    config: { ...runtimeFor((release.configSnapshot ?? {}) as Record<string, unknown>, target as never), env },
  }, { timeoutMs: COPY_TIMEOUT_MS })
    .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
  if (reply.error) return failed(reply.error.message)
  if (executor.kind === 'stub') return failed('stub executor — no copy was served')

  const asOf = reply.data?.as_of
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) return failed('the outpost answered no as_of for the copy')
  if (host) await app.jobs.dispatch(appCopyDns, { appId: target.id }, { actor: null })
  return finish({ status: 'success', asOf, error: null, refreshedAt: new Date().toISOString() })
}

// ─── The main address ─────────────────────────────────────────────────────

/** What the copy's route answers: its own address, and the App's routed
 *  hostnames while it serves the main address. */
export async function copyHostsOf(app: App, appId: string, servingMain: boolean): Promise<{ host: string | null; hosts: string[] }> {
  return {
    host:  await copyAddressOf(app.db!.asSystem(), appId),
    hosts: servingMain ? await routedHosts(app.db, appId) : [],
  }
}

/**
 * Route the running copy at the hostnames `servingMain` says, without
 * restaging it (`POST /replica/route`). Answers the machine's refusal, or
 * null: a hostname the App's own route holds on that machine is refused there,
 * and so is a copy that is not running.
 */
export async function routeCopyHosts(app: App, appId: string, servingMain: boolean): Promise<{ server: string; error: string } | null> {
  const copy = await (app.db!.asSystem() as any).appCopy.findFirst({ where: { appId }, include: { server: true } })
  if (!copy) return null
  const server   = copy.server?.name ?? copy.serverId
  const executor = await executorOn(app, copy.serverId, copy.server?.name)
  if (!isExecutor(executor)) return { server, error: executor.reason }
  const reply = await executor.call('/replica/route', { app_id: appId, ...await copyHostsOf(app, appId, servingMain) })
    .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
  return reply.error ? { server, error: reply.error.message } : null
}

// ─── Off ──────────────────────────────────────────────────────────────────
//
// Outpost keeps a copy up until it is told otherwise, so a row turned off, a
// row moved to another machine and an app deleted each owe its old machine
// this call. An unreachable machine does not block the change: the answer
// says the copy may still be serving, the way `retireFromMachine` does.

export type CopyMachineAnswer = { ok: true; removed: string[] } | { ok: false; why: string }

/** Ask the machine a copy was on to stop serving it and drop its staging and
 *  its Domains' certificates. The address follows the row either way: removed
 *  with it, or onto the machine it moved to. */
export async function unserveCopy(app: App, appId: string, serverId: string, serverName?: string): Promise<CopyMachineAnswer> {
  await app.jobs.dispatch(appCopyDns, { appId }, { actor: null })
  const executor = await executorOn(app, serverId, serverName)
  if (!isExecutor(executor)) {
    app.logger.warn(`copy of app ${appId} left on ${serverName ?? serverId}: ${executor.reason}`)
    return { ok: false, why: executor.reason }
  }
  const reply = await executor.call('/replica/unserve', { app_id: appId })
    .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
  await dropCopyCerts(app, executor, appId)
  if (!reply.error) return { ok: true, removed: (reply.data?.removed as string[] | undefined) ?? [] }
  app.logger.warn(`copy of app ${appId} still serving on ${serverName ?? serverId}: ${reply.error.message}`)
  return { ok: false, why: reply.error.message }
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
        data:  { status: 'failed', error: executor.reason.slice(0, 2000) },
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
