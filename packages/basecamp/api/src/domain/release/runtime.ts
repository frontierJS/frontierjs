// src/domain/release/runtime.ts
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
 * internet. A Domain that redirects is not a host the app answers: it is in
 * `routedRedirects`. A name sent here is a certificate Caddy asks Let's Encrypt
 * for, so a deleted row must drop out — `@@softDelete` is what takes it out of
 * this read.
 */
export async function routedHosts(db: any, appId: string): Promise<string[]> {
  const rows = await db.asSystem().domain.findMany({
    where: { appId, redirectTo: null }, orderBy: { hostname: 'asc' },
  })
  return rows.map((d: { hostname: string }) => d.hostname)
}

/**
 * The app's redirecting Domains, sent beside `hosts` on every route push so
 * Caddy answers them itself (`FJS-1615`). `redirectTo` is typed by a person, so
 * a bare hostname is read as `https://` — Outpost refuses anything that is not
 * an absolute http(s) URL, and the release would fail on a form that looked fine.
 */
export async function routedRedirects(db: any, appId: string): Promise<{ host: string, to: string }[]> {
  const rows = await db.asSystem().domain.findMany({
    where: { appId, redirectTo: { not: null } }, orderBy: { hostname: 'asc' },
  })
  return rows
    .filter((d: { redirectTo: string }) => d.redirectTo.trim())
    .map((d: { hostname: string, redirectTo: string }) => {
      const to = d.redirectTo.trim()
      return { host: d.hostname, to: /^[a-z][a-z0-9+.-]*:\/\//i.test(to) ? to : `https://${to}` }
    })
}

/**
 * The prefixes of other Domains this app answers (`FJS-D1040`), sent beside
 * `hosts` on every route push: `/api` of `shop.example.com` goes to the App
 * holding the route while the Domain's own App keeps the rest. Redirecting
 * Domains are left out, since a redirect answers the whole host. The Domain
 * must be live — `@@softDelete` takes a deleted one out of this read.
 */
export async function routedPaths(db: any, appId: string): Promise<{ host: string, prefix: string }[]> {
  const sys   = db.asSystem()
  const rows  = await sys.domainRoute.findMany({ where: { appId } }) as { domainId: string, pathPrefix: string }[]
  if (!rows.length) return []
  const hosts = await sys.domain.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.domainId))] }, redirectTo: null },
  }) as { id: string, hostname: string }[]
  const byId  = new Map(hosts.map(d => [d.id, d.hostname]))
  return rows
    .filter(r => byId.has(r.domainId))
    .map(r => ({ host: byId.get(r.domainId)!, prefix: r.pathPrefix }))
    .sort((a, b) => (a.host + a.prefix).localeCompare(b.host + b.prefix))
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
