// src/domain/host/host-machine.ts — the box this Basecamp runs on, as a fleet machine.
//
// Two callers make it one: the *Use this Basecamp server* button
// (`servers.useHost`, as the person) and `fli deploy` (`api/src/domain/host/enroll-host.ts`,
// run in the container over the operator's SSH, as the application —
// FJS-D1191). Both find the row through the hub App (`HubConfig.appId`,
// `FJS-D1603`) and the server it is placed on, and both mint the token here, so
// a box enrolled from one is the same row the other finds, and the fleet never
// holds two rows for one machine. Not by `HOST_SLUG`: a slug is unique per
// workspace and any administrator may name a server `basecamp-host`, which made
// a tenant's box the one /hub/security/ graded (`FJS-3488`).
//
// `client` is the caller's: scoped for the button, system for the script. The
// token's hash and the hub's rows are always written as the application —
// `@guarded` refuses a scoped write of one and `@system` the pointer.

import { randomUUID }         from 'node:crypto'
import { BadRequest, Conflict, NotFound } from '@frontierjs/junction'
import { mintEnrollToken, installCommand, outpostUnpublished, ENROLL_WINDOW_MS, OUTPOST_PORT } from '../../providers/compute/enrollment.ts'
import { env } from '../../core/env.ts'
import { cronMatches, parseCron } from '@frontierjs/toolbelt/cron'
import { encryptionKeyFingerprint } from '../../core/db.ts'
import { mailProvider } from '../../core/mailer.ts'
import { databaseDisk } from './db-disk.ts'
import { gradeHub } from './posture.ts'
import type { HostDeclared } from './posture.ts'

export const HOST_SLUG = 'basecamp-host'
const HUB_SLUG = 'basecamp'
const HUB = 'hub'

export interface Issued { command: string; token: string; expiresAt: string; windowMs: number }

/**
 * A single-use enrollment for `serverId`, and the one command that spends it.
 *
 * Running it again replaces the token, and the old one stops working the
 * moment the hash is overwritten — which is also the revoke.
 */
/**
 * The hub signs what it tells a machine with a key derived from
 * `ENCRYPTION_KEY`, so a machine enrolled while that is the all-zeros
 * placeholder trusts a key anyone can compute. Refused in every environment,
 * at the boundary where the key gets pinned; `core/db.ts` refuses only a
 * production boot (`FJS-D1798`).
 */
export function refusePlaceholderKey(): void {
  if (encryptionKeyFingerprint() === null) throw new Conflict(
    'ENCRYPTION_KEY is the development placeholder, which is public — a machine enrolled now would trust a key anyone can compute. ' +
    'Set a real one (openssl rand -hex 32) in the hub\'s environment and restart before enrolling a machine.')
}

export async function issueEnrollmentFor(client: any, serverId: string, actor: string): Promise<Issued> {
  refusePlaceholderKey()
  const unpublished = await outpostUnpublished()
  if (unpublished) throw new Conflict(unpublished)
  const enroll = mintEnrollToken()
  await client.asSystem().server.update({
    where: { id: serverId },
    data:  { enrollTokenHash: enroll.hash, enrollExpiresAt: enroll.expiresAt },
  })
  await client.serverEvent.create({ data: {
    serverId, kind: 'enrollmentIssued',
    message:  'An enrollment token was issued for this machine',
    metadata: { issued_by: actor, expires_at: enroll.expiresAt.toISOString() },
  } })

  // The token rides BESIDE the command: an installer that scraped it back out
  // of a shell string would be re-deriving the input from the output.
  return {
    command:   installCommand({ serverId, basecampUrl: env.FRONTIER_API_URL, token: enroll.token, outpostPort: OUTPOST_PORT }),
    token:     enroll.token,
    expiresAt: enroll.expiresAt.toISOString(),
    windowMs:  ENROLL_WINDOW_MS,
  }
}

const IPV4    = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const PRIVATE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

/**
 * `ip` when it is a public IPv4 address, else undefined. A private one is a
 * tunnel or a LAN, which no ingress record can send the public to.
 */
export function publicIp(ip: unknown): string | undefined {
  if (typeof ip !== 'string') return undefined
  const m = IPV4.exec(ip)
  if (!m || m.slice(1).some(o => Number(o) > 255)) return undefined
  return PRIVATE.test(ip) ? undefined : ip
}

/** The App row that is this Basecamp, or null before `useHost` made it. `sys` is a system client. */
export async function hubApp(sys: any) {
  const hub = await sys.hubConfig.findFirst({ where: { id: HUB }, select: { appId: true } })
  return hub?.appId ? sys.app.findFirst({ where: { id: hub.appId } }) : null
}

/** The server the hub App is placed on, or null. `sys` is a system client. */
export async function hostServer(sys: any) {
  const hub = await sys.hubConfig.findFirst({ where: { id: HUB }, select: { appId: true } })
  if (!hub?.appId) return null
  const placed = await sys.appServer.findFirst({ where: { appId: hub.appId }, orderBy: { replicaIndex: 'asc' } })
  return placed ? sys.server.findFirst({ where: { id: placed.serverId } }) : null
}

/** The hub App as /hub/settings/ and /hub/backups/ show it: the row, its
 *  schedule, destinations and found replica, and the box it is placed on. */
export async function hubSummary(sys: any) {
  const app = await hubApp(sys)
  if (!app) return null
  const server = await hostServer(sys)
  return {
    id: app.id, name: app.name, port: app.port ?? null,
    backupCron: app.backupCron ?? null, backupDestinationId: app.backupDestinationId ?? null,
    replicaDestinationId: app.replicaDestinationId ?? null,
    replicaFoundAt: app.replicaFoundAt ?? null, replicaSyncedAt: app.replicaSyncedAt ?? null,
    server: server ? { id: server.id, name: server.name, ipAddress: server.ipAddress ?? null, status: server.status } : null,
  }
}

/**
 * The ids the lists leave out: the hub App and the Project and Environment
 * made to hold it (`FJS-D1628`). Empty before `useHost` made them.
 */
export async function hubIds(sys: any): Promise<{ app?: string; environment?: string; project?: string }> {
  const app = await hubApp(sys)
  if (!app) return {}
  const environment = await sys.environment.findFirst({ where: { id: app.environmentId }, select: { projectId: true } })
  return { app: app.id, environment: app.environmentId, project: environment?.projectId }
}

/** A where clause a list spreads to leave the hub's own `model` row out (`FJS-D1603`, `FJS-D1628`). */
export async function notHub(sys: any, model: 'app' | 'environment' | 'project'): Promise<Record<string, unknown>> {
  const id = (await hubIds(sys))[model]
  return id ? { NOT: { id } } : {}
}

/**
 * Refuse a Release of the hub App, by name: no column of that row starts the
 * hub (`FJS-D1603`), so a release of it would run a second Basecamp beside the
 * one answering, on a box whose deploy is `fli deploy`'s.
 */
export async function refuseHubRelease(sys: any, appId: string) {
  if (await isHubApp(sys, appId))
    throw new Conflict('This App is Basecamp itself, which is released by fli deploy, not from here')
}

/** Refuse an app-volume backup of the hub App: its volume holds none of its
 *  databases, and its archive is `backup:run`'s (`FJS-D1606`). */
export async function refuseHubVolume(sys: any, appId: string) {
  if (await isHubApp(sys, appId))
    throw new Conflict('This App is Basecamp itself — take its backup on /hub/backups/')
}

/** Whether `appId` is the hub App. `sys` is a system client. */
export async function isHubApp(sys: any, appId: string): Promise<boolean> {
  const hub = await sys.hubConfig.findFirst({ where: { id: HUB }, select: { appId: true } })
  return !!hub?.appId && hub.appId === appId
}

/** The hub App's id, or a refusal naming why there is none yet: its archives
 *  and schedule are that row's (`FJS-D1606`), so before `useHost` made it
 *  there is nothing to hang one on. `sys` is a system client. */
export async function requireHubAppId(sys: any): Promise<string> {
  const hub = await sys.hubConfig.findFirst({ where: { id: HUB }, select: { appId: true } })
  if (!hub?.appId) throw new BadRequest(
    'This Basecamp has no App row yet — press Use this Basecamp server on /servers/ (or run fli deploy) first')
  return hub.appId
}

/**
 * Place the hub App on `server`, making it — with its own `basecamp` Project
 * and protected `production` Environment in the server's workspace — the
 * first time (`FJS-D1628`). Nothing in the row starts the hub; a Release on it
 * is refused (`FJS-D1603`), so it is a record of what runs, graded by
 * `hub.app-row-drift`.
 */
export async function placeHub(sys: any, server: { id: string; workspaceId: string }) {
  let app = await hubApp(sys)
  if (app && app.workspaceId !== server.workspaceId)
    throw new Conflict('This Basecamp is an App in another workspace; enroll its box from there')

  if (!app) {
    const { workspaceId } = server
    const taken   = await sys.project.exists({ where: { workspaceId, slug: HUB_SLUG } })
    const project = await sys.project.create({ data: {
      workspaceId, name: 'Basecamp', slug: taken ? `${HUB_SLUG}-${randomUUID().slice(0, 6)}` : HUB_SLUG,
      description: 'This Basecamp itself',
    } })
    const environment = await sys.environment.create({ data: {
      workspaceId, projectId: project.id, name: 'Production', slug: 'production', tier: 'production', isProtected: true,
    } })
    app = await sys.app.create({ data: {
      workspaceId, environmentId: environment.id, name: 'Basecamp', slug: HUB_SLUG,
    } })
    await sys.hubConfig.update({ where: { id: HUB }, data: { appId: app.id } })
  }

  if (!await sys.appServer.exists({ where: { appId: app.id, serverId: server.id } }))
    await sys.appServer.create({ data: { appId: app.id, serverId: server.id } })
  return app
}

/** The host row if `client` can see it, or null. */
export async function findHost(client: any) {
  const host = await hostServer(client.asSystem())
  return host ? client.server.findFirst({ where: { id: host.id } }) : null
}

/**
 * Find or make the host row, and enroll it unless it already checked in.
 *
 * A row that has heartbeated is answered `enrolled` and NOT re-issued: its
 * Outpost holds a secret of its own, and a fresh token beside it is a live
 * credential for a machine that needs none.
 *
 * `ipAddress` is where the caller reached the box, and only `fli deploy` knows
 * it. A self box has no vendor to report one, and a row with none is a machine
 * no ingress record can name, so a Domain on an App it serves is never pushed
 * (`FJS-3515`). It fills an empty address and never replaces one.
 *
 * `name` is what the operator calls the box — the ssh alias `fli` dialed — and
 * names a new row only; a row already made keeps whatever it was renamed to.
 */
export async function useHost(client: any, { workspaceId, actor, ipAddress, name }: { workspaceId?: string; actor: string; ipAddress?: string; name?: string }) {
  const sys = client.asSystem()
  if (await hostServer(sys)) {
    let server = await findHost(client)
    if (!server) throw new Conflict('This Basecamp\'s box is a machine in another workspace; enroll it from there')
    if (ipAddress && !server.ipAddress)
      server = await client.server.update({ where: { id: server.id }, data: { ipAddress } })
    if (server.lastHeartbeatAt) return { server, enrolled: true as const }
    return { server, enrolled: false as const, ...(await issueEnrollmentFor(client, server.id, actor)) }
  }

  if (!await sys.hubConfig.exists({ where: { id: HUB } }))
    throw new NotFound('This installation has no hub settings, which /setup writes; save them on /hub/settings/ first')
  // Asked before the server row is made, or a refusal leaves a box behind.
  const hub = await hubApp(sys)
  if (hub && !await client.app.exists({ where: { id: hub.id, ...(workspaceId ? { workspaceId } : {}) } }))
    throw new Conflict('This Basecamp is an App in another workspace; enroll its box from there')
  // The slug is a name and no longer the identity, so one a tenant already
  // took is stepped around rather than adopted.
  const taken  = await client.server.exists({ where: { slug: HOST_SLUG, ...(workspaceId ? { workspaceId } : {}) } })
  const server = await client.server.create({ data: {
    ...(workspaceId ? { workspaceId } : {}),
    name: name || 'Basecamp host', slug: taken ? `${HOST_SLUG}-${randomUUID().slice(0, 6)}` : HOST_SLUG,
    role: 'general', region: 'self', ...(ipAddress ? { ipAddress } : {}),
  } })
  await placeHub(sys, server)
  await client.serverEvent.create({ data: {
    serverId: server.id, kind: 'created', message: 'Server registered', metadata: { created_by: actor },
  } })
  return { server, enrolled: false as const, ...(await issueEnrollmentFor(client, server.id, actor)) }
}

// ─── the hub's own grade ──────────────────────────────────────────────────

/** `finishedAt` of the hub App's newest backup that succeeded (`FJS-D1606`) — what `hub.backup-recent` grades.
 *  `error: null` is the filter: a `success` row with an `error` is an archive that
 *  was meant to leave the box and stayed on its disk (`backup-run.job.ts`), and a
 *  backup that never reached its destination is not the one this grades. A
 *  local-only backup finishes with `error: null`, so it still counts. */
export async function lastBackupAt(sys: any, appId: string | null): Promise<string | null> {
  if (!appId) return null
  const row = await sys.appBackup.findFirst({
    where: { appId, status: 'success', error: null, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' },
  })
  return row?.finishedAt ?? null
}

/** What `hub.app-row-drift` reads of the row the hub points at. */
async function hubAppDeclared(sys: any, appId: string | null): Promise<HostDeclared['hubApp']> {
  if (!appId) return null
  const app = await sys.app.findFirst({ where: { id: appId }, select: { port: true, containerPort: true } })
  if (!app) return 'gone'
  return { placed: await sys.appServer.exists({ where: { appId } }), port: app.port ?? null, containerPort: app.containerPort ?? null }
}

/** The lock on the bucket the hub's archives go to, as its last `test` read it. */
async function bucketLockDeclared(sys: any, appId: string | null): Promise<HostDeclared['bucketLock']> {
  const app  = appId && await sys.app.findFirst({ where: { id: appId }, select: { backupDestinationId: true } })
  const dest = app?.backupDestinationId && await sys.backupDestination.findFirst({ where: { id: app.backupDestinationId } })
  if (!dest) return null
  return { name: dest.name, tested: !!dest.lastTestAt, lockDays: dest.lockDays ?? null, attestedAt: dest.lockAttestedAt ?? null }
}

/** The days between two fires of a cron line, measured on a UTC walk; 1 where it cannot be read. */
export function cronGapDays(expr: string): number {
  try {
    const fields = parseCron(expr)
    const start  = Date.UTC(2026, 0, 1)
    let first: number | null = null
    for (let m = 0; m < 70 * 1440; m++) {
      const d = new Date(start + m * 60_000)
      if (!cronMatches(fields, { minutes: d.getUTCMinutes(), hours: d.getUTCHours(), date: d.getUTCDate(), month: d.getUTCMonth() + 1, day: d.getUTCDay() })) continue
      if (first === null) first = m
      else return Math.max(1, Math.ceil((m - first) / 1440))
    }
  } catch { /* an unreadable line grades on the daily floor */ }
  return 1
}

/** Every other app with a backup or drill schedule, and when its newest good run finished (`app.backup-recent`).
 *  Good is the hub's own test: `success` with no `error`. A run is owed twice per interval before it is called missed, floor two days. */
async function scheduledApps(sys: any, hubAppId: string | null): Promise<HostDeclared['scheduledApps']> {
  const apps = await sys.app.findMany({
    where: { deletedAt: null, ...(hubAppId ? { id: { not: hubAppId } } : {}), OR: [{ backupCron: { not: null } }, { drillCron: { not: null } }] },
    select: { id: true, name: true, backupCron: true, drillCron: true }, limit: 5_000,
  })
  const out: HostDeclared['scheduledApps'] = []
  for (const a of apps) {
    if (a.backupCron) out.push({ name: a.name, what: 'backup', maxAgeDays: Math.max(2, 2 * cronGapDays(a.backupCron)), lastOkAt: await lastBackupAt(sys, a.id) })
    if (a.drillCron) {
      const drill = await sys.appDrill.findFirst({ where: { appId: a.id, status: 'success', finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' } })
      out.push({ name: a.name, what: 'drill', maxAgeDays: Math.max(2, 2 * cronGapDays(a.drillCron)), lastOkAt: drill?.finishedAt ?? null })
    }
  }
  return out
}

/** What the `hub.*` controls grade in process: the newest archive, the key's escrow and the env. */
async function hostDeclared(sys: any, push: HostDeclared['install']['push'], dbPath: string): Promise<HostDeclared> {
  const config = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
  return {
    hubApp:         await hubAppDeclared(sys, config?.appId ?? null),
    bucketLock:     await bucketLockDeclared(sys, config?.appId ?? null),
    lastBackupAt:   await lastBackupAt(sys, config?.appId ?? null),
    scheduledApps:  await scheduledApps(sys, config?.appId ?? null),
    dbDisk:         databaseDisk(dbPath),
    keyFingerprint: encryptionKeyFingerprint(),
    keyEscrow:      config?.encryptionKeyEscrowedAt && config.encryptionKeyFingerprint
      ? { at: config.encryptionKeyEscrowedAt, fingerprint: config.encryptionKeyFingerprint }
      : null,
    install: {
      production: env.NODE_ENV === 'production',
      appUrl:     env.FRONTIER_APP_URL,
      apiUrl:     env.FRONTIER_API_URL,
      mailer:     mailProvider()?.address ?? null,
      mailFrom:   env.MAIL_FROM,
      push,
    },
  }
}

/**
 * The `hub.*` controls graded now, with the host row and its newest report
 * they were graded from. One reading for `/hub/security/` and the daily
 * `hub-posture` job, so the screen and the mail cannot disagree.
 */
export async function gradeHubNow(sys: any, push: HostDeclared['install']['push'], dbPath: string, now = Date.now()) {
  const server = await hostServer(sys)
  const row    = server
    ? await sys.serverPosture.findFirst({ where: { serverId: server.id }, orderBy: { at: 'desc' } })
    : null
  const hub = gradeHub(row?.readings ?? null, await hostDeclared(sys, push, dbPath), { at: row?.at ?? now, now })
  return { server, row, hub }
}
