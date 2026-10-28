// src/services/app-backups/app-backups.service.ts
// Archives of an app's data volume, taken on the machine that holds it.
//
// Mounted at /app-backups. `backups` is the installation's own database and
// stays the hub's; this is the app's data, which that archive never held
// (`FJS-1782`, `FJS-D679`, `FJS-D965`).
//
// ─── Three doors into one taking ──────────────────────────────────────────
//
// `take` is the person's door: it reads the app, the placement and the bucket
// in the CALLER's scope, so a caller can only name their own, and hands the
// rows to `jobs/app-backup-run.job.ts`, which owns asking the machine — the
// App's schedule and a release's `Back up volume` step come through the same
// function (Invariant 4). What an archive is, where it goes and how a refused
// upload reads is that file's header.
//
// ─── Written at SYSTEM, after the caller proves the app is theirs ─────────
//
// `@@gate(5.8.8.8)` and `take` at ADMINISTRATOR: an administrator reads and
// asks, and the outcome columns are the service's, as `Backup`'s are.

import { createService, BadRequest, NotFound, $ }            from '@frontierjs/junction'
import { LEVELS }                                          from '@frontierjs/litestone'
import { sessionScope, getPagination, WORKSPACE_QUERY }       from '../../core/hooks.ts'
import { db, getScoped, actor, callerOrder, callerSelect }   from '../../core/resource.ts'
import { executorOn, isExecutor }                            from '../../providers/executor.ts'
import { takeAppBackup }                                     from '../../jobs/app-backup-run.job.ts'
import { queueAppArchiveRescan }                             from '../../jobs/app-archive-rescan.job.ts'
import { keyScope }                                          from '../../domain/api-key/scopes.ts'

export default createService({
  name:  'appBackups',
  scope: keyScope('appBackups'),
  model: 'AppBackup',
  reservedQuery: [...WORKSPACE_QUERY],

  // `create`, `update` and `remove` are absent on purpose: the row is what the
  // machine reported, and the base would otherwise answer all three with
  // whatever the caller wrote. `take` writes at SYSTEM, so a model gate on
  // `create` could never grade it and the method states its own.
  methods: ['find', 'get',
    { method: 'take',   gate: LEVELS.ADMINISTRATOR, input: 'AppBackupTake' },
    { method: 'rescan', gate: LEVELS.ADMINISTRATOR, input: 'AppBackupRescan' }],

  async find() {
    const { limit, offset } = getPagination({ limit: 50, max: 200 })
    const where: Record<string, unknown> = {}
    for (const key of ['appId', 'serverId', 'status'])
      if ($.query[key]) where[key] = $.query[key]
    const { rows, total } = await db().appBackup.findManyAndCount({
      where, limit, offset,
      orderBy: callerOrder({ createdAt: 'desc' }),
      ...callerSelect(),
    })
    return { total, limit, offset, data: rows }
  },

  async get() {
    const row = await db().appBackup.findFirst({ where: { id: $.id as string } })
    if (!row) throw new NotFound(`App backup '${$.id}' not found`)
    return row
  },

  // ── take — POST /app-backups  X-Service-Method: take ──
  async take() {
    const data          = ($.data ?? {}) as Record<string, unknown>
    const appId         = data.appId as string
    const serverId      = data.serverId as string
    const destinationId = (data.destinationId as string | null | undefined) ?? null

    const app    = await getScoped('app', 'App', appId)
    const placed = await db().appServer.findFirst({ where: { appId: app.id, serverId }, include: { server: true } })
    if (!placed) throw new NotFound('This app is not placed on that server')
    // A destination of another workspace is `NotFound` here, before any
    // machine is asked (`FJS-D1491`).
    const destination = destinationId
      ? await db().backupDestination.findFirst({ where: { id: destinationId } })
      : null
    if (destinationId && !destination) throw new NotFound(`No backup destination '${destinationId}'`)

    const executor = await executorOn($.app, serverId, placed.server?.name)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)

    return takeAppBackup($.app, { target: app, executor, destination, kind: 'manual', requestedBy: actor() })
  },

  // ── rescan — POST /app-backups  X-Service-Method: rescan ──
  /** Queue the listing of the app's bucket for archives no row names; each
   *  found one is restorable once the hub has read its sha256 (`FJS-D1572`). */
  async rescan() {
    const app = await getScoped('app', 'App', (($.data ?? {}) as Record<string, unknown>).appId as string)
    if (!app.backupDestinationId) throw new BadRequest(`App '${app.name}' names no backup destination`)
    await queueAppArchiveRescan($.app, app.id)
    return { queued: true }
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
