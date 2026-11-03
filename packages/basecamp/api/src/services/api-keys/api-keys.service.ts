// src/services/api-keys/api-keys.service.ts
// API keys — how a MACHINE acting for a person proves identity to Basecamp.
//
// Mounted at /api-keys. Custom methods dispatch on X-Service-Method:
//   revoke · scopes · owners · enrollPeer (the last three collection-level)
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

import { createService, BadRequest, Conflict, Forbidden, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { sessionScope, workspaceChannel, getPagination, roleOf, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, ws, actor, slugify } from '../../core/resource.ts'
import { grantsFor } from '../../core/capabilities.ts'
import { scopeVocabulary, WHOLE_KEY } from '../../domain/api-key/scopes.ts'
import { WORKSPACE_ROLE_LEVEL } from '../../core/gate.ts'
import type { IAuth } from '@frontierjs/junction'

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

/** `fjs_AbCd…wXyZ` — enough to recognize a key in a list, useless as a token. */
export function maskToken(raw: string): string {
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

/** app.auth is optional on the App interface — an app can run without one,
 *  and Junction requires only `verifySession` of the one it has (`FJS-D10`).
 *  This service needs more than that: minting and revoking are auth's,
 *  entirely. Both refusals are sentences rather than a TypeError on
 *  `undefined.createApiKey` — and the second is not hypothetical, since a
 *  provider that verifies sessions and issues no keys is now a legal one. */
type ApiKeyIssuer = IAuth & Required<Pick<IAuth, 'createApiKey' | 'revokeApiKey'>>

function authOrRefuse(): ApiKeyIssuer {
  const auth = $.app.auth
  if (!auth)
    throw new BadRequest('API keys need an auth provider — none is configured on this server')
  if (typeof auth.createApiKey !== 'function' || typeof auth.revokeApiKey !== 'function')
    throw new BadRequest('the configured auth provider does not issue API keys')
  return auth as ApiKeyIssuer
}

/**
 * before/create: shapes what the model validates. `expiresIn` is a preset
 * name, not a column, and becomes `expiresAt`; an absent `userId` is the
 * caller. Nothing here spends anything: the mint is in create(), after
 * autoValidate has graded the payload, because a credential minted ahead of
 * a refusal is one that has to be revoked again.
 */
function shapeKey(): void {
  const data = $.data as Record<string, unknown> | undefined
  if (!data) return
  const preset = typeof data.expiresIn === 'string' ? data.expiresIn : 'never'
  delete data.expiresIn
  if (!(preset in EXPIRY))
    throw new BadRequest(`expiresIn must be one of ${EXPIRY_PRESETS.join(', ')}`)
  const days = EXPIRY[preset]
  data.expiresAt = days === null
    ? null
    : new Date(Date.now() + days * 86_400_000).toISOString()
  data.userId ??= actor()
}

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
 *   it is in THIS workspace — the key is stamped with ws() either way,
 *                            and a key for a bot from another tenant would
 *                            be a cross-tenant credential
 *   it is not above you    — an admin cannot mint a key for a bot that
 *                            outranks them and then act through it
 */
function outranksCaller(role: string): boolean {
  return (WORKSPACE_ROLE_LEVEL[role] ?? 0) > (WORKSPACE_ROLE_LEVEL[roleOf($) ?? ''] ?? 0)
}

async function assertBotOwner(userId: string): Promise<string> {
  if (userId === actor()) return userId

  // asSystem(): `kind` is a column on auth's User, which no caller-scoped
  // client here reads — the same reason the hub service is written this way.
  const sys: any = $.db.asSystem()
  const bot = await sys.user.findUnique({ where: { id: userId } })
  if (!bot || bot.kind !== 'bot')
    throw new BadRequest('userId may only name a bot account — create one on the hub Users screen')

  const members = sys.workspaceMember
  const botMember = await members.findFirst({ where: { workspaceId: ws(), userId } })
  if (!botMember) throw new BadRequest('That bot is not a member of this workspace')

  if (outranksCaller(botMember.role))
    throw new Forbidden(`That bot is a ${botMember.role} — you cannot issue a key with more standing than your own`)

  return userId
}

// What the model cannot say — which scopes exist, whose key it is, a name
// taken — is checked here, ahead of the mint.
async function mintKey(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // A key is never more than its owner. The default owner is the caller;
  // naming somebody else is allowed for exactly one kind of somebody else,
  // and assertBotOwner is where that rule lives.
  const userId = await assertBotOwner(input.userId as string)

  const scopes = (input.scopes ?? []) as string[]
  if (!Array.isArray(scopes) || scopes.length === 0)
    throw new BadRequest('scopes is required — a key with no scopes can do nothing')

  const known = new Set(scopeVocabulary($.app).map(s => s.id))
  const bad   = scopes.filter(s => !known.has(s))
  if (bad.length) throw new BadRequest(`unknown scope: ${bad.join(', ')}`)

  // A whole key is one minted with no scopes, which junction holds to none;
  // `admin` beside a scope would read as narrowing and grant everything.
  if (scopes.includes(WHOLE_KEY) && scopes.length > 1)
    throw new BadRequest(`'${WHOLE_KEY}' is every scope, so it is issued alone`)
  const granted = scopes.includes(WHOLE_KEY) ? [] : scopes

  const name = input.name as string

  // Checked before the mint, not after: the unique is [workspaceId, name],
  // and a name collision found by SQLite would already have cost a real
  // credential that nothing then points at. The constraint stays the rule.
  if (await db().apiKey.exists({ where: { workspaceId: ws(), name } }))
    throw new Conflict(`An API key named '${name}' already exists in this workspace`)

  // auth mints and hashes. Nothing in this app stores the plaintext; it
  // travels on $.locals to the response and stops there.
  const { key, id } = await authOrRefuse().createApiKey(userId, {
    name,
    scopes:    granted,
    expiresAt: input.expiresAt ? new Date(input.expiresAt as string) : undefined,
  })

  $.locals.mintedToken = key
  return {
    name, userId,
    expiresAt:    input.expiresAt ?? null,
    scopes:       granted,
    createdBy:    actor(),
    credentialId: id,
    tokenHint:    maskToken(key),
  }
}

// ─── Peers ───────────────────────────────────────────────────────────────
// Another app, acting as itself (`FJS-D1196`): a User of kind `peer` that owns
// a key enrolled under the peer's own Ed25519 pair (`FJS-D1604`). Basecamp
// keeps only the public half, so nothing here can sign as the peer.

/** Not a deliverable domain, as a bot's is not: nothing is ever sent to a peer. */
const PEER_EMAIL_DOMAIN = 'peers.invalid'
/** Above a bot's default: a preview creates an Environment, which is admin's
 *  to create. The key's scopes, not the role, are what narrow the peer. */
const PEER_ROLE = 'admin'
/** What a peer's key reaches when the enrollment names nothing: a preview, alone. */
export const PEER_SCOPES = ['apps:preview']

/** An Ed25519 public key as `generateSigningKeys` emits it — 32 raw bytes, base64url — or null. */
export function asPeerKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return null
  return Buffer.from(key, 'base64url').length === 32 ? key : null
}

/** A peer key is always scoped: one issued whole would reach every service added later. */
function peerScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return PEER_SCOPES
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(s => typeof s !== 'string'))
    throw new BadRequest('scopes is a list of scope names — a peer key with none would reach everything')
  if (raw.includes(WHOLE_KEY)) throw new BadRequest(`a peer's key is never issued '${WHOLE_KEY}'`)
  const known = new Set(scopeVocabulary($.app).map(s => s.id))
  const bad   = raw.filter(s => !known.has(s))
  if (bad.length) throw new BadRequest(`unknown scope: ${bad.join(', ')}`)
  return raw
}

/** `ed25519 AbCd…wXyZ` — the row's hint, recognizable beside the peer's own copy. */
const peerHint = (key: string) => `ed25519 ${key.slice(0, 4)}…${key.slice(-4)}`

async function enrollPeer(input: Record<string, unknown>): Promise<{ id: string, userId: string, name: string }> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 200) throw new BadRequest('name is required — what this screen calls the peer, up to 200 characters')
  const publicKey = asPeerKey(input.publicKey)
  if (!publicKey) throw new BadRequest('publicKey is not an Ed25519 public key — paste the 43-character key the peer shows')
  const scopes = peerScopes(input.scopes)

  if (await db().apiKey.exists({ where: { workspaceId: ws(), name } }))
    throw new Conflict(`An API key named '${name}' already exists in this workspace`)
  if (await db().apiKey.exists({ where: { workspaceId: ws(), publicKey } }))
    throw new Conflict('That public key is already enrolled in this workspace — revoke it to enroll it again')

  // asSystem(): `kind` is @system on auth's User and no caller writes it, the
  // same reason the hub's createBot is written this way. One transaction: a
  // peer with no membership is an account nothing reaches and nothing cleans up.
  const sys: any = $.db.asSystem()
  const workspace = await sys.workspace.findUnique({ where: { id: ws() }, select: { accountId: true } })
  const now  = new Date().toISOString()
  const peer = await sys.$transaction(async (tx: any) => {
    const user = await tx.user.create({ data: {
      email: `${slugify(name) || 'peer'}-${crypto.randomUUID().slice(0, 8)}@${PEER_EMAIL_DOMAIN}`,
      name, displayName: name, kind: 'peer', status: 'active', accountId: workspace?.accountId ?? null,
      // No password Credential, here or anywhere: a peer signs each request
      // with its own key and has no way to sign in.
      isEmailVerified: false, isSystemAdmin: false,
    }})
    await tx.workspaceMember.create({ data: {
      workspaceId: ws(), userId: user.id, role: PEER_ROLE, capabilities: grantsFor(PEER_ROLE),
      invitedBy: actor(), invitedAt: now, acceptedAt: now,
    }})
    return user
  })

  try {
    // As the caller, so the trail names who enrolled the peer.
    const row = await db().apiKey.create({
      data:   { name, userId: peer.id, scopes, publicKey, tokenHint: peerHint(publicKey), createdBy: actor() },
      system: ['publicKey', 'tokenHint'],
    })
    return { id: row.id, userId: peer.id, name: row.name }
  } catch (err) {
    // An account no key points at is one nothing on any screen can remove.
    await sys.user.delete({ where: { id: peer.id } }).catch(() => {})
    throw err
  }
}

/**
 * before/find: `status` is derived, so it is not a column, so autoFilter
 * would 400 on it (FJS-109) before find() ever ran. Same shape as the
 * wire-only fields on create, one hop earlier.
 */
function captureStatus(): void {
  const q = $.query as Record<string, unknown>
  const status = q.status
  delete q.status
  if (status === undefined || status === 'all') return
  if (typeof status !== 'string' || !STATUSES.includes(status))
    throw new BadRequest(`status must be one of all, ${STATUSES.join(', ')}`)
  $.locals.statusFilter = status
}

/** The shape the UI reads. `status` is derived here so one answer exists. */
function present(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, status: statusOf(row as { revokedAt?: string; expiresAt?: string }) }
}

export default createService({
  name:  'apiKeys',
  model: 'ApiKey',
  paginate: { default: 20, max: 200 },
  // The whole surface. `owners` reads the roster through the app, so no model's
  // gate grades it and the level is stated here.
  methods: [
    'find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore',
    'revoke', 'scopes',
    { method: 'owners', gate: LEVELS.ADMINISTRATOR },
    // Writes an account and its membership as the system, so the level is
    // stated: the one that may issue a key that is not its own.
    { method: 'enrollPeer', gate: LEVELS.ADMINISTRATOR },
  ],
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

  async find() {
    const { limit, offset } = getPagination()
    const status = $.locals.statusFilter as string | undefined
    const page = await findScoped('apiKey', {
      where:   status ? whereStatus(status) : {},
      orderBy: { createdAt: 'desc' },
      limit, offset,
    })
    return { ...page, data: (page.data as Record<string, unknown>[]).map(present) }
  },

  async get() {
    return present(await getScoped('apiKey', 'API key'))
  },

  // ── create ────────────────────────────────────────────────────────
  // The only moment the plaintext token exists outside the caller's hands.
  // Everything that decides what the key IS happens in mintKey; this is
  // the insert, plus the one thing an insert can still get wrong.
  async create() {
    const data = await mintKey($.data as Record<string, unknown>)

    try {
      // `system:` names the two columns the caller may not send — `mintKey`
      // derived them from a token that did not exist when the request was
      // made, and `@system` refuses a write naming one BY NAME. Stating them
      // here keeps the gate, the row policies and the audit actor, where
      // `asSystem()` would drop all three to set two values.
      const row = await db().apiKey.create({ data, system: ['credentialId', 'tokenHint'] })
      // `token` is not a column and is on no later read. The screen has one
      // chance to show it, and says so.
      return { ...present(row), token: $.locals.mintedToken }
    } catch (err) {
      // A credential exists now. If the row does not, nothing in this app
      // points at it, nothing can revoke it, and it verifies forever.
      if (data.credentialId)
        await authOrRefuse().revokeApiKey(data.credentialId as string, { userId: String(data.userId) }).catch(() => {})
      throw err
    }
  },

  async patch() {
    const existing = await getScoped('apiKey', 'API key')

    // Renaming is the only safe change. Scopes and expiry are baked into the
    // credential auth issued, so editing them here would produce a row that
    // describes a key differently from the thing doing the authenticating —
    // rotate instead: revoke, and mint a new one.
    const patch = narrowPatch($.data as Record<string, unknown>)

    if (changesNothing(patch)) return present(existing)
    return present(await db().apiKey.update({ where: { id: existing.id }, data: patch }))
  },

  // ── remove ────────────────────────────────────────────────────────
  // A hard delete — ApiKey declares no @@softDelete, because revocation is
  // already this model's visible "off" and a second hidden one would make
  // four states out of two.
  async remove() {
    const row = await getScoped('apiKey', 'API key')

    // Deleting a key that still works has to stop it working. Otherwise the
    // token outlives every record of itself: nothing left to revoke, and the
    // credential still verifying.
    if (row.credentialId) await authOrRefuse().revokeApiKey(row.credentialId, { userId: String(row.userId) })

    await db().apiKey.delete({ where: { id: row.id } })
    return present(row)
  },

  // ── revoke ────────────────────────────────────────────────────────
  // Deletes the credential — the token stops working on the next request —
  // and keeps the row, so the operator can still see what was revoked and
  // when. credentialId is nulled because after this there is not one.
  async revoke() {
    const row = await getScoped('apiKey', 'API key')
    if (row.revokedAt) throw new BadRequest(`'${row.name}' is already revoked`)

    if (row.credentialId) await authOrRefuse().revokeApiKey(row.credentialId, { userId: String(row.userId) })

    return present(await db().apiKey.update({
      where:  { id: row.id },
      data:   { revokedAt: new Date().toISOString(), credentialId: null },
      system: ['credentialId', 'revokedAt'],
    }))
  },

  // ── scopes ────────────────────────────────────────────────────────
  // Collection-level (no id): the vocabulary is a fact about the server, not
  // about one key. The screen builds its checkboxes from this rather than
  // shipping a copy, which is what keeps a service added later from being
  // invisible to the thing that grants access to it.
  async scopes() {
    $.dispatch = false          // a read — do not announce it on a channel
    return { scopes: scopeVocabulary($.app), expiry: EXPIRY_PRESETS }
  },

  // ── owners ────────────────────────────────────────────────────────
  // Collection-level: the bots this caller may issue a key to, by
  // assertBotOwner's rule. The roster carries no `kind` (`FJS-D619`), and a
  // picker filtering every bot member offers ones senior to the caller that
  // create refuses.
  async owners() {
    $.dispatch = false
    const rows = await ($.db.asSystem() as any).workspaceMember.findMany({
      where:   { workspaceId: ws() },
      include: { user: { select: { kind: true, name: true, displayName: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    })
    const data = rows
      .filter((m: any) => m.user?.kind === 'bot' && !outranksCaller(m.role))
      .map((m: any) => ({ userId: m.userId, role: m.role, name: m.user.displayName ?? m.user.name ?? m.user.email }))
    return { data }
  },

  // ── enrollPeer ────────────────────────────────────────────────────
  // Collection-level. `{ name, publicKey, scopes? }` → `{ id, userId, name }`;
  // the `id` is what the peer names in `X-Fjs-Key` on every signed call.
  async enrollPeer() {
    return enrollPeer(($.data ?? {}) as Record<string, unknown>)
  },

  hooks: {
    before: {
      all:    [sessionScope(), noKeyManagementByKey],
      find:   [captureStatus],
      // Issuing a token that carries your standing is an admin act. A
      // developer who could mint one could hand out their own access.
      create: [shapeKey],
    },
  },
})

/**
 * A key may not manage keys — including its own.
 *
 * The scope hook would already refuse it (there is no `api-keys:*` scope to
 * hold), but that leaves the rule as an absence, and an absence is not
 * something a reader can find. Stated here it is one line with a reason.
 */
function noKeyManagementByKey(): void {
  const user = $.user as { authMethod?: string } | undefined
  if (user?.authMethod === 'apiKey' || user?.authMethod === 'peer')
    throw new Forbidden('An API key cannot manage API keys — sign in to issue or revoke one')
}
