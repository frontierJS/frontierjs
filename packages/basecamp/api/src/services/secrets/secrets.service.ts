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

import { createService, BadRequest, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, narrowPatch, changesNothing, dbOf, wsOf, actorOf }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

const KINDS = ['ssh_key', 'provider_key', 'registry_auth', 'tls_cert', 'generic']

export function createSecretsService(app: BasecampApp) {

  /** Secret has no `slug` column, so the shared stampWorkspace — which derives
   *  one from `name` — would add a key autoValidate then strips. Stamping what
   *  this model actually has says so out loud instead of relying on that. */
  function stampSecret(ctx: ServiceContext): void {
    const data = ctx.data as Record<string, unknown>
    if (!data) return
    data.workspaceId = wsOf(ctx)
    data.createdBy   = actorOf(ctx)
  }

  return createService({
    name:  'secrets',
    model: 'Secret',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const kind = ctx.query.kind as string | undefined
      return findScoped(ctx, 'secret', {
        where:   { ...(kind ? { kind } : {}) },
        orderBy: { name: 'asc' },
        limit, offset,
      })
    },

    async get(ctx: ServiceContext) {
      return getScoped(ctx, 'secret', 'Secret')
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      if (data.kind && !KINDS.includes(data.kind as string))
        throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`)
      if (!data.data) throw new BadRequest('data is required — a secret with no value is a name')

      // The unique is [workspaceId, name], and a raw constraint violation
      // reaches an HTTP caller as a SQLite message rather than a sentence.
      if (await dbOf(ctx).secret.exists({ where: { workspaceId: wsOf(ctx), name: data.name } }))
        throw new BadRequest(`A secret named '${data.name}' already exists in this workspace`)

      return dbOf(ctx).secret.create({ data })
    },

    async patch(ctx: ServiceContext) {
      await getScoped(ctx, 'secret', 'Secret')
      const data = ctx.data as Record<string, unknown>

      if (data.kind && !KINDS.includes(data.kind as string))
        throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`)

      // Rotating the value is allowed and is the point of patch here. What is
      // NOT allowed is kind and createdBy: a secret that changes what it IS
      // invalidates everything holding it, and who added it is a fact.
      const patch = narrowPatch(data, ['kind', 'createdBy'])

      // A rotated secret is unverified again until something proves otherwise.
      if ('data' in patch) patch.isVerified = false

      if (changesNothing(patch)) return getScoped(ctx, 'secret', 'Secret')
      return dbOf(ctx).secret.update({ where: { id: ctx.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      return removeScoped(ctx, 'secret', 'Secret')
    },

    // ── verify ────────────────────────────────────────────────────────
    // Marks a secret as known-good. It does NOT test the credential against
    // whatever it opens: that needs the thing on the other end, which is an
    // adapter this app does not have yet. Stated rather than faked — a verify
    // that always says yes is worse than no verify, because the flag is then
    // read as evidence.
    async verify(ctx: ServiceContext) {
      const secret = await getScoped(ctx, 'secret', 'Secret')
      return dbOf(ctx).secret.update({
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
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
