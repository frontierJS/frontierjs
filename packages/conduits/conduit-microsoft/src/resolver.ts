// src/resolver.ts — the user's access token, per grant, as a conduit
// CredentialResolver (FJS-2245, hand-built as the ruling says; FJS-D848 for
// the per-caller half).
//
// ─── Why the lock crosses processes ───────────────────────────────────────
// Microsoft ROTATES the refresh token on every refresh and the spent one is
// dead. Two processes refreshing one grant at once — the API and a worker,
// or two replicas — both succeed, and whichever writes its row second has
// stored a refresh token the other's success already burned: the next
// refresh is `invalid_grant` and the person signs in again for no reason.
// So the grant ROW carries the lock: `refreshing: { by, until }`, claimed by
// compare-and-set through the store, and a process that loses the claim polls
// the row for the winner's token instead of refreshing itself. The in-process
// `inflight` map is the cheap first layer for callers in one process.
//
// ─── The store is the app's (C12) ─────────────────────────────────────────
// Three functions over the row the app holds: `read`, a compare-and-set
// `update`, and `lose`. `memoryGrantStore` is one for a drive, and the shape
// a litestone-backed one copies.

import type { CredentialCaller, CredentialResolver, Material } from '@frontierjs/conduit'
import { refreshGrant, type ClientCredentials, type MicrosoftSend } from './index.ts'
import type { MicrosoftFailure } from './errors.ts'

export interface StoredGrant {
  refreshToken: string
  accessToken:  string | null
  /** Epoch ms the access token dies. */
  expiresAt:    number | null
  /** Who is refreshing now, until when (epoch ms); a lease the holder's crash lets lapse. */
  refreshing:   { by: string; until: number } | null
}

export interface GrantStore {
  /** The row `who.grant` names, as the app holds it; null means no such grant, or one marked lost. */
  read(key: string, who: CredentialCaller): Promise<StoredGrant | null> | StoredGrant | null
  /**
   * Write `change` onto the row, only where its `refreshing` still equals
   * `expect` (deep-equal; null for unclaimed): the compare-and-set the lock is
   * made of. Answers whether it was written.
   */
  update(key: string, change: Partial<StoredGrant>, expect: StoredGrant['refreshing']): Promise<boolean> | boolean
  /** `invalid_grant`: the app marks the row and asks the person to sign in again. */
  lose(key: string, failure: MicrosoftFailure): Promise<void> | void
}

export interface MicrosoftTokenResolver extends CredentialResolver {
  getFor(ref: string, who: CredentialCaller): Promise<Material | null>
  invalidateFor(ref: string, value: string, who: CredentialCaller): void
  /** `lost`: every later getFor fails closed until `forget`. */
  state(key: string): 'ok' | 'lost' | 'failed' | 'none'
  lastFailure(key: string): MicrosoftFailure | null
  /** After the person signed in again and the row holds a new refresh token. */
  forget(key: string): void
  /** How many times the identity platform was asked, per grant: what a drive measures the lock by. */
  refreshes(key: string): number
}

export interface TokenResolverOptions {
  /** Treat a token as expired this many ms before it is; a call must not leave carrying one that dies in flight. */
  skewMs?:  number
  /** How long a claim is held before another process may take it over. */
  leaseMs?: number
  /** How long a loser waits on the winner before giving up. */
  waitMs?:  number
  pollMs?:  number
  /** This process's name in `refreshing.by`. */
  self?:    string
  now?:     () => number
}

export function microsoftTokenResolver(ms: MicrosoftSend, creds: ClientCredentials, store: GrantStore, opts: TokenResolverOptions = {}): MicrosoftTokenResolver {
  const SKEW  = opts.skewMs  ?? 60_000
  const LEASE = opts.leaseMs ?? 30_000
  const WAIT  = opts.waitMs  ?? 20_000
  const POLL  = opts.pollMs  ?? 50
  const self  = opts.self    ?? `${process.pid}:${Math.random().toString(36).slice(2, 8)}`
  const now   = opts.now     ?? Date.now
  const inflight = new Map<string, Promise<Material | null>>()
  const refused  = new Set<string>()
  const failures = new Map<string, MicrosoftFailure>()
  const counts   = new Map<string, number>()
  /** Access tokens a 401 said are dead, so a row still carrying one is read as expired. */
  const dead     = new Map<string, string>()

  const usable = (g: StoredGrant, key: string) =>
    g.accessToken && g.accessToken !== dead.get(key) && (g.expiresAt ?? 0) - SKEW > now() ? { value: g.accessToken, expires_at: g.expiresAt! } : null

  async function refresh(key: string, g: StoredGrant, claim: StoredGrant['refreshing']): Promise<Material | null> {
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const r = await refreshGrant(ms, creds, { refreshToken: g.refreshToken })
    if (r.error) {
      failures.set(key, r.error)
      if (r.error.kind === 'grant_lost') {
        refused.add(key)
        await store.lose(key, r.error)
      } else {
        await store.update(key, { refreshing: null }, claim)
      }
      return null
    }
    const t = r.tokens!
    const expiresAt = now() + Number(t.expires_in ?? 3600) * 1000
    // The row is written BEFORE the token is answered: a caller that gets the
    // token and crashes must not leave the app holding a refresh token the
    // identity platform already burned.
    await store.update(key, { refreshToken: t.refresh_token ?? g.refreshToken, accessToken: t.access_token, expiresAt, refreshing: null }, claim)
    failures.delete(key)
    dead.delete(key)
    return { value: t.access_token, expires_at: expiresAt }
  }

  async function acquire(key: string, who: CredentialCaller): Promise<Material | null> {
    const deadline = now() + WAIT
    for (;;) {
      const g = await store.read(key, who)
      if (!g) return null
      const hit = usable(g, key)
      if (hit) return hit
      const held = g.refreshing && g.refreshing.until > now() ? g.refreshing : null
      if (!held) {
        const claim = { by: self, until: now() + LEASE }
        if (await store.update(key, { refreshing: claim }, g.refreshing)) return refresh(key, { ...g, refreshing: claim }, claim)
        // Lost the race; the winner's token lands in the row shortly.
      }
      if (now() >= deadline) {
        failures.set(key, { kind: 'timeout', message: `the refresh of grant ${key} held by ${held?.by ?? 'another process'} did not finish in ${WAIT}ms`, retryable: true })
        return null
      }
      await new Promise(r => setTimeout(r, POLL))
    }
  }

  return {
    /** A `graph` send without `who` is refused by conduit before it asks; fail closed here too. */
    async get() { return null },
    getFor(_ref, who) {
      const key = who.grant
      if (!key || refused.has(key)) return Promise.resolve(null)
      let pending = inflight.get(key)
      if (!pending) {
        pending = acquire(key, who).finally(() => inflight.delete(key))
        inflight.set(key, pending)
      }
      return pending
    },
    invalidateFor(_ref, value, who) {
      // Remembered rather than written: twenty sends refused on one dead token
      // each call this, and the row is the winner's to write.
      if (who.grant) dead.set(who.grant, value)
    },
    state(key)       { return refused.has(key) ? 'lost' : failures.has(key) ? 'failed' : counts.has(key) ? 'ok' : 'none' },
    lastFailure(key) { return failures.get(key) ?? null },
    forget(key)      { refused.delete(key); failures.delete(key); dead.delete(key) },
    refreshes(key)   { return counts.get(key) ?? 0 },
  }
}

/** A store for a drive, and the shape a litestone one copies. */
export function memoryGrantStore(initial: Record<string, StoredGrant> = {}) {
  const rows = new Map<string, StoredGrant>(Object.entries(initial).map(([k, v]) => [k, { ...v }]))
  const lost = new Map<string, MicrosoftFailure>()
  const same = (a: StoredGrant['refreshing'], b: StoredGrant['refreshing']) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const store: GrantStore & {
    rows:  Map<string, StoredGrant>
    lost:  Map<string, MicrosoftFailure>
    put(key: string, refreshToken: string): void
  } = {
    rows, lost,
    read(key)  { return lost.has(key) ? null : rows.get(key) ? { ...rows.get(key)! } : null },
    update(key, change, expect) {
      const row = rows.get(key)
      if (!row || !same(row.refreshing, expect)) return false
      rows.set(key, { ...row, ...change })
      return true
    },
    lose(key, failure) { lost.set(key, failure) },
    put(key, refreshToken) { lost.delete(key); rows.set(key, { refreshToken, accessToken: null, expiresAt: null, refreshing: null }) },
  }
  return store
}
