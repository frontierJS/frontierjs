// src/jobs/ingress-dns.job.ts
// Pushes one App's ingress record and its hostnames. Dispatched as `ingress:dns`.
//
// An App answers at its ingress name with no Domain at all (`FJS-D1952`), so
// its record cannot wait for a Domain's push to be written ahead of a CNAME.
// The triggers are `domain:dns`'s, keyed by the App: `isIngressNamePublished`
// written, a release landing, a machine entering or leaving `online` -- the last
// two only for an App with no Domain (`ownRecordHolders`). Each
// pushes the record through `edge.ingressStep` and the App's hosts to Caddy on
// every machine running it, since the column decides whether the name is a host
// or a redirect there.
//
// Each dispatch STATES its id — `ingress:<appId>:<updatedAt>` for a write,
// `ingress:<appId>:release:<deploymentId>`, and
// `ingress:<appId>:server:<serverId>:<status>:<at>` — for `domain:dns`'s
// reason. Which failures are retried is `domain:dns`'s too: below 500 is
// terminal, a machine that cannot be reached is retried.

import { defineJob }     from '@frontierjs/caravan'
import { runsEitherWay } from '../domain/job/job-context.ts'
import { routeApp, rebindStale, type RoutePush } from './domain-dns.job.ts'
import type { App }      from '@frontierjs/junction'

const ingressDns = defineJob<{ appId: string }>({
  name: 'ingress:dns',
  handler: async (ctx) => {
    const { app, mode } = runsEitherWay(ctx, 'ingress:dns')
    const log   = app.logger.child('ingress-dns')
    const appId = ctx.data.appId

    let dns: unknown = null
    try {
      const out = await app.service('edge').call('ingressStep', appId) as { name?: string; skipped?: string; removed?: unknown[] }
      if (out.skipped)      log.info('not pushed', { appId, reason: out.skipped })
      else if (out.removed) log.info('removed', { appId, name: out.name, records: out.removed.length })
      else                  log.info('pushed', { appId, name: out.name })
    } catch (err) {
      const code = Number((err as { code?: unknown }).code)
      if (code >= 400 && code < 500) (err as { retryable?: boolean }).retryable = false
      log.error('push failed', { appId, error: (err as Error).message, retried: code >= 500 || !code })
      dns = err
    }

    const routes: RoutePush = { appId, routed: [], failed: [] }
    await routeApp(app, appId, routes)
    if (routes.failed.length) log.error('route push failed', { appId, failed: routes.failed })
    const rebound = await rebindStale(app, mode, log, routes)

    if (routes.failed.length)
      throw new Error(`route not pushed to ${routes.failed.map(f => `${f.server}: ${f.error}`).join('; ')}`)
    if (rebound) throw rebound
    if (dns) throw dns
  },
  queue:       'dns',
  maxAttempts: 5,
  retryDelay:  [10_000, 60_000],
  timeout:     120_000,
})

export default ingressDns

/** Which of `appIds` hold an ingress record no Domain push writes: published,
 *  with no Domain. A release and a machine moving dispatch for these alone,
 *  since every other App's record rides on its Domains' `domain:dns`, and the
 *  one-wide queue would carry each push twice. */
export async function ownRecordHolders(app: App, appIds: string[]): Promise<string[]> {
  if (!appIds.length) return []
  const sys   = (app.db as any).asSystem()
  const on    = await sys.app.findMany({ where: { id: { in: appIds }, isIngressNamePublished: true }, select: { id: true } }) as { id: string }[]
  const owned = await sys.domain.findMany({ where: { appId: { in: on.map(a => a.id) } }, select: { appId: true } }) as { appId: string }[]
  const held  = new Set(owned.map(d => d.appId))
  return on.map(a => a.id).filter(id => !held.has(id))
}
