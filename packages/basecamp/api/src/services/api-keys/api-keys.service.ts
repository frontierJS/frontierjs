// src/services/api-keys/api-keys.service.ts
// API keys — how a MACHINE acting for a person proves identity to Basecamp.
//
// Mounted at /api-keys. Custom methods dispatch on X-Service-Method:
//   revoke · scopes (collection-level)
//
// The third direction, and the one `secrets` and auth's `Credential` do not
// cover between them. A Credential is how a person proves identity to
// Basecamp; a Secret is how Basecamp proves identity to a provider; an ApiKey
// is a token Basecamp ISSUES.
//
// **This service never sees a stored token.** @frontierjs/auth generates it,
// keeps an HMAC of it in a Credential row and is the only thing that can
// verify one; the row here owns the operational half — workspace, scopes,
// usage, revocation. `create` returns the plaintext exactly once, in the
// response to the call that minted it, and there is no second read of it
// anywhere in this app. The mock's `reveal` button is therefore not a feature
// that was skipped: building it would mean storing the token, which is the one
// thing an API key exists not to do.

import { createService, BadRequest, Forbidden, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { findScoped, getScoped, narrowPatch, changesNothing, dbOf, wsOf, actorOf } from '../../core/resource.ts'
import { scopeVocabulary } from './scopes.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext, IAuth } from '@frontierjs/junction'

// ─── Expiry ──────────────────────────────────────────────────────────────
// Server-side, deliberately. A browser computing "90 days" means 90 days by
// whatever the browser's clock says, and the expiry of a credential is not a
// thing to take the caller's word for.

const EXPIRY: Record<string, number | null> = {
  never: null,
  '30d': 30,
  '90d': 90,
  '1y':  365,
}

export const EXPIRY_PRESETS = Object.keys(EXPIRY)

/** `fjs_AbCd…wXyZ` — enough to recognise a key in a list, useless as a token. */
function maskToken(raw: string): string {
  const body = raw.replace(/^fjs_/, '')
  return `fjs_${body.slice(0, 4)}…${body.slice(-4)}`
}

/** active | expired | revoked — derived, never stored. See the schema comment. */
export function statusOf(row: { revokedAt?: string | null; expiresAt?: string | null }): string {
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt && new Date(row.expiresAt) <= new Date()) return 'expired'
  return 'active'
}

const STATUSES = ['active', 'expired', 'revoked']

/** The where-clause for a status. Derived state still has to be queryable. */
function whereStatus(status: string): Record<string, unknown> {
  const now = new Date().toISOString()
  if (status === 'revoked') return { revokedAt: { not: null } }
  if (status === 'expired') return { revokedAt: null, expiresAt: { lte: now } }
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
}

export function createApiKeysService(app: BasecampApp) {

  /** app.auth is optional on the App interface — an app can run without one,
   *  and Junction requires only `verifySession` of the one it has (`FJS-D10`).
   *  This service needs more than that: minting and revoking are auth's,
   *  entirely. Both refusals are sentences rather than a TypeError on
   *  `undefined.createApiKey` — and the second is not hypothetical, since a
   *  provider that verifies sessions and issues no keys is now a legal one. */
  type ApiKeyIssuer = IAuth & Required<Pick<IAuth, 'createApiKey' | 'revokeApiKey'>>

  function authOrRefuse(): ApiKeyIssuer {
    const auth = app.auth
    if (!auth)
      throw new BadRequest('API keys need an auth provider — none is configured on this server')
    if (typeof auth.createApiKey !== 'function' || typeof auth.revokeApiKey !== 'function')
      throw new BadRequest('the configured auth provider does not issue API keys')
    return auth as ApiKeyIssuer
  }

  /**
   * before/create: everything the client did not send — including the token.
   *
   * The mint is HERE rather than in create() for a reason that is not
   * stylistic: `tokenHint` and `credentialId` are columns derived from the
   * token, `tokenHint` is NOT NULL, and autoValidate runs after user hooks and
   * before the method body. Minting in create() means every request 400s with
   * "tokenHint is required" — a field the caller was never meant to send,
   * about a value that does not exist yet.
   *
   * So this hook validates first, mints second, and create() is left with one
   * insert and the job of not leaving a credential behind if it fails.
   *
   * `expiresIn` is the other half: a preset name, not a column, deleted here
   * because autoValidate would strip it anyway and the reader should see it go
   * on purpose. Ruled in DECISIONS.md; the channels service's `secret` is the
   * same shape.
   */
  /**
   * A key may be issued to a BOT in this workspace, and to nothing else.
   *
   * Until bots existed (Phase 10) every key belonged to whoever pressed the
   * button, which is why CI's key was somebody's key and revoking it when they
   * left broke the pipeline. Naming an arbitrary user would be an escalation
   * route — issue a key as the owner, use it, and the trail says the owner did
   * it — so the rule is narrow and checked in three parts:
   *
   *   it is a bot            — a bot has no password credential, so a key is
   *                            the only way it acts and nobody is being
   *                            impersonated
   *   it is in THIS workspace — the key is stamped with wsOf(ctx) either way,
   *                            and a key for a bot from another tenant would
   *                            be a cross-tenant credential
   *   it is not above you    — an admin cannot mint a key for a bot that
   *                            outranks them and then act through it
   */
  async function assertBotOwner(ctx: ServiceContext, userId: string): Promise<string> {
    if (userId === actorOf(ctx)) return userId

    // asSystem(): `kind` is a column on auth's User, which no caller-scoped
    // client here reads — the same reason the hub service is written this way.
    const sys: any = app.data.asSystem()
    const bot = await sys.user.findUnique({ where: { id: userId } })
    if (!bot || bot.kind !== 'bot')
      throw new BadRequest('userId may only name a bot account — create one on the hub Users screen')

    const members = sys.workspaceMember
    const botMember = await members.findFirst({ where: { workspaceId: wsOf(ctx), userId } })
    if (!botMember) throw new BadRequest('That bot is not a member of this workspace')

    const level = { viewer: 1, billing: 1, developer: 2, admin: 3, owner: 4 } as Record<string, number>
    const mine  = level[ctx.locals.memberRole as string ?? ''] ?? 0
    if ((level[botMember.role] ?? 0) > mine)
      throw new Forbidden(`That bot is a ${botMember.role} — you cannot issue a key with more standing than your own`)

    return userId
  }

  async function stampKey(ctx: ServiceContext): Promise<void> {
    const data = ctx.data as Record<string, unknown>
    if (!data) return

    const preset = typeof data.expiresIn === 'string' ? data.expiresIn : 'never'
    delete data.expiresIn
    if (!(preset in EXPIRY))
      throw new BadRequest(`expiresIn must be one of ${EXPIRY_PRESETS.join(', ')}`)
    const days = EXPIRY[preset]
    data.expiresAt = days === null
      ? null
      : new Date(Date.now() + days * 86_400_000).toISOString()

    data.workspaceId = wsOf(ctx)
    data.createdBy   = actorOf(ctx)
    // A key is never more than its owner. The default owner is the caller;
    // naming somebody else is allowed for exactly one kind of somebody else,
    // and assertBotOwner is where that rule lives.
    data.userId      = data.userId ? await assertBotOwner(ctx, data.userId as string) : actorOf(ctx)

    const scopes = (data.scopes ?? []) as string[]
    if (!Array.isArray(scopes) || scopes.length === 0)
      throw new BadRequest('scopes is required — a key with no scopes can do nothing')

    const known = new Set(scopeVocabulary(app).map(s => s.id))
    const bad   = scopes.filter(s => !known.has(s))
    if (bad.length) throw new BadRequest(`unknown scope: ${bad.join(', ')}`)

    if (typeof data.name !== 'string' || !data.name.trim())
      throw new BadRequest('name is required')

    // Checked before the mint, not after: the unique is [workspaceId, name],
    // and a name collision found by SQLite would already have cost a real
    // credential that nothing then points at.
    if (await dbOf(ctx).apiKey.exists({ where: { workspaceId: wsOf(ctx), name: data.name } }))
      throw new BadRequest(`An API key named '${data.name}' already exists in this workspace`)

    // auth mints and hashes. Nothing in this app stores the plaintext; it
    // travels on ctx.locals to the response and stops there.
    const { key, id } = await authOrRefuse().createApiKey(data.userId as string, {
      name:      data.name,
      scopes,
      expiresAt: data.expiresAt ? new Date(data.expiresAt as string) : undefined,
    })

    ctx.locals.mintedToken = key
    data.credentialId      = id
    data.tokenHint         = maskToken(key)
  }

  /**
   * before/find: `status` is derived, so it is not a column, so autoFilter
   * would 400 on it (FJS-109) before find() ever ran. Same shape as the
   * wire-only fields on create, one hop earlier.
   */
  function captureStatus(ctx: ServiceContext): void {
    const q = ctx.query as Record<string, unknown>
    const status = q.status
    delete q.status
    if (status === undefined || status === 'all') return
    if (typeof status !== 'string' || !STATUSES.includes(status))
      throw new BadRequest(`status must be one of all, ${STATUSES.join(', ')}`)
    ctx.locals.statusFilter = status
  }

  /** The shape the UI reads. `status` is derived here so one answer exists. */
  function present(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, status: statusOf(row as { revokedAt?: string; expiresAt?: string }) }
  }

  return createService({
    name:  'api-keys',
    model: 'ApiKey',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const status = ctx.locals.statusFilter as string | undefined
      const page = await findScoped(ctx, 'apiKey', {
        where:   status ? whereStatus(status) : {},
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })
      return { ...page, data: (page.data as Record<string, unknown>[]).map(present) }
    },

    async get(ctx: ServiceContext) {
      return present(await getScoped(ctx, 'apiKey', 'API key'))
    },

    // ── create ────────────────────────────────────────────────────────
    // The only moment the plaintext token exists outside the caller's hands.
    // Everything that decides what the key IS happened in stampKey; this is
    // the insert, plus the one thing an insert can still get wrong.
    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>

      try {
        const row = await dbOf(ctx).apiKey.create({ data })
        // `token` is not a column and is on no later read. The screen has one
        // chance to show it, and says so.
        return { ...present(row), token: ctx.locals.mintedToken }
      } catch (err) {
        // A credential exists now. If the row does not, nothing in this app
        // points at it, nothing can revoke it, and it verifies forever.
        if (data.credentialId)
          await authOrRefuse().revokeApiKey(data.credentialId as string).catch(() => {})
        throw err
      }
    },

    async patch(ctx: ServiceContext) {
      const existing = await getScoped(ctx, 'apiKey', 'API key')

      // Renaming is the only safe change. Scopes and expiry are baked into the
      // credential auth issued, so editing them here would produce a row that
      // describes a key differently from the thing doing the authenticating —
      // rotate instead: revoke, and mint a new one.
      const patch = narrowPatch(ctx.data as Record<string, unknown>, [
        'userId', 'credentialId', 'tokenHint', 'scopes', 'expiresAt',
        'revokedAt', 'lastUsedAt', 'totalUses', 'usageDate', 'usesOnDate', 'createdBy',
      ])

      if (changesNothing(patch)) return present(existing)
      return present(await dbOf(ctx).apiKey.update({ where: { id: existing.id }, data: patch }))
    },

    // ── remove ────────────────────────────────────────────────────────
    // A hard delete — ApiKey declares no @@softDelete, because revocation is
    // already this model's visible "off" and a second hidden one would make
    // four states out of two.
    async remove(ctx: ServiceContext) {
      const row = await getScoped(ctx, 'apiKey', 'API key')

      // Deleting a key that still works has to stop it working. Otherwise the
      // token outlives every record of itself: nothing left to revoke, and the
      // credential still verifying.
      if (row.credentialId) await authOrRefuse().revokeApiKey(row.credentialId)

      await dbOf(ctx).apiKey.delete({ where: { id: row.id } })
      return present(row)
    },

    // ── revoke ────────────────────────────────────────────────────────
    // Deletes the credential — the token stops working on the next request —
    // and keeps the row, so the operator can still see what was revoked and
    // when. credentialId is nulled because after this there is not one.
    async revoke(ctx: ServiceContext) {
      const row = await getScoped(ctx, 'apiKey', 'API key')
      if (row.revokedAt) throw new BadRequest(`'${row.name}' is already revoked`)

      if (row.credentialId) await authOrRefuse().revokeApiKey(row.credentialId)

      return present(await dbOf(ctx).apiKey.update({
        where: { id: row.id },
        data:  { revokedAt: new Date().toISOString(), credentialId: null },
      }))
    },

    // ── scopes ────────────────────────────────────────────────────────
    // Collection-level (no id): the vocabulary is a fact about the server, not
    // about one key. The screen builds its checkboxes from this rather than
    // shipping a copy, which is what keeps a service added later from being
    // invisible to the thing that grants access to it.
    async scopes(ctx: ServiceContext) {
      ctx.dispatch = false          // a read — do not announce it on a channel
      return { scopes: scopeVocabulary(app), expiry: EXPIRY_PRESETS }
    },

    hooks: {
      before: {
        all:    [sessionScope(app), noKeyManagementByKey],
        find:   [captureStatus],
        // Issuing a token that carries your standing is an admin act. A
        // developer who could mint one could hand out their own access.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampKey],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        revoke: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}

/**
 * A key may not manage keys — including its own.
 *
 * The scope hook would already refuse it (there is no `api-keys:*` scope to
 * hold), but that leaves the rule as an absence, and an absence is not
 * something a reader can find. Stated here it is one line with a reason.
 */
function noKeyManagementByKey(ctx: ServiceContext): void {
  const user = ctx.auth?.user as { authMethod?: string } | undefined
  if (user?.authMethod === 'apiKey')
    throw new Forbidden('An API key cannot manage API keys — sign in to issue or revoke one')
}
