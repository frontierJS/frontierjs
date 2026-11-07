// src/domain/release/runtime.ts
// How the machine starts an app's container — the one reader of `App`'s
// runtime columns, and so the one place a column becomes a `docker run` flag.
//
// A column listed here and not applied by outpost is the failure this replaced
// (`FJS-1605`): a blueprint's limits were copied into `App.config` and started
// nothing. `api/test/services.test.ts` and outpost's own suite hold each name to
// a flag.

/** The App kinds a release starts as a container, so each needs an image to
 *  run and a host port to be reached on — the one list, read by the release's
 *  refusal and by `placeApp`'s allocation (`FJS-D1557`). A `static`, `worker`,
 *  `daemon` or `cron` App publishes nothing. */
export const CONTAINER_KINDS: ReadonlySet<string> = new Set(['container', 'function', 'database'])

/** The columns, in `App`'s and `Blueprint`'s shared spelling (`containerPort` is `App`'s alone).
 *  The declared residual of `restated-fields` (`FJS-D1438`): `db/test/schema.test.ts`
 *  'App runtime columns' fails on a name that is no column and on an App column neither here nor
 *  named exempt there. */
export const RUNTIME_COLUMNS = ['port', 'containerPort', 'volumePath', 'healthCheck', 'cpuLimit', 'memLimitMb', 'stopGraceSeconds', 'healthTimeoutSeconds', 'command'] as const

/** The two columns that carry their unit in the name. The release runtime is what Outpost reads and
 *  keeps its own spelling, so the column maps onto it here and nowhere else. */
const WIRE_KEY = { stopGraceSeconds: 'stopGrace', healthTimeoutSeconds: 'healthTimeout' } as const

type Column = (typeof RUNTIME_COLUMNS)[number]
type Wire<C> = C extends keyof typeof WIRE_KEY ? (typeof WIRE_KEY)[C] : C

export type Runtime = Partial<Record<Wire<Column>, string | number | string[]>>

/**
 * The settings a row states, nulls and an empty `command` left out, under the release runtime's
 * keys. Read off an `App` when a release is made, and off a `Blueprint` when an app is made from
 * one — the names are the same on both, which is what makes that a copy.
 */
export function runtimeOf(row: Record<string, unknown>): Runtime {
  const out: Record<string, string | number | string[]> = {}
  for (const key of RUNTIME_COLUMNS) {
    const value = row[key]
    if (value != null && !(Array.isArray(value) && !value.length))
      out[(WIRE_KEY as Record<string, string>)[key] ?? key] = value as string | number | string[]
  }
  return out as Runtime
}

/** How the release's container starts — the snapshot's, falling back to the
 *  app's columns only for a release that recorded none. */
export function runtimeFor(snapshot: Record<string, unknown>, service: Record<string, unknown>): Runtime {
  const runtime = (snapshot.runtime as Runtime | undefined) ?? runtimeOf(service)
  // A snapshot taken before the App's first build holds no container port;
  // the build adopted the Dockerfile's onto the App (`adoptContainerPort`),
  // and a rollback to that release, which builds nothing, reads it there
  // rather than mapping the host port to itself.
  return runtime.containerPort == null && service.containerPort != null
    ? { ...runtime, containerPort: service.containerPort as number } : runtime
}

/** An App's ingress record, named from its id so a rename rewrites nothing —
 *  and a customer who typed the CNAME by hand never has to again (`FJS-D561`).
 *  Outpost reads a host whose first label is the app id as this name. */
export const ingressName = (appId: string, zone: string) => `${appId}.${zone.trim().toLowerCase().replace(/\.$/, '')}`

/** An App's read-only copy's address, one label under the ingress zone like
 *  the ingress name (`FJS-D1982`), so the workspace's wildcard covers it. */
export const copyName = (appId: string, zone: string) => ingressName(`${appId}-copy`, zone)

/**
 * The copy's address when its machine should answer it, or null: the rule
 * `answeredIngressName` keeps, that no name is served before the workspace
 * holds its `*.<zone>` wildcard (`FJS-D1954`).
 */
export async function copyAddressOf(sys: any, appId: string): Promise<string | null> {
  const app = await sys.app.findFirst({ where: { id: appId }, withDeleted: true, select: { workspaceId: true } }) as { workspaceId: string } | null
  const ws  = app && await sys.workspace.findFirst({ where: { id: app.workspaceId }, select: { ingressZone: true, ingressCertSecretId: true } }) as
    { ingressZone: string | null, ingressCertSecretId: string | null } | null
  return ws?.ingressZone && ws.ingressCertSecretId ? copyName(appId, ws.ingressZone) : null
}

/**
 * The App's ingress name when Caddy should answer it, or null. Answered only
 * while `isIngressNamePublished` is on and the workspace holds its `*.<zone>`
 * wildcard: no ingress name is served before that certificate exists
 * (`FJS-D1954`), since Caddy would order one per name and the machine would
 * have two certificate paths.
 */
async function answeredIngressName(sys: any, appId: string): Promise<string | null> {
  const app = await sys.app.findFirst({ where: { id: appId }, select: { workspaceId: true, isIngressNamePublished: true } }) as
    { workspaceId: string, isIngressNamePublished: boolean } | null
  if (!app?.isIngressNamePublished) return null
  const ws = await sys.workspace.findFirst({ where: { id: app.workspaceId }, select: { ingressZone: true, ingressCertSecretId: true } }) as
    { ingressZone: string | null, ingressCertSecretId: string | null } | null
  return ws?.ingressZone && ws.ingressCertSecretId ? ingressName(appId, ws.ingressZone) : null
}

/**
 * What the App's ingress name does, for the App page (`FJS-D1952`): `served`
 * when Caddy fronts the App at it, `redirected` when a Domain serves it,
 * `waiting` when the workspace has no ingress zone or wildcard yet, `off` when
 * the column is. Read off the same rows `routedHosts` reads, so the page and
 * the machine cannot disagree.
 */
export async function ingressStateOf(db: any, appId: string): Promise<{ name: string | null, state: 'served' | 'redirected' | 'waiting' | 'off' }> {
  const sys = db.asSystem()
  const app = await sys.app.findFirst({ where: { id: appId }, select: { workspaceId: true, isIngressNamePublished: true } }) as
    { workspaceId: string, isIngressNamePublished: boolean } | null
  const ws  = app && await sys.workspace.findFirst({ where: { id: app.workspaceId }, select: { ingressZone: true, ingressCertSecretId: true } }) as
    { ingressZone: string | null, ingressCertSecretId: string | null } | null
  const name = ws?.ingressZone ? ingressName(appId, ws.ingressZone) : null
  if (!app?.isIngressNamePublished) return { name, state: 'off' }
  if (!name || !ws?.ingressCertSecretId) return { name, state: 'waiting' }
  return { name, state: (await servingDomains(sys, appId)).length ? 'redirected' : 'served' }
}

/** The App's serving Domains — live, not redirecting — by hostname. */
async function servingDomains(sys: any, appId: string): Promise<{ hostname: string, isPrimary: boolean }[]> {
  return sys.domain.findMany({ where: { appId, redirectTo: null }, orderBy: { hostname: 'asc' } })
}

/**
 * The hostnames Caddy on the machine fronts an app by (`FJS-D564`), sent on
 * every `/deploy`. The live `Domain` rows and never a release's snapshot: a
 * rollback puts back old bytes and old config, not an old set of names on the
 * internet. A Domain that redirects is not a host the app answers: it is in
 * `routedRedirects`. A name sent here is a certificate Caddy asks Let's Encrypt
 * for, so a deleted row must drop out — `@@softDelete` is what takes it out of
 * this read. With no serving Domain the ingress name is the host (`FJS-D1952`).
 */
export async function routedHosts(db: any, appId: string): Promise<string[]> {
  const sys   = db.asSystem()
  const hosts = (await servingDomains(sys, appId)).map(d => d.hostname)
  if (hosts.length) return hosts
  const name = await answeredIngressName(sys, appId)
  return name ? [name] : []
}

/**
 * The app's redirecting Domains, sent beside `hosts` on every route push so
 * Caddy answers them itself (`FJS-1615`). `redirectTo` is typed by a person, so
 * a bare hostname is read as `https://` — Outpost refuses anything that is not
 * an absolute http(s) URL, and the release would fail on a form that looked fine.
 * Once a Domain serves the App its ingress name redirects to the primary one,
 * or the first by hostname (`FJS-D1956`), so a link shared before keeps working.
 */
export async function routedRedirects(db: any, appId: string): Promise<{ host: string, to: string }[]> {
  const sys  = db.asSystem()
  const rows = await sys.domain.findMany({
    where: { appId, redirectTo: { not: null } }, orderBy: { hostname: 'asc' },
  })
  const out = rows
    .filter((d: { redirectTo: string }) => d.redirectTo.trim())
    .map((d: { hostname: string, redirectTo: string }) => {
      const to = d.redirectTo.trim()
      return { host: d.hostname, to: /^[a-z][a-z0-9+.-]*:\/\//i.test(to) ? to : `https://${to}` }
    })
  const serving = await servingDomains(sys, appId)
  const name    = serving.length ? await answeredIngressName(sys, appId) : null
  if (name) out.push({ host: name, to: `https://${(serving.find(d => d.isPrimary) ?? serving[0]).hostname}` })
  return out
}

/**
 * The hosts Caddy answers `X-Robots-Tag: noindex` on, sent beside `hosts` and
 * `redirects` on every route push: the ingress name, served or redirected, so a
 * search engine indexes the Domain and never the name every App has
 * (`IDEAS/ingress-name.md` § Security 5). Stated here because the zone is
 * Basecamp's; Outpost cannot tell the name from a Domain that starts with the id.
 */
export async function noindexHosts(db: any, appId: string): Promise<string[]> {
  const name = await answeredIngressName(db.asSystem(), appId)
  return name ? [name] : []
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

/** The App's read-only copy with its machine while it serves the main
 *  address, or null. */
export async function copyServingMain(sys: any, appId: string): Promise<{ serverId: string; server: { name: string | null; status: string; ipAddress: string | null } | null } | null> {
  return sys.appCopy.findFirst({ where: { appId, isServingMainAddress: true }, include: { server: true } })
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
 *
 * While the App's read-only copy serves its main address, the record holds
 * the copy's machine alone (`IDEAS/read-only-copy.md` 3.1), whatever the
 * placements say, so a release landing or a machine coming back does not
 * move users off the copy before the switch is turned back.
 */
export async function servingAddresses(db: any, appId: string): Promise<string[]> {
  const copy = await copyServingMain(db.asSystem(), appId)
  if (copy) return copy.server?.status === 'online' && copy.server.ipAddress ? [String(copy.server.ipAddress)] : []
  return placementAddresses(db, appId)
}

/** `servingAddresses` from the App's own placements, the copy aside: where
 *  switching the main address back would point the record. */
export async function placementAddresses(db: any, appId: string): Promise<string[]> {
  const rows = await db.asSystem().appServer.findMany({
    where: { appId, status: 'running' }, include: { server: true },
  })
  const ips = rows
    .filter((p: any) => p.server?.status === 'online' && p.server.ipAddress)
    .map((p: any) => String(p.server.ipAddress))
  return [...new Set<string>(ips)].sort()
}

/**
 * Why `servingAddresses` is empty, as the one condition that is missing.
 * Four rows have to line up and a person fixes each in a different place, so
 * "runs on no online server" for all four sent someone looking at a machine
 * that was up while its IP address was the thing unset.
 */
export async function servingRefusal(db: any, appId: string): Promise<string> {
  const copy = await copyServingMain(db.asSystem(), appId)
  if (copy) {
    const name = `'${copy.server?.name ?? copy.serverId}'`
    return copy.server?.status !== 'online'
      ? `the read-only copy serves the main address and its machine ${name} is ${copy.server?.status ?? 'missing'}`
      : `the read-only copy serves the main address and its machine ${name} has no IP address recorded`
  }
  return placementRefusal(db, appId)
}

/** Why `placementAddresses` is empty. */
export async function placementRefusal(db: any, appId: string): Promise<string> {
  const rows = await db.asSystem().appServer.findMany({ where: { appId }, include: { server: true } }) as any[]
  const named = (ps: any[]) => [...new Set(ps.map(p => `'${p.server?.name ?? p.serverId}'`))].join(', ')
  if (!rows.length) return 'the app is placed on no server — place it on one, then deploy'
  const online = rows.filter(p => p.server?.status === 'online')
  if (!online.length)
    return `the app's servers are not online (${rows.map(p => `'${p.server?.name ?? p.serverId}' ${p.server?.status ?? 'missing'}`).join(', ')})`
  const running = online.filter(p => p.status === 'running')
  if (!running.length) return `no release has landed on ${named(online)} — deploy it`
  return `${named(running)} has no IP address recorded, so there is nothing to point a record at`
}

/**
 * The container port a build read off the Dockerfile it shipped, taken by an
 * App that stores none (`FJS-D1567`): Basecamp cannot read a private
 * repository's file before the machine clones it. A number a person typed, or
 * the seed named, is never moved by a build; the build step names the
 * disagreement instead, and the health check is what fails.
 */
export async function adoptContainerPort(db: any, appId: string, containerPort: number): Promise<boolean> {
  const { count } = await db.asSystem().app.updateMany({ where: { id: appId, containerPort: null }, data: { containerPort } })
  return count > 0
}

/** Mark the placements a release landed on as `running`. Every replica row on
 *  that machine, since `/deploy` starts the app's one container there.
 *
 *  Every OTHER machine the app is placed on goes back to `unknown`: it still
 *  serves the release before this one, and while it read `running` the ingress
 *  record kept sending traffic to it — the moment a drained machine came back,
 *  half the requests met the old version (`FJS-3851`). It rejoins the record
 *  when a release lands on it. */
export async function markRunning(db: any, appId: string, serverId: string): Promise<void> {
  const sys = db.asSystem()
  await sys.appServer.updateMany({
    where: { appId, serverId },
    data:  { status: 'running', startedAt: new Date().toISOString(), stoppedAt: null },
  })
  await sys.appServer.updateMany({
    where: { appId, serverId: { not: serverId }, status: 'running' },
    data:  { status: 'unknown' },
  })
}
