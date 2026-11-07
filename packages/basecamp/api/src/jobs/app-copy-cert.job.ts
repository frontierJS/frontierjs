// src/jobs/app-copy-cert.job.ts
// Mints, keeps and pushes the certificate of each of an App's Domains onto its
// read-only copy's machine, ahead of any flip (`FJS-D1988`,
// `IDEAS/read-only-copy.md` 2.4). Dispatched as `app-copy:cert` with an
// `appId` when a copy is turned on, moved or off, and fired daily with none,
// which is the sweep.
//
// Without it the lifeboat would order every Domain's certificate at the
// moment of the outage, by HTTP-01, once the record pointed at the copy -- and
// a try made a moment early backs off for hours (0.5).
//
// Which certificate a Domain gets on the copy's machine:
//   - one of its own that is valid anywhere -- `originCa` or `uploaded` -- is
//     pushed as it is, and nothing is minted;
//   - otherwise one minted by DNS-01 in the connected zone that holds the
//     hostname, kept in `copyCertSecretId`. Never in `certSecretId`:
//     `certStatusOf` reads that one as what the live machine serves.
// A Domain deleted, or an App with no copy, has its minted one dropped.
//
// IDEMPOTENT by looking, as `ingress:cert` is: a mint happens only for a
// certificate that is absent, names another host or is inside 30 days, and
// whatever is held is pushed again either way. Every Domain is tried; what
// failed is written to `AppCopy.certError`, which the card shows, and fails
// the job so the queue retries it.

import { defineJob }       from '@frontierjs/caravan'
import type { App }        from '@frontierjs/junction'
import { runsAsApp }       from '../domain/job/job-context.ts'
import { createSystemSecret } from '../domain/secret/system-secret.ts'
import { executorOn, isExecutor, type Executor } from '../providers/executor.ts'
import { certStatusOf }    from '../services/domains/domains.service.ts'
import { edgeAccounts, zoneOf } from '../services/edge/edge.service.ts'
import { orderByDns, readMaterial, namesOf, RENEWING, type IngressCertDeps, type Material } from './ingress-cert.job.ts'

/** The id the copy's machine holds a Domain's certificate under (`/certs/load { id }`). */
export const copyCertId = (domainId: string) => `copy-${domainId}`

/** A Domain's own certificate kinds that serve from any machine. */
const PORTABLE = new Set(['originCa', 'uploaded'])

interface DomainRow {
  id: string; workspaceId: string; hostname: string; version: number; deletedAt: string | null
  certSecretId: string | null; certKind: string | null
  copyCertSecretId: string | null; copyCertExpiresAt: string | null
}

const SELECT = {
  id: true, workspaceId: true, hostname: true, version: true, deletedAt: true,
  certSecretId: true, certKind: true, copyCertSecretId: true, copyCertExpiresAt: true,
}

const condition = (d: DomainRow) =>
  certStatusOf({ certSecretId: d.copyCertSecretId, certExpiresAt: d.copyCertExpiresAt }).cert_status

const appCopyCert = defineJob<{ appId?: string }>({
  name: 'app-copy:cert',
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'app-copy:cert')
    const appId = ctx.data?.appId
    if (!appId) { await sweep(app); return }
    const out = await ensureCopyCerts(app, appId)
    if (out.failed.length) throw new Error(failure(out.failed))
  },
  cron:        '47 3 * * *',
  queue:       'sync',
  maxAttempts: 5,
  retryDelay:  [10_000, 60_000],
  // A dozen CA calls and a 10 s wait per Domain.
  timeout:     15 * 60_000,
})

export default appCopyCert

const failure = (failed: { hostname: string; error: string }[]) =>
  failed.map(f => `${f.hostname}: ${f.error}`).join('; ')

/** Dispatch for every App with a live copy, and every App holding a minted
 *  certificate its copy no longer needs. Every copy and not only those owed a
 *  mint: a Domain's own certificate re-uploaded, a Domain added and a machine
 *  reinstalled are each a push nothing else sends. */
export async function sweep(app: App): Promise<void> {
  const log    = app.logger.child('app-copy-cert')
  const sys    = (app.db as any).asSystem()
  const copies = (await sys.appCopy.findMany({ select: { appId: true } }) as { appId: string }[]).map(c => c.appId)
  const live   = new Set((await sys.app.findMany({ where: { id: { in: copies } }, select: { id: true } }) as { id: string }[]).map(a => a.id))
  const held   = await sys.domain.findMany({ where: { copyCertSecretId: { not: null } }, withDeleted: true, select: { appId: true } }) as { appId: string }[]
  const owed   = new Set([...live, ...held.map(d => d.appId)])
  const day    = new Date().toISOString().slice(0, 10)
  for (const appId of owed)
    await app.jobs.dispatch(appCopyCert, { appId }, { id: `app-copy:cert:${appId}:sweep:${day}`, actor: null })
  if (owed.size) log.info('swept', { owed: owed.size })
}

/**
 * Bring one App's Domains' certificates on its copy's machine to what its
 * Domains say. Answers what it did; `failed` is per hostname, and is also
 * what `AppCopy.certError` now says.
 */
export async function ensureCopyCerts(app: App, appId: string, deps: IngressCertDeps = {}):
  Promise<{ minted: string[]; pushed: string[]; dropped: string[]; failed: { hostname: string; error: string }[] }> {
  const log = app.logger.child('app-copy-cert')
  const sys = (app.db as any).asSystem()
  const out = { minted: [] as string[], pushed: [] as string[], dropped: [] as string[], failed: [] as { hostname: string; error: string }[] }

  const copy    = await sys.appCopy.findFirst({ where: { appId }, include: { server: true } })
  const target  = copy && await sys.app.findFirst({ where: { id: appId }, select: { id: true, workspaceId: true } })
  const domains = await sys.domain.findMany({ where: { appId }, withDeleted: true, select: SELECT }) as DomainRow[]

  // Off: a copy turned off or moved had its old machine told by `unserveCopy`,
  // so only the rows are left to clear.
  if (!copy || !target) {
    for (const d of domains.filter(d => d.copyCertSecretId)) { await forget(sys, d); out.dropped.push(d.hostname) }
    return out
  }

  const executor = await executorOn(app, copy.serverId, copy.server?.name)
  for (const d of domains.filter(d => d.copyCertSecretId && (d.deletedAt || PORTABLE.has(d.certKind ?? '')))) {
    if (d.deletedAt && isExecutor(executor)) await executor.call('/certs/drop', { id: copyCertId(d.id) }).catch(() => null)
    await forget(sys, d)
    out.dropped.push(d.hostname)
  }

  const live = domains.filter(d => !d.deletedAt)
  if (!isExecutor(executor)) {
    out.failed = live.map(d => ({ hostname: d.hostname, error: executor.reason }))
    await record(sys, copy.id, out.failed)
    return out
  }

  // One ACME account for the run, so an App with many Domains is not many
  // new accounts at once; Let's Encrypt limits those per address.
  let accountKey: JsonWebKey | undefined
  for (const d of live) {
    try {
      const material = await certificateFor(app, sys, d, deps, accountKey, log, out)
      accountKey ??= material.accountKey
      const reply = await executor.call('/certs/load', { id: copyCertId(d.id), cert: material.cert, key: material.key })
      if (!reply.error) { out.pushed.push(d.hostname); continue }
      // An outpost from before certificates: nothing a retry changes.
      if (/no such route/i.test(reply.error.message)) { log.warn('outpost too old to hold a certificate', { hostname: d.hostname }); continue }
      out.failed.push({ hostname: d.hostname, error: `the machine refused it: ${reply.error.message}` })
    } catch (err) {
      out.failed.push({ hostname: d.hostname, error: (err as Error).message })
    }
  }
  await record(sys, copy.id, out.failed)
  return out
}

/** The material a Domain serves from the copy's machine, minting when owed. */
async function certificateFor(app: App, sys: any, d: DomainRow, deps: IngressCertDeps, accountKey: JsonWebKey | undefined,
  log: ReturnType<App['logger']['child']>, out: { minted: string[] }): Promise<Material> {
  if (PORTABLE.has(d.certKind ?? '') && d.certSecretId) {
    const own = await sys.secret.findFirst({ where: { id: d.certSecretId } }) as { data?: string } | null
    const pem = own?.data ? JSON.parse(own.data) as { certPem?: string; keyPem?: string } : {}
    if (!pem.certPem || !pem.keyPem) throw new Error(`its ${d.certKind} certificate's Secret holds no material`)
    return { cert: pem.certPem, key: pem.keyPem }
  }

  const held  = d.copyCertSecretId ? await readMaterial(sys, d.copyCertSecretId) : null
  if (held && namesOf(held.cert).includes(d.hostname) && !RENEWING.has(condition(d))) return held

  const home = await zoneOf(await edgeAccounts(d.workspaceId, app.db), d.hostname, app)
  if (!home) throw new Error('no connected zone holds it, so no DNS-01 record can be written for it')
  const issued = await orderByDns(app, {
    connector: home.connector, accountId: home.account.id, zoneId: home.zone.id,
    names: [d.hostname], accountKey: held?.accountKey ?? accountKey,
  }, deps)

  const material: Material = { cert: issued.cert, key: issued.key, accountKey: issued.accountKey }
  const secret = await createSystemSecret(sys, 'copy-cert', d.hostname, {
    workspaceId: d.workspaceId,
    kind:        'tlsCert',
    data:        JSON.stringify(material),
  })
  // Read again: the Domain may have been patched while the CA worked.
  const now = await sys.domain.findFirst({ where: { id: d.id }, select: { version: true } }) as { version: number }
  await sys.domain.update({
    where:  { id: d.id },
    data:   { copyCertSecretId: secret.id, copyCertExpiresAt: issued.expiresAt, version: now.version },
    system: ['copyCertSecretId', 'copyCertExpiresAt'],
  })
  // The replaced Secret held a private key nothing refers to any more.
  if (d.copyCertSecretId) await sys.secret.delete({ where: { id: d.copyCertSecretId } })
  out.minted.push(d.hostname)
  log.info('minted', { hostname: d.hostname })
  return material
}

/** Null both columns and delete the Secret they named. */
async function forget(sys: any, d: DomainRow): Promise<void> {
  await sys.domain.update({
    where: { id: d.id }, withDeleted: true,
    data:  { copyCertSecretId: null, copyCertExpiresAt: null, version: d.version },
    system: ['copyCertSecretId', 'copyCertExpiresAt'],
  })
  await sys.secret.delete({ where: { id: d.copyCertSecretId } })
}

async function record(sys: any, copyId: string, failed: { hostname: string; error: string }[]): Promise<void> {
  await sys.appCopy.update({ where: { id: copyId }, data: { certError: failed.length ? failure(failed).slice(0, 2000) : null } })
}

/**
 * `unserveCopy`'s half: take every Domain's certificate off the machine the
 * copy left. Best effort, as the unserve is -- a machine that cannot be told
 * holds a certificate for a name it does not route.
 */
export async function dropCopyCerts(app: App, executor: Executor, appId: string): Promise<void> {
  const sys = (app.db as any).asSystem()
  const domains = await sys.domain.findMany({ where: { appId }, withDeleted: true, select: { id: true } }) as { id: string }[]
  for (const d of domains) await executor.call('/certs/drop', { id: copyCertId(d.id) }).catch(() => null)
}
