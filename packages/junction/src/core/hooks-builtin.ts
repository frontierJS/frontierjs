// core/hooks-builtin.ts
// The built-in hook standard library — authenticate, requireRole, paginate,
// protect, allow, timestamps, logTiming. Split out of hooks.ts, which now
// owns only the pipeline engine. hooks.ts re-exports everything here, so
// existing imports are unaffected.

import type { ServiceContext } from './context.ts'
import { resultData } from './envelope.ts'
import { Unauthorized, Forbidden } from './errors.ts'
import type { Hook, AroundHook } from './hooks.ts'
import { clampPage } from './directives.ts'

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

/**
 * Declare this service's page size, and hold callers to it.
 *
 * It NARROWS `ctx.directives` rather than publishing a second copy of the same
 * fact. `$` is transport syntax and the bridge is its one owner (Invariant 10):
 * it moves every `$` key onto `ctx.directives`, so `ctx.query.$limit` is never
 * there past it — which this hook read for its whole life, falling back to its
 * defaults on every request and silently ignoring the caller's page size. A
 * parallel `ctx.locals.paginate` is exactly how the two came to disagree.
 *
 * Narrowing the directives is also what makes the ceiling reach anything: a
 * custom `find` that hands `ctx.directives` to Litestone now gets it without
 * threading a second value. `ctx.locals.paginate` is still written, for the
 * callers that read it.
 *
 * A MODEL service does not need this — `paginate: { default, max }` is a
 * service option and `parseQuery` has always applied it correctly. This is for
 * a service that builds its own query.
 */
export function paginate(defaultLimit = 20, maxLimit = 100): Hook {
  return (ctx: ServiceContext): void => {
    // `ctx.query` as the fallback: an internal caller may pass `{ limit: 50 }`
    // plainly, having never gone through a bridge.
    const q    = ctx.query as Record<string, unknown> | undefined
    const page = clampPage(ctx.directives, defaultLimit, maxLimit,
      { limit: q?.limit, offset: q?.offset })

    if (ctx.directives) {
      ctx.directives.limit  = page.limit
      ctx.directives.offset = page.offset
    }
    ctx.locals.paginate = page
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
  const pick = (row: Record<string, unknown>): Record<string, unknown> => {
    const kept: Record<string, unknown> = {}
    for (const f of fields) if (f in row) kept[f] = row[f]
    return kept
  }
  return (ctx: ServiceContext): void => {
    if (!ctx.data) return
    // `ctx.data` is a row OR an array of rows — bulk create sends the second.
    // Indexing the union was a type error, and the shape it hid is that this
    // hook did nothing useful on a bulk payload.
    ctx.data = Array.isArray(ctx.data) ? ctx.data.map(pick) : pick(ctx.data)
  }
}

/** Attach timestamp fields */
export function timestamps(opts: { created?: string; updated?: string } = {}): Hook {
  const created = opts.created ?? 'created_at'
  const updated = opts.updated ?? 'updated_at'
  return (ctx: ServiceContext): void => {
    if (!ctx.data) return
    const now   = new Date().toISOString()
    const stamp = (row: Record<string, unknown>) => {
      if (ctx.method === 'create') row[created] = now
      row[updated] = now
    }
    // On a bulk create `ctx.data` is an ARRAY, and the un-narrowed version set
    // the two columns as properties OF THE ARRAY — so every row in a bulk
    // create went in with no timestamps and nothing said so.
    if (Array.isArray(ctx.data)) ctx.data.forEach(stamp)
    else                         stamp(ctx.data)
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

