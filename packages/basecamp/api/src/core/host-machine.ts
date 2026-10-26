// src/core/host-machine.ts — the box this Basecamp runs on, as a fleet machine.
//
// Two callers make it one: the *Use this Basecamp server* button
// (`servers.useHost`, as the person) and `fli deploy` (`api/src/core/enroll-host.ts`,
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
import { mintEnrollToken, installCommand, ENROLL_WINDOW_MS, OUTPOST_PORT } from '../providers/compute/enrollment.ts'
import { env } from './env.ts'

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
 */
export async function useHost(client: any, { workspaceId, actor }: { workspaceId?: string; actor: string }) {
  const sys = client.asSystem()
  if (await hostServer(sys)) {
    const server = await findHost(client)
    if (!server) throw new Conflict('This Basecamp\'s box is a machine in another workspace; enroll it from there')
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
    role: 'general', region: 'self',
  } })
  await sys.hubConfig.update({ where: { id: HUB }, data: { hostServerId: server.id } })
  await client.serverEvent.create({ data: {
    serverId: server.id, kind: 'created', message: 'Server registered', metadata: { created_by: actor },
  } })
  return { server, enrolled: false as const, ...(await issueEnrollmentFor(client, server.id, actor)) }
}
