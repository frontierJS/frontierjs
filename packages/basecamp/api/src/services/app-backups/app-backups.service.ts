// src/services/app-backups/app-backups.service.ts
// Archives of an app's data volume, taken on the machine that holds it.
//
// Mounted at /app-backups. `backups` is the installation's own database and
// stays the hub's; this is the app's data, which that archive never held
// (`FJS-1782`, `FJS-D679`, `FJS-D965`).
//
// ─── The archive stays on the machine ─────────────────────────────────────
//
// `take` asks the Outpost on the named server to tar `fjs-<app>-data`
// (`POST /backup`) and records the path it answers. No bytes cross the command
// port, so a lost machine takes its backups with it; `location` is a path on
// THAT machine, and restoring is `apps.restoreVolume` once the file sits in the
// machine's restore directory.
//
// ─── Written at SYSTEM, after the caller proves the app is theirs ─────────
//
// `@@gate(5.8.8.8)` and `take` at ADMINISTRATOR: an administrator reads and
// asks, and the outcome columns are the service's, as `Backup`'s are. The scoped
// read of the App comes first,
// so a caller can only name an app in their own workspace; the placement read is
// the same confinement for the machine.
//
// A stub executor answers the protocol and does nothing. That is recorded as a
// failure: a row reading `success` over an archive nobody took is the
// worst answer a backup can give.

import { createService, BadRequest, Conflict, NotFound, $ } from '@frontierjs/junction'
import { LEVELS }                                          from '@frontierjs/litestone'
import { sessionScope, getPagination, WORKSPACE_QUERY }       from '../../core/hooks.ts'
import { db, getScoped, actor, callerOrder, callerSelect }   from '../../core/resource.ts'
import { executorOn, isExecutor }                            from '../../providers/executor.ts'
import { keyScope }                                          from '../api-keys/scopes.ts'

/** Outpost's tar is bounded at an hour; this outlasts it by a minute, as the
 *  volume restore does, so a slow archive reads as slow rather than as failed. */
const BACKUP_TIMEOUT_MS = 61 * 60_000

/** A row still pending or running past the timeout belongs to a process that
 *  died; counting it would refuse every later backup of that app. */
const STALE_AFTER_MS = BACKUP_TIMEOUT_MS + 60_000

export default createService({
  name:  'app-backups',
  scope: keyScope('app-backups'),
  model: 'AppBackup',
  reservedQuery: [...WORKSPACE_QUERY],

  // `create`, `update` and `remove` are absent on purpose: the row is what the
  // machine reported, and the base would otherwise answer all three with
  // whatever the caller wrote. `take` writes at SYSTEM, so a model gate on
  // `create` could never grade it and the method states its own.
  methods: ['find', 'get', { method: 'take', gate: LEVELS.ADMINISTRATOR, input: 'AppBackupTake' }],

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
    const data     = ($.data ?? {}) as Record<string, unknown>
    const appId    = data.appId as string
    const serverId = data.serverId as string

    const app    = await getScoped('app', 'App', appId)
    const placed = await db().appServer.findFirst({ where: { appId: app.id, serverId }, include: { server: true } })
    if (!placed) throw new NotFound('This app is not placed on that server')

    const inFlight = await db().appBackup.findFirst({
      where: {
        appId: app.id, serverId, status: { in: ['pending', 'running'] },
        createdAt: { gt: new Date(Date.now() - STALE_AFTER_MS).toISOString() },
      },
    })
    if (inFlight) throw new Conflict(`A backup of this app on '${placed.server?.name}' is already ${inFlight.status}`)

    const executor = await executorOn($.app, serverId, placed.server?.name)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)

    const sys       = $.db.asSystem() as any
    const startedAt = new Date().toISOString()
    const row = await sys.appBackup.create({
      data: { appId: app.id, serverId, status: 'running', requestedBy: actor(), startedAt },
    })

    const finish = async (outcome: Record<string, unknown>) => {
      const finishedAt = new Date().toISOString()
      return sys.appBackup.update({
        where: { id: row.id },
        data:  { ...outcome, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) },
      })
    }

    // A throw would leave the row `running` until the staleness window passes.
    const reply = await executor.call('/backup', { app_id: app.id }, { timeoutMs: BACKUP_TIMEOUT_MS })
      .catch((err: Error) => ({ error: { message: err.message } }) as Awaited<ReturnType<typeof executor.call>>)
    if (reply.error)
      return finish({ status: 'failed', error: reply.error.message.slice(0, 2000) })
    if (executor.kind === 'stub')
      return finish({ status: 'failed', error: 'stub executor — no backup was taken' })

    const { path, bytes, files } = reply.data ?? {}
    if (typeof path !== 'string')
      return finish({ status: 'failed', error: 'the outpost answered no archive path' })
    return finish({
      status: 'success', error: null,
      location: path as string, sizeBytes: bytes as number, fileCount: files as number,
    })
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
