// plugins/search/index.ts
// searchService({ models }) — one ranked list across models, over one round trip.
//
//   GET /search?q=quasar                       every model the mount holds
//   GET /search?q=quasar&models=issue,comment  a subset of them
//   app.service('search').find({ q: 'quasar' })
//
// The index, the rank and the grade are litestone's `db.$search` (`FJS-D970`):
// one MATCH over `_search`, each model's own row policy folded in before the
// LIMIT. This adds the route and the mount and nothing else, so a hit the
// caller may not read cannot come from here (Invariant 6) — the client the call
// holds is the caller's, and `$search` grades as that client.
//
// The mount is where an app says which models a palette holds. A caller may
// narrow it and never widen it: `$search` would answer any `@@fts` model, so a
// model the app left out of its palette would otherwise be one query string
// away.

import { createService } from '../../core/service.ts'
import { BadRequest }    from '../../core/errors.ts'
import type { ServiceDefinition } from '../../core/service.ts'
import type { ServiceContext } from '../../core/context.ts'
import { callDb } from '../../core/context.ts'

/** Options for `searchService()`. */
export interface SearchServiceOptions {
  /** The accessors this search holds (`['issue', 'comment']`). Each must declare `@@fts`. */
  models: readonly string[]
  /** The URL segment and registry key. Default `'search'`. */
  name?: string
}

/** One hit: `db.$search`'s answer, unchanged. */
export interface SearchHit {
  model:    string
  id:       unknown
  title:    string
  sub:      unknown
  _rank:    number | null
  _snippet: string | null
}

const KEYS = ['q', 'models'] as const

/** `?models=a,b`, `?models=a&models=b` and an internal `['a', 'b']` all name the same list. */
function modelList(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : [raw]
  return parts.flatMap(p => String(p).split(',')).map(s => s.trim()).filter(Boolean)
}

export function searchService({ models, name = 'search' }: SearchServiceOptions): ServiceDefinition {
  if (!Array.isArray(models) || !models.length) {
    throw new TypeError(`searchService({ models }) names the accessors this search holds, e.g. models: ['issue', 'comment'] — got ${JSON.stringify(models)}`)
  }
  const held = [...new Set(models)]

  return createService({
    name,
    model:         null,
    // Level 0 states that no level grades this verb: each hit is graded by its
    // own model's row policies. Undeclared, mcp reports the tool as graded by nothing.
    methods:       [{ method: 'find', gate: 0 }],
    reservedQuery: KEYS,

    async find(ctx: ServiceContext) {
      // A key that is neither is a misspelling, and ignoring it answers the
      // whole mount where the caller asked for less.
      const stray = Object.keys((ctx.query ?? {}) as Record<string, unknown>)
      if (stray.length) {
        throw new BadRequest(`${name}: '${stray[0]}' is not a search key. ${name} takes q (the words) and models (which of ${held.join(', ')})`)
      }

      const reserved = (ctx.reserved ?? {}) as Record<string, unknown>
      const q = typeof reserved.q === 'string' ? reserved.q.trim() : ''
      // An empty box answers nothing rather than everything a caller may read.
      if (!q) return []

      let chosen = held
      if (reserved.models != null) {
        chosen = modelList(reserved.models)
        for (const m of chosen) {
          if (!held.includes(m)) {
            throw new BadRequest(`${name}: '${m}' is not in this search. Models it holds: ${held.join(', ')}`)
          }
        }
        if (!chosen.length) return []
      }

      const db = callDb(ctx)
      if (!db || !('$search' in db) || !db.$search) {
        throw new Error(`${name}: the call's client has no $search, so searchService needs a litestone client`)
      }
      const { limit, offset } = (ctx.directives ?? {}) as { limit?: number; offset?: number }
      // A palette searches as the word is typed, so the last word is a prefix.
      const found = await db.$search(q, {
        models: chosen, prefix: true,
        ...(limit  != null ? { limit }  : {}),
        ...(offset != null ? { offset } : {}),
      })
      return found as unknown as SearchHit[]
    },
  })
}
