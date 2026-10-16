// ============================================================
// Conduit — Credential Resolvers
//
// A TargetDescriptor carries `auth: { type, ref }` — a reference,
// never the secret. The resolver turns that ref into material at
// send time, so credentials stay out of the registry, out of
// resolve()/list(), out of hooks, and off the management routes.
//
//   createConduit({
//     credentials: createEnvResolver(),
//     targets: [{ …, auth: { type: 'bearer', ref: 'HETZNER_TOKEN' } }],
//   })
// ============================================================

import type { CredentialCaller, CredentialResolver, Material } from './types.ts'

// ─── The answer ──────────────────────────────────────────────────────────────

// The string in a resolver's answer, or null for no answer. Empty counts as
// none: an unset env var read through a shell default is the common way to
// end up with one. An `expires_at` that is not a finite number is refused by
// name here rather than read as never-expiring by `withCache`.
export function valueOf(m: Material | null | undefined): string | null {
  if (m === null || m === undefined) return null
  if (typeof m === 'string') return m === '' ? null : m
  if (m.expires_at !== undefined && !Number.isFinite(m.expires_at))
    throw new TypeError(`a credential's expires_at is epoch milliseconds, got ${String(m.expires_at)}`)
  return typeof m.value === 'string' && m.value !== '' ? m.value : null
}

// When the answer stops being good, or Infinity when it never says.
function expiryOf(m: Material | null | undefined): number {
  return m !== null && typeof m === 'object' && m.expires_at !== undefined ? m.expires_at : Infinity
}

// ─── Resolvers ───────────────────────────────────────────────────────────────

// Reads refs from process.env. This is the default when
// ConduitOptions.credentials is omitted.
//
// prefix scopes lookups so a ref cannot reach arbitrary environment:
//   createEnvResolver({ prefix: 'CONDUIT_' })  →  ref 'HETZNER' reads CONDUIT_HETZNER
export function createEnvResolver(opts: { prefix?: string } = {}): CredentialResolver {
  const prefix = opts.prefix ?? ''

  return {
    async get(ref) {
      return process.env[`${prefix}${ref}`] ?? null
    }
  }
}

// Fixed map of ref → secret. Use at the composition root when secrets
// arrive from somewhere already loaded (a config object, a decrypted
// bundle), and in tests.
//
// The map is copied on construction, so later mutation of the caller's
// object does not change what the resolver returns.
export function createStaticResolver(
  secrets: Record<string, string>
): CredentialResolver {
  const table = new Map(Object.entries(secrets))

  return {
    async get(ref) {
      return table.get(ref) ?? null
    }
  }
}

// Resolves nothing. Every ref fails closed with auth_failed.
// Used as the default for StubTransport, where auth is not exercised.
export function createNullResolver(): CredentialResolver {
  return {
    async get() {
      return null
    }
  }
}

// One resolver per ref, for a conduit whose credentials do not share a
// lifetime: an APNs JWT good for fifty minutes beside an FCM access token
// good for fifty-five, beside a key read from the environment. Each entry
// keeps its own `withCache`, and a refusal reaches the entry that answered.
// A ref the table does not name resolves to nothing and the send fails
// closed, so a typo is `auth_failed` naming the ref, never another entry's
// secret (`FJS-2724`).
//
//   credentials: byRef({
//     STRIPE_KEY: createEnvResolver(),
//     FCM_SA:     withCache(fcmTokenResolver(sa, { send }), { ttl_ms: FCM_TOKEN_TTL_MS }),
//   })
//
// The table is copied on construction, as createStaticResolver's map is.
export function byRef(table: Record<string, CredentialResolver>): CredentialResolver {
  const entries = new Map(Object.entries(table))

  const routed: CredentialResolver = {
    async get(ref) {
      return (await entries.get(ref)?.get(ref)) ?? null
    },

    invalidate(ref, value) {
      entries.get(ref)?.invalidate?.(ref, value)
    },
  }

  // Offered only when some entry can answer per caller, so put() still
  // refuses a per-caller target against a table that has none. A per-caller
  // ref routed to an entry without getFor fails the send by name.
  if ([...entries.values()].some(r => r.getFor)) {
    routed.getFor = async (ref, who) => {
      const entry = entries.get(ref)
      if (!entry) return null
      if (!entry.getFor) throw new Error(`byRef: the resolver for '${ref}' has no getFor, and its target is per_caller`)
      return entry.getFor(ref, who)
    }
    routed.invalidateFor = (ref, value, who) => entries.get(ref)?.invalidateFor?.(ref, value, who)
  }

  return routed
}

// Wraps a resolver with a cache. Transports resolve once per
// attempt, so a retried request hits the underlying resolver up to
// retry_limit + 1 times — worth avoiding for anything networked.
//
// An entry lives until `ttl_ms` or the answer's own `expires_at`, whichever
// is first: an answer that says when it expires is held exactly that long, so
// a minted token is `ttl_ms: Infinity` with the provider's number on the
// answer, never a TTL copied from the provider's documentation. An answer
// already expired is used for the send that asked and not kept.
//
// Only successful lookups are cached; a null keeps failing through
// so a newly-provisioned secret is picked up without a restart.
//
// Concurrent misses on one ref share one inner call: a burst against a
// cold cache otherwise sends one vault request per send(), and five callers
// finding one token stale otherwise refresh it five times. The in-flight
// entry clears when the call settles, so a rejection is not remembered.
//
// A credential minted by a login — a cookie session — is this with
// `ttl_ms: Infinity` and an inner get() that logs in: one login per burst,
// held until the target answers 401, then one login again. The same 401 is
// what picks up a rotated vault secret before its TTL runs out.
export function withCache(
  inner: CredentialResolver,
  opts: { ttl_ms?: number } = {}
): CredentialResolver {
  const ttl      = opts.ttl_ms ?? 60_000
  const cache    = new Map<string, { value: string; expires_at: number }>()
  const inflight = new Map<string, Promise<string | null>>()

  // One cache for both methods, keyed so they cannot meet: a process-scoped
  // ref is its own key, and a per-caller one is the ref plus every part of
  // who, joined on a byte no id contains. Keying a per-caller credential on
  // the ref alone is FJS-2232 — the first tenant's login answered for the next.
  const keyFor = (ref: string, who?: CredentialCaller) =>
    who ? ['\u0000who', ref, who.tenant ?? '', who.principal ?? '', who.grant ?? ''].join('\u0000') : ref

  function cached(key: string, fetch: () => Promise<Material | null>): Promise<string | null> {
    const hit = cache.get(key)
    if (hit && hit.expires_at > Date.now()) return Promise.resolve(hit.value)

    let pending = inflight.get(key)
    if (!pending) {
      // Cleared after the set: a resolver that throws synchronously would
      // otherwise settle before the entry exists and leave it behind.
      pending = (async () => {
        const answer = await fetch()
        const value  = valueOf(answer)
        const until  = Math.min(Date.now() + ttl, expiryOf(answer))
        if (value !== null && until > Date.now()) cache.set(key, { value, expires_at: until })
        return value
      })().finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    return pending
  }

  const wrapped: CredentialResolver = {
    get(ref) {
      return cached(keyFor(ref), () => inner.get(ref))
    },

    invalidate(ref, value) {
      if (cache.get(ref)?.value === value) cache.delete(ref)
      inner.invalidate?.(ref, value)
    },
  }

  // Offered only when the inner resolver has it, so wrapping keeps put()'s
  // refusal of a per-caller target honest: a cache cannot mint per caller.
  if (inner.getFor) {
    const getFor = inner.getFor.bind(inner)
    wrapped.getFor = (ref, who) => cached(keyFor(ref, who), () => getFor(ref, who))
    wrapped.invalidateFor = (ref, value, who) => {
      const key = keyFor(ref, who)
      if (cache.get(key)?.value === value) cache.delete(key)
      inner.invalidateFor?.(ref, value, who)
    }
  }

  return wrapped
}
