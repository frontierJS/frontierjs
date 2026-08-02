// core/hooks-builtin.ts
// The built-in hook standard library — authenticate, requireRole, paginate,
// protect, allow, timestamps, logTiming. Split out of hooks.ts, which now
// owns only the pipeline engine. hooks.ts re-exports everything here, so
// existing imports are unaffected.

import type { ServiceContext } from './context.ts'
import { resultData } from './envelope.ts'
import { Unauthorized, Forbidden } from './errors.ts'
import type { Hook, AroundHook } from './hooks.ts'

// ─── Common built-in hooks ────────────────────────────────────────────────

/** Reject unauthenticated requests */
export function authenticate(ctx: ServiceContext): void {
  if (!ctx.auth.user)
    throw new Unauthorized('Authentication required')
}

/** Require specific role */
export function requireRole(...roles: string[]): Hook {
  return (ctx: ServiceContext): void => {
    const userRole = ctx.auth.user?.role
    if (!userRole || !roles.includes(userRole))
      throw new Forbidden(`Role required: ${roles.join(' | ')}`)
  }
}

/** Attach pagination from query params */
export function paginate(defaultLimit = 20, maxLimit = 100): Hook {
  return (ctx: ServiceContext): void => {
    const query = ctx.query as Record<string, string>
    ctx.locals.paginate = {
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

    // Always strip the RECORDS, never the envelope. resultData() reaches
    // through either kind, and returns a bare value untouched — so envelope,
    // bare array and bare object all land in the same two lines.
    //
    // This was four hand-rolled branches inspecting `.data` and `'object' in
    // result`, and the reason to care is on the record: the July password leak
    // was protect() stripping fields off the WRAPPER instead of the record,
    // which removed nothing and reported success.
    const target = resultData(ctx.result)

    if (Array.isArray(target)) {
      (target as Record<string, unknown>[]).forEach(strip)
    } else if (target && typeof target === 'object') {
      strip(target as Record<string, unknown>)
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

