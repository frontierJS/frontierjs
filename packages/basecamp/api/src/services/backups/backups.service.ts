// src/services/backups/backups.service.ts
// Archives of the application database — the hub tier's own safety net.
//
// Mounted at /backups, behind `requireSystemAdmin()` like /hub and /hub-config.
// `Backup` is `@@tenant(none)`: an archive is of the whole installation, every
// workspace in it, so there is no workspace to scope by and no member standing
// that could grant it.
//
// ─── The row is created here and finished by the job ──────────────────────
//
// `create` writes a `pending` row and dispatches; `backup:run` does the work and
// writes the outcome. The outcome columns are gated at SYSTEM — `@@gate("7.7.8.7")`
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
import { db, actor }                                        from '../../core/resource.ts'
import backupRun                                            from '../../jobs/backup-run.job.ts'
import type { BasecampApp }                                 from '../../basecamp.types.ts'

/** Terminal states — anything else is still in flight. */
const SETTLED = ['success', 'failed', 'timeout']

export function createBackupsService(app: BasecampApp) {
  return createService({
    name:  'backups',
    model: 'Backup',

    methods: ['find', 'get', 'create', 'remove'],

    async find() {
      const { limit, offset } = getPagination()
      const status = $.query.status as string | undefined
      const { rows, total } = await db().backup.findManyAndCount({
        where:   status ? { status } : {},
        limit, offset,
        orderBy: { createdAt: 'desc' },
      })
      return { total, limit, offset, data: rows }
    },

    async get() {
      const row = await db().backup.findFirst({ where: { id: $.id as string } })
      if (!row) throw new NotFound(`Backup '${$.id}' not found`)
      return row
    },

    /**
     * Ask for one now.
     *
     * Refuses while another is in flight. Two concurrent `VACUUM INTO`s on one
     * database are not a corruption risk — SQLite serializes them — but they are
     * two archives of the same bytes taken a second apart, and the second one
     * doubles how long the first takes for no reason anybody would want.
     */
    async create() {
      const data = ($.data ?? {}) as Record<string, unknown>

      const inFlight = await db().backup.findFirst({
        where: { status: { notIn: SETTLED } }, orderBy: { createdAt: 'desc' },
      })
      if (inFlight) throw new Conflict(
        `A backup is already ${inFlight.status} (started ${inFlight.startedAt ?? 'just now'}). ` +
        `Wait for it to finish.`)

      // `s3` is a declared value with nothing behind it. Refused by name here
      // rather than accepted and failed by the job, because a queued row that
      // is going to fail for a reason already known is a worse answer than a
      // refusal — the person has to come back to find out.
      const destination = String(data.destination ?? 'local')
      if (destination !== 'local') throw new BadRequest(
        `Only 'local' backups are implemented. '${destination}' needs an outbound ` +
        `adapter this app does not have (FJS-153).`)

      const backup = await db().backup.create({
        data: { kind: 'manual', status: 'pending', destination, requestedBy: actor() },
      })

      // `actor: null` — see the header. A hub action has no tenant, so the
      // handler declares `runsAsApp` and this says so rather than letting
      // caravan inherit a principal the handler would then refuse.
      await app.jobs.dispatch(backupRun, { backupId: backup.id },
        { queue: 'fleet', priority: 5, actor: null })

      return backup
    },

    /**
     * Forget an archive.
     *
     * The ROW only. The file it names is not deleted, and that is deliberate
     * while `location` is a path on a disk this process shares with the live
     * database: a delete that unlinks a file is a delete that can unlink the
     * wrong one, and the failure mode is losing the backup you were about to
     * restore from. Pruning the files is an operator's job until there is a
     * destination that owns its own lifecycle.
     */
    async remove() {
      const id  = $.id as string
      const row = await db().backup.findFirst({ where: { id } })
      if (!row) throw new NotFound(`Backup '${id}' not found`)
      if (!SETTLED.includes(row.status)) throw new Conflict(
        `That backup is still ${row.status} — wait for it to finish.`)

      await db().backup.delete({ where: { id } })
      return { ...row, note: row.location ? `The archive at ${row.location} was left in place` : null }
    },

    hooks: {
      before: { all: [requireSystemAdmin()] },
    },
  })
}
