// src/jobs/domain-dns.job.ts
// Pushes one Domain to its zone. Dispatched as `domain:dns`.
//
// Three things make a zone wrong, and each dispatches this: a `Domain` written
// (created, changed, deleted), a release landing on a machine the App's
// ingress record does not name, and a machine entering or leaving `online`
// without a release (`FJS-1614`) — a drain, a sweep finding it gone, a check-in
// bringing it back. Each one pushes twice: the zone, through `edge.syncStep`,
// and the App's hostnames to Caddy on every machine running it, through
// `/route` (`FJS-1610`) — a Domain written between releases otherwise answers
// nothing on the machine (no route, no certificate) until the next deploy. This
// file decides only whether to try again.
//
// Each dispatch STATES its id — `dns:<domainId>:<version>` for a write,
// `dns:<domainId>:release:<deploymentId>` for a release,
// `dns:<domainId>:server:<serverId>:<status>:<at>` for a machine moving — so a
// replayed write is one push for all time, and a second release is a second
// push rather than a no-op keyed on a version that did not move.
//
// A write and a release are somebody's and run as them. A machine moving is
// the fleet's: the sweep and a check-in have no caller at all, and a person's
// drain is not a request to publish DNS as them. So those dispatch as the app,
// and `syncStep` confines itself to the Domain's own workspace.
//
// ─── Which failures are retried ──────────────────────────────────────────
//
// The vendor having a bad minute is a 502 and is retried: the write is one
// batch that applied whole or not at all, so a second attempt repeats it rather
// than finishing half of it. Anything below 500 is the same answer next time —
// a record somebody else made at the hostname, a Domain that is gone — so it is
// marked terminal and the job's error is the sentence a person reads. *Not
// yet* is neither: `syncStep` answers it as skipped, and the drift on `/dns/`
// still names the hostname as missing.
//
// A machine that cannot be reached — an outpost that refused, or one not yet
// registered since the API restarted — is retried: its heartbeat registers it
// within the delays below, and a route left stale is a hostname still served
// after it was deleted. The zone is pushed either way, and pushed again on the
// retry, which is no write when it is already true.

import { defineJob }     from '@frontierjs/caravan'
import { runsEitherWay } from './context.ts'
import { executorOn, isExecutor } from '../providers/executor.ts'
import { routedHosts }   from '../core/runtime.ts'
import { isInline }      from '../core/app-source.ts'
import type { BasecampApp } from '../basecamp.types.ts'

const domainDns = defineJob<{ domainId: string }>(
  'domain:dns',
  async (ctx) => {
    const { app } = runsEitherWay(ctx, 'domain:dns')
    const log     = app.logger.child('domain-dns')

    let dns: unknown = null
    try {
      const out = await app.service('edge').call('syncStep', ctx.data.domainId) as { hostname: string; skipped?: string }
      if (out.skipped) log.info('not pushed', { id: ctx.data.domainId, hostname: out.hostname, reason: out.skipped })
      else             log.info('pushed', { id: ctx.data.domainId, hostname: out.hostname })
    } catch (err) {
      const code = Number((err as { code?: unknown }).code)
      if (code >= 400 && code < 500) (err as { terminal?: boolean }).terminal = true
      log.error('push failed', { id: ctx.data.domainId, error: (err as Error).message, retried: code >= 500 || !code })
      dns = err
    }

    const routes = await routeDomainApp(app, ctx.data.domainId)
    for (const r of routes.routed)
      if (r.rebind) log.warn('routed, bind stale until the next release', { serverId: r.serverId, rebind: r.rebind })
    if (routes.failed.length)
      log.error('route push failed', { id: ctx.data.domainId, failed: routes.failed })

    // A terminal zone refusal stops the retries only when every machine took
    // its route; otherwise the retry is owed to the machines.
    if (routes.failed.length)
      throw new Error(`route not pushed to ${routes.failed.map(f => `${f.server}: ${f.error}`).join('; ')}`)
    if (dns) throw dns
  },
  {
    // Its own queue, one wide (junction.config.js says why).
    queue:       'dns',
    maxAttempts: 5,
    retryDelay:  [10_000, 60_000],
    // A push is a few vendor calls, and the queue is one wide: a push hung on
    // a vendor that never answers would hold every push behind it.
    timeout:     120_000,
  },
)

export default domainDns

/**
 * Push every Domain of every App running on `serverId`, because the machine
 * moved into or out of `online` and each of those Apps' ingress records now
 * names the wrong set. `at` is the move's own instant, so two moves are two
 * pushes and a replay of one is none.
 *
 * An App left on NO online machine is still dispatched: the push refuses it as
 * not-yet and the record stays where it last ran (`FJS-D567`).
 */
export async function pushAppsOn(app: BasecampApp, serverId: string, status: string, at: string): Promise<number> {
  const sys    = (app.db as any).asSystem()
  const placed = await sys.appServer.findMany({ where: { serverId, status: 'running' }, select: { appId: true } }) as { appId: string }[]
  const appIds = [...new Set(placed.map(p => p.appId))]
  if (!appIds.length) return 0
  const domains = await sys.domain.findMany({ where: { appId: { in: appIds } }, select: { id: true } }) as { id: string }[]
  for (const d of domains)
    await app.jobs.dispatch(domainDns, { domainId: d.id },
      { id: `dns:${d.id}:server:${serverId}:${status}:${at}`, actor: null })
  return domains.length
}

interface RoutePush {
  routed: { serverId: string; hosts: string[]; rebind: string | null }[]
  failed: { server: string; error: string }[]
}

/**
 * Send the App's hostnames to Caddy on every machine it runs on: each
 * `running` placement on an `online` server, the set `servingAddresses` puts
 * in the ingress record, so a name the zone sends to a machine is a name that
 * machine routes. The hosts are the live rows (`routedHosts`), so a deleted
 * Domain, or one turned into a redirect, drops out, and an App with none left
 * is unrouted.
 *
 * An inline App is skipped: its origin is the static listener, which no route
 * fronts yet (`FJS-1615`).
 */
export async function routeDomainApp(app: BasecampApp, domainId: string): Promise<RoutePush> {
  const out: RoutePush = { routed: [], failed: [] }
  const sys    = (app.db as any).asSystem()
  const domain = await sys.domain.findFirst({ where: { id: domainId }, withDeleted: true, select: { appId: true } }) as { appId: string } | null
  if (!domain) return out
  const row = await sys.app.findFirst({ where: { id: domain.appId }, select: { source: true } }) as { source: unknown } | null
  if (!row || isInline(row.source)) return out

  const hosts  = await routedHosts(app.db, domain.appId)
  const placed = await sys.appServer.findMany({ where: { appId: domain.appId, status: 'running' }, include: { server: true } }) as any[]
  const servers = new Map<string, string>()
  for (const p of placed) if (p.server?.status === 'online') servers.set(p.serverId, p.server.name ?? p.serverId)

  for (const [serverId, name] of servers) {
    const executor = await executorOn(app, serverId, name)
    if (!isExecutor(executor)) { out.failed.push({ server: name, error: executor.reason }); continue }
    const reply = await executor.call('/route', { app_id: domain.appId, hosts })
    if (reply.error) { out.failed.push({ server: name, error: reply.error.message }); continue }
    out.routed.push({ serverId, hosts, rebind: (reply.data?.rebind as string | null | undefined) ?? null })
  }
  return out
}
