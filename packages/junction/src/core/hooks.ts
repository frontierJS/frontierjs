// core/hooks.ts
// Feathers-style hook pipeline with `around` hooks added.
//
// Execution order:
//   around enter  →  before  →  method  →  after  →  around exit
//
// Short-circuit: set ctx.result in a before hook to skip the method.
// Error hooks:   run when any stage throws. around exit still runs.

import type { ServiceContext, ServiceMethod } from '../transport/bridge.ts'
import { toFrameworkError, Unauthorized, Forbidden } from './errors.ts'

// ─── Hook definitions ─────────────────────────────────────────────────────

export type Hook        = (ctx: ServiceContext) => Promise<void> | void
export type AroundHook  = (ctx: ServiceContext, next: () => Promise<void>) => Promise<void>

// HookMap supports all five standard CRUD methods as typed keys (autocomplete),
// plus an index signature for arbitrary action names ('reboot', 'drain', etc.).
// The [action: string] signature must be compatible with the typed keys,
// so each stage uses a union of the known type and undefined.

export interface HookMap {
  around?: {
    all?:    AroundHook[]
    find?:   AroundHook[]
    get?:    AroundHook[]
    create?: AroundHook[]
    patch?:  AroundHook[]
    remove?: AroundHook[]
    [action: string]: AroundHook[] | undefined
  }
  before?: {
    all?:    Hook[]
    find?:   Hook[]
    get?:    Hook[]
    create?: Hook[]
    patch?:  Hook[]
    remove?: Hook[]
    [action: string]: Hook[] | undefined
  }
  after?: {
    all?:    Hook[]
    find?:   Hook[]
    get?:    Hook[]
    create?: Hook[]
    patch?:  Hook[]
    remove?: Hook[]
    [action: string]: Hook[] | undefined
  }
  error?: {
    all?:    Hook[]
    find?:   Hook[]
    get?:    Hook[]
    create?: Hook[]
    patch?:  Hook[]
    remove?: Hook[]
    [action: string]: Hook[] | undefined
  }
}

// ─── Resolved (merged) pipeline ───────────────────────────────────────────
// Built once per method at registration time.

export interface ResolvedPipeline {
  around: AroundHook[]
  before: Hook[]
  after:  Hook[]
  error:  Hook[]
}

// ─── Merge hook map into resolved pipelines per method ──────────────────
// Processes all five CRUD methods plus any extra action names found in the map.

export function resolvePipelines(hooks: HookMap): Record<string, ResolvedPipeline> {

  const crudMethods: ServiceMethod[] = ['find', 'get', 'create', 'patch', 'remove', 'restore']

  // Collect any custom action names from the hook map
  const actionNames = new Set<string>()
  for (const stage of ['around', 'before', 'after', 'error'] as const) {
    if (!hooks[stage]) continue
    for (const key of Object.keys(hooks[stage]!)) {
      if (key !== 'all' && !crudMethods.includes(key as ServiceMethod)) {
        actionNames.add(key)
      }
    }
  }

  const methods = [...crudMethods, ...actionNames]
  const result: Record<string, ResolvedPipeline> = {}

  for (const method of methods) {
    result[method] = {
      around: [...(hooks.around?.all ?? []), ...(hooks.around?.[method] ?? [])],
      before: [...(hooks.before?.all ?? []), ...(hooks.before?.[method] ?? [])],
      after:  [...(hooks.after?.all  ?? []), ...(hooks.after?.[method]  ?? [])],
      error:  [...(hooks.error?.all  ?? []), ...(hooks.error?.[method]  ?? [])],
    }
  }

  return result
}

// ─── Merge multiple hook maps (service-level + app-level) ────────────────

export function mergeHookMaps(...maps: HookMap[]): HookMap {
  const merged: Required<HookMap> = {
    around: { all: [] },
    before: { all: [] },
    after:  { all: [] },
    error:  { all: [] },
  }

  for (const map of maps) {
    for (const stage of ['around', 'before', 'after', 'error'] as const) {
      if (!map[stage]) continue
      for (const method of Object.keys(map[stage]!)) {
        const hooks = map[stage]![method]
        if (!hooks?.length) continue

        if (!merged[stage][method]) merged[stage][method] = []
        ;(merged[stage][method] as unknown[]).push(...hooks)
      }
    }
  }

  return merged
}

// ─── Pipeline runner ──────────────────────────────────────────────────────

// Minimal telemetry emitter interface — avoids importing IEventBus
interface TelemetryEmitter { emit(event: string, data: unknown): void | Promise<void> }

export async function runPipeline(
  ctx:       ServiceContext,
  pipeline:  ResolvedPipeline,
  method:    () => Promise<void>,
  telemetry?: TelemetryEmitter
): Promise<void> {

  // Wrap everything in around hooks
  const runCore = async (): Promise<void> => {
    // ── Before hooks ─────────────────────────────────────────────
    ctx.type = 'before'
    if (pipeline.before.length) {
      await runHooks(ctx, pipeline.before, 'before', telemetry)
    }

    // Short-circuit: if a before hook already set result, skip the method.
    // The normal case is ctx.result === null (not yet set) → run method().
    if (ctx.result !== null) {
      // Before hook pre-populated the result — skip the actual method call
    } else {
      ctx.type = 'method'
      await method()
    }

    // ── After hooks ───────────────────────────────────────────────
    ctx.type = 'after'
    if (pipeline.after.length) {
      await runHooks(ctx, pipeline.after, 'after', telemetry)
    }
  }

  const runWithError = async (): Promise<void> => {
    try {
      await runCore()
    } catch (err) {
      ctx.type  = 'error'
      ctx.error = toFrameworkError(err)

      if (pipeline.error.length) {
        try {
          await runHooks(ctx, pipeline.error, 'error', telemetry)
          // If error hook cleared ctx.error, treat as recovered
          if (!ctx.error) return
        } catch {
          // Error in error hook — original error wins
        }
      }

      throw ctx.error
    }
  }

  // ── Around hooks ─────────────────────────────────────────────────
  if (!pipeline.around.length) {
    await runWithError()
    return
  }

  await runAroundHooks(ctx, pipeline.around, 0, runWithError, telemetry)
}

// ─── Sequential around hook runner ───────────────────────────────────────

async function runAroundHooks(
  ctx:       ServiceContext,
  hooks:     AroundHook[],
  index:     number,
  core:      () => Promise<void>,
  telemetry?: TelemetryEmitter
): Promise<void> {

  if (index >= hooks.length) {
    await core()
    return
  }

  if (!telemetry) {
    await hooks[index](ctx, () => runAroundHooks(ctx, hooks, index + 1, core))
    return
  }

  // Around hooks: single event at exit with full duration (covers everything inside)
  const hook  = hooks[index]
  const start = Date.now()
  let   status: 'ok' | 'error' = 'ok'
  let   hookErr: { name: string; message: string } | undefined

  try {
    await hook(ctx, () => runAroundHooks(ctx, hooks, index + 1, core, telemetry))
  } catch (err) {
    status  = 'error'
    const e = err as Record<string, unknown>
    hookErr = { name: String(e?.name ?? 'Error'), message: String(e?.message ?? err) }
    throw err
  } finally {
    telemetry.emit('junction.hook', {
      telemetryId: ctx.telemetryId,
      service:     ctx.service,
      method:      ctx.method,
      phase:       'around',
      hookName:    hook.name || 'anonymous',
      index,
      durationMs:  Date.now() - start,
      status,
      ...(hookErr ? { error: hookErr } : {}),
    })
  }
}

// ─── Sequential hook runner ───────────────────────────────────────────────
// Stops early if a before hook sets ctx.result — subsequent before hooks
// are skipped just as the method itself is. This is the correct Feathers
// short-circuit behaviour.

async function runHooks(
  ctx:        ServiceContext,
  hooks:      Hook[],
  phase:      'before' | 'after' | 'error',
  telemetry?: TelemetryEmitter
): Promise<void> {
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i]

    if (!telemetry) {
      await hook(ctx)
      if (phase === 'before' && ctx.result !== null) break
      continue
    }

    const start = Date.now()
    let   status: 'ok' | 'error' = 'ok'
    let   hookErr: { name: string; message: string } | undefined

    try {
      await hook(ctx)
    } catch (err) {
      status  = 'error'
      const e = err as Record<string, unknown>
      hookErr = { name: String(e?.name ?? 'Error'), message: String(e?.message ?? err) }
      throw err
    } finally {
      telemetry.emit('junction.hook', {
        telemetryId: ctx.telemetryId,
        service:     ctx.service,
        method:      ctx.method,
        phase,
        hookName:    hook.name || 'anonymous',
        index:       i,
        durationMs:  Date.now() - start,
        status,
        ...(hookErr ? { error: hookErr } : {}),
      })
    }

    // Short-circuit: if a before hook populated ctx.result, stop the chain.
    if (phase === 'before' && ctx.result !== null) break
  }
}

// ─── Common built-in hooks ────────────────────────────────────────────────

/** Reject unauthenticated requests */
export function authenticate(ctx: ServiceContext): void {
  if (!ctx.params.user)
    throw new Unauthorized('Authentication required')
}

/** Require specific role */
export function requireRole(...roles: string[]): Hook {
  return (ctx: ServiceContext): void => {
    const userRole = ctx.params.user?.role
    if (!userRole || !roles.includes(userRole))
      throw new Forbidden(`Role required: ${roles.join(' | ')}`)
  }
}

/** Attach pagination from query params */
export function paginate(defaultLimit = 20, maxLimit = 100): Hook {
  return (ctx: ServiceContext): void => {
    const query = ctx.query as Record<string, string>
    ctx.params.paginate = {
      limit:  Math.min(parseInt(query.$limit ?? String(defaultLimit), 10), maxLimit),
      offset: parseInt(query.$offset ?? '0', 10),
    }
  }
}

/** Strip fields from result.
 *  Supports dot-path notation for nested fields: protect('user.password', 'meta.internal')
 */
export function protect(...fields: string[]): Hook {
  return (ctx: ServiceContext): void => {
    if (!ctx.result) return

    function stripField(obj: Record<string, unknown>, path: string): void {
      const dot = path.indexOf('.')
      if (dot === -1) {
        // Top-level field
        delete obj[path]
      } else {
        // Nested — recurse into the sub-object
        const key  = path.slice(0, dot)
        const rest = path.slice(dot + 1)
        const sub  = obj[key]
        if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
          stripField(sub as Record<string, unknown>, rest)
        }
      }
    }

    const strip = (obj: Record<string, unknown>) => {
      for (const f of fields) stripField(obj, f)
    }

    if (Array.isArray(ctx.result)) {
      // Plain array result
      (ctx.result as Record<string, unknown>[]).forEach(strip)
    } else if (
      ctx.result &&
      typeof ctx.result === 'object' &&
      Array.isArray((ctx.result as Record<string, unknown>).data)
    ) {
      // Paginated/list envelope — strip from the items inside data
      ((ctx.result as Record<string, unknown>).data as Record<string, unknown>[]).forEach(strip)
    } else if (
      ctx.result &&
      typeof ctx.result === 'object' &&
      'object' in (ctx.result as object) &&
      'data'   in (ctx.result as object) &&
      (ctx.result as Record<string, unknown>).data &&
      typeof (ctx.result as Record<string, unknown>).data === 'object'
    ) {
      // Single-record envelope — { object: model, data: { ...record... }, errors: [] }
      // Strip from .data, never from the envelope itself.
      strip((ctx.result as { data: Record<string, unknown> }).data)
    } else {
      // Bare object (legacy / direct service call without envelope)
      strip(ctx.result as Record<string, unknown>)
    }
  }
}

/** Keep only permitted fields from request data */
export function allow(...fields: string[]): Hook {
  return (ctx: ServiceContext): void => {
    if (!ctx.data) return
    const kept: Record<string, unknown> = {}
    for (const f of fields)
      if (f in ctx.data) kept[f] = ctx.data[f]
    ctx.data = kept
  }
}

/** Attach timestamp fields */
export function timestamps(opts: { created?: string; updated?: string } = {}): Hook {
  const created = opts.created ?? 'created_at'
  const updated = opts.updated ?? 'updated_at'
  return (ctx: ServiceContext): void => {
    if (!ctx.data) return
    const now = new Date().toISOString()
    if (ctx.method === 'create')
      ctx.data[created] = now
    ctx.data[updated] = now
  }
}

/** Log method + timing — around hook */
export function logTiming(logger: { info: (...a: unknown[]) => void }): AroundHook {
  return async (ctx: ServiceContext, next: () => Promise<void>): Promise<void> => {
    const start = Date.now()
    await next()
    logger.info(`${ctx.service}.${ctx.method} ${Date.now() - start}ms`)
  }
}

// ─── Circuit breaker ──────────────────────────────────────────────────────
// Wraps a service method (or action) as an around hook.
// Transitions: CLOSED → OPEN after `threshold` consecutive failures.
//              OPEN   → HALF_OPEN after `timeout` ms.
//              HALF_OPEN → CLOSED on success, back to OPEN on failure.
//
// Usage — protect a service that calls an external API:
//
//   service.hooks({
//     around: {
//       all: [circuitBreaker({ threshold: 5, timeout: 30_000 })]
//     }
//   })
//
// Options:
//   threshold  — consecutive failures before opening. Default 5.
//   timeout    — ms to wait in OPEN state before trying again. Default 30 000.
//   onOpen     — called when circuit opens. Useful for alerting.
//   onClose    — called when circuit resets to closed.
//   onHalfOpen — called when circuit enters half-open probe state.

export interface CircuitBreakerOptions {
  threshold?:  number
  timeout?:    number
  onOpen?:     (ctx: ServiceContext) => void
  onClose?:    (ctx: ServiceContext) => void
  onHalfOpen?: (ctx: ServiceContext) => void
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export function circuitBreaker(opts: CircuitBreakerOptions = {}): AroundHook {

  const threshold = opts.threshold ?? 5
  const timeout   = opts.timeout   ?? 30_000

  let state:      CircuitState = 'CLOSED'
  let failures    = 0
  let openedAt    = 0

  return async (ctx: ServiceContext, next: () => Promise<void>): Promise<void> => {

    // ── OPEN — fail fast unless timeout has elapsed ──────────────
    if (state === 'OPEN') {
      if (Date.now() - openedAt < timeout) {
        throw new (await import('./errors.ts')).Unavailable(
          `Circuit open for ${ctx.service}.${ctx.method} — too many recent failures`
        )
      }
      // Timeout elapsed — allow one probe through
      state = 'HALF_OPEN'
      opts.onHalfOpen?.(ctx)
    }

    // ── CLOSED / HALF_OPEN — attempt the call ────────────────────
    try {
      await next()

      // Success — reset regardless of which state we were in
      if (state !== 'CLOSED') {
        state    = 'CLOSED'
        failures = 0
        opts.onClose?.(ctx)
      } else {
        failures = 0
      }

    } catch (err) {
      failures++

      if (state === 'HALF_OPEN' || failures >= threshold) {
        state    = 'OPEN'
        openedAt = Date.now()
        opts.onOpen?.(ctx)
      }

      throw err
    }
  }
}


// ─── Rate limiter ─────────────────────────────────────────────────────────
// Before hook — operates inside the pipeline where the full ServiceContext
// is available (ctx.params.user, ctx.params.ip, ctx.service, ctx.method).
//
// In-process memory store — correct for single-instance deployments.
// For multi-instance, replace with a Redis-backed counter via the key option.
//
// Distinct from the transport-level rateLimit middleware plugin which applies
// globally at the HTTP layer before any service context exists.
//
// Usage:
//   service.hooks({
//     before: {
//       create: [rateLimitHook({ max: 10, window: '15 minutes' })]
//     }
//   })
//
// Keyed by IP by default. Key by user for authenticated routes:
//   rateLimitHook({ max: 100, window: '1 hour', key: (ctx) => ctx.params.user?.userId ?? ctx.params.ip })

import { TooManyRequests } from './errors.ts'
import { parseTtl }        from '../config/index.ts'
import type { RateLimitHookOptions } from '../auth/types.ts'

export type { RateLimitHookOptions }

export function rateLimit(opts: RateLimitHookOptions): Hook {
  const windowMs = parseTtl(opts.window)
  const counters  = new Map<string, { count: number; resetAt: number }>()

  // GC: sweep expired buckets on the window interval to prevent unbounded growth
  const gc = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of counters) {
      if (bucket.resetAt < now) counters.delete(key)
    }
  }, windowMs)
  if (gc.unref) gc.unref()

  return (ctx: ServiceContext): void => {
    const key = opts.key
      ? opts.key(ctx)
      : (ctx.params.ip as string) ?? 'unknown'

    const now    = Date.now()
    const bucket = counters.get(key)

    if (!bucket || now > bucket.resetAt) {
      counters.set(key, { count: 1, resetAt: now + windowMs })
      return
    }

    bucket.count++

    if (bucket.count > opts.max) {
      throw new TooManyRequests(
        opts.message ?? `Rate limit exceeded — max ${opts.max} requests per ${opts.window}`
      )
    }
  }
}
