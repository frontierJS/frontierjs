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
import { env }                       from '../../core/env.ts'
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
 *
 * `address` overrides where the cloud IS. Omitted in every production path, so
 * the connector's own answer stands. It exists because that answer is read from
 * `env`, which is a snapshot taken when the module first loads — correct for a
 * deployed app, and unusable for a caller that only knows where to point after
 * something has already imported the app. A test pointing a connector at a
 * stand-in by setting a variable therefore reaches the REAL vendor whenever
 * some other file imported first, which is an ordering nothing declares.
 */
export async function registerAccount(
  app: BasecampApp, secret: SecretRow, opts: { address?: string } = {},
): Promise<string | null> {
  if (!app.conduit) return null
  if (secret.kind && secret.kind !== 'provider_key') return null

  const connector = connectorFor(secret.providerKind)
  if (!connector) return null

  const target = targetFor(connector.kind, secret.id)
  await app.conduit.register(connector.descriptor({
    accountId: secret.id, ref: tokenRef(secret.id), address: opts.address,
  }))
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
/**
 * Is this address a stand-in on this machine?
 *
 * Loopback only. Not *is it the real DigitalOcean* — that test is the wrong way
 * round: it has to enumerate every vendor origin correctly forever, and the one
 * it gets wrong is the one that bills somebody. This asks the fail-closed
 * question instead, so an address nobody recognizes is treated as real.
 */
function isStandIn(address: string | undefined): boolean {
  if (!address) return false
  try {
    const host = new URL(address).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * May this process spend money at a real cloud?
 *
 * A GET costs nothing but rate limit. A POST or a DELETE at a vendor creates or
 * destroys a machine somebody pays for, and the way that goes wrong is not a bug
 * in a connector — it is a test, a script or a `bun run dev` that meant to be
 * pointed at a stand-in and was not. P1 measured exactly that: three tests sent
 * their reads to the real DigitalOcean because an environment variable did not
 * apply in the order they ran, and reads were all that saved it.
 *
 * So the default is REFUSE and the two ways through are both deliberate:
 *
 *   `NODE_ENV=production`  — a deployed control plane. Provisioning is its job,
 *                            and an operator should not have to find a flag to
 *                            do the thing they installed it for.
 *   `ALLOW_CLOUD_SPEND=1`  — a developer who means it, on their own account.
 *
 * The same shape `BASECAMP_STUB_OUTPOST` already has here, pointed the other
 * way: that one is refused IN production, this one is only free there.
 */
function maySpend(): boolean {
  return env.NODE_ENV === 'production' || env.ALLOW_CLOUD_SPEND === '1'
}

/** The methods that can cost money. A GET is not one of them. */
const SPENDING = new Set(['POST', 'DELETE', 'PUT', 'PATCH'])

export function sendVia(app: BasecampApp, target: string): ComputeSend {
  return async (req) => {
    if (!app.conduit) throw new Error('compute: app.conduit is not configured')

    // The guard is on the TRANSPORT and not on each connector method, which is
    // what makes it complete: a spending call somebody adds next year is
    // covered without anybody remembering it exists. Checked against the
    // registered descriptor's address rather than against what a caller passed,
    // because the descriptor is what a send actually reaches.
    if (SPENDING.has(req.method) && !maySpend()) {
      const descriptor = await app.conduit.resolve(target).catch(() => null)
      if (!isStandIn(descriptor?.address)) {
        throw new Error(
          `compute: refusing to ${req.method} ${req.path} at ${descriptor?.address ?? 'an unknown address'} — `
          + 'this creates or destroys machines somebody pays for, and this process has not said it means to. '
          + 'Point the account at a stand-in on localhost, set ALLOW_CLOUD_SPEND=1, or run with NODE_ENV=production.',
        )
      }
    }

    const res = await app.conduit.send({
      target,
      method: req.method,
      path:   req.path,
      ...(req.body === undefined ? {} : { body: req.body }),
    })
    return {
      data:   res.data as unknown,
      status: res.meta?.status,
      error:  res.error as { kind: string; message?: string } | undefined,
    }
  }
}
