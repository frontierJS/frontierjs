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
import type { BasecampApp }    from '../../basecamp.types.ts'

const KINDS = ['ssh_key', 'provider_key', 'registry_auth', 'tls_cert', 'generic']

export function createSecretsService(app: BasecampApp) {

  /** Secret has no `slug` column, so the shared deriveSlug — which derives
   *  one from `name` — would add a key autoValidate then strips. Stamping what
   *  this model actually has says so out loud instead of relying on that. */
  function stampSecret(): void {
    const data = $.data as Record<string, unknown>
    if (!data) return
    data.createdBy   = actor()
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

      // The unique is [workspaceId, name], and a raw constraint violation
      // reaches an HTTP caller as a SQLite message rather than a sentence.
      if (await db().secret.exists({ where: { workspaceId: ws(), name: data.name } }))
        throw new BadRequest(`A secret named '${data.name}' already exists in this workspace`)

      return db().secret.create({ data })
    },

    async patch() {
      await getScoped('secret', 'Secret')
      const data = $.data as Record<string, unknown>

      if (data.kind && !KINDS.includes(data.kind as string))
        throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`)

      // Rotating the value is allowed and is the point of patch here. What is
      // NOT allowed is kind and createdBy: a secret that changes what it IS
      // invalidates everything holding it, and who added it is a fact.
      const patch = narrowPatch(data, ['kind', 'createdBy'])

      // A rotated secret is unverified again until something proves otherwise.
      if ('data' in patch) patch.isVerified = false

      if (changesNothing(patch)) return getScoped('secret', 'Secret')
      return db().secret.update({ where: { id: $.id as string }, data: patch })
    },

    async remove() {
      return removeScoped('secret', 'Secret')
    },

    // ── verify ────────────────────────────────────────────────────────
    // Marks a secret as known-good. It does NOT test the credential against
    // whatever it opens: that needs the thing on the other end, which is an
    // adapter this app does not have yet. Stated rather than faked — a verify
    // that always says yes is worse than no verify, because the flag is then
    // read as evidence.
    async verify() {
      const secret = await getScoped('secret', 'Secret')
      return db().secret.update({
        where: { id: secret.id },
        data:  { isVerified: true, version: secret.version },
      })
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
