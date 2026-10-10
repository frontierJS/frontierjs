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

import type { CredentialCaller, CredentialResolver } from './types.ts'

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

// Wraps a resolver with a TTL cache. Transports resolve once per
// attempt, so a retried request hits the underlying resolver up to
// retry_limit + 1 times — worth avoiding for anything networked.
//
// Only successful lookups are cached; a null keeps failing through
// so a newly-provisioned secret is picked up without a restart.
//
// Concurrent misses on one ref share one inner call: a burst against a
// cold cache otherwise sends one vault request per send(). The in-flight
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

  function cached(key: string, fetch: () => Promise<string | null>): Promise<string | null> {
    const hit = cache.get(key)
    if (hit && hit.expires_at > Date.now()) return Promise.resolve(hit.value)

    let pending = inflight.get(key)
    if (!pending) {
      // Cleared after the set: a resolver that throws synchronously would
      // otherwise settle before the entry exists and leave it behind.
      pending = (async () => {
        const value = await fetch()
        if (value !== null && value !== '') cache.set(key, { value, expires_at: Date.now() + ttl })
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
