// api/src/core/auth.ts — one provider per SHOP.
//
// The shop is the tenant and the tenant is a file (`tenancy { strategy database
// }`), so `User`, `Credential` and `Session` live in the shop's own database:
// an account at one shop is not an account at another. That makes a sign-in a
// question about WHICH shop before it is a question about who, and
// `createLitestoneAuth(client)` binds exactly one client at construction.
//
// ─── Where the shop comes from, and why it is two answers ─────────────────
//
// `verifySession` is resolved by the TRANSPORT, before any hook has run and so
// before `withTenantDb` has resolved a tenant. It is handed the request's own
// origin as a second argument for exactly this case (`CredentialOrigin`), and
// without it a fleet with per-shop people could not authenticate anybody.
//
// Everything else — login, register, the reset flow — is called from inside a
// route, where junction's request scope is already open, so `requestMeta()`
// carries the headers that opened it. Two sources, one question.

import { createLitestoneAuth } from '@frontierjs/auth'
import { requestMeta }         from '@frontierjs/junction'

type Origin = { host?: string | null, headers?: Record<string, unknown> | null }

type Shops = {
  get: (id: string) => Promise<unknown>
  tenantFor: (from: Origin & { principal?: unknown }) => string
}

/**
 * An `IAuth` whose every method runs against the shop this request is for.
 *
 * The proxy's TARGET is the default shop's real provider, which is what keeps
 * it honest: a key that is not a function — an option, a flag, a sub-object —
 * is answered from it unchanged, so this cannot invent a capability the
 * provider does not have. Only the methods are routed.
 */
export function perShopAuth<O extends object>(
  shops: Shops,
  defaultShop: string,
  options: O,
  base: ReturnType<typeof createLitestoneAuth>,
) {
  const cache = new Map<string, ReturnType<typeof createLitestoneAuth>>([[defaultShop, base]])

  const shopOf = (from?: Origin) => {
    const headers = (from?.headers ?? requestMeta()?.client?.headers ?? null) as Record<string, unknown> | null
    const host    = (from?.host ?? (headers?.host as string | undefined) ?? null) as string | null
    return shops.tenantFor({ host, headers })
  }

  const providerFor = async (id: string) => {
    let p = cache.get(id)
    if (!p) { p = createLitestoneAuth(await shops.get(id) as never, options as never); cache.set(id, p) }
    return p
  }

  // `oauthProviderNames()` is the ONE synchronous method across `IAuth` and
  // `AuthOAuth` — everything else answers a Promise — and it answers this app's
  // own CONFIGURATION, which is the same for every shop, so there is nothing
  // per-shop to resolve. Wrapped like the rest it returns a Promise, and a
  // Promise is not a broken value anywhere that awaits: `GET /auth/oauth` writes
  // it straight into `ctx.json`, `JSON.stringify` renders it `{}`, and a sign-in
  // page draws no buttons at all with a 200 and no error (`FJS-548`). Anything
  // added to this list has to be synchronous AND shop-independent — both, or the
  // pass-through is a different bug.
  const PER_APP = new Set(['oauthProviderNames'])

  return new Proxy(base as object, {
    get(target, key: string) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (PER_APP.has(key)) return (value as (...a: unknown[]) => unknown).bind(target)
      return async (...args: unknown[]) => {
        // `verifySession(token, from)` is the one method that carries its own
        // origin, because it runs before there is a request scope to read.
        const from = key === 'verifySession' ? (args[1] as Origin | undefined) : undefined
        const provider = await providerFor(shopOf(from)) as Record<string, (...a: unknown[]) => unknown>
        return provider[key](...args)
      }
    },
  }) as ReturnType<typeof createLitestoneAuth>
}
