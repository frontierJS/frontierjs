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

import type { CredentialResolver } from './types.ts'

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
export function withCache(
  inner: CredentialResolver,
  opts: { ttl_ms?: number } = {}
): CredentialResolver {
  const ttl   = opts.ttl_ms ?? 60_000
  const cache = new Map<string, { value: string; expires_at: number }>()

  return {
    async get(ref) {
      const hit = cache.get(ref)
      if (hit && hit.expires_at > Date.now()) return hit.value

      const value = await inner.get(ref)
      if (value !== null && value !== '') {
        cache.set(ref, { value, expires_at: Date.now() + ttl })
      }
      return value
    }
  }
}
