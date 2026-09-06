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
// The certificate MATERIAL is a `Secret` of kind `tls_cert`, referenced by
// `certSecretId`. `Secret.data` is `@encrypted`, so the private key is written
// once and never read back: it is absent from every response, and absent from
// the database file in plaintext. A `keyPem` column here would have undone that
// at the Data boundary, which is the only place it is enforceable.
//
// And `certStatus` is DERIVED from `certExpiresAt` on read. Storing both a
// status and an expiry is two owners of one fact, and the stored one is the one
// that silently goes stale overnight — a certificate does not expire when
// somebody remembers to run an update.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, narrowPatch, changesNothing, ws, actor }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

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

export function createDomainsService(app: BasecampApp) {

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

  return createService({
    name:  'domains',
    model: 'Domain',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const appId = $.query.appId as string | undefined

      const result = await findScoped('domain', {
        where:   { ...(appId ? { appId } : {}) },
        orderBy: { hostname: 'asc' },
        limit, offset,
      })
      return { ...result, data: result.data.map(decorate) }
    },

    async get() {
      return decorate(await getScoped('domain', 'Domain'))
    },

    async create() {
      const data = $.data as Record<string, unknown>
      await appInWorkspace(data.appId as string)

      // The unique is [workspaceId, hostname], and a raw constraint violation
      // reaches an HTTP caller as a SQLite message rather than a sentence.
      if (await db().domain.exists({ where: { workspaceId: ws(), hostname: data.hostname } }))
        throw new Conflict(`'${data.hostname}' is already claimed in this workspace`)

      // The first hostname an app gets IS its primary — nobody means to add a
      // domain and leave the app with none.
      const existing = await db().domain.count({ where: { appId: data.appId } })
      if (existing === 0) data.isPrimary = true

      const created = await db().domain.create({ data })
      if (created.isPrimary) await demoteSiblings(created.appId, created.id)
      return decorate(created)
    },

    async patch() {
      const domain = await getScoped('domain', 'Domain')
      // appId is immutable — moving a hostname to another app is a delete and a
      // create, and doing it as a patch would carry the certificate with it.
      // The cert columns are `uploadCert`'s, never a client's.
      const patch = narrowPatch($.data as Record<string, unknown>,
        ['appId', 'certSecretId', 'certKind', 'certIssuedAt', 'certExpiresAt'])

      if (changesNothing(patch)) return decorate(domain)

      const updated = await db().domain.update({ where: { id: domain.id }, data: patch })
      if (updated.isPrimary) await demoteSiblings(updated.appId, updated.id)
      return decorate(updated)
    },

    async remove() {
      const domain = await getScoped('domain', 'Domain')
      // Refused rather than silently repointing: which hostname is primary is a
      // routing decision, and making it by deletion is how an app ends up
      // answering on one nobody chose.
      if (domain.isPrimary && await db().domain.count({ where: { appId: domain.appId } }) > 1)
        throw new Conflict('That is the primary hostname — make another one primary first')

      return removeScoped('domain', 'Domain')
    },

    // ── uploadCert ────────────────────────────────────────────────────
    // The certificate arrives here ONCE. The material goes into a Secret,
    // whose `data` is `@encrypted`; this row keeps only what an operator reads.
    async uploadCert() {
      const domain = await getScoped('domain', 'Domain')
      const { certPem, keyPem, kind, issuedAt, expiresAt } =
        ($.data ?? {}) as Record<string, string>

      if (!certPem || !keyPem) throw new BadRequest('certPem and keyPem are both required')
      if (!expiresAt || Number.isNaN(Date.parse(expiresAt)))
        throw new BadRequest('expiresAt is required and must be a date — it is what decides renewal')

      const secret = await db().secret.create({
        data: {
          workspaceId: ws(),
          name:        `tls:${domain.hostname}`,
          kind:        'tls_cert',
          // One value, both halves. Splitting them across two Secrets would
          // let a rotation replace one and not the other.
          data:        JSON.stringify({ certPem, keyPem }),
          createdBy:   actor(),
          isVerified:  false,
        },
      })

      const updated = await db().domain.update({
        where: { id: domain.id },
        data: {
          certSecretId:  secret.id,
          certKind:      kind ?? 'uploaded',
          certIssuedAt:  issuedAt ?? new Date().toISOString(),
          certExpiresAt: expiresAt,
          version:       domain.version,
        },
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
      return decorate(updated)
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // A hostname decides where traffic lands and a certificate decides
        // whether it is private. Both are admin acts.
        // No deriveSlug: `Domain` has neither `name` nor `slug`, so it was a
        // hook that could never fire.
        create:      [requireWorkspaceRole(app, 'admin', 'owner')],
        patch:       [requireWorkspaceRole(app, 'admin', 'owner')],
        remove:      [requireWorkspaceRole(app, 'admin', 'owner')],
        uploadCert:  [requireWorkspaceRole(app, 'admin', 'owner')],
        makePrimary: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
