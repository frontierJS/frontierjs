// src/domain/backup/archive-drill.ts
// A dry-run restore of the newest hub archive in the bucket (`FJS-3881`).
//
// A backup that was never read back is a hope. This fetches the newest remote
// archive the hub holds a sha256 for, checks the bytes against that digest,
// unpacks it beside the live database and asks the questions a real restore
// asks -- `archiveRefusals` (this key, this install, this code's migration
// history, every listed file's hash) and `PRAGMA integrity_check` over each
// database -- then deletes the copy. The live files are never opened for
// write. The answer is an `AppDrill` row on the hub App, the same record an
// app's replica drill leaves, so the history reads in one place.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mintDownload }       from '../../jobs/app-backup-run.job.ts'
import { checkStaged }        from '../../jobs/backup-run.job.ts'
import { hostServer, requireHubAppId } from '../host/host-machine.ts'
import { archiveRefusals, sha256Of } from './archive-manifest.ts'
import { ARCHIVE_NAME, hubInstallId } from './backup-archives.ts'
import type { App }           from '@frontierjs/junction'
import type { AppDrill, DrillKind } from '#db/schema.d.ts'

const MIGRATIONS_ROOT = new URL('../../../../db/migrations', import.meta.url).pathname

/** Why the archive at `tarball` would not restore, one sentence each, or none. */
async function whyNot(tarball: string, work: string, expectSha: string, installId: string): Promise<string[]> {
  if (await sha256Of(tarball) !== expectSha)
    return ['The downloaded archive does not match the sha256 recorded when it was uploaded.']
  const proc = Bun.spawn(['tar', '-xzf', tarball, '-C', work, '--no-same-owner'], { stderr: 'pipe' })
  if (await proc.exited !== 0)
    return [`The archive is not a gzipped tar: ${(await new Response(proc.stderr).text()).trim().split('\n')[0]}`]
  const top = readdirSync(work).filter(n => n !== 'archive.tar.gz')
  if (top.length !== 1 || !ARCHIVE_NAME.test(top[0]))
    return [`A hub archive holds one basecamp-… directory; this one holds ${top.join(', ') || 'nothing'}.`]
  const dir = join(work, top[0])
  const reasons = await archiveRefusals(dir, { migrationsRoot: MIGRATIONS_ROOT, installId })
  if (reasons.length) return reasons
  const damaged = checkStaged(dir)
  return damaged ? [`A database in the archive failed PRAGMA integrity_check: ${damaged}`] : []
}

/**
 * Drill the newest remote hub archive once. Answers the finished `AppDrill`,
 * or why nothing was drilled (no row is written then: there was nothing to
 * grade). Never throws past the row's creation.
 */
export async function drillHubArchive(
  app: App, opts: { kind?: DrillKind; requestedBy?: string | null } = {},
): Promise<AppDrill | { skipped: string }> {
  const sys = app.db!.asSystem() as any
  const hubId  = await requireHubAppId(sys)
  const server = await hostServer(sys)
  if (!server) return { skipped: 'This hub is placed on no machine, so a drill has no server to record against' }

  const archive = await sys.appBackup.findFirst({
    where: { appId: hubId, status: 'success', error: null, destinationId: { not: null }, sha256: { not: null } },
    orderBy: { startedAt: 'desc' },
  })
  if (!archive?.location) return { skipped: 'No uploaded hub archive carries a sha256, so there is nothing to drill' }
  const dest = await sys.backupDestination.findFirst({ where: { id: archive.destinationId } })
  if (!dest) return { skipped: `Destination '${archive.destinationId}' is gone, so ${archive.location} cannot be reached` }

  const startedAt = new Date().toISOString()
  const row = await sys.appDrill.create({ data: {
    appId: hubId, serverId: server.id, kind: opts.kind ?? 'manual', status: 'running',
    requestedBy: opts.requestedBy ?? null, startedAt,
  } })

  // Beside the live database: the volume that holds the archive's size.
  const work = mkdtempSync(join(dirname(resolve(app.sqlite.filename)), '.drill-'))
  let reasons: string[]
  try {
    const res = await fetch(await mintDownload(app, dest, archive.location))
    if (!res.ok) reasons = [`'${dest.name}' answered ${res.status} for ${archive.location}`]
    else {
      const tarball = join(work, 'archive.tar.gz')
      await Bun.write(tarball, res)
      reasons = await whyNot(tarball, work, archive.sha256, await hubInstallId(sys))
    }
  } catch (err) {
    reasons = [(err as Error).message]
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const finishedAt = new Date().toISOString()
  return sys.appDrill.update({ where: { id: row.id }, data: {
    status: reasons.length ? 'failed' : 'success', finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    report: { archive: archive.location, backupId: archive.id, reasons },
    error:  reasons.length ? reasons.join(' ').slice(0, 2000) : null,
  } })
}
