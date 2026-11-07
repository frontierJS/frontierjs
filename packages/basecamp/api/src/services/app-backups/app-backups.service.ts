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

import { createService, BadRequest, Conflict, NotFound, $ }  from '@frontierjs/junction'
import { LEVELS }                                          from '@frontierjs/litestone'
import { sessionScope, getPagination, WORKSPACE_QUERY }       from '../../core/hooks.ts'
import { db, getScoped, actor, callerOrder, callerSelect }   from '../../core/resource.ts'
import { executorOn, isExecutor }                            from '../../providers/executor.ts'
import { takeAppBackup }                                     from '../../jobs/app-backup-run.job.ts'
import { queueAppArchiveRescan }                             from '../../jobs/app-archive-rescan.job.ts'
import { bucketDownload, deleteRemote, isRemote, removeOnMachine } from '../../domain/backup/backup-archives.ts'
import { mintUploadUrl }                                     from '../../plugins/app-archive-upload.ts'
import { mintPullUrls }                                      from '../../plugins/app-archive-pull.ts'
import { BODY_CEILING_BYTES }                                from '../../plugins/signed-link.ts'
import { env }                                               from '../../core/env.ts'
import { keyScope }                                          from '../../domain/api-key/scopes.ts'
import { hubIds, refuseHubVolume }                           from '../../domain/host/host-machine.ts'
import type { AppBackup }                                  from '#db/schema.d.ts'

/** A 128 MB archive over a slow uplink takes minutes; the GET link is minted
 *  after the send returns, so this bounds the wait, not the link. */
const PULL_TIMEOUT_MS = 10 * 60_000

/** The machine-kept half of `download`: ask the machine to send the file to a
 *  hub route, wait for it to land, answer the link that reads it. */
async function pullFromMachine(row: AppBackup, app: { id: string }, name: string): Promise<{ url: string; name: string }> {
  const server = row.serverId ? await db().asSystem().server.findFirst({ where: { id: row.serverId } }) : null
  const where  = server?.name ?? 'its machine'
  // Bun refuses a body over the ceiling before the route reads it, so the hub
  // could not receive it however the machine sent it (`FJS-3090`).
  if ((row.sizeBytes ?? 0) > BODY_CEILING_BYTES)
    throw new BadRequest(`That backup is ${Math.ceil(row.sizeBytes! / 1024 ** 2)} MB, over the ${BODY_CEILING_BYTES / 1024 ** 2} MB the hub can pull from ${where} — give the app a backup destination, or copy it off the machine with scp`)
  if (!server || server.status !== 'online')
    throw new BadRequest(`${where} is ${server?.status ?? 'gone'}, so its archive cannot be fetched — try again when it is online`)
  const executor = await executorOn($.app, server.id, server.name)
  if (!isExecutor(executor)) throw new BadRequest(executor.reason)

  const urls = mintPullUrls(crypto.randomUUID(), name)
  const sent = await executor.call('/backup/send', {
    app_id: app.id, path: row.location, upload_url: `${env.FRONTIER_API_URL.replace(/\/$/, '')}${urls.put}`,
  }, { timeoutMs: PULL_TIMEOUT_MS })
  if (sent.error) throw new BadRequest(`${where} could not send that archive: ${sent.error.message}`)
  if (executor.kind === 'stub') throw new BadRequest(`${where} is a stub — no archive was sent`)
  return { url: urls.get, name }
}

/**
 * The machine's copy of an archive deleted, by its file name: once an upload
 * lands the row holds the object key. Answers why not, or null once it is
 * gone. A machine whose row is gone took its archives along.
 */
async function removeFromMachine(row: AppBackup, name: string): Promise<string | null> {
  const server = await db().asSystem().server.findFirst({ where: { id: row.serverId! } })
  if (!server) return null
  if (server.status !== 'online')
    return `${server.name} is ${server.status}, so its copy cannot be deleted — try again when it is online`
  const done = await removeOnMachine($.app, server, row.appId, name)
  return 'error' in done ? done.error : null
}

export default createService({
  name:  'appBackups',
  scope: keyScope('appBackups'),
  model: 'AppBackup',
  reservedQuery: [...WORKSPACE_QUERY],

  // `create`, `update` and `remove` are absent on purpose: the row is what the
  // machine reported, and the base would otherwise answer all three with
  // whatever the caller wrote. `take` writes at SYSTEM, so a model gate on
  // `create` could never grade it and the method states its own; `discard`
  // deletes the archive before the row, which a base `remove` would not.
  methods: ['find', 'get',
    { method: 'take',   gate: LEVELS.ADMINISTRATOR, input: 'AppBackupTake' },
    { method: 'discard', gate: LEVELS.ADMINISTRATOR },
    { method: 'rescan', gate: LEVELS.ADMINISTRATOR, input: 'AppBackupRescan' },
    { method: 'download', gate: LEVELS.ADMINISTRATOR, read: true },
    { method: 'upload',   gate: LEVELS.ADMINISTRATOR, input: 'AppBackupUpload' }],

  async find() {
    const { limit, offset } = getPagination({ limit: 50, max: 200 })
    // The hub App's archives are `/hubBackups`' (`FJS-D1606`), and its row is
    // left out of every list (`FJS-D1628`).
    const hub = (await hubIds(db().asSystem())).app
    if (hub && $.query.appId === hub) return { total: 0, limit, offset, data: [] }
    const where: Record<string, unknown> = hub ? { appId: { not: hub } } : {}
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
    // Before the machine is asked for, so this is the sentence a person sees.
    await refuseHubVolume(db().asSystem(), app.id)
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
    $.dispatch = false   // nothing written yet; the job writes the rows
    return { queued: true }
  },

  // ── download — POST /app-backups/{id}  X-Service-Method: download ──
  /** One archive as `<slug>-<stamp>.tar.gz`. A bucket's is its pre-signed GET.
   *  A machine-kept one is PULLED THROUGH THE HUB (`FJS-D1833`): the hub mints
   *  a PUT to `plugins/app-archive-pull.ts`, the machine's Outpost sends the
   *  file to it (`/backup/send`) and this answers a GET for that copy once it
   *  has landed. The bytes still do not cross the command port (`FJS-D1485`)
   *  -- they go over the minted PUT, as `/backup`'s `upload_url` does. */
  async download() {
    const row = await db().appBackup.findFirst({ where: { id: $.id as string } })
    const hub = (await hubIds(db().asSystem())).app
    if (!row || row.appId === hub) throw new NotFound(`App backup '${$.id}' not found`)
    if (row.status !== 'success') throw new BadRequest(`That backup is ${row.status}, so there is no archive to download`)
    const keptOnMachine = !isRemote(row) && !!row.location?.startsWith('/')
    if (!isRemote(row) && !keptOnMachine) throw new BadRequest('That backup has no archive to download')
    const app  = await getScoped('app', 'App', row.appId)
    const base = row.location!.split('/').pop()!.replace(/\.tar\.gz$/, '')
    const name = `${base.startsWith(`${app.id}-`) ? `${app.slug}-${base.slice(app.id.length + 1)}` : base}.tar.gz`
    // The URL is the credential and nobody follows it through here.
    $.app.logger.info('app backup link minted', { backupId: row.id, appId: app.id, by: actor() })
    if (keptOnMachine) return pullFromMachine(row, app, name)
    return bucketDownload($.app, row, name)
  },

  // ── discard — POST /app-backups/{id}  X-Service-Method: discard ──
  /** Delete an archive, then its row (`FJS-D2012`): the bucket's object, then
   *  the machine's file, the only copy of a machine-kept archive and a warm
   *  one of an uploaded archive. A delete that fails keeps the row and answers
   *  409 with why; a warm copy left behind is listed by `servers.archives`. */
  async discard() {
    const row = await db().appBackup.findFirst({ where: { id: $.id as string } })
    const hub = (await hubIds(db().asSystem())).app
    if (!row || row.appId === hub) throw new NotFound(`App backup '${$.id}' not found`)
    if (row.status === 'pending' || row.status === 'running')
      throw new Conflict(`That backup is still ${row.status} — wait for it to finish.`)

    // The newest good archive is the app's way back, as the hub's is (`FJS-3902`).
    if (row.status === 'success') {
      const newest = await db().asSystem().appBackup.findFirst({
        where: { appId: row.appId, status: 'success' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
      })
      if (newest?.id === row.id) throw new Conflict(
        `That is the app's newest good backup, and the way back if its data is lost — take another and discard this one once it succeeds.`)
    }

    const remote = isRemote(row)
    if (remote) {
      const kept = await deleteRemote($.app, row)
      if (kept) throw new Conflict(`The backup was kept: ${kept}`)
    }
    const name = row.location?.split('/').pop()
    if (row.status === 'success' && row.serverId && name?.endsWith('.tar.gz')) {
      const left = await removeFromMachine(row, name)
      if (left && !remote) throw new Conflict(`The backup was kept: ${left}`)
      if (left) $.app.logger.warn('app backup warm copy left on its machine', { backupId: row.id, why: left })
    }
    await db().asSystem().appBackup.delete({ where: { id: row.id } })
    return row
  },

  // ── upload — POST /app-backups  X-Service-Method: upload ──
  /** The link one file is PUT to, signed for this app, its name and the
   *  caller. The bytes cannot cross a service body (`maxBodySize`), so the
   *  grading is here and the stream route checks only the signature
   *  (`plugins/app-archive-upload.ts`). */
  async upload() {
    const data = ($.data ?? {}) as Record<string, unknown>
    const app  = await getScoped('app', 'App', data.appId as string)
    await refuseHubVolume(db().asSystem(), app.id)
    if (!app.backupDestinationId) throw new BadRequest(`App '${app.name}' names no backup destination — give it one to import an archive`)
    $.dispatch = false   // nothing written yet; the route writes the row
    return { url: mintUploadUrl(app.id, String(data.name ?? ''), actor()), method: 'PUT' }
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
