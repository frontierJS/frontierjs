// src/services/secrets/secrets.service.ts
// Secrets — how BASECAMP proves identity to a machine.
//
// Mounted at /secrets. Custom methods dispatch on X-Service-Method:
//   verify
//
// Not `Credential`, which is how a PERSON proves identity to Basecamp and
// belongs to @frontierjs/auth. `db/README.md` records that rename; this service
// is the other half of it finally having an API.
//
// **The plaintext never comes back.** `Secret.data` is `@encrypted` in the
// schema, so Litestone omits the key entirely from every read — a listed row
// has no `data` property at all, not an empty one. That is enforced at the Data
// boundary, which is why this file contains no redaction code: a service that
// redacted by hand would be a second owner of the same rule, and the one that
// mattered would be the one somebody forgot to write.
//
// Verified in the Data realm rebuild by planting an SSH key through the real
// client: 0 occurrences in `strings bc.db`, 0 in the audit log.

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, narrowPatch, changesNothing, ws, actor }
  from '../../core/resource.ts'
import { connectorFor, targetFor } from '../../providers/compute/index.ts'
import { registerAccount, unregisterAccount, sendVia, tokenDocument, TOKEN_FIELD }
  from '../../providers/compute/accounts.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ProviderKind }   from '../../../../db/schema.d.ts'

const KINDS = ['ssh_key', 'provider_key', 'registry_auth', 'tls_cert', 'notification', 'generic']

export function createSecretsService(app: BasecampApp) {

  /** Secret has no `slug` column, so the shared deriveSlug — which derives
   *  one from `name` — would add a key autoValidate then strips. Stamping what
   *  this model actually has says so out loud instead of relying on that. */
  function stampSecret(): void {
    const data = $.data as Record<string, unknown>
    if (!data) return
    data.createdBy   = actor()
  }

  /**
   * A provider key's value has ONE shape: `{"token": "…"}`.
   *
   * The ref a Conduit descriptor carries is `secret:<id>#token`, resolved at
   * send time, so the field name is part of the contract rather than a
   * convention — a row holding a bare string resolves to the whole document and
   * signs a request with `{"token":"…"}` as the credential, which fails at the
   * vendor with an authentication error nobody can trace back to here.
   *
   * A person types a token, not a JSON document, so the wrapping is done here.
   * Already-shaped input is left alone, which is what makes this idempotent
   * across a create and the rotation in `patch`.
   */
  function normalizeProviderKey(data: Record<string, unknown>): void {
    if (data.kind !== 'provider_key') return

    if (!data.providerKind)
      throw new BadRequest('providerKind is required on a provider key — which cloud this token opens')
    if (!connectorFor(data.providerKind as ProviderKind))
      throw new BadRequest(`Basecamp has no connector for '${data.providerKind}'`)

    const raw = String(data.data ?? '').trim()
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && typeof parsed[TOKEN_FIELD] === 'string') return
    } catch { /* not JSON — a bare token, which is what a person types */ }

    data.data = tokenDocument(raw)
  }

  return createService({
    name:  'secrets',
    model: 'Secret',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const kind = $.query.kind as string | undefined
      return findScoped('secret', {
        where:   { ...(kind ? { kind } : {}) },
        orderBy: { name: 'asc' },
        limit, offset,
      })
    },

    async get() {
      return getScoped('secret', 'Secret')
    },

    async create() {
      const data = $.data as Record<string, unknown>
      if (data.kind && !KINDS.includes(data.kind as string))
        throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`)
      if (!data.data) throw new BadRequest('data is required — a secret with no value is a name')

      normalizeProviderKey(data)

      // The unique is [workspaceId, name], and a raw constraint violation
      // reaches an HTTP caller as a SQLite message rather than a sentence.
      if (await db().secret.exists({ where: { workspaceId: ws(), name: data.name } }))
        throw new BadRequest(`A secret named '${data.name}' already exists in this workspace`)

      const secret = await db().secret.create({ data })

      // A cloud account becomes an ADDRESS the moment it exists. Registered
      // here rather than only at boot, because the person who just typed a
      // token expects the next screen to be able to spend it — and re-registered
      // at boot for every row that already exists (`providers/compute/accounts.ts`).
      await registerAccount(app, secret as { id: string; kind?: string; providerKind?: ProviderKind | null })

      return secret
    },

    async patch() {
      await getScoped('secret', 'Secret')
      const data = $.data as Record<string, unknown>

      if (data.kind && !KINDS.includes(data.kind as string))
        throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`)

      // Rotating the value is allowed and is the point of patch here. What is
      // NOT allowed is kind and createdBy: a secret that changes what it IS
      // invalidates everything holding it, and who added it is a fact.
      const patch = narrowPatch(data, ['kind', 'createdBy', 'providerKind'])

      // A rotated secret is unverified again until something proves otherwise.
      // The ref is `secret:<id>#token` and the id has not changed, so a rotated
      // token is picked up by the next send with nothing re-registered — which
      // is the whole reason the target is keyed on the row rather than on the
      // material.
      if ('data' in patch) {
        patch.isVerified = false

        // The row says what KIND it is — `kind` cannot be patched — so the
        // shape a rotated value must take is read off the existing row rather
        // than off the payload, which carries only the new token.
        const current = await getScoped('secret', 'Secret')
        const shaped: Record<string, unknown> = {
          data: patch.data, kind: current.kind, providerKind: current.providerKind,
        }
        normalizeProviderKey(shaped)
        patch.data = shaped.data
      }

      if (changesNothing(patch)) return getScoped('secret', 'Secret')
      return db().secret.update({ where: { id: $.id as string }, data: patch })
    },

    async remove() {
      // Read before the delete: an account's target is keyed on the row, and
      // after `removeScoped` there is no row to ask which cloud it named.
      // Deregistered rather than left to fail — a revoked key that is still a
      // registered address answers `auth_failed` on a screen, where an absent
      // one says the account is gone.
      const secret  = await getScoped('secret', 'Secret')
      const removed = await removeScoped('secret', 'Secret')
      await unregisterAccount(app, secret as { id: string; providerKind?: ProviderKind | null })
      return removed
    },

    // ── verify ────────────────────────────────────────────────────────
    //
    // Does this credential open what it claims to?
    //
    // For a `provider_key` the question is now ASKED: the connector makes the
    // cheapest authenticated read the vendor offers, and a token the vendor
    // rejects leaves the flag false and says so. That is the whole difference
    // between a flag and evidence, and until there was a connector this method
    // could only be the former.
    //
    // Every other kind is still a person asserting it. An SSH key opens a
    // machine, and testing it means connecting to one — which is a different
    // capability and is `docs/PROVISIONING.md` phase 5's. Stated out loud on
    // the answer (`tested`), because a caller cannot otherwise tell which of
    // the two just happened, and *verified* meaning two things is how a flag
    // gets read as evidence it is not.
    async verify() {
      const secret    = await getScoped('secret', 'Secret')
      const connector = secret.kind === 'provider_key'
        ? connectorFor(secret.providerKind as ProviderKind | null)
        : null

      let ok     = true
      let tested = false

      if (connector) {
        tested = true
        const target = targetFor(connector.kind, secret.id as string)
        try {
          ok = await connector.verify(sendVia(app, target))
        } catch (err) {
          // Not knowing is not the same as a bad token, and neither is a
          // reason to mark a working credential broken — so the failure is
          // reported and the flag is left where it was.
          app.logger.warn('secrets: verify could not reach the provider', {
            secret_id: secret.id, provider: secret.providerKind, error: String(err),
          })
          throw new BadRequest(`Could not reach ${connector.label} to check this token`)
        }
      }

      const updated = await db().secret.update({
        where: { id: secret.id },
        data:  { isVerified: ok, version: secret.version },
      })
      return { ...updated, tested }
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Every write is admin/owner. A developer who can add a deploy key can
        // reach whatever that key opens, so this is not the same bar as
        // creating a project.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampSecret],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        verify: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Reads are NOT restricted further, because there is nothing sensitive
        // in one: the value is stripped at the Data boundary, so a viewer sees
        // that a secret exists and never what it is.
      },
    },
  })
}
