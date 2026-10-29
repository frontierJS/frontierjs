// src/domain/host/host-machine.ts — the box this Basecamp runs on, as a fleet machine.
//
// Two callers make it one: the *Use this Basecamp server* button
// (`servers.useHost`, as the person) and `fli deploy` (`api/src/domain/host/enroll-host.ts`,
// run in the container over the operator's SSH, as the application —
// FJS-D1191). Both find the row through `HubConfig.hostServerId` and both mint
// the token here, so a box enrolled from one is the same row the other finds,
// and the fleet never holds two rows for one machine. Not by `HOST_SLUG`: a
// slug is unique per workspace and any administrator may name a server
// `basecamp-host`, which made a tenant's box the one /hub/security/ graded
// (`FJS-3488`).
//
// `client` is the caller's: scoped for the button, system for the script. The
// token's hash and the hub's pointer are always written as the application —
// `@guarded` refuses a scoped write of one and `@system` the other.

import { randomUUID }         from 'node:crypto'
import { Conflict, NotFound } from '@frontierjs/junction'
import { mintEnrollToken, installCommand, outpostUnpublished, ENROLL_WINDOW_MS, OUTPOST_PORT } from '../../providers/compute/enrollment.ts'
import { env } from '../../core/env.ts'
import { encryptionKeyFingerprint } from '../../core/db.ts'
import { mailProvider } from '../../core/mailer.ts'
import { gradeHub } from './posture.ts'
import type { HostDeclared } from './posture.ts'

export const HOST_SLUG = 'basecamp-host'
const HUB = 'hub'

export interface Issued { command: string; token: string; expiresAt: string; windowMs: number }

/**
 * A single-use enrollment for `serverId`, and the one command that spends it.
 *
 * Running it again replaces the token, and the old one stops working the
 * moment the hash is overwritten — which is also the revoke.
 */
export async function issueEnrollmentFor(client: any, serverId: string, actor: string): Promise<Issued> {
  const unpublished = await outpostUnpublished()
  if (unpublished) throw new Conflict(unpublished)
  const enroll = mintEnrollToken()
  await client.asSystem().server.update({
    where: { id: serverId },
    data:  { enrollTokenHash: enroll.hash, enrollExpiresAt: enroll.expiresAt },
  })
  await client.serverEvent.create({ data: {
    serverId, kind: 'enrollment_issued',
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

/** The row the hub points at, or null. `sys` is a system client. */
export async function hostServer(sys: any) {
  const hub = await sys.hubConfig.findFirst({ where: { id: HUB }, select: { hostServerId: true } })
  return hub?.hostServerId ? sys.server.findFirst({ where: { id: hub.hostServerId } }) : null
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
 */
export async function useHost(client: any, { workspaceId, actor, ipAddress }: { workspaceId?: string; actor: string; ipAddress?: string }) {
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
  // The slug is a name and no longer the identity, so one a tenant already
  // took is stepped around rather than adopted.
  const taken  = await client.server.exists({ where: { slug: HOST_SLUG, ...(workspaceId ? { workspaceId } : {}) } })
  const server = await client.server.create({ data: {
    ...(workspaceId ? { workspaceId } : {}),
    name: 'Basecamp host', slug: taken ? `${HOST_SLUG}-${randomUUID().slice(0, 6)}` : HOST_SLUG,
    role: 'general', region: 'self', ...(ipAddress ? { ipAddress } : {}),
  } })
  await sys.hubConfig.update({ where: { id: HUB }, data: { hostServerId: server.id } })
  await client.serverEvent.create({ data: {
    serverId: server.id, kind: 'created', message: 'Server registered', metadata: { created_by: actor },
  } })
  return { server, enrolled: false as const, ...(await issueEnrollmentFor(client, server.id, actor)) }
}

// ─── the hub's own grade ──────────────────────────────────────────────────

/** `finishedAt` of the newest backup that succeeded — what `hub.backup-recent` grades. */
async function lastBackupAt(sys: any): Promise<string | null> {
  const row = await sys.backup.findFirst({
    where: { status: 'success', finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' },
  })
  return row?.finishedAt ?? null
}

/** What the `hub.*` controls grade in process: the newest archive, the key's escrow and the env. */
async function hostDeclared(sys: any): Promise<HostDeclared> {
  const config = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
  return {
    lastBackupAt:   await lastBackupAt(sys),
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
    },
  }
}

/**
 * The `hub.*` controls graded now, with the host row and its newest report
 * they were graded from. One reading for `/hub/security/` and the daily
 * `hub-posture` job, so the screen and the mail cannot disagree.
 */
export async function gradeHubNow(sys: any, now = Date.now()) {
  const server = await hostServer(sys)
  const row    = server
    ? await sys.serverPosture.findFirst({ where: { serverId: server.id }, orderBy: { at: 'desc' } })
    : null
  const hub = gradeHub(row?.readings ?? null, await hostDeclared(sys), { at: row?.at ?? now, now })
  return { server, row, hub }
}
