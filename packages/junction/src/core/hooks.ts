// core/hooks.ts
// Feathers-style hook pipeline with `around` hooks added.
//
// Execution order:
//   around enter  →  before  →  method  →  after  →  around exit
//
// Short-circuit: set ctx.result in a before hook to skip the method.
// Error hooks:   run when any stage throws. around exit still runs.

import type { ServiceContext, ServiceMethod } from './context.ts'
import { toFrameworkError, Unauthorized, Forbidden } from './errors.ts'

// ─── Hook definitions ─────────────────────────────────────────────────────

export type Hook        = (ctx: ServiceContext) => Promise<void> | void
export type AroundHook  = (ctx: ServiceContext, next: () => Promise<void>) => Promise<void>

// HookMap supports all five standard CRUD methods as typed keys (autocomplete),
// plus an index signature for arbitrary method names ('reboot', 'drain', etc.).
// The [method: string] signature must be compatible with the typed keys,
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
  // Runs after `before`, so after the derived layer — the gate has graded the
  // caller and the validator has coerced the payload. The slot an app rule that
  // READS the database belongs in: in `before` it runs for callers the model's
  // @@gate refuses, on data nothing has checked.
  validated?: {
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
  around:    AroundHook[]
  before:    Hook[]
  validated: Hook[]
  after:     Hook[]
  error:     Hook[]
}

// The stages a hook map can carry. One list rather than four literals: a stage
// resolvePipelines walks and mergeHookMaps does not is a hook somebody declared
// that never runs, with nothing said.
export const HOOK_STAGES = ['around', 'before', 'validated', 'after', 'error'] as const

// ─── Merge hook map into resolved pipelines per method ──────────────────
// Processes all five CRUD methods plus any extra method names found in the map.

export function resolvePipelines(hooks: HookMap): Record<string, ResolvedPipeline> {

  const crudMethods: ServiceMethod[] = ['find', 'get', 'create', 'patch', 'remove', 'restore']

  // Collect any custom method names from the hook map
  const customNames = new Set<string>()
  for (const stage of HOOK_STAGES) {
    if (!hooks[stage]) continue
    for (const key of Object.keys(hooks[stage]!)) {
      if (key !== 'all' && !crudMethods.includes(key as ServiceMethod)) {
        customNames.add(key)
      }
    }
  }

  const methods = [...crudMethods, ...customNames]
  const result: Record<string, ResolvedPipeline> = {}

  for (const method of methods) {
    result[method] = {
      around:    [...(hooks.around?.all    ?? []), ...(hooks.around?.[method]    ?? [])],
      before:    [...(hooks.before?.all    ?? []), ...(hooks.before?.[method]    ?? [])],
      validated: [...(hooks.validated?.all ?? []), ...(hooks.validated?.[method] ?? [])],
      after:     [...(hooks.after?.all     ?? []), ...(hooks.after?.[method]     ?? [])],
      error:     [...(hooks.error?.all     ?? []), ...(hooks.error?.[method]     ?? [])],
    }
  }

  // '*' — the all-hooks-only pipeline. callService falls back to this for
  // custom methods that declare no hooks of their own; without it they ran
  // with an EMPTY pipeline, silently skipping every app-level hook
  // (Litestone scoping, logging, error handlers).
  result['*'] = {
    around:    [...(hooks.around?.all    ?? [])],
    before:    [...(hooks.before?.all    ?? [])],
    validated: [...(hooks.validated?.all ?? [])],
    after:     [...(hooks.after?.all     ?? [])],
    error:     [...(hooks.error?.all     ?? [])],
  }

  return result
}

// ─── Merge multiple hook maps (service-level + app-level) ────────────────

export function mergeHookMaps(...maps: HookMap[]): HookMap {
  const merged: Required<HookMap> = {
    around:    { all: [] },
    before:    { all: [] },
    validated: { all: [] },
    after:     { all: [] },
    error:     { all: [] },
  }

  for (const map of maps) {
    for (const stage of HOOK_STAGES) {
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

    // ── Validated hooks ──────────────────────────────────────────
    // The derived layer lives in `before`, so a hook here sees a caller the
    // model's @@gate admitted and a payload autoValidate has coerced. A before
    // hook that answered the call skips these for the same reason it skips the
    // method — there is nothing left to check.
    if (ctx.result === null && pipeline.validated?.length) {
      ctx.type = 'validated'
      await runHooks(ctx, pipeline.validated, 'validated', telemetry)
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
// Stops early if a before or validated hook sets ctx.result — the rest of the
// chain is skipped just as the method itself is. This is the correct Feathers
// short-circuit behaviour.

async function runHooks(
  ctx:        ServiceContext,
  hooks:      Hook[],
  phase:      'before' | 'validated' | 'after' | 'error',
  telemetry?: TelemetryEmitter
): Promise<void> {
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i]

    if (!telemetry) {
      await hook(ctx)
      if ((phase === 'before' || phase === 'validated') && ctx.result !== null) break
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
    if ((phase === 'before' || phase === 'validated') && ctx.result !== null) break
  }
}


// ─── Hook standard library — re-exported for API stability ───────────────
// The built-in hooks and resilience hooks live in their own modules now;
// this module remains the single public import surface for all of them.

export {
  authenticate, requireRole, paginate, protect, allow, timestamps, logTiming,
} from './hooks-builtin.ts'

export {
  circuitBreaker, rateLimit,
  type CircuitBreakerOptions, type RateLimitHookOptions, type BridgeHook,
} from './hooks-resilience.ts'
