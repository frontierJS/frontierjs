// src/jobs/ingress-cert.job.ts
// Mints, keeps and pushes a workspace's wildcard, `*.<ingressZone>`. Dispatched
// as `ingress:cert` with a `workspaceId`, and fired daily with none, which is the
// sweep (`FJS-D1954`, `FJS-D1974`, `FJS-D1975`).
//
// One certificate per workspace, minted by DNS-01 through the workspace's own
// edge account: the TXT record goes into the zone with the vendor token
// Basecamp already holds, so the token never leaves this process. The machine
// is sent the PEM and never the token. The ACME account key rides in the same
// `tlsCert` Secret as the cert and key, so a renewal is the same account and
// not a new one every sixty days.
//
// What dispatches it:
//   - `resolveIngressZone`'s patch, when `ingressZoneId` changes or clears
//     (`ingress:cert:<workspaceId>:<version>`);
//   - the daily sweep, for each workspace whose zone has no certificate or
//     whose certificate is inside `certStatusOf()`'s 30 days, or whose zone is
//     gone and whose certificate is not (`ingress:cert:<workspaceId>:sweep:<day>`).
// Each states its id, so a replayed write or a second tick of the day is one
// mint for all time -- Let's Encrypt limits a name to five certificates a week.
//
// The job is IDEMPOTENT by looking, not by remembering: it decides whether to
// mint from the stored certificate (absent, naming another zone, or expiring),
// then pushes whatever is stored to every online machine either way. A retry
// after a machine was unreachable therefore pushes again and mints nothing.
//
// ─── Which failures are retried ──────────────────────────────────────────
//
// A machine that cannot be reached is retried: its heartbeat registers it
// within the delays below. An Outpost answering `no such route` is an older one
// that cannot hold a certificate yet; it is logged and does not fail the job,
// because a retry would say the same. A CA or vendor refusal is retried -- the
// vendor having a bad minute is the common case -- but a refusal to reach a
// real CA from a process that has not said it may (`maySpend`) is not, and
// neither is a workspace whose edge account is gone: both are the same answer
// next time.
//
// A release pushes the same certificate to its own machine before it routes
// (`pushIngressCert`), so a machine enrolled after the mint holds it before it
// serves. A failure there is logged by the release and does not fail it.

import { X509Certificate } from 'node:crypto'
import { defineJob }       from '@frontierjs/caravan'
import type { App }        from '@frontierjs/junction'
import { env }             from '../core/env.ts'
import { runsAsApp }       from '../domain/job/job-context.ts'
import { createSystemSecret } from '../domain/secret/system-secret.ts'
import { executorOn, isExecutor, type Executor } from '../providers/executor.ts'
import { issue as acmeIssue } from '../providers/acme/index.ts'
import { edgeConnectorFor }   from '../providers/edge/index.ts'
import { FLEET, targetFor }   from '../providers/compute/index.ts'
import { isStandIn, maySpend, sendVia } from '../providers/compute/accounts.ts'
import { certStatusOf }       from '../services/domains/domains.service.ts'

/** Where Let's Encrypt is, when `ACME_URL` does not point somewhere else. A
 *  drive points it at Pebble, the way `CLOUDFLARE_URL` points at the sink. */
const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory'

/** The id every machine holds Basecamp's wildcard under (`/certs/load { id }`). */
export const INGRESS_CERT_ID = 'ingress'

/** certbot-dns-cloudflare's default propagation wait. The CA asks once and an
 *  `invalid` authorization is not retried, so the record has to be there. */
const PROPAGATION_MS = 10_000

const RENEWING = new Set(['expiring_soon', 'expired'])

/** `certStatusOf` reads a Domain's column names; the pair here is the same fact. */
const condition = (w: WorkspaceRow) =>
  certStatusOf({ certSecretId: w.ingressCertSecretId, certExpiresAt: w.ingressCertExpiresAt }).cert_status

interface WorkspaceRow {
  id: string; version: number; deletedAt: string | null
  ingressSecretId: string | null; ingressZoneId: string | null; ingressZone: string | null
  ingressCertSecretId: string | null; ingressCertExpiresAt: string | null
}

interface Material { cert: string; key: string; accountKey?: JsonWebKey }

/** What a test replaces: the CA client and the wait. Production passes nothing,
 *  and a replaced client is not a real CA, so the guard on ordering skips it. */
export interface IngressCertDeps {
  issue?:      typeof acmeIssue
  waitForDns?: () => Promise<void>
}

const SELECT = {
  id: true, version: true, deletedAt: true, ingressSecretId: true, ingressZoneId: true, ingressZone: true,
  ingressCertSecretId: true, ingressCertExpiresAt: true,
}

const ingressCert = defineJob<{ workspaceId?: string }>({
  name: 'ingress:cert',
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'ingress:cert')
    const workspaceId = ctx.data?.workspaceId
    if (!workspaceId) { await sweep(app); return }
    const out = await ensureIngressCert(app, workspaceId)
    if (out.failed.length) throw new Error(`certificate not pushed to ${out.failed.map(f => `${f.server}: ${f.error}`).join('; ')}`)
  },
  cron:        '17 3 * * *',
  queue:       'sync',
  maxAttempts: 5,
  retryDelay:  [10_000, 60_000],
  // An order is a dozen CA calls and a 10 s wait; a CA that never answers
  // would hold one of the queue's two slots.
  timeout:     5 * 60_000,
})

export default ingressCert

/** Dispatch the mint for every workspace whose wildcard is owed. */
async function sweep(app: App): Promise<void> {
  const log  = app.logger.child('ingress-cert')
  const sys  = (app.db as any).asSystem()
  const rows = await sys.workspace.findMany({ select: SELECT }) as WorkspaceRow[]
  const day  = new Date().toISOString().slice(0, 10)
  let owed = 0
  for (const w of rows) {
    const zoned = Boolean(w.ingressZone && w.ingressSecretId)
    const needs = zoned
      ? !w.ingressCertSecretId || RENEWING.has(condition(w))
      : Boolean(w.ingressCertSecretId)
    if (!needs) continue
    owed++
    await app.jobs.dispatch(ingressCert, { workspaceId: w.id }, { id: `ingress:cert:${w.id}:sweep:${day}`, actor: null })
  }
  if (owed) log.info('swept', { owed })
}

/**
 * Bring one workspace's wildcard to what its zone says, then put it on every
 * online machine. Answers what it did; `failed` is the machines to try again.
 */
export async function ensureIngressCert(app: App, workspaceId: string, deps: IngressCertDeps = {}):
  Promise<{ minted: boolean; dropped: boolean; pushed: string[]; failed: { server: string; error: string }[] }> {
  const log = app.logger.child('ingress-cert')
  const sys = (app.db as any).asSystem()
  const ws  = await sys.workspace.findFirst({ where: { id: workspaceId }, select: SELECT }) as WorkspaceRow | null
  const out = { minted: false, dropped: false, pushed: [] as string[], failed: [] as { server: string; error: string }[] }
  if (!ws || ws.deletedAt) return out

  // ── The zone is gone: drop the machines' copy before the record of it, so a
  // machine that could not be reached is still owed the drop on the retry. ──
  if (!ws.ingressZone || !ws.ingressSecretId) {
    if (!ws.ingressCertSecretId) return out
    const drop = await onEachMachine(app, workspaceId, '/certs/drop', { id: INGRESS_CERT_ID }, log)
    out.failed = drop.failed
    if (drop.failed.length) return out
    await sys.workspace.update({
      where: { id: workspaceId },
      data:  { ingressCertSecretId: null, ingressCertExpiresAt: null, version: ws.version },
      system: ['ingressCertSecretId', 'ingressCertExpiresAt'],
    })
    await sys.secret.delete({ where: { id: ws.ingressCertSecretId } })
    out.dropped = true
    log.info('zone cleared, certificate dropped', { workspaceId, machines: drop.pushed.length })
    return out
  }

  const want  = `*.${ws.ingressZone}`
  const held  = ws.ingressCertSecretId ? await readMaterial(sys, ws.ingressCertSecretId) : null
  const names = held ? namesOf(held.cert) : []
  const stale = !held || !names.includes(want) || RENEWING.has(condition(ws))

  let material = held
  if (stale) {
    material = await mint(app, ws, want, deps, held?.accountKey)
    out.minted = true
    log.info('minted', { workspaceId, name: want })
  }

  const pushed = await onEachMachine(app, workspaceId, '/certs/load',
    { id: INGRESS_CERT_ID, cert: material!.cert, key: material!.key }, log)
  out.pushed = pushed.pushed
  out.failed = pushed.failed
  return out
}

/** Order the wildcard through the workspace's edge account and keep the result. */
async function mint(app: App, ws: WorkspaceRow, want: string, deps: IngressCertDeps, accountKey?: JsonWebKey): Promise<Material> {
  const sys = (app.db as any).asSystem()
  const account = await sys.secret.findFirst({
    where: { id: ws.ingressSecretId, workspaceId: ws.id }, select: { id: true, providerKind: true },
  }) as { id: string; providerKind: string } | null
  const connector = edgeConnectorFor(account?.providerKind as never)
  if (!account || !connector)
    throw Object.assign(new Error(`the ingress zone names edge account '${ws.ingressSecretId}', which this workspace no longer holds`), { retryable: false })

  // The CA is a real thing out there: an order is public and counts against a
  // weekly limit. The same fail-closed question the vendors are asked
  // (`providers/compute/accounts.ts`), so a test or a laptop pointed at nothing
  // in particular orders nothing.
  const directoryUrl = env.ACME_URL || LETS_ENCRYPT
  if (!deps.issue && !maySpend() && !isStandIn(directoryUrl))
    throw Object.assign(new Error(`refusing to order ${want} at ${directoryUrl} -- this makes a public certificate order and `
      + 'this process has not said it means to. Point ACME_URL at a stand-in on localhost, set ALLOW_CLOUD_SPEND=1, or run with NODE_ENV=production.'),
      { retryable: false })

  const send = sendVia(app, targetFor(connector.kind, account.id))
  const mark = { fleet: FLEET }
  const zoneId = ws.ingressZoneId!

  const dns = {
    // Appended, never set: the apex and the wildcard share this name.
    async set(txt: string, value: string) {
      await connector.appendRecords(send, zoneId, mark, [{ type: 'TXT', name: txt, content: value }])
    },
    // Exactly the record this order made. The vendor may hand a TXT value back
    // quoted, so the one to delete is found by its unquoted text and removed by
    // the content it answered.
    async clear(txt: string, value: string) {
      const ours = (await connector.records(send, zoneId))
        .filter(r => r.type === 'TXT' && r.name.replace(/\.$/, '').toLowerCase() === txt && r.content.replace(/^"|"$/g, '') === value)
      for (const r of ours)
        await connector.deleteRecords(send, zoneId, [{ type: 'TXT', name: txt, content: r.content, mark }])
    },
  }

  const issued = await (deps.issue ?? acmeIssue)({
    directoryUrl, names: [want], accountKey, dns,
    waitForDns: deps.waitForDns ?? (async () => { await new Promise(r => setTimeout(r, PROPAGATION_MS)) }),
  })

  const material: Material = { cert: issued.cert, key: issued.key, accountKey: issued.accountKey }
  const secret = await createSystemSecret(sys, 'ingress-cert', ws.ingressZone!, {
    workspaceId: ws.id,
    kind:        'tlsCert',
    data:        JSON.stringify(material),
  })

  // Read again: the version the patch left may have moved while the CA worked.
  const fresh = await sys.workspace.findFirst({ where: { id: ws.id }, select: { version: true } }) as { version: number }
  await sys.workspace.update({
    where:  { id: ws.id },
    data:   { ingressCertSecretId: secret.id, ingressCertExpiresAt: issued.expiresAt, version: fresh.version },
    system: ['ingressCertSecretId', 'ingressCertExpiresAt'],
  })
  // The replaced Secret held a private key nothing refers to any more.
  if (ws.ingressCertSecretId) await sys.secret.delete({ where: { id: ws.ingressCertSecretId } })
  return material
}

function namesOf(pem: string): string[] {
  try {
    return (new X509Certificate(pem).subjectAltName ?? '').split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(Boolean)
  } catch { return [] }
}

async function readMaterial(sys: any, secretId: string): Promise<Material | null> {
  const row = await sys.secret.findFirst({ where: { id: secretId } }) as { data?: string } | null
  if (!row?.data) return null
  try {
    const m = JSON.parse(row.data) as Material
    return m.cert && m.key ? m : null
  } catch { return null }
}

/** Every `online` machine of the workspace, asked one thing. */
async function onEachMachine(app: App, workspaceId: string, path: string, body: Record<string, unknown>, log: ReturnType<App['logger']['child']>):
  Promise<{ pushed: string[]; failed: { server: string; error: string }[] }> {
  const sys     = (app.db as any).asSystem()
  const servers = await sys.server.findMany({ where: { workspaceId, status: 'online' }, select: { id: true, name: true } }) as { id: string; name: string | null }[]
  const out = { pushed: [] as string[], failed: [] as { server: string; error: string }[] }
  for (const s of servers) {
    const name     = s.name ?? s.id
    const executor = await executorOn(app, s.id, name)
    if (!isExecutor(executor)) { out.failed.push({ server: name, error: executor.reason }); continue }
    const reply = await executor.call(path, body)
    if (!reply.error) { out.pushed.push(name); log.info('pushed', { path, server: name, ...(reply.data?.stubbed ? { stubbed: true } : {}) }); continue }
    // An outpost from before certificates: nothing a retry changes.
    if (/no such route/i.test(reply.error.message)) { log.warn('outpost too old to hold a certificate', { path, server: name }); continue }
    out.failed.push({ server: name, error: reply.error.message })
  }
  return out
}

/**
 * A release's own half (`FJS-D1975`): the wildcard onto the machine it is about
 * to route, so one enrolled after the mint holds it before it serves. Answers
 * what happened and never throws -- the release goes on, and Phase 2 gates what
 * is served on the certificate being there.
 */
export async function pushIngressCert(app: App, executor: Executor, workspaceId: string):
  Promise<'pushed' | 'none' | 'old-outpost' | { failed: string }> {
  try {
    const sys = (app.db as any).asSystem()
    const ws  = await sys.workspace.findFirst({ where: { id: workspaceId }, select: { ingressCertSecretId: true } }) as { ingressCertSecretId: string | null } | null
    if (!ws?.ingressCertSecretId) return 'none'
    const material = await readMaterial(sys, ws.ingressCertSecretId)
    if (!material) return { failed: 'the certificate Secret holds no material' }
    const reply = await executor.call('/certs/load', { id: INGRESS_CERT_ID, cert: material.cert, key: material.key })
    if (!reply.error) return 'pushed'
    return /no such route/i.test(reply.error.message) ? 'old-outpost' : { failed: reply.error.message }
  } catch (err) {
    return { failed: (err as Error).message }
  }
}
