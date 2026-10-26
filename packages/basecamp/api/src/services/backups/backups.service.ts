// src/services/backups/backups.service.ts
// Archives of everything the application keeps (every declared database and the
// job queue) — the hub tier's own safety net.
//
// Mounted at /backups, behind `requireSystemAdmin()` like /hub and /hub-config.
// `Backup` is `@@tenant(none)`: an archive is of the whole installation, every
// workspace in it, so there is no workspace to scope by and no member standing
// that could grant it.
//
// ─── The row is created here and finished by the job ──────────────────────
//
// `create` writes a `pending` row and dispatches; `backup:run` does the work and
// writes the outcome. The outcome columns are gated at SYSTEM — `@@gate(7.7.8.7)`
// — which is the schema saying what every `*Run` here says: a status a caller
// can write is not evidence of anything.
//
// ─── This dispatch states `actor: null`, and that is not the cron's reason ──
//
// A person really did ask for a manual backup, so the obvious declaration is
// `runsAsCaller`. It is the wrong one: `runsAsCaller` refuses without a TENANT,
// and a hub action has none — there is no membership to re-resolve and no
// scoped parent read to confine the write. So the mode is `runsAsApp`, stated
// at the dispatch, and who asked is kept where it can be read: `requestedBy` on
// the row (`FJS-384`).

import { createService, BadRequest, Conflict, NotFound, $ } from '@frontierjs/junction'
import { requireSystemAdmin, getPagination }                from '../../core/hooks.ts'
import { db, actor, callerOrder, callerSelect }               from '../../core/resource.ts'
import { queueBackup, SETTLED }                             from '../../jobs/backup-run.job.ts'
import { deleteArchive, rescanDestination }                 from '../../jobs/backup-archives.ts'
import { LEVELS }                                           from '@frontierjs/litestone'
import { keyScope } from '../api-keys/scopes.ts'

export default createService({
  name:  'backups',
  scope: keyScope('backups'),
  model: 'Backup',

  methods: ['find', 'get', 'create', 'remove', { method: 'rescan', gate: LEVELS.SYSADMIN, input: 'BackupRescan' }],

  async find() {
    const { limit, offset } = getPagination()
    const status = $.query.status as string | undefined
    const { rows, total } = await db().backup.findManyAndCount({
      where:   status ? { status } : {},
      limit, offset,
      orderBy: callerOrder({ createdAt: 'desc' }),
      ...callerSelect(),
    })
    return { total, limit, offset, data: rows }
  },

  async get() {
    const row = await db().backup.findFirst({ where: { id: $.id as string } })
    if (!row) throw new NotFound(`Backup '${$.id}' not found`)
    return row
  },

  /** Ask for one now. Refuses while another is in flight (`queueBackup`). */
  async create() {
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
  async remove() {
    const id  = $.id as string
    const row = await db().backup.findFirst({ where: { id } })
    if (!row) throw new NotFound(`Backup '${id}' not found`)
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

  hooks: {
    before: { all: [requireSystemAdmin()] },
  },
})
