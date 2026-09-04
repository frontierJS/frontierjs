// src/core/config-scope.ts
// Reading configuration at CALL scope rather than at boot scope.
//
// Everything an app is configured with resolves once, at boot, and is the same
// for every caller for the life of the process. That is correct for a port and
// a database path and wrong for the half of *theirs* a tenant sees — a
// from-address, a bucket, a timezone, a locale, a branding value, a rate limit
// (`FJS-385`).
//
// **This module is the read, and only the read.** There is no resolver behind
// it: `configFor()` answers `app.config` for every tenant, identically, and
// nothing an app does today changes. Where the value comes from is `FJS-D126`,
// which is unruled — and building the read first is deliberate, because the read
// is the part that gets more expensive the longer it waits. Twenty-five reads
// inside this package plus every closure an app captured is a boundary move
// under a live feature; the same move under no feature at all costs nothing and
// changes no behavior.
//
// ─── Why a read and never a rebind ────────────────────────────────────────
//
// Every mature implementation of this reached for the container: Laravel's
// tenancy bootstrappers rebind `config()` per request, and pay for it in a rule
// that every singleton must capture its central value in its constructor
// because once `bootstrap()` has mutated the config the original is unreachable.
// Django's own guidance is the same lesson stated as a prohibition — never
// module-level variables, use request context. NestJS documents that a
// request-scoped provider silently makes every dependent request-scoped, and its
// own docs point at AsyncLocalStorage instead.
//
// Junction already has the ALS. So the thing all three pay for is the thing this
// gets for free, and the whole of what that costs is a rule: **the resolution is
// a view, and `app.config` is never written to.** A view that could be written
// would be a rebind wearing a different word, and the next reader after the
// write would see somebody else's tenant.

import type { AppConfig } from '../config/index.ts'

/** An app, as much of one as this needs. Structural, so `configFor` can be
 *  reached from the ambient `$` without a circular import. */
export interface ConfigHost {
  config: AppConfig
  tenantConfig?: TenantConfigStore | null
}

// One read-only view per config object. Memoised because `$.config` is read per
// call and a fresh Proxy per read would be an allocation on the hot path for a
// value that does not change.
const _views = new WeakMap<object, AppConfig>()

const REFUSED = (path: string) =>
  `[Junction] '$.config${path}' cannot be assigned. Configuration is READ at call ` +
  `scope and written at boot — a value written here would be visible to the next ` +
  `caller, who may be a different tenant. Set it in junction.config.js, in ` +
  `createApp({ config }), or (once FJS-D126 is ruled) in the tenant's own config.`

/**
 * A read-only view of a config object, deep.
 *
 * Deep, because the shallow version refuses `$.config.name = x` and admits
 * `$.config.http.cors.origin = x`, which is the same defect one level down and
 * the one somebody actually writes. Nested views are memoised in the same map,
 * so a path read twice is one object both times and `===` still holds.
 */
export function readOnlyConfig<T extends object>(cfg: T, path = ''): T {
  const cached = _views.get(cfg)
  if (cached) return cached as unknown as T

  const view = new Proxy(cfg, {
    get(target, key) {
      const value = Reflect.get(target, key)
      // A function on a config object is a callback the app supplied, and
      // wrapping one would change its identity for a caller comparing it.
      if (value && typeof value === 'object')
        return readOnlyConfig(value as object, `${path}.${String(key)}`)
      return value
    },
    set(_t, key)          { throw new Error(REFUSED(`${path}.${String(key)}`)) },
    defineProperty(_t, key) { throw new Error(REFUSED(`${path}.${String(key)}`)) },
    deleteProperty(_t, key) { throw new Error(REFUSED(`${path}.${String(key)}`)) },
  }) as T

  _views.set(cfg, view as unknown as AppConfig)
  return view
}

/**
 * This tenant's configuration, over `app.config` as the floor.
 *
 * The one owner of *what is this app configured with, for this caller* —
 * `$.config` reads it off the ambient call and `app.configFor(tenant)` is the
 * same question asked from a job, a boot task or a script, which hold no call.
 *
 * Today it answers the floor for every tenant, so an app that adopts it is
 * making a statement about WHEN the value is read and none at all about what it
 * is. The tenant id is taken and ignored on purpose rather than being absent
 * from the signature: adding a parameter later means changing every call site,
 * and every call site is exactly what this exists to stop having to change.
 */
export function configFor(host: ConfigHost, tenantId: string | null = null): AppConfig {
  const resolved = tenantId != null ? host.tenantConfig?.peek(tenantId) : null
  return readOnlyConfig(resolved ?? host.config)
}

// ─── the source ───────────────────────────────────────────────────────────────
//
// `FJS-D126`, clause 3. A resolver rather than a declaration, on `FJS-D113`'s
// ground: the source is a row for one app, a file for another and a control
// plane for a third, and a declaration would have to name one.
//
// ─── Why the read is synchronous and the resolver is not ──────────────────
//
// `$.config` is a property read. A resolver that reads a row is async, and the
// two cannot meet at the point of use without making every reader `await` —
// which is the read shape thrown away.
//
// So the resolve happens where the tenant is ALREADY resolved: the same around
// hook that establishes `ctx.locals.tenantId` warms this store before anything
// downstream runs, exactly as `applyClaims` resolves the principal there rather
// than at the point some policy needs it. By the time a service method reads
// `$.config`, the answer is in hand and the read is a lookup.
//
// The memo holds the PROMISE, not the value. Two requests for one tenant
// arriving together would otherwise both miss and both resolve, and a resolver
// that reads a row would run twice for a value that cannot differ.

/** Configuration a tenant may override, and where it comes from. */
export interface TenantConfigOptions {
  /** This tenant's overrides, as a plain object shaped like `AppConfig`. */
  resolve: (tenantId: string) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** The dotted paths a tenant may override. Nothing else applies, and a
   *  resolver answering something else is refused by name. */
  keys:    string[]
}

/**
 * Paths a tenant may never override, refused at `createApp` rather than per
 * call.
 *
 * This is the half that makes the feature safe, and it is an allow-list with a
 * floor rather than a deny-list on its own: `keys` already says what applies, so
 * this exists for the entry somebody adds by mistake. `database` is the one that
 * matters — a tenant naming its own database path is every other tenant's rows,
 * one typo away — and the rest are values something reads at BOOT, with no
 * tenant in scope, so a per-tenant answer would be written and never read.
 *
 * Boot-time, because a per-request refusal is a production incident and a
 * boot-time one is a failed start.
 */
export const RESERVED_CONFIG_PATHS = ['port', 'host', 'database', 'http', 'auth', 'apiPrefix', 'logging'] as const

export function assertOverridable(keys: string[]): void {
  const bad = keys.filter(k =>
    RESERVED_CONFIG_PATHS.some(r => k === r || k.startsWith(`${r}.`)))
  if (!bad.length) return
  throw new Error(
    `[Junction] createApp({ tenantConfigKeys }) names ${bad.map(k => `'${k}'`).join(', ')}, ` +
    `which a tenant may never override. Reserved: ${RESERVED_CONFIG_PATHS.join(', ')} — ` +
    `a database path handed to a tenant is every other tenant's rows, and the rest are read ` +
    `at boot with no tenant in scope, so a per-tenant answer would be written and never read.`
  )
}

const getPath = (o: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o)

const hasPath = (o: Record<string, unknown>, path: string): boolean => {
  const parts = path.split('.')
  let cur: unknown = o
  for (const k of parts) {
    if (!cur || typeof cur !== 'object' || !(k in (cur as object))) return false
    cur = (cur as Record<string, unknown>)[k]
  }
  return true
}

/** Every dotted path a plain object actually carries, leaves only. */
function leafPaths(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k
    return v && typeof v === 'object' && !Array.isArray(v)
      ? leafPaths(v as Record<string, unknown>, path)
      : [path]
  })
}

/**
 * The floor with this tenant's allowed overrides applied, as a NEW object.
 *
 * Never a mutation of the floor: the floor is shared by every tenant and the
 * process, and writing into it is the rebind this whole design is arranged to
 * avoid — the next tenant would read the previous one's answer.
 *
 * A key the resolver answered that `keys` does not name is refused rather than
 * dropped. Dropping it means the tenant's configuration silently does not apply,
 * which is a support ticket that reads as *the feature is broken*; the refusal
 * says which key and is deterministic on the first request.
 */
export function mergeTenantConfig(
  floor:     AppConfig,
  overrides: Record<string, unknown>,
  keys:      string[],
  tenantId:  string,
): AppConfig {
  const offered = leafPaths(overrides)
  const allowed = new Set(keys)
  const refused = offered.filter(p => !allowed.has(p) && !keys.some(k => p.startsWith(`${k}.`)))

  if (refused.length) throw new Error(
    `[Junction] the tenant config resolver answered ${refused.map(k => `'${k}'`).join(', ')} ` +
    `for tenant '${tenantId}', which createApp({ tenantConfigKeys }) does not name. ` +
    `Add the key, or stop answering it — a key that is silently dropped is a tenant ` +
    `whose configuration does not apply, with nothing saying so.`
  )

  const out = structuredCloneish(floor as unknown as Record<string, unknown>)
  for (const key of keys) {
    if (!hasPath(overrides, key)) continue
    const parts = key.split('.')
    const leaf  = parts.pop() as string
    let   cur   = out
    for (const part of parts) {
      if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {}
      cur = cur[part] as Record<string, unknown>
    }
    cur[leaf] = getPath(overrides, key)
  }
  return out as unknown as AppConfig
}

// A config holds functions (a logger, a hook), and `structuredClone` throws on
// one. Only the objects on the path to an override have to be fresh; everything
// else may be shared with the floor, since nothing writes to either.
function structuredCloneish(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o))
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? structuredCloneish(v as Record<string, unknown>)
      : v
  return out
}

export interface TenantConfigStore {
  /** The resolved config for a tenant, or null if it has not been loaded. Sync,
   *  because `$.config` is a property read. */
  peek:       (tenantId: string) => AppConfig | null
  /** Resolve and memoise. Called by the hook that established the tenant. */
  load:       (tenantId: string) => Promise<AppConfig>
  /** Forget one tenant, or all of them. The explicit invalidation, because a
   *  memo with no way out is a config change that needs a restart. */
  invalidate: (tenantId?: string) => void
  keys:       string[]
}

export function createTenantConfigStore(floor: () => AppConfig, opts: TenantConfigOptions): TenantConfigStore {
  assertOverridable(opts.keys)

  const memo = new Map<string, Promise<AppConfig>>()
  const done = new Map<string, AppConfig>()

  return {
    keys: opts.keys,
    peek: (tenantId) => done.get(tenantId) ?? null,
    load(tenantId) {
      const hit = memo.get(tenantId)
      if (hit) return hit
      const p = Promise.resolve(opts.resolve(tenantId))
        .then(overrides => {
          const merged = mergeTenantConfig(floor(), overrides ?? {}, opts.keys, tenantId)
          done.set(tenantId, merged)
          return merged
        })
        .catch(err => {
          // A failed resolve must not be memoised as a failure for the life of
          // the process — the row it reads may be a second away from existing.
          memo.delete(tenantId)
          throw err
        })
      memo.set(tenantId, p)
      return p
    },
    invalidate(tenantId) {
      if (tenantId === undefined) { memo.clear(); done.clear(); return }
      memo.delete(tenantId)
      done.delete(tenantId)
    },
  }
}
