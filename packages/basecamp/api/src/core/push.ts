// src/core/push.ts — a git push starts a release (FJS-1781, FJS-D884).
//
// The one inbound door for a forge, declared as two conduit Receivers on one
// provider: the forge's own HMAC (`X-Hub-Signature-256`, which GitHub, Forgejo
// and Gitea all send) at `/hooks/git/{appId}`, and an unguessable per-App token
// at `/hooks/git/{appId}/{token}` for a script or a forge that signs nothing.
// Both end in the same `apply`.
//
//   dialect   how a push is verified, parsed and named — pure
//   receiver  which App's key verifies THIS delivery, chosen before the body is
//             believed, and what the push does
//   apply     a release created through `deployments.create` as whoever enabled
//             push, standing read again by `runAs`: a person removed since is
//             refused and the forge's retry shows it
//
// A refusal is conduit's one 401 sentence, so a wrong secret, a wrong token and
// an App with push off read alike to a stranger.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { App } from '@frontierjs/junction'
import type { Delivery, Dialect, Receiver, ReceivedEvent } from '@frontierjs/conduit'

export const PUSH_PROVIDER = 'git'
export const PUSH_PATH     = '/hooks/git/{appId}'
export const PUSH_TOKEN_PATH = '/hooks/git/{appId}/{token}'
const TOKEN_PREFIX = 'bcpt_'

export interface PushEvent extends ReceivedEvent {
  payload: { ref: string | null, after: string | null, deleted: boolean, defaultBranch: string | null }
}

// ─── Minting ───────────────────────────────────────────────────────────

/** The two credentials of one App, and the hash to keep of the token. */
export function mintPush() {
  const token = TOKEN_PREFIX + randomBytes(32).toString('hex')
  return { secret: randomBytes(32).toString('hex'), token, tokenHash: hashPushToken(token) }
}

/**
 * SHA-256, unsalted: the input is 32 bytes of CSPRNG output, so there is no
 * dictionary to attack (`hashEnrollToken` is the same argument).
 */
export function hashPushToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ─── Dialects ──────────────────────────────────────────────────────────

const header = (d: Delivery, ...names: string[]) => names.map(n => d.headers[n]).find(Boolean)

function parsePush(d: Delivery): PushEvent | null {
  // A forge's ping and every non-push event is answered 200 and ignored: a
  // 4xx would be retried and shown red for an event nobody asked us to act on.
  const kind = header(d, 'x-github-event', 'x-forgejo-event', 'x-gitea-event')
  if (kind && kind !== 'push') return null
  const body = (d.body && typeof d.body === 'object' ? d.body : {}) as Record<string, any>
  const after = typeof body.after === 'string' ? body.after : null
  return {
    id:   header(d, 'x-github-delivery', 'x-forgejo-delivery', 'x-gitea-delivery') ?? randomUUID(),
    type: 'push',
    payload: {
      ref:           typeof body.ref === 'string' ? body.ref : null,
      after,
      deleted:       body.deleted === true || (after != null && /^0+$/.test(after)),
      defaultBranch: typeof body.repository?.default_branch === 'string' ? body.repository.default_branch : null,
    },
  }
}

// One delivery id per App: the same id could never name two Apps' pushes, but a
// sha pushed to two Apps' repos should release both.
const dedupeKey = (d: Delivery, ev: PushEvent) => `${d.route.appId}:${ev.id}`

/** The forge's HMAC over the exact bytes it sent, keyed by the App's `pushSecret`. */
export const forgeDialect: Dialect<string, PushEvent> = {
  verify(d, secret) {
    const sent = header(d, 'x-hub-signature-256')
    if (!sent?.startsWith('sha256=')) return { ok: false, reason: 'no X-Hub-Signature-256' }
    const want = createHmac('sha256', secret).update(d.rawBody).digest('hex')
    return same(sent.slice('sha256='.length), want) ? { ok: true } : { ok: false, reason: 'signature does not match' }
  },
  parse:  parsePush,
  dedupeKey,
}

/** The URL token, compared by hash to the App's `pushTokenHash`. */
export const tokenDialect: Dialect<string, PushEvent> = {
  verify(d, tokenHash) {
    const sent = d.route.token
    return sent && same(hashPushToken(sent), tokenHash) ? { ok: true } : { ok: false, reason: 'token does not match' }
  },
  parse:  parsePush,
  dedupeKey,
}

// ─── The receivers ─────────────────────────────────────────────────────

type Column = 'pushSecret' | 'pushTokenHash'

/** The App's key for this delivery, or null: unknown App, push off, no key. */
const credentialFrom = (app: App, column: Column) => async (d: Delivery): Promise<string | null> => {
  const id = d.route.appId
  if (!id) return null
  const row = await (app.db as any).asSystem().app.findFirst({ where: { id, deletedAt: null } })
  return row?.deployOnPush && row[column] ? row[column] as string : null
}

/** Does this push name the branch the App is built from. */
export function pushesBranch(ev: PushEvent, source: { branch?: string }): boolean {
  const { ref, deleted, defaultBranch } = ev.payload
  if (deleted) return false
  // A script's deploy hook carries no ref and means the App's own branch.
  if (ref == null) return true
  const want = source.branch ?? defaultBranch
  return want != null && ref === `refs/heads/${want}`
}

function receiver(app: App, path: string, dialect: Dialect<string, PushEvent>, column: Column): Receiver<string, PushEvent> {
  return {
    provider:   PUSH_PROVIDER,
    path,
    dialect,
    credential: credentialFrom(app, column),
    async apply(ev, { delivery }) {
      const sys = (app.db as any).asSystem()
      const row = await sys.app.findFirst({ where: { id: delivery.route.appId, deletedAt: null } })
      if (!row?.deployOnPush || !row.pushActorId) return 'ignored'
      if (!pushesBranch(ev, (row.source ?? {}) as { branch?: string })) return 'ignored'

      // The release is made at the standing of whoever enabled push, read
      // again now. A throw is a 500, so the forge's delivery shows red and its
      // retry gets a clean run.
      await app.runAs(row.pushActorId, { tenant: row.workspaceId }, () =>
        (app.service('deployments') as any).create({ appId: row.id }))
      return 'applied'
    },
  }
}

/** Declares both doors on `app.conduit`; call once, after the conduit plugin is configured. */
export function registerPushReceivers(app: App): void {
  const conduit = (app as any).conduit
  conduit.receive(receiver(app, PUSH_PATH,       forgeDialect, 'pushSecret'))
  conduit.receive(receiver(app, PUSH_TOKEN_PATH, tokenDialect, 'pushTokenHash'))
}
