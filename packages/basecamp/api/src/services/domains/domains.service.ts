// src/services/domains/domains.service.ts
// The hostnames an App answers on, and the certificates that terminate them.
//
// Mounted at /domains. Custom methods dispatch on X-Service-Method:
//   uploadCert · makePrimary
//
// This is the model `App.domain` could not be. One nullable string described
// exactly one hostname, with no certificate, no redirect and no primary — and
// an apex plus a www is the ordinary case, not the exception.
//
// **Two things are deliberately NOT columns.**
//
// The certificate MATERIAL is a `Secret` of kind `tlsCert`, referenced by
// `certSecretId`. `Secret.data` is `@encrypted`, so the private key is written
// once and never read back: it is absent from every response, and absent from
// the database file in plaintext. A `keyPem` column here would have undone that
// at the Data boundary, which is the only place it is enforceable.
//
// And `certStatus` is DERIVED from `certExpiresAt` on read. Storing both a
// status and an expiry is two owners of one fact, and the stored one is the one
// that silently goes stale overnight — a certificate does not expire when
// somebody remembers to run an update.

import { createService, NotFound, BadRequest, Conflict, parseWhere, $ } from '@frontierjs/junction'
import { createSystemSecret } from '../../domain/secret/system-secret.ts'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, restoreScoped, narrowPatch, changesNothing, ws, actor }
  from '../../core/resource.ts'
import domainDns from '../../jobs/domain-dns.job.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { syncManagedMonitor } from '../../domain/monitor/managed.ts'

const DAY = 86_400_000

/** How close to the edge counts as "renew this". The mock's own threshold. */
const EXPIRING_WITHIN_DAYS = 30

export type CertStatus = 'none' | 'active' | 'expiring_soon' | 'expired'

/**
 * The one definition of a certificate's condition.
 *
 * Exported because the notice rules will want it and a second copy would
 * disagree the first time the threshold moves.
 */
export function certStatusOf(
  domain: { certSecretId?: string | null; certExpiresAt?: string | null },
  now = Date.now(),
): { cert_status: CertStatus; cert_days_remaining: number | null } {
  if (!domain.certSecretId) return { cert_status: 'none', cert_days_remaining: null }

  const expires = Date.parse(domain.certExpiresAt ?? '')
  if (Number.isNaN(expires)) return { cert_status: 'active', cert_days_remaining: null }

  const days = Math.floor((expires - now) / DAY)
  if (days < 0)                    return { cert_status: 'expired',       cert_days_remaining: days }
  if (days <= EXPIRING_WITHIN_DAYS) return { cert_status: 'expiring_soon', cert_days_remaining: days }
  return { cert_status: 'active', cert_days_remaining: days }
}

const decorate = (row: Record<string, unknown>) => ({ ...row, ...certStatusOf(row as never) })

async function appInWorkspace(appId: string) {
  const row = await db().app.findFirst({ where: { id: appId, workspaceId: ws() } })
  if (!row) throw new NotFound(`App '${appId}' not found in this workspace`)
  return row
}

/** Exactly one primary per app. Demoting the others is the write that makes
 *  "primary" mean something; without it two rows both claim it and the
 *  screen picks whichever sorted first. */
async function demoteSiblings(appId: string, keepId: string) {
  const siblings = await db().domain.findMany({ where: { appId, isPrimary: true } })
  for (const sib of siblings)
    if (sib.id !== keepId)
      // Domain declares @version, so every scoped update states the version it
      // read. Not a formality here: two people promoting different hostnames
      // at once is exactly the race, and the loser is told rather than
      // silently demoted back.
      await db().domain.update({
        where: { id: sib.id },
        data:  { isPrimary: false, version: sib.version },
      })
}

/** Tell the zone. The id is the row's version, so a replayed write is one
 *  push; the job decides whether this workspace pushes at all. */
export const toZone = (domainId: string, version: number | string) =>
  $.app.jobs.dispatch(domainDns, { domainId }, { id: `dns:${domainId}:${version}` })

/** The App's managed Monitor follows its primary hostname (`FJS-D1859`). Every
 *  write that can move the primary calls this, or the Monitor probes a hostname
 *  the App no longer answers on. */
const toMonitor = (appId: string) => syncManagedMonitor($.app, $.db.asSystem(), appId)

async function patchDomain() {
  const domain = await getScoped('domain', 'Domain')
  // appId is immutable — moving a hostname to another app is a delete and a
  // create, and doing it as a patch would carry the certificate with it.
  // So is the hostname, for the same reason twice over: a certificate is
  // FOR a hostname, and the CNAME pushed for the old one would stay in its
  // zone marked as this row's, which no drift reports as wrong. Refused
  // rather than dropped, or a save that changed nothing looks like one
  // that renamed it. A form resending the same hostname is not a change.
  const asked = ($.data ?? {}) as Record<string, unknown>
  if ('hostname' in asked && String(asked.hostname).trim().toLowerCase() !== domain.hostname.toLowerCase())
    throw new BadRequest('A hostname is fixed once added — add the new one, then delete this one')
  const patch = narrowPatch($.data as Record<string, unknown>)

  if (changesNothing(patch)) return decorate(domain)

  const updated = await db().domain.update({ where: { id: domain.id }, data: patch })
  if (updated.isPrimary) await demoteSiblings(updated.appId, updated.id)
  await toZone(updated.id, updated.version)
  await toMonitor(updated.appId)
  return decorate(updated)
}

export default createService({
  name:  'domains',
  scope: keyScope('domains'),
  model: 'Domain',
  paginate: { default: 20, max: 200 },
  // The whole surface: a service gaining `input:` lists every verb it answers.
  methods: [
    'find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore',
    'makePrimary',
    { method: 'uploadCert', input: 'DomainCertUpload' },
  ],
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

  async find() {
    const { limit, offset } = getPagination()
    // Every filter the caller sent: a column autoFilter admitted and this body
    // skipped answered every row, so ?hostname= came back as the workspace.
    const result = await findScoped('domain', {
      where:   parseWhere($.query),
      orderBy: { hostname: 'asc' },
      limit, offset,
    })
    return { ...result, data: (result.data as Record<string, unknown>[]).map(decorate) }
  },

  async get() {
    return decorate(await getScoped('domain', 'Domain'))
  },

  async create() {
    const data = $.data as Record<string, unknown>
    await appInWorkspace(data.appId as string)

    // The first hostname an app gets IS its primary — nobody means to add a
    // domain and leave the app with none.
    const existing = await db().domain.count({ where: { appId: data.appId } })
    if (existing === 0) data.isPrimary = true

    const created = await db().domain.create({ data })
    if (created.isPrimary) await demoteSiblings(created.appId, created.id)
    await toZone(created.id, created.version)
    await toMonitor(created.appId)
    return decorate(created)
  },

  // `update` is `patch` with an id required; left out, the base CRUD answers a
  // PUT and it skips the primary demotion, the zone push and the Monitor sync.
  async update() {
    return patchDomain()
  },

  async patch() {
    return patchDomain()
  },

  async remove() {
    const domain = await getScoped('domain', 'Domain')
    // Refused rather than silently repointing: which hostname is primary is a
    // routing decision, and making it by deletion is how an app ends up
    // answering on one nobody chose.
    if (domain.isPrimary && await db().domain.count({ where: { appId: domain.appId } }) > 1)
      throw new Conflict('That is the primary hostname — make another one primary first')

    const removed = await removeScoped('domain', 'Domain')
    // Removing and restoring move no version, so only the stamp tells a second
    // delete from the first: a repeated job id queues nothing and the CNAME stays.
    await toZone(domain.id, `${domain.version}:removed:${removed.deletedAt}`)
    await toMonitor(domain.appId)
    return removed
  },

  // A Domain brought back is a hostname to push again — its CNAME went when
  // it was deleted.
  async restore() {
    const restored = await restoreScoped('domain', 'Domain')
    await toZone(restored.id, `${restored.version}:restored:${restored.updatedAt}`)
    await toMonitor(restored.appId)
    return decorate(restored)
  },

  // ── uploadCert ────────────────────────────────────────────────────
  // The certificate arrives here ONCE. The material goes into a Secret,
  // whose `data` is `@encrypted`; this row keeps only what an operator reads.
  async uploadCert() {
    const domain = await getScoped('domain', 'Domain')
    const { certPem, keyPem, kind, issuedAt, expiresAt } =
      ($.data ?? {}) as Record<string, string>

    const secret = await createSystemSecret(db(), 'tls', domain.hostname as string, {
      workspaceId: ws(),
      kind:        'tlsCert',
      // One value, both halves. Splitting them across two Secrets would
      // let a rotation replace one and not the other.
      data:        JSON.stringify({ certPem, keyPem }),
      createdBy:   actor(),
    })

    const cert = {
      certSecretId:  secret.id,
      certKind:      kind ?? 'uploaded',
      certIssuedAt:  issuedAt ?? new Date().toISOString(),
      certExpiresAt: expiresAt,
    }
    const updated = await db().domain.update({
      where: { id: domain.id },
      data: { ...cert, version: domain.version },
      system: Object.keys(cert),
    })
    return decorate(updated)
  },

  // ── makePrimary ───────────────────────────────────────────────────
  async makePrimary() {
    const domain = await getScoped('domain', 'Domain')
    if (domain.isPrimary) throw new BadRequest('Already the primary hostname')

    const updated = await db().domain.update({
      where: { id: domain.id }, data: { isPrimary: true, version: domain.version },
    })
    await demoteSiblings(updated.appId, updated.id)
    await toMonitor(updated.appId)
    return decorate(updated)
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      // A hostname decides where traffic lands and a certificate decides
      // whether it is private. Both are admin acts.
      // No deriveSlug: `Domain` has neither `name` nor `slug`, so it was a
      // hook that could never fire.
    },
  },
})
