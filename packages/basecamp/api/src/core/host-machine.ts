// src/core/host-machine.ts — the box this Basecamp runs on, as a fleet machine.
//
// Two callers make it one: the *Use this Basecamp server* button
// (`servers.useHost`, as the person) and `fli deploy` (`api/src/core/enroll-host.ts`,
// run in the container over the operator's SSH, as the application —
// FJS-D1191). Both find the row by `HOST_SLUG` and both mint the token here, so
// a box enrolled from one is the same row the other finds, and the fleet never
// holds two rows for one machine.
//
// `client` is the caller's: scoped for the button, system for the script. The
// token's hash is always written as the application, because `@guarded`
// refuses a scoped write of it.

import { mintEnrollToken, installCommand, ENROLL_WINDOW_MS, OUTPOST_PORT } from '../providers/compute/enrollment.ts'
import { env } from './env.ts'

export const HOST_SLUG = 'basecamp-host'

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
    command:   installCommand({ serverId, basecampUrl: env.API_URL, token: enroll.token, outpostPort: OUTPOST_PORT }),
    token:     enroll.token,
    expiresAt: enroll.expiresAt.toISOString(),
    windowMs:  ENROLL_WINDOW_MS,
  }
}

/** The host row, or null. A system client must name the workspace. */
export async function findHost(client: any, workspaceId?: string) {
  return client.server.findFirst({ where: { slug: HOST_SLUG, ...(workspaceId ? { workspaceId } : {}) } })
}

/**
 * Find or make the host row, and enroll it unless it already checked in.
 *
 * A row that has heartbeated is answered `enrolled` and NOT re-issued: its
 * Outpost holds a secret of its own, and a fresh token beside it is a live
 * credential for a machine that needs none.
 */
export async function useHost(client: any, { workspaceId, actor }: { workspaceId?: string; actor: string }) {
  let server = await findHost(client, workspaceId)
  if (server?.lastHeartbeatAt) return { server, enrolled: true as const }

  if (!server) {
    server = await client.server.create({ data: {
      ...(workspaceId ? { workspaceId } : {}),
      name: 'Basecamp host', slug: HOST_SLUG, role: 'general', region: 'self',
    } })
    await client.serverEvent.create({ data: {
      serverId: server.id, kind: 'created', message: 'Server registered', metadata: { created_by: actor },
    } })
  }

  return { server, enrolled: false as const, ...(await issueEnrollmentFor(client, server.id, actor)) }
}
