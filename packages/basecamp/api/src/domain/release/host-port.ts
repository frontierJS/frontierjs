// src/domain/release/host-port.ts
// Which host ports a machine's Apps already publish — the one reader of that
// question, asked before an App takes a port and by the CLI's preflight.
//
// Two Apps placed on one Server with one `port` both pass every row check, and
// the second release fails at `docker run` with *port is already allocated*
// (`FJS-3563`). Every scaffolded API listens on 8100, so it is the first port
// two Apps reach for. `containerPort` is the app's own and may repeat freely;
// only the host side is the machine's.

import { Conflict } from '@frontierjs/junction'
import { db } from '../../core/resource.ts'

export type PortHolder = { port: number, appId: string, appName: string, serverId: string, serverName: string }

/** The host ports other Apps publish on any of `serverIds`. A soft-deleted
 *  App was retired from its machines, so its port is free again. */
export async function portHolders(serverIds: string[], exceptAppId?: string): Promise<PortHolder[]> {
  if (!serverIds.length) return []
  const rows = await db().appServer.findMany({
    where:   { serverId: { in: serverIds } },
    include: { app: true, server: true },
  })
  return rows
    .filter((r: any) => r.app && !r.app.deletedAt && r.app.id !== exceptAppId && r.app.port != null)
    .map((r: any) => ({ port: r.app.port, appId: r.app.id, appName: r.app.name, serverId: r.serverId, serverName: r.server?.name ?? r.serverId }))
}

/** The Servers an App is placed on. */
export async function serversOf(appId: string): Promise<string[]> {
  const rows = await db().appServer.findMany({ where: { appId }, select: { serverId: true } })
  return [...new Set<string>(rows.map((r: any) => r.serverId))]
}

/** Refuse a host port another App on one of these Servers already publishes,
 *  naming that App — the refusal docker would give after the old container
 *  had already stopped. */
export async function assertPortFree(port: number | null | undefined, serverIds: string[], exceptAppId?: string): Promise<void> {
  if (port == null) return
  const holder = (await portHolders(serverIds, exceptAppId)).find(h => h.port === port)
  if (holder)
    throw new Conflict(
      `Port ${port} on '${holder.serverName}' is published by App '${holder.appName}' (${holder.appId}) — pick another host port; the container port can stay`)
}
