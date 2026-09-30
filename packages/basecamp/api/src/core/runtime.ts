// src/core/runtime.ts
// How the machine starts an app's container — the one reader of `App`'s
// runtime columns, and so the one place a column becomes a `docker run` flag.
//
// A column listed here and not applied by outpost is the failure this replaced
// (`FJS-1605`): a blueprint's limits were copied into `App.config` and started
// nothing. `api/test/services.test.ts` and outpost's own suite hold each name to
// a flag.

/** The columns, in `App`'s and `Blueprint`'s shared spelling. */
export const RUNTIME_COLUMNS = ['port', 'containerPort', 'volumePath', 'healthCheck', 'cpuLimit', 'memLimitMb'] as const

export type Runtime = Partial<Record<(typeof RUNTIME_COLUMNS)[number], string | number>>

/**
 * The settings a row states, nulls left out. Read off an `App` when a release
 * is made, and off a `Blueprint` when an app is made from one — the names are
 * the same on both, which is what makes that a copy.
 */
export function runtimeOf(row: Record<string, unknown>): Runtime {
  const out: Runtime = {}
  for (const key of RUNTIME_COLUMNS) {
    const value = row[key]
    if (value != null) out[key] = value as string | number
  }
  return out
}

/**
 * The hostnames Caddy on the machine fronts an app by (`FJS-D564`), sent on
 * every `/deploy`. The live `Domain` rows and never a release's snapshot: a
 * rollback puts back old bytes and old config, not an old set of names on the
 * internet. A Domain that redirects is not routed yet, so it is not sent. A
 * name sent here is a certificate Caddy asks Let's Encrypt for, so a deleted
 * row must drop out — `@@softDelete` is what takes it out of this read.
 */
export async function routedHosts(db: any, appId: string): Promise<string[]> {
  const rows = await db.asSystem().domain.findMany({
    where: { appId, redirectTo: null }, orderBy: { hostname: 'asc' },
  })
  return rows.map((d: { hostname: string }) => d.hostname)
}

/**
 * The addresses an app's INGRESS RECORD holds (`FJS-D561`): each server this
 * app has a `running` placement on that is `online` — the executor's rule for
 * a machine that can take work, so a draining or unreachable machine drops out
 * of the record the way it drops out of the next release. `running` is written
 * by the deploy job on the machine the release landed on; a placement nothing
 * has deployed to yet is `unknown`, and naming its machine would send traffic
 * to a Caddy with no route. Sorted and unique, because two replicas on one
 * machine are one address and the drift read compares this as a set.
 */
export async function servingAddresses(db: any, appId: string): Promise<string[]> {
  const rows = await db.asSystem().appServer.findMany({
    where: { appId, status: 'running' }, include: { server: true },
  })
  const ips = rows
    .filter((p: any) => p.server?.status === 'online' && p.server.ipAddress)
    .map((p: any) => String(p.server.ipAddress))
  return [...new Set<string>(ips)].sort()
}

/** Mark the placements a release landed on as `running`. Every replica row on
 *  that machine, since `/deploy` starts the app's one container there. */
export async function markRunning(db: any, appId: string, serverId: string): Promise<void> {
  await db.asSystem().appServer.updateMany({
    where: { appId, serverId },
    data:  { status: 'running', startedAt: new Date().toISOString(), stoppedAt: null },
  })
}
