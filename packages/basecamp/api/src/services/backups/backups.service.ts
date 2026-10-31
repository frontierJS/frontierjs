// src/services/backups/backups.service.ts
// Archives of everything the application keeps (every declared database and the
// job queue) — the hub tier's own safety net.
//
// Mounted at /backups, behind `requireSystemAdmin()` like /hub and /hub-config.
// A row is an `AppBackup` on the hub App (`FJS-D1606`), and every read here
// names that App: an archive is of the whole installation, every workspace in
// it, so the hub App's workspace is not a standing that could grant one, and
// the reads are at system behind the sysadmin refusal.
// `appBackups` is the door to every other App's.
//
// ─── The row is created here and finished by the job ──────────────────────
//
// `take` writes a `pending` row and dispatches; `backup:run` does the work and
// writes the outcome, at system: a status a caller can write is not evidence
// of anything.
//
// ─── This dispatch states `actor: null`, and that is not the cron's reason ──
//
// A person really did ask for a manual backup, so the obvious declaration is
// `runsAsCaller`. It is the wrong one: `runsAsCaller` refuses without a TENANT,
// and a hub action has none — there is no membership to re-resolve and no
// scoped parent read to confine the write. So the mode is `runsAsApp`, stated
// at the dispatch, and who asked is kept where it can be read: `requestedBy` on
// the row (`FJS-384`).

import { createService, BadRequest, Conflict, NotFound, parseWhere, $ } from '@frontierjs/junction'
import { requireSystemAdmin, getPagination }                from '../../core/hooks.ts'
import { db, actor, callerOrder, callerSelect }               from '../../core/resource.ts'
import { requireHubAppId }                                  from '../../domain/host/host-machine.ts'
import { queueBackup, SETTLED }                             from '../../jobs/backup-run.job.ts'
import { deleteArchive, rescanDestination, isRemote, localArchive, bucketDownload } from '../../domain/backup/backup-archives.ts'
import { mintArchiveUrl }                                 from '../../plugins/backup-archive.ts'
import { LEVELS }                                           from '@frontierjs/litestone'
import { keyScope } from '../../domain/api-key/scopes.ts'

/** One of the hub App's archives; an id of any other App's is not found here. */
async function hubArchive(id: string) {
  const sys = db().asSystem()
  const row = await sys.appBackup.findFirst({ where: { id, appId: await requireHubAppId(sys) } })
  if (!row) throw new NotFound(`Backup '${id}' not found`)
  return row
}

export default createService({
  name:  'backups',
  scope: keyScope('backups'),
  model: 'AppBackup',

  // The writes are named: `AppBackup`'s @@gate puts its CRUD writes at SYSTEM,
  // which no caller holds. They carry no `gate:` either — a method gate
  // answers 403 before `requireSystemAdmin()` can answer 404 (`FJS-D49`).
  methods: ['find', 'get', 'take', 'discard',
            { method: 'rescan',   gate: LEVELS.SYSADMIN, input: 'BackupRescan' },
            { method: 'download', gate: LEVELS.SYSADMIN, read: true }],

  async find() {
    const { limit, offset } = getPagination()
    // No hub App yet is no archive yet, not a refusal: the screen lists before
    // anyone has pressed Use this Basecamp server.
    const order  = callerOrder({ createdAt: 'desc' }), select = callerSelect()
    const appId  = (await db().asSystem().hubConfig.findFirst({ where: { id: 'hub' }, select: { appId: true } }))?.appId
    if (!appId) return { total: 0, limit, offset, data: [] }
    const { rows, total } = await db().asSystem().appBackup.findManyAndCount({
      where:   { ...parseWhere($.query), appId },
      limit, offset, orderBy: order, ...select,
    })
    return { total, limit, offset, data: rows }
  },

  async get() {
    return hubArchive($.id as string)
  },

  /** Ask for one now. Refuses while another is in flight (`queueBackup`). */
  async take() {
    const data = ($.data ?? {}) as Record<string, unknown>

    // Null is the local disk. A destination is a row in some workspace, read
    // at system because a sysadmin's own standing may be elsewhere; one that
    // does not exist is refused here by name rather than queued to fail,
    // because a row that is going to fail for a reason already known is a
    // worse answer than a refusal — the person has to come back to find out.
    const destinationId = (data.destinationId ?? null) as string | null
    if (destinationId !== null) {
      const found = await db().asSystem().backupDestination.findFirst({ where: { id: destinationId } })
      if (!found) throw new BadRequest(`No backup destination '${destinationId}'`)
      if (!found.secretId) throw new BadRequest(`Destination '${found.name}' holds no credential — rotate one in first`)
    }

    const queued = await queueBackup($.app, { kind: 'manual', destinationId, requestedBy: actor() })
    if ('inFlight' in queued) throw new Conflict(
      `A backup is already ${queued.inFlight.status} (started ${queued.inFlight.startedAt ?? 'just now'}). ` +
      `Wait for it to finish.`)
    return queued.backup
  },

  /**
   * Delete an archive: its directory on this disk or its object in the bucket,
   * then the row (`FJS-D1494`), through the one delete retention uses. A
   * delete the vendor refuses keeps the row and answers 409 with why, so the
   * archive is never left in the bucket with nothing listing it.
   */
  async discard() {
    const row = await hubArchive($.id as string)
    if (!SETTLED.includes(row.status)) throw new Conflict(
      `That backup is still ${row.status} — wait for it to finish.`)

    const done = await deleteArchive($.app, row)
    if ('kept' in done) throw new Conflict(`The backup was kept: ${done.kept}`)
    return row
  },

  // ── rescan — POST /backups  X-Service-Method: rescan ──
  /** Give a `found` row to each archive in the destination's prefix that no
   *  row names, so retention counts it (`FJS-D1493`). */
  async rescan() {
    const destinationId = (($.data ?? {}) as Record<string, unknown>).destinationId as string
    const result = await rescanDestination($.app, destinationId)
    if ('error' in result) throw new BadRequest(result.error)
    return result
  },

  // ── download — POST /backups/{id}  X-Service-Method: download ──
  /** The URL one archive is fetched by (`IDEAS/backups.md` 4.2): the bucket's
   *  pre-signed GET for a remote one, a five-minute link this process signed
   *  for a local one (`plugins/backup-archive.ts`). Both save as
   *  `basecamp-<stamp>.tar.gz`. */
  async download() {
    const row = await hubArchive($.id as string)
    if (row.status !== 'success') throw new BadRequest(`That backup is ${row.status}, so there is no archive to download`)
    const name = `${(row.location ?? '').split('/').pop()!.replace(/\.tar\.gz$/, '')}.tar.gz`

    if (isRemote(row)) return bucketDownload($.app, row, name)
    if (!localArchive($.app, row)) throw new NotFound(`${row.location ?? 'That backup'} is no longer on this disk`)
    // The route cannot know who follows the link, so who minted it is logged here.
    $.app.logger.info('backup archive link minted', { backup_id: row.id, by: actor() })
    return { url: mintArchiveUrl(row.id), name }
  },

  hooks: {
    before: { all: [requireSystemAdmin()] },
  },
})
