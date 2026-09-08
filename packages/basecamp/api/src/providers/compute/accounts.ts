// src/providers/compute/accounts.ts
// A cloud ACCOUNT is a `Secret` of kind `provider_key`, and this file is what
// turns one into a Conduit target.
//
// No model was minted for it. An account is a name, a vendor and a token, which
// is what `Secret` already is once it can say which cloud it opens —
// `Secret.providerKind`, added for this. The shape is `NotificationChannel`'s
// without the wrapper: that model exists because a channel carries `config` and
// a delivery history beside its credential, and an account carries neither yet.
//
// ─── Registration is not declaration ─────────────────────────────────────
//
// The mail target is declared in `app.ts` at boot because it is configuration.
// An account is a row somebody typed into a form, so it is registered when it is
// written and re-registered at boot for every row that already exists. Both
// paths are here, so *what does a registered account look like* has one answer.
//
// Keyed on the SECRET, which is what makes a rotation free: the ref is
// `secret:<id>#token` and resolves at send time, so a new token in the same row
// is picked up by the next call with nothing re-registered.

import { secretRef }                 from '../../core/credentials.ts'
import { connectorFor, targetFor }   from './index.ts'
import type { ComputeSend }          from './index.ts'
import type { BasecampApp }          from '../../basecamp.types.ts'
import type { ProviderKind }         from '../../../../db/schema.d.ts'

/** The key a provider token is stored under inside `Secret.data`. One name,
 *  three readers — the write, the ref, and the check that a row is usable. */
export const TOKEN_FIELD = 'token'

/** `{"token": "…"}` — what a `provider_key` secret holds. A caller may type a
 *  bare token into a form, so the normalization is here and not in a screen. */
export function tokenDocument(value: string): string {
  return JSON.stringify({ [TOKEN_FIELD]: value })
}

/** The ref a descriptor carries. Never the material. */
export function tokenRef(secretId: string): string {
  return secretRef(secretId, TOKEN_FIELD)
}

type SecretRow = { id: string; providerKind?: ProviderKind | null; kind?: string | null }

/**
 * Register one account as a Conduit target. A no-op — reported, not thrown —
 * where the row names a cloud this app cannot speak to, because a workspace is
 * allowed to hold a key for something Basecamp has no connector for and that is
 * not a startup failure.
 */
export async function registerAccount(app: BasecampApp, secret: SecretRow): Promise<string | null> {
  if (!app.conduit) return null
  if (secret.kind && secret.kind !== 'provider_key') return null

  const connector = connectorFor(secret.providerKind)
  if (!connector) return null

  const target = targetFor(connector.kind, secret.id)
  await app.conduit.register(connector.descriptor({ accountId: secret.id, ref: tokenRef(secret.id) }))
  return target
}

/** Drop an account's target. Called when the secret is removed, so a revoked
 *  key stops being a registered address rather than an address that fails. */
export async function unregisterAccount(app: BasecampApp, secret: SecretRow): Promise<void> {
  if (!app.conduit) return
  const connector = connectorFor(secret.providerKind)
  if (!connector) return
  await app.conduit.deregister(targetFor(connector.kind, secret.id))
}

/**
 * Every account that already exists, at boot.
 *
 * `asSystem()`: this runs before any request, so there is no principal and no
 * workspace — and it must see every workspace's accounts, since the machine
 * whose sync needs a target belongs to whoever owns it. The confinement is that
 * nothing here returns a row to a caller; it reads ids and registers addresses.
 */
export async function registerAllAccounts(app: BasecampApp, db: any): Promise<number> {
  if (!app.conduit) return 0

  const accounts = await db.asSystem().secret.findMany({
    where:  { kind: 'provider_key' },
    select: { id: true, kind: true, providerKind: true },
  })

  let n = 0
  for (const row of accounts as SecretRow[]) {
    try {
      if (await registerAccount(app, row)) n++
    } catch (err) {
      // One unregistrable account must not stop the others, and must not be
      // silent either — a fleet whose provider target is missing answers
      // `target_not_found` on a screen with no explanation otherwise.
      app.logger.warn('compute: account not registered', {
        secret_id: row.id, provider: row.providerKind, error: String(err),
      })
    }
  }
  return n
}

/**
 * A sender bound to one account's target.
 *
 * The `path` a connector asks for is appended to the target's address by
 * conduit, so nothing here builds a URL. Errors come back as a typed
 * `error.kind` rather than a thrown string, which is what lets `machine()` tell
 * *the vendor says it is gone* from *we could not ask*.
 */
export function sendVia(app: BasecampApp, target: string): ComputeSend {
  return async (req) => {
    if (!app.conduit) throw new Error('compute: app.conduit is not configured')
    const res = await app.conduit.send({
      target,
      method: req.method,
      path:   req.path,
      ...(req.body === undefined ? {} : { body: req.body }),
    })
    return { data: res.data as unknown, error: res.error as { kind: string; message?: string } | undefined }
  }
}
