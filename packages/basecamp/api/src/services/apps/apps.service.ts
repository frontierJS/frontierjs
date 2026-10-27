// src/services/apps/apps.service.ts
// Apps — the deployable unit. Lives in an Environment, runs on one or more
// Servers.
//
// Mounted at /apps. `model: 'App'` derives validation from db/schema.lite.
//
// Custom methods, addressed the way DECISIONS.md settled — `POST /apps/:id`
// with `X-Service-Method`, never a path segment:
//   place · unplace — which machines the app runs on
//   logs           — what the container is saying, read through the executor
//   restoreVolume  — an archive on the machine or a backup in a bucket, extracted into the app's data volume
//   restoreReplica — the app's databases out of its Litestream replica, at an instant
//   fromBlueprint  — an app made out of a catalog entry and its parameters
//   publish        — a static build handed in, sent to the machine and released
//   mintDeployKey · importDockerfile — the machine's deploy key, and its clone's Dockerfile (FJS-D1555)
//   readRepoDockerfile · dockerfileTemplate — the two seeds the create form offers
//
// The table is `app`, not `service`. The old header here said "table name in
// DB: service (legacy — kept for migration continuity)"; that name was the
// exact overload VISION.md §Vocabulary forbids and it is gone — Service is the
// API realm's noun. See db/README.md §Two renames.
//
// The hand-rolled WITH_ENV JOIN is replaced by `include: { environment: true }`.
// The relation is declared in the schema, so the join is derived rather than
// spelled out — and it returns a nested object instead of flattened
// `environment_name` / `environment_tier` columns.

import { randomBytes } from 'node:crypto'
import { createService, NotFound, BadRequest, Conflict, parseWhere, $ } from '@frontierjs/junction'
import { normalizeOrderBy, type SortParam } from '@frontierjs/toolbelt/query'
import { LEVELS, AccessDeniedError } from '@frontierjs/litestone'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, getScoped, removeScoped, restoreScoped, deriveSlug, narrowPatch, changesNothing, ws, actor,
         slugify, }
  from '../../core/resource.ts'
import { env }      from '../../core/env.ts'
import { mintPush } from '../../plugins/push.ts'
// The ONE definition of a certificate's condition, imported rather than
// recomputed: an include returns raw Domain rows, so without this the app
// detail screen received hostnames with no cert_status at all and every one of
// them rendered as "no certificate" — including the expired ones.
import { certStatusOf } from '../domains/domains.service.ts'
import { resolveExecutor, executorOn, isExecutor } from '../../providers/executor.ts'
// The one reader of `App.source`. A service that parsed the blob itself would
// be the second, and the two would disagree the first time a kind was added.
import { parseAppSource, sourceKindOf, summarizeSource, describeSource, isGit, isInline } from '../../domain/release/app-source.ts'
import { fjsDockerfileTemplate, readRepoDockerfile, DOCKERFILE_PATHS } from '../../domain/release/dockerfile-template.ts'
import { runtimeOf } from '../../domain/release/runtime.ts'
import { mintDownload } from '../../jobs/app-backup-run.job.ts'
import { cronProblem, syncAppBackupSchedule, syncAppDrillSchedule } from '../../domain/job/job-schedule.ts'
import { syncReplicasOn, syncReplicasOf, replicaHolder, replicaOf, replicaDatabases } from '../../jobs/replicate-sync.job.ts'
import type { App }            from '@frontierjs/junction'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { replicaLag } from '../../domain/host/posture.ts'

const _WITH_ENV = { environment: true }

/** Outpost bounds the extract at an hour; a multi-GB archive sent at conduit's
 *  10s default reads as a failure while the machine is still writing it. */
const VOLUME_RESTORE_TIMEOUT_MS = 61 * 60_000

/** A build is up to 24 MB written file by file; conduit's 10s default fails it mid-write. */
const STATIC_PUBLISH_TIMEOUT_MS = 120_000

/** A value for a parameter that says how to mint one. The number is BYTES,
 *  read the way `openssl rand -hex 32` reads it — so `random_hex_32` is 64
 *  characters, and a key a vendor documents by that command is the length it
 *  asked for. */
function mint(generator: string): string {
  const bytes = Number(/^random_hex_(\d+)$/.exec(generator)?.[1])
  if (!bytes) throw new BadRequest(`No generator named '${generator}'`)
  return randomBytes(bytes).toString('hex')
}

// The detail read. `domains` comes with the app because `App.domain` — one
// nullable string — is gone: a hostname is a row now, and an app with an apex
// and a www is the ordinary case rather than the case the column could not
// describe. Litestone batches an include into one `IN` per relation level, so
// this is a second query for the whole page, not one per app.
const WITH_DETAIL = { environment: true, domains: true }

export type MachineAnswer = { ok: true } | { ok: false, why: string }

/**
 * A server in the caller's workspace that can hold work. A destroyed server
 * still has a row, and placing on one produces a deployment that can never
 * resolve an executor. Asked before anything is written, so a caller making
 * several rows refuses the server before the first of them.
 */
export async function placeableServer(serverId: string) {
  const server = await db().server.findFirst({ where: { id: serverId, workspaceId: ws() } })
  if (!server) throw new NotFound(`Server '${serverId}' not found in this workspace`)
  if (['destroyed', 'stopped'].includes(server.status))
    throw new BadRequest(`Cannot place an app on a ${server.status} server`)
  return server
}

/**
 * One replica of an App on a server — `apps.place` and `projects.fromRepo`.
 * `AppServer` is `@@gate(2.8)`, a system context's to write, so the caller has
 * already proved it may see the App and the server; the replica stated wins,
 * otherwise the next free index, so placing twice adds a replica rather than
 * failing on the @@unique.
 */
export async function placeApp(
  app: App,
  target: { id: string, replicaDestinationId?: string | null },
  server: { id: string, name: string },
  stated?: number,
): Promise<void> {
  const existing = await db().appServer.findMany({ where: { appId: target.id, serverId: server.id } })
  const replicaIndex = stated ?? existing.reduce((n: number, p: any) => Math.max(n, p.replicaIndex + 1), 0)
  if (existing.some((p: any) => p.replicaIndex === replicaIndex))
    throw new BadRequest(`Replica ${replicaIndex} of this app is already on '${server.name}'`)

  await $.db.asSystem().appServer.create({
    data: { appId: target.id, serverId: server.id, replicaIndex, status: 'unknown' },
  })
  if (target.replicaDestinationId) await syncReplicasOn(app, [server.id])
}

/** An SSH public key as a machine reports one. Never trusted further than
 *  that: a value carrying a private block is refused rather than shown. */
export function asPublicKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (key.length > 4096 || /PRIVATE/i.test(key)) return null
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\n]*)?$/.test(key) ? key : null
}

/**
 * Ask the machine holding this App for its deploy key and write the public
 * half (FJS-D1555). The machine makes the key on first ask and answers the
 * same one after. A machine that is offline, a stub, or an Outpost too old to
 * know the route leaves the column as it was and says why: the key is shown
 * for a person to add at the forge, and an App with none yet is still an App.
 */
export async function mintDeployKey(app: App, appId: string, serverId?: string): Promise<{ deployPublicKey: string | null, note?: string }> {
  const executor = serverId ? await executorOn(app, serverId) : await resolveExecutor(app, appId)
  if (!isExecutor(executor)) return { deployPublicKey: null, note: executor.reason }
  if (executor.kind === 'stub') return { deployPublicKey: null, note: 'stub executor — no machine made a deploy key' }

  const reply = await executor.call('/deploy-key', { app_id: appId })
  if (reply.error) return { deployPublicKey: null, note: `The machine made no deploy key: ${reply.error.message}` }
  const key = asPublicKey(reply.data?.public_key)
  if (!key || reply.data?.app_id !== appId) return { deployPublicKey: null, note: 'The machine answered without a public key for this app' }

  await $.db.asSystem().app.update({
    where: { id: appId }, data: { deployPublicKey: key }, system: ['deployPublicKey'],
  })
  return { deployPublicKey: key }
}

/**
 * An App off its machine — the one owner of *deleting an app retires it*.
 * Neither kind stops on its own. Files go on serving their last release at
 * their own address, and a container is started `unless-stopped` with a Caddy
 * route in front of it — a row removed from a console and an app still on the
 * internet. A machine that cannot be reached does not block the delete: the
 * row is the operator's decision and the retire is best effort, said in the
 * log rather than swallowed, and in the answer for a caller that has to act
 * on it. Marked stopped as well: a deleted app that still reads "running"
 * keeps showing up as live in any status rollup, and a restored one is not
 * on the machine until it is released again.
 */
export async function retireFromMachine(app: App, target: { id: string, slug: string, source: unknown }): Promise<MachineAnswer> {
  await db().app.update({ where: { id: target.id }, data: { status: 'stopped' }, system: ['status'] })
  const executor = await resolveExecutor(app, target.id)
  if (!isExecutor(executor)) {
    app.logger.warn(`app ${target.id} deleted with no machine to retire it from: ${executor.reason}`)
    return { ok: false, why: executor.reason }
  }
  const reply = sourceKindOf(target.source) === 'inline'
    ? await executor.call('/static/retire', { app_id: target.id, slug: target.slug })
    : await executor.call('/stop', { app_id: target.id })
  if (!reply.error) return { ok: true }
  app.logger.warn(`app ${target.id} deleted, but the machine still serves it: ${reply.error.message}`)
  return { ok: false, why: reply.error.message }
}

/**
 * Every live App in these Environments, retired before a parent's delete
 * cascades to them. `@@softDelete(cascade)` stamps the rows and sends nothing
 * (`FJS-2536`); the cascade, not `apps.remove`, stays the delete, so restoring
 * the parent brings its Apps back with it.
 */
export async function retireAppsIn(app: App, environmentIds: string[]): Promise<{ id: string, machine: MachineAnswer }[]> {
  if (!environmentIds.length) return []
  const live = await db().app.findMany({ where: { environmentId: { in: environmentIds } }, select: { id: true, slug: true, source: true } })
  const out: { id: string, machine: MachineAnswer }[] = []
  for (const target of live) out.push({ id: target.id, machine: await retireFromMachine(app, target) })
  return out
}

/**
 * `source` and `type` are one decision, so they are checked together.
 *
 * An inline app has no image and no container — its release is files behind
 * a web server — and `AppType` already has the word for that. Letting the two
 * disagree would produce an app whose deploy pipeline is the container one
 * and whose bytes are an HTML file, which fails four steps in with a docker
 * error about an image nobody named.
 *
 * The parse REWRITES `data.source`: what gets stored is the normalized shape,
 * never the payload, so an unknown key cannot ride into the column and be
 * read back later as though something had meant it.
 */
function checkSource(data: Record<string, unknown>, current?: Record<string, unknown>) {
  const source = 'source' in data ? parseAppSource(data.source) : null
  if ('source' in data) data.source = source ?? {}

  const kind = 'source' in data ? source?.kind : sourceKindOf(current?.source)
  const type = (data.type ?? current?.type ?? 'container') as string
  if (kind === 'inline' && type !== 'static')
    throw new BadRequest(
      `An inline source is served as files, so this app's type must be 'static' — it is '${type}'`)
}

/** A health path is asked of the port the release publishes, so one with
 *  no port could only fail — after the old container is already gone. */
function checkRuntime(data: Record<string, unknown>, current?: Record<string, unknown>) {
  const path = 'healthCheck' in data ? data.healthCheck : current?.healthCheck
  const port = 'port' in data ? data.port : current?.port
  if (path != null && port == null)
    throw new BadRequest(`A health check is asked of the published port, so '${path}' needs a port`)
}

/**
 * The app's schedules (`IDEAS/backups.md` 1.6, 3.3). An expression the clock cannot
 * hold is refused BEFORE the write, as `hubConfig.save` does, so a stored
 * schedule always registers; the bucket is read in the caller's scope, so
 * another workspace's row is refused by name and never pointed at. A replica
 * destination is one replica's (`FJS-D1505`), so one already held is refused
 * naming who holds it.
 */
async function checkBackup(data: Record<string, unknown>, selfId?: string): Promise<void> {
  for (const key of ['backupCron', 'drillCron']) {
    const problem = typeof data[key] === 'string' && cronProblem(data[key] as string)
    if (problem) throw new BadRequest(`${key}: ${problem}`)
  }
  for (const key of ['backupDestinationId', 'replicaDestinationId']) {
    const id = data[key]
    if (typeof id === 'string' && !await db().backupDestination.exists({ where: { id } }))
      throw new BadRequest(`No backup destination '${id}'`)
  }
  if (typeof data.replicaDestinationId === 'string') {
    const holder = await replicaHolder($.app, data.replicaDestinationId)
    if (holder && 'hub' in holder)
      throw new Conflict('That destination replicates Basecamp\'s own database; give this app a destination of its own')
    if (holder && holder.app.id !== selfId)
      throw new Conflict(`That destination replicates '${holder.app.slug}'; give this app a destination of its own`)
  }
}

/**
 * What a machine fetches one of the app's backups by: a GET minted for its
 * object key, and the digest recorded when it was taken. A backup whose upload
 * failed is a path on the machine it was taken on, under the backup directory
 * rather than the restore one, so it is refused here naming where it is.
 */
async function backupSource(appId: string, backupId: string): Promise<{ url: string; sha256: string }> {
  const backup = await db().appBackup.findFirst({ where: { id: backupId, appId } })
  if (!backup) throw new NotFound(`No backup '${backupId}' of this app`)
  if (backup.status !== 'success') throw new BadRequest(`Backup '${backupId}' is ${backup.status}, so there is no archive to restore`)
  if (!backup.destinationId || !backup.location || backup.location.startsWith('/'))
    throw new BadRequest(`Backup '${backupId}' never left its machine (${backup.location ?? 'no archive'}) — copy it under the restore directory and restore by path`)
  if (!backup.sha256) throw new BadRequest(`Backup '${backupId}' records no sha256, so the machine has nothing to check the fetched copy against`)
  const dest = await db().backupDestination.findFirst({ where: { id: backup.destinationId } })
  if (!dest) throw new NotFound(`No backup destination '${backup.destinationId}'`)
  return { url: await mintDownload($.app, dest, backup.location), sha256: backup.sha256 }
}

async function assertEnvironmentInWorkspace(environmentId: string) {
  const env = await db().environment.findFirst({ where: { id: environmentId, workspaceId: ws() } })
  if (!env) throw new NotFound(`Environment '${environmentId}' not found in this workspace`)
}

// The detail read, shared by `get` and by every custom method that changes
// the app's topology. A method that answered a bare row instead would hand
// the screen a record with no `placement` key, and a client assigning that
// over what it is rendering loses the section it just edited.
async function detail(id: string) {
  const row = await db().app.findFirst({
    where:   { id, workspaceId: ws() },
    // The project too, for the screen's breadcrumb — an app's address is
    // project, then environment, and the list read has no use for it.
    include: { ...WITH_DETAIL, environment: { include: { project: true } } },
  })
  if (!row) throw new NotFound(`App '${id}' not found`)

  // What the detail screen needs and a list does not: where the replicas
  // landed, what has been released, and what runs on a schedule. Three
  // reads here rather than three round trips from the browser — the screen
  // is one question ("what is this app doing"), so it is one request.
  const [placement, deployments, jobs] = await Promise.all([
    db().appServer.findMany({ where: { appId: row.id }, include: { server: true } }),
    // Columns, not the row. `configSnapshot` holds an inline app's whole
    // source, so ten releases of a pasted page is ten copies of it on a
    // request that draws a ten-line table.
    db().deployment.findMany({
      where:   { appId: row.id },
      select:  { id: true, status: true, trigger: true, queuedAt: true, finishedAt: true,
                 durationMs: true, commitSha: true, commitMessage: true, branch: true,
                 author: true, builtImage: true, toImage: true, previousDeploymentId: true },
      orderBy: { queuedAt: 'desc' },
      limit:   10,
    }),
    db().job.findMany({ where: { appId: row.id }, orderBy: { createdAt: 'desc' }, limit: 10 }),
  ])
  const drills = await lastDrills(row.id)

  return {
    ...row,
    domains: (row.domains ?? []).map((d: Record<string, unknown>) => ({ ...d, ...certStatusOf(d as never) })),
    sourceLabel: describeSource(row.source),
    // Each machine's Litestream reading for THIS app; the rest of that
    // reading names other apps on the machine and stays off this answer.
    placement: placement.map(({ server, ...p }: any) => {
      const { replication, ...rest } = server ?? {}
      return { ...p, server: server ? rest : server,
        replication: row.replicaDestinationId ? replicaLag(replication, row.id, Date.now()) : null,
        drill: drills.get(p.serverId) ?? null }
    }),
    recent_deployments: deployments,
    jobs,
  }
}

// The newest finished drill on each machine (`FJS-D1525`). `AppDrill` reads at
// ADMINISTRATOR, and a developer's detail screen leaves the badge out rather
// than failing the whole read.
async function lastDrills(appId: string): Promise<Map<string, unknown>> {
  const latest = new Map<string, unknown>()
  try {
    const rows = await db().appDrill.findMany({
      where:   { appId, status: { in: ['success', 'failed'] } },
      select:  { id: true, serverId: true, status: true, error: true, finishedAt: true },
      orderBy: { createdAt: 'desc' },
      limit:   20,
    })
    for (const r of rows as { serverId: string }[]) if (!latest.has(r.serverId)) latest.set(r.serverId, r)
  } catch (err) {
    if (!(err instanceof AccessDeniedError)) throw err
  }
  return latest
}

/**
 * What a blueprint's parameters become: one `Variable` each, on the app, and
 * a secret parameter's value in the row's `@encrypted` column. A blank field
 * falls back to the blueprint's default, then to a minted value for a param
 * that says how to mint one; a required param with none of the three is
 * refused by label.
 */
function paramValues(params: any[], values: Record<string, unknown>) {
  const known   = new Set(params.map(p => p.key))
  const unknown = Object.keys(values).filter(k => !known.has(k))
  if (unknown.length)
    throw new BadRequest(`This blueprint takes no parameter named ${unknown.map(k => `'${k}'`).join(', ')}`)

  const out: Array<{ key: string; value: string; secret: boolean }> = []
  const missing: string[] = []
  for (const p of params) {
    const given = values[p.key]
    if (given != null && typeof given !== 'string')
      throw new BadRequest(`'${p.key}' must be text`)
    const value = (given as string | undefined)?.trim()
      || p.defaultValue
      || (p.generate ? mint(p.generate) : '')
    if (!value) { if (p.required) missing.push(p.label); continue }
    out.push({ key: p.key, value, secret: Boolean(p.secret) })
  }
  if (missing.length) throw new BadRequest(`Required: ${missing.join(', ')}`)
  return out
}

export default createService({
  name:  'apps',
  scope: keyScope('apps'),
  model: 'App',
  paginate: { default: 20, max: 200 },
  // The whole surface. `place` and `unplace` write AppServer as the app, which
  // is `@@gate(2.8)`, so the level is stated here rather than read off it.
  methods: [
    'find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore',
    'logs',
    { method: 'fromBlueprint', input: 'AppFromBlueprint' },
    { method: 'place',   gate: LEVELS.USER, input: 'AppPlace' },
    { method: 'unplace', gate: LEVELS.USER, input: 'AppUnplace' },
    // Replaces what a database holds, so the level that may prune a volume.
    { method: 'restoreVolume', gate: LEVELS.ADMINISTRATOR, input: 'AppVolumeRestore' },
    { method: 'restoreReplica', gate: LEVELS.ADMINISTRATOR, input: 'AppReplicaRestore' },
    // A Deployment's create level, asked before the bytes reach the machine.
    { method: 'publish', gate: LEVELS.USER, input: 'AppPublish' },
    // Both write @system columns as the app; the level is stated for that.
    // `enablePush` hands a standing to the push receiver, so it is a release's.
    { method: 'enablePush',  gate: LEVELS.ADMINISTRATOR },
    { method: 'disablePush', gate: LEVELS.ADMINISTRATOR },
    // Writes an @system column as the app, at the level that may place it.
    { method: 'mintDeployKey',    gate: LEVELS.USER },
    { method: 'importDockerfile', gate: LEVELS.USER, read: true },
    // The create form's two seeds. Neither names an App, so they are reads
    // of the collection, at the level that may create one.
    { method: 'readRepoDockerfile', gate: LEVELS.USER, read: true, input: 'AppRepoDockerfile' },
    { method: 'dockerfileTemplate', gate: LEVELS.USER, read: true },
  ],
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  // `?serverId=` is not a column of App — a placement is an AppServer row —
  // so it is reserved rather than graded as a filter, and read below.
  reservedQuery: [...WORKSPACE_QUERY, 'serverId'],

  async find() {
    const { limit, offset } = getPagination()
    const serverId = $.reserved.serverId as string | undefined
    // The caller's `$orderBy` wins over newest-first; autoSort has validated
    // the key but left the value raw, and junction refuses a directive the
    // body never read (the jobs form sorts its app picker by name).
    const sort = $.directives?.orderBy
    // Every filter the caller sent, not a chosen few. autoFilter has already
    // refused a key that is not a column, so a key it admitted and this body
    // skipped answered every row as a match: `?name=` or `?status=` came back
    // as the whole workspace.
    const { rows, total } = await db().app.findManyAndCount({
      where: {
        ...parseWhere($.query),
        workspaceId: ws(),
        ...(serverId ? { appServers: { some: { serverId } } } : {}),
      },
      include: WITH_DETAIL,
      orderBy: sort ? normalizeOrderBy(sort as SortParam) : { createdAt: 'desc' },
      limit, offset,
    })
    // See `summarizeSource`: a list says what each app's source is, the
    // detail read says what it holds.
    return { total, limit, offset, data: rows.map((r: any) => ({ ...r, source: summarizeSource(r.source), sourceLabel: describeSource(r.source) })) }
  },

  async get() {
    return detail($.id as string)
  },

  async create() {
    const data = $.data as Record<string, unknown>
    checkSource(data)
    checkRuntime(data)
    await checkBackup(data)
    await assertEnvironmentInWorkspace(data.environmentId as string)
    const created = await db().app.create({ data })
    syncAppBackupSchedule($.app, created)
    syncAppDrillSchedule($.app, created)
    // Placed nowhere yet, so no machine has a list to change; `place` sends it.
    return db().app.findFirst({ where: { id: created.id }, include: WITH_DETAIL })
  },

  async patch() {
    const current = await getScoped('app', 'App')
    // environmentId and slug are @immutable and status is @system — the
    // schema refuses all three by name, so nothing here restates them.
    const patch = narrowPatch($.data as Record<string, unknown>)
    checkSource(patch, current as Record<string, unknown>)
    checkRuntime(patch, current as Record<string, unknown>)
    await checkBackup(patch, current.id as string)
    if (!changesNothing(patch)) {
      const updated = await db().app.update({ where: { id: $.id as string }, data: patch })
      syncAppBackupSchedule($.app, updated)
      syncAppDrillSchedule($.app, updated)
    }
    if ('replicaDestinationId' in patch) await syncReplicasOf($.app, [current.id])

    return db().app.findFirst({ where: { id: $.id as string }, include: WITH_DETAIL })
  },

  async remove() {
    const target  = await getScoped('app', 'App')
    const machine = await retireFromMachine($.app, target)
    const removed = await removeScoped('app', 'App')
    // A deleted app's volume is not a thing to archive at 02:00.
    syncAppBackupSchedule($.app, { id: target.id, backupCron: null, deletedAt: null })
    syncAppDrillSchedule($.app, { id: target.id, drillCron: null, deletedAt: null })
    if (target.replicaDestinationId) await syncReplicasOf($.app, [target.id])
    return { ...removed, machine }
  },

  async restore() {
    const row = await restoreScoped('app', 'App')
    syncAppBackupSchedule($.app, row)
    syncAppDrillSchedule($.app, row)
    if (row.replicaDestinationId) await syncReplicasOf($.app, [row.id])
    return detail(row.id)
  },


  // ── place / unplace — POST /apps/:id  X-Service-Method: place ─────
  //
  // Which machines an app runs on. Three jobs read `AppServer` and until
  // now nothing wrote one, so every app was placed nowhere and a deploy had
  // no machine to talk to — which is the state the deploy stub was hiding
  // (FJS-257).
  //
  // `AppServer` is `@@gate(2.8)`: readable by a member, writable only by a
  // system context. That is right — a placement is the app's topology, not a
  // row a caller edits — so the authority check is done here, against the
  // WORKSPACE, and the write goes through asSystem(). The second of the two
  // asSystem() calls in this file's realm; the other is the outpost heartbeat.

  // ─── logs ─────────────────────────────────────────────────────────────
  // What the container is saying, from a console rather than over ssh.
  //
  // The screen this feeds carried a comment saying its logs tab was absent
  // because *nothing stores or streams a log line* — true of the whole
  // fleet, not of that screen. `fli deploy:logs` answers the same question
  // for one app an operator is already sitting next to; this answers it for
  // a fleet somebody is looking after.
  //
  // A READ that leaves the process, so it goes through the executor like
  // every other machine call rather than reaching for a Conduit target by
  // hand — which is what keeps *who carries this out* a question with one
  // answer (`providers/executor.ts`).
  //
  // Scoped read first: `getScoped` proves the caller may see this app before
  // anything is asked of a machine on their behalf. Nothing is written, so
  // there is no audit event — the trail records writes, and a log read that
  // filed one would file one per poll.
  async logs() {
    const target = await getScoped('app', 'App')
    const data   = ($.data ?? {}) as Record<string, unknown>

    const executor = await resolveExecutor($.app, target.id)
    // Not a 500: an app that is placed nowhere has no logs to give and that
    // is a state the operator can act on, which is what `reason` says.
    if (!isExecutor(executor))
      return { running: false, reason: executor.reason, stdout: '', stderr: '', serverId: null }

    const reply = await executor.call('/logs', {
      app_id: target.id,
      tail:   data.tail,
      since:  data.since,
    }, { timeoutMs: 20_000 })

    // The machine's own words. A generic failure here is how an operator ends
    // up ssh'ing to the box the console exists to replace.
    if (reply.error) throw new BadRequest(`Could not read logs: ${reply.error.message}`)

    const out = (reply.data ?? {}) as Record<string, unknown>
    return {
      running:  out.running ?? false,
      serverId: executor.serverId,
      tail:     out.tail  ?? null,
      since:    out.since ?? null,
      stdout:   out.stdout ?? '',
      stderr:   out.stderr ?? '',
      ...(out.error ? { reason: out.error } : {}),
    }
  },

  // ── fromBlueprint — POST /apps  X-Service-Method: fromBlueprint ───
  //
  // The catalog entry is COPIED, column for column, into the app it becomes
  // — the names on `Blueprint` are `App`'s own where they overlap, which is
  // what makes this a copy rather than a translation — and `blueprintId`
  // records where it came from. Nothing is placed and nothing is released:
  // those are `place` and `deployments.create`, the same two steps an app
  // described by hand takes, so a blueprint app is not a second kind of app.
  async fromBlueprint() {
    const data = ($.data ?? {}) as Record<string, unknown>
    const { blueprintId, environmentId } = data as Record<string, string>
    const name = typeof data.name === 'string' ? data.name.trim() : ''

    const bp = await db().blueprint.findFirst({
      where:   { id: blueprintId },
      include: { params: { orderBy: [{ position: 'asc' }, { key: 'asc' }] } },
    })
    if (!bp) throw new NotFound(`Blueprint '${blueprintId}' not found`)
    if (bp.deprecatedAt) throw new BadRequest(`${bp.name} has been withdrawn from the catalog`)

    await assertEnvironmentInWorkspace(environmentId)
    const appName = name || bp.name
    const slug    = typeof data.slug === 'string' && data.slug ? data.slug : slugify(appName)
    checkRuntime(runtimeOf(bp))

    const values = (data.values ?? {}) as Record<string, unknown>
    if (typeof values !== 'object' || Array.isArray(values))
      throw new BadRequest('`values` must be an object of parameter → text')
    const params = paramValues(bp.params, values)

    // One transaction: an app whose variables did not land is an app whose
    // first release starts a container without its password.
    const created = await db().$transaction(async (tx: any) => {
      const row = await tx.app.create({
        data: {
          environmentId, name: appName, slug,
          type:   bp.appType,
          source: parseAppSource({ kind: 'image', image: bp.image }),
          ...runtimeOf(bp),
          blueprintId: bp.id,
        },
        system: ['blueprintId'],
      })
      for (const p of params)
        await tx.variable.create({
          data: { environmentId, appId: row.id, key: p.key, secret: p.secret,
                  ...(p.secret ? { secretValue: p.value } : { value: p.value }) },
        })
      return row
    })

    return detail(created.id)
  },

  async place() {
    const data     = $.data as Record<string, unknown>
    const serverId = data.serverId as string

    const target = await getScoped('app', 'App')
    await placeApp($.app, target, await placeableServer(serverId), data.replicaIndex as number | undefined)
    return detail(target.id)
  },

  async unplace() {
    const data     = $.data as Record<string, unknown>
    const serverId = data.serverId as string

    const target = await getScoped('app', 'App')

    // Scoped read first, system write second: the caller proves they may see
    // this app before anything is removed on their behalf.
    const rows = await db().appServer.findMany({
      where: {
        appId: target.id, serverId,
        ...(data.replicaIndex !== undefined ? { replicaIndex: data.replicaIndex as number } : {}),
      },
    })
    if (!rows.length) throw new NotFound('This app is not placed on that server')

    const sys = $.db.asSystem()
    for (const row of rows) await sys.appServer.delete({ where: { id: row.id } })
    if (target.replicaDestinationId) await syncReplicasOn($.app, [serverId])

    return detail(target.id)
  },

  // ── restoreVolume — POST /apps/:id  X-Service-Method: restoreVolume ──
  //
  // Adopting a running app: its SQLite files, tarred, copied onto the machine
  // by scp, extracted into `fjs-<app>-data` before the first release starts a
  // container on it (`FJS-D943`). Or one of the app's backups in a bucket:
  // the machine fetches it by a pre-signed GET minted here, and refuses an
  // object whose sha256 is not the one recorded when it was taken
  // (`FJS-D1521`). The SERVER is named because the volume is per machine, and
  // a replica elsewhere is handed nothing. Outpost refuses a path off its
  // restore directory, a volume a container holds, and one with files in it
  // unless `overwrite` is stated, each in its own words.
  async restoreVolume() {
    const data   = $.data as Record<string, unknown>
    const target = await getScoped('app', 'App')
    if ((data.path == null) === (data.backupId == null)) throw new BadRequest('Name a path on the server or a backupId, one of the two')
    const placed = await db().appServer.findFirst({ where: { appId: target.id, serverId: data.serverId as string }, include: { server: true } })
    if (!placed) throw new NotFound('This app is not placed on that server — place it there first')

    const from = data.path != null ? { path: data.path } : await backupSource(target.id, data.backupId as string)
    const executor = await executorOn($.app, placed.serverId, placed.server?.name)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)
    const reply = await executor.call('/volume/restore', {
      app_id: target.id, ...from, overwrite: data.overwrite === true,
    }, { timeoutMs: VOLUME_RESTORE_TIMEOUT_MS })
    if (reply.error) throw new BadRequest(`The volume was not restored: ${reply.error.message}`)
    return { serverId: placed.serverId, ...(reply.data ?? {}) }
  },

  // ── restoreReplica — POST /apps/:id  X-Service-Method: restoreReplica ──
  //
  // A stopped app brought back to an instant out of its own replica: every
  // database the bucket lists under the app's path, restored on the named
  // machine into `fjs-<app>-data`. The key goes in the body the way
  // `/replicate` already sends it to that machine. Only the `.db` files are
  // replaced — a replica carries nothing else — and Outpost refuses a held
  // volume, and a database already there unless `overwrite`.
  async restoreReplica() {
    const data   = $.data as Record<string, unknown>
    const target = await getScoped('app', 'App')
    const placed = await db().appServer.findFirst({ where: { appId: target.id, serverId: data.serverId as string }, include: { server: true } })
    if (!placed) throw new NotFound('This app is not placed on that server — place it there first')

    const replica = await replicaOf($.app, target).catch((err: Error) => { throw new BadRequest(err.message) })
    if (!replica) throw new BadRequest(`App '${target.name}' names no replica destination, so there is nothing to restore from`)
    const databases = await replicaDatabases($.app, replica.dest, replica.entry.path)
      .catch((err: Error) => { throw new BadRequest(`The replica could not be listed: ${err.message}`) })
    if (!databases.length) throw new BadRequest(`The replica at ${replica.dest.bucket}/${replica.entry.path} holds no database yet`)

    const executor = await executorOn($.app, placed.serverId, placed.server?.name)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)
    const { app_id, ...entry } = replica.entry
    const reply = await executor.call('/replica/restore', {
      app_id, replica: entry, databases,
      ...(data.at != null ? { at: new Date(data.at as string).toISOString() } : {}),
      overwrite: data.overwrite === true,
    }, { timeoutMs: VOLUME_RESTORE_TIMEOUT_MS })
    if (reply.error) throw new BadRequest(`The replica was not restored: ${reply.error.message}`)
    return { serverId: placed.serverId, ...(reply.data ?? {}) }
  },

  // ── publish — POST /apps/:id  X-Service-Method: publish ──────────
  //
  // A static build made somewhere else — a preview's Freeze, `fli
  // basecamp:deploy` on a laptop — sent to the App's machine, then released
  // by the digest it answers. The caller never holds the Outpost secret, and
  // the files never enter a row: a build runs to hundreds of files and
  // megabytes, and every row here is in the audit trail.
  async publish() {
    const data   = $.data as Record<string, unknown>
    const target = await getScoped('app', 'App')
    if (sourceKindOf(target.source) !== 'inline')
      throw new BadRequest(`App '${target.name}' is not inline — only an App served as files takes a build`)
    if (!Array.isArray(data.files) || !data.files.length)
      throw new BadRequest('files is the build: a list of { path, content } or { path, content_base64 }')

    const executor = await resolveExecutor($.app, target.id)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)
    const reply = await executor.call('/static/publish', { app_id: target.id, files: data.files }, { timeoutMs: STATIC_PUBLISH_TIMEOUT_MS })
    if (reply.error) throw new BadRequest(`The machine refused the build: ${reply.error.message}`)
    const digest = String((reply.data as { digest?: unknown })?.digest ?? '')
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('The machine wrote the build and reported no digest')

    return $.app.service('deployments').create({
      appId: target.id, builtImage: digest,
      ...Object.fromEntries(['trigger', 'commitSha', 'branch'].filter(k => data[k] != null).map(k => [k, data[k]])),
    })
  },

  // ── enablePush · disablePush — deploy on push (FJS-D884) ─────────
  //
  // Enabling mints BOTH credentials again, so it is also the rotation: the old
  // secret and token stop verifying the moment this returns. They are in this
  // answer and nowhere else — the row keeps the secret encrypted and the token
  // as a hash, and neither reads back.
  async enablePush() {
    const target = await getScoped('app', 'App')
    if (!isGit(target.source))
      throw new BadRequest(`App '${target.name}' is not built from a git repository — only a git source has a push to release`)
    const { secret, token, tokenHash } = mintPush()
    await $.db.asSystem().app.update({
      where: { id: target.id },
      data:  { deployOnPush: true, pushSecret: secret, pushTokenHash: tokenHash, pushActorId: actor() },
      system: ['deployOnPush', 'pushSecret', 'pushTokenHash', 'pushActorId'],
    })
    // The answer holds the credentials, so the announcement states the row
    // instead and the workspace's other tabs never see them.
    $.dispatch = await db().app.findFirst({ where: { id: target.id, workspaceId: ws() } })
    const base = `${env.FRONTIER_API_URL.replace(/\/$/, '')}/hooks/git/${target.id}`
    return { url: base, tokenUrl: `${base}/${token}`, secret, token }
  },

  async disablePush() {
    const target = await getScoped('app', 'App')
    await $.db.asSystem().app.update({
      where: { id: target.id },
      data:  { deployOnPush: false, pushSecret: null, pushTokenHash: null, pushActorId: null },
      system: ['deployOnPush', 'pushSecret', 'pushTokenHash', 'pushActorId'],
    })
    return detail(target.id)
  },

  // ── mintDeployKey · importDockerfile — FJS-D1555 ─────────────────
  async mintDeployKey() {
    const target = await getScoped('app', 'App')
    if (!isGit(target.source))
      throw new BadRequest(`App '${target.name}' is not built from a git repository, so it clones nothing`)
    const minted = await mintDeployKey($.app, target.id)
    return { deployPublicKey: minted.deployPublicKey ?? target.deployPublicKey ?? null, ...(minted.note ? { note: minted.note } : {}) }
  },

  // The App's machine reads its own clone, which is how a PRIVATE repository's
  // file is reached: Basecamp holds no key to it. Answers the file for the
  // editor and writes nothing; saving it is `patch` with `source.dockerfile`.
  async importDockerfile() {
    const target = await getScoped('app', 'App')
    if (!isGit(target.source))
      throw new BadRequest(`App '${target.name}' is not built from a git repository`)
    const executor = await resolveExecutor($.app, target.id)
    if (!isExecutor(executor)) return { path: null, content: null, note: executor.reason }
    // A machine that has never built this app holds no clone and refuses the
    // route by name; that reason is the note, not a 500.
    for (const path of DOCKERFILE_PATHS) {
      const reply = await executor.call('/source/file', { app_id: target.id, path })
      const content = reply.data?.content
      if (!reply.error && typeof content === 'string' && content.trim()) return { path, content }
    }
    return { path: null, content: null, note: 'The machine has no Dockerfile in its clone of this app, or cannot read one yet' }
  },

  async readRepoDockerfile() {
    const data = $.data as { repo: string, branch?: string }
    return (await readRepoDockerfile({ repo: data.repo, branch: data.branch })) ?? { path: null, content: null }
  },

  async dockerfileTemplate() {
    return { content: fjsDockerfileTemplate() }
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      create: [deriveSlug],
      // `fromBlueprint` is create's authority and writes `App` through the
      // caller's client. Topology, not content: the same authority that may patch the app.
    },
  },
})
