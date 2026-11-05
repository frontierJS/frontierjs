// src/resolver.ts — the two things that live between calls: the provider's keys
// and the user's access token. Both are conduit CredentialResolvers, because a
// resolver is the one shape conduit has for a value that is fetched, cached,
// and forgotten when the far end refuses it.
//
// ─── JWKS ─────────────────────────────────────────────────────────────────
// `jwksResolver(oidc, discovery)` answers the key set as JSON; `withCache` is
// its TTL. `jwksKeys(...)` wraps the pair and applies the one rule a cache
// cannot: a token whose `kid` is not in the cached set forgets the set and
// fetches ONCE. Once, because a provider that just rotated has the new key in
// its JWKS and a second miss is a key the provider never published — refetching
// on every unknown kid is a way to make a verifier fetch on an attacker's
// schedule.
//
// ─── Access tokens (FJS-2245, hand-built here as the ruling says) ─────────
// `oidcTokenResolver` is leg three. Its `get(ref)` is the mint: refresh at the
// provider and hand back the access token. Three things `withCache` cannot do
// and this does:
//   - expiry is the PROVIDER's `expires_in`, not a fixed TTL; the token is
//     refreshed `earlySeconds` before it dies, so a call never leaves with one
//     that expires in flight.
//   - one refresh per grant at a time, in-process: two callers racing one grant
//     share one call to the provider. Two replicas would each refresh; a lock
//     across processes is the app's.
//   - a provider that ROTATES the refresh token (Microsoft) answers a new one;
//     it is handed to `grants.onRotated` and never stored here, because the
//     row it belongs to is the app's (C12). A `grant_lost` is marked and
//     reported through `grants.onLost`, and every later `get` fails closed
//     until the app re-authenticates and `forget(ref)`s the mark.

import type { CredentialResolver } from '@frontierjs/conduit'
import { fetchJwks, refreshTokens, type OidcSend } from './index.ts'
import type { OidcFailure } from './errors.ts'
import type { Discovery, IdClaims, Jwks, TokenSet } from './types.ts'
import { verifyIdToken, type Verified, type VerifyOptions } from './verify.ts'

// ─── JWKS ─────────────────────────────────────────────────────────────────

export function jwksResolver(oidc: OidcSend, discovery: Pick<Discovery, 'jwks_uri'>): CredentialResolver {
  return {
    async get() {
      const r = await fetchJwks(oidc, discovery)
      // Null is not cached by withCache, so an outage is retried on the next
      // verify rather than remembered for the TTL.
      return r.jwks ? JSON.stringify(r.jwks) : null
    },
  }
}

export interface JwksKeys {
  /** The ref the resolver is asked under; the JWKS URL. */
  ref:     string
  jwks():  Promise<Jwks | null>
  /** `verifyIdToken` with the cached set, refetched once on an unknown kid. */
  verify(jwt: string, opts: Omit<VerifyOptions, 'jwks'>): Promise<Verified<IdClaims> & { refetched?: true }>
}

/** `cached` is the resolver already wrapped in `withCache`; the ref is the JWKS URL. */
export function jwksKeys(cached: CredentialResolver, discovery: Pick<Discovery, 'jwks_uri'>): JwksKeys {
  const ref = discovery.jwks_uri
  const jwks = async () => { const v = await cached.get(ref); return v ? JSON.parse(v) as Jwks : null }
  return {
    ref,
    jwks,
    async verify(jwt, opts) {
      const first = await cached.get(ref)
      if (!first) return { ok: false, reason: 'the JWKS could not be fetched' }
      const v = await verifyIdToken(jwt, { ...opts, jwks: JSON.parse(first) })
      if (v.ok || !v.unknownKid) return v
      cached.invalidate?.(ref, first)
      const second = await cached.get(ref)
      if (!second) return { ok: false, reason: `${v.reason}; the JWKS could not be refetched` }
      const again = await verifyIdToken(jwt, { ...opts, jwks: JSON.parse(second) })
      return { ...again, refetched: true }
    },
  }
}

// ─── access tokens ────────────────────────────────────────────────────────

export interface GrantStore {
  /** The refresh token for this grant, as the app holds it; null means no grant. */
  refreshTokenFor(ref: string): Promise<string | null> | string | null
  /** The provider rotated: `next` replaces `previous` and the app writes the row. */
  onRotated?(ref: string, next: string, previous: string): Promise<void> | void
  /** `invalid_grant`: the app marks the row and asks the user to sign in again (FJS-D795). */
  onLost?(ref: string, failure: OidcFailure): Promise<void> | void
}

export type GrantState =
  | { status: 'none' }
  | { status: 'ok';     expiresAt: number }
  | { status: 'lost';   failure: OidcFailure }
  | { status: 'failed'; failure: OidcFailure }

export interface OidcTokenResolver extends CredentialResolver {
  invalidate(ref: string, value: string): void
  state(ref: string): GrantState
  /** Clears a `lost` mark after the app re-authenticated and stored a new refresh token. */
  forget(ref: string): void
  /** How many times the provider was asked, per ref; what a drive measures the lock by. */
  refreshes(ref: string): number
}

export function oidcTokenResolver(oidc: OidcSend, discovery: Pick<Discovery, 'token_endpoint'>, grants: GrantStore, opts: {
  /** Refresh this many seconds before `expires_in` runs out. */
  earlySeconds?: number
  /** Where the provider sends no `expires_in`; RFC 6749 says the client should assume one. */
  defaultExpiresIn?: number
  now?: () => number
} = {}): OidcTokenResolver {
  const early    = opts.earlySeconds ?? 30
  const fallback = opts.defaultExpiresIn ?? 3600
  const now      = opts.now ?? (() => Date.now() / 1000)
  const tokens   = new Map<string, { value: string; expiresAt: number }>()
  const inflight = new Map<string, Promise<string | null>>()
  const marks    = new Map<string, GrantState>()
  const counts   = new Map<string, number>()

  async function refresh(ref: string): Promise<string | null> {
    const current = await grants.refreshTokenFor(ref)
    if (!current) { marks.set(ref, { status: 'none' }); return null }
    counts.set(ref, (counts.get(ref) ?? 0) + 1)
    const r = await refreshTokens(oidc, discovery, { refreshToken: current })
    if (r.error) {
      if (r.error.kind === 'grant_lost') {
        marks.set(ref, { status: 'lost', failure: r.error })
        await grants.onLost?.(ref, r.error)
      } else {
        marks.set(ref, { status: 'failed', failure: r.error })
      }
      return null
    }
    const t = r.tokens as TokenSet
    const expiresAt = now() + (t.expires_in ?? fallback)
    tokens.set(ref, { value: t.access_token, expiresAt })
    marks.set(ref, { status: 'ok', expiresAt })
    // Handed over BEFORE the token is answered: a caller that gets the access
    // token and crashes must not leave the app holding a refresh token the
    // provider already burned.
    if (t.refresh_token && t.refresh_token !== current) await grants.onRotated?.(ref, t.refresh_token, current)
    return t.access_token
  }

  return {
    get(ref) {
      if (marks.get(ref)?.status === 'lost') return Promise.resolve(null)
      const hit = tokens.get(ref)
      if (hit && hit.expiresAt - early > now()) return Promise.resolve(hit.value)
      let pending = inflight.get(ref)
      if (!pending) {
        pending = refresh(ref).finally(() => inflight.delete(ref))
        inflight.set(ref, pending)
      }
      return pending
    },
    invalidate(ref, value) {
      // Compare-and-set, as withCache does: twenty sends refused on one dead
      // token must not each throw away the fresh one the first refresh minted.
      if (tokens.get(ref)?.value === value) tokens.delete(ref)
    },
    state(ref)   { return marks.get(ref) ?? { status: 'none' } },
    forget(ref)  { marks.delete(ref); tokens.delete(ref) },
    refreshes(ref) { return counts.get(ref) ?? 0 },
  }
}
