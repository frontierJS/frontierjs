// src/jobs/platform-observe.job.ts — what a platform App serves, as the vendor says.
//
// A Worker is shipped by whoever holds a token — wrangler on a laptop, the
// vendor's own git build, the dashboard — and Cloudflare signs nothing to a URL
// when it happens, so this polls (`IDEAS/app-platforms.md` 1.4). Each
// AppPlatform's newest deployment is what serves; when it names a version the
// row does not, that is a release.
//
// A release Basecamp did not start is written as an `observed` Deployment and
// run through `release-record.ts`, the one owner of a release's moves, so it
// reaches the App's status and the channel as any other release does. One
// Basecamp started (Phase 2) already names the version on its newest row, and
// is taken as it is rather than recorded twice.
//
// A vendor that could not be asked changes nothing: not knowing is not a
// release, and not a stop.

import { defineJob }      from '@frontierjs/caravan'
import { runsAsApp }      from './context.ts'
import { platformConnectorFor } from '../providers/platform/index.ts'
import { targetFor }      from '../providers/compute/index.ts'
import { sendVia }        from '../providers/compute/accounts.ts'
import { startRelease, finishRelease } from '../domain/release/release-record.ts'
import type { PlatformDeployment } from '../providers/platform/index.ts'
import type { App }       from '@frontierjs/junction'

export interface PlatformObserveOptions {
  /** One AppPlatform rather than every one. */
  appPlatformId?: string
}

export interface PlatformObserveResult {
  observed: number
  recorded: number
  failed:   number
}

/** The version taking most traffic — the one serving, mid-rollout too. */
const servingVersion = (d: PlatformDeployment) =>
  [...d.versions].sort((a, b) => b.percent - a.percent)[0]?.id ?? null

/**
 * Read every AppPlatform's live deployment, and record the ones that moved.
 *
 * Exported so a test can run it; the job below is one caller.
 */
export async function observePlatforms(app: App, opts: PlatformObserveOptions = {}): Promise<PlatformObserveResult> {
  const db     = (app.db as any).asSystem()
  const log    = app.logger.child('platform-observe')
  const result = { observed: 0, recorded: 0, failed: 0 }
  const rows   = await db.appPlatform.findMany({
    where: opts.appPlatformId ? { id: opts.appPlatformId } : {},
    limit: 5_000,
  })

  for (const row of rows) {
    const connector = platformConnectorFor(row.provider)
    if (!connector) continue
    let live: PlatformDeployment | undefined
    try {
      live = (await connector.deployments(sendVia(app, targetFor(connector.kind, row.accountId)), row.providerAccountId, row.name))[0]
    } catch (err) {
      result.failed++
      log.warn('vendor not asked', { appPlatformId: row.id, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    result.observed++
    const version    = live ? servingVersion(live) : null
    const observedAt = new Date().toISOString()
    if (!live || !version || version === row.liveVersion) {
      await db.appPlatform.update({ where: { id: row.id }, data: { observedAt } })
      continue
    }

    // Compare-and-set on the version it read, so two sweeps that both saw the
    // move write one release between them.
    const { count } = await db.appPlatform.updateMany({
      where: { id: row.id, liveVersion: row.liveVersion },
      data:  { liveVersion: version, status: 'running', observedAt },
    })
    if (!count) continue

    const newest = await db.deployment.findFirst({
      where: { appId: row.appId }, orderBy: { queuedAt: 'desc' }, select: { platformVersion: true },
    })
    if (newest?.platformVersion === version) continue

    const deploy = await db.deployment.create({ data: {
      appId: row.appId, workspaceId: row.workspaceId, trigger: 'observed',
      platformVersion: version, author: live.author, commitMessage: live.message,
      queuedAt: live.createdAt || observedAt,
      configSnapshot: { observed: { deploymentId: live.id, source: live.source, versions: live.versions } },
    } })
    const run = await startRelease(app, deploy)
    if (run.runnable) await finishRelease(app, deploy, { status: 'success', startedAt: run.startedAt })
    result.recorded++
  }
  return result
}

export default defineJob({
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'platform-observe')
    await observePlatforms(app)
  },
  // An observed release is history, not an alarm; five minutes keeps a
  // hundred Workers well inside Cloudflare's API allowance.
  cron: '*/5 * * * *',
})
