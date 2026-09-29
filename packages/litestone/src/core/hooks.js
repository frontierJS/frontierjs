// hooks.js — what watches a client: the `hooks`, `onEvent` and `onQuery`
// options, and `announce`, what a bulk write tells the world.

// ─── What a bulk write tells the world ───────────────────────────────────────
//
// A bulk statement answers `{count}` and never builds its rows, so by default it
// announces a COLLECTION — *count rows under this filter changed* — and every
// open list re-asks the server (FJS-307). That is always correct and costs
// nothing, and it is also the coarsest possible answer: a three-row cancel makes
// every subscribed tab reload its page.
//
// `rows` is the opt-in that buys precision, and what it costs is MEMORY
// proportional to the batch — a `deleteMany` over 100k rows materializes 100k
// rows because somebody subscribed. That is why it cannot be the default, and
// why it cannot be decided by size: the count is unknowable before the statement
// without a second query, so this is declared rather than guessed (FJS-D34).
//
// `none` is the other end and it is not the same as having no subscribers: a
// nightly purge nobody is watching should not send every tab back to the server
// either.
//
// The dial is per CALL with a client-level floor, because the call site is the
// only place the batch size is knowable — the same model carries both a
// three-row cancel and a two-million-row purge.
const ANNOUNCE_MODES = ['collection', 'rows', 'none']

/**
 * Validate an `announce` option, answering it unchanged or `undefined` when the
 * caller named none. A typo is refused by NAME rather than falling back to the
 * default: `announce: 'row'` means somebody wanted per-row announcements, and
 * silently giving them the coarse one is the class of bug FJS-307 closed.
 */
export function checkAnnounce(value, where) {
  if (value === undefined || value === null) return undefined
  if (ANNOUNCE_MODES.includes(value)) return value
  // 400 rather than a 500: the request named something that does not exist, and
  // the identical call fails identically until the caller changes it.
  const err = new Error(
    `${where}: announce must be one of ${ANNOUNCE_MODES.map(m => `'${m}'`).join(', ')} — got ${JSON.stringify(value)}.`)
  err.name      = 'InvalidAnnounceError'
  err.status    = 400
  err.retryable = false
  throw err
}

// ─── Query event emission ─────────────────────────────────────────────────────
//
// One statement, one event. Module level rather than inside the table closure
// because `resolveIncludes` runs statements too and is not in that closure —
// and a second copy of this body there is exactly the second origin the tap
// exists to avoid.
//
// Zero-cost when nothing is listening. Never throws and never blocks: a tap is
// an observer, so a listener that fails must not fail the read it is watching.
export function emitQuery(ctx, model, database, event) {
  if (!ctx.onQuery && !ctx._queryListeners.size) return
  // `system` because `actorId` cannot say it: a bare client and `asSystem()`
  // both report null, and only the second returns @guarded and @encrypted
  // values — so a watcher grading what a read EXPOSED could not tell them apart.
  const e = { model, database, actorId: ctx.auth?.id ?? null, system: !!ctx.isSystem, ...event }
  if (ctx.onQuery) { try { const r = ctx.onQuery(e); if (r?.catch) r.catch(() => {}) } catch {} }
  if (ctx._queryListeners.size) for (const fn of ctx._queryListeners) { try { const r = fn(e); if (r?.catch) r.catch(() => {}) } catch {} }
}

/** Is anything watching? The guard every include timer is behind. */
export function queryTapped(ctx) {
  return !!(ctx.onQuery || ctx._queryListeners.size)
}

// ─── Hook + event engine ──────────────────────────────────────────────────────
//
// TWO distinct systems:
//
// 1. Transform hooks  — synchronous middleware, run IN the query pipeline.
//    Can mutate args.data before write, or transform result rows after read.
//    Registered as: hooks.before.{operation|setters|getters|all}
//                   hooks.after.{operation|setters|getters|all}
//
// 2. Event listeners  — async callbacks, fire AFTER commit completes.
//    The caller already has their result. Used for side effects.
//    Registered as: on.{create|update|remove|change}
//
// Operation groups — the two sets below are the contract, and `installHooks`
// is the only thing that calls the runner, so a name in a set is a name that
// fires. Registering on eleven of them used to be silent in both directions
// (FJS-288): the hook never ran, and nothing said it would not.
//   setters  — create, createMany, update, updateMany, upsert, upsertMany,
//              remove, removeMany, delete, deleteMany
//   getters  — findMany, findFirst, findUnique, findManyCursor, count, search, exists
//   all      — everything
//
// Context shape (same for both systems):
//   { model, operation, args, result, schema }
//   args   — mutable in before hooks (changes affect the actual query)
//   result — present in after hooks + events (read-only in events)

const SETTER_OPS = new Set(['create','createMany','update','updateMany','upsert','upsertMany','remove','removeMany','delete','deleteMany'])
const GETTER_OPS = new Set(['findMany','findFirst','findUnique','findManyCursor','count','search','exists'])

// Table method → the operation a hook names it by. Everything in the two sets
// above, plus the composite reads that are a findMany wearing another shape.
const HOOKED_METHODS = new Map([
  ...[...SETTER_OPS, ...GETTER_OPS].map(op => [op, op]),
  ['findManyAndCount', 'findMany'],
])

export function buildHookRunner(hooks) {
  if (!hooks) return null

  // Flatten hook config into { before: Map<op, [fn]>, after: Map<op, [fn]> }
  function expand(phase) {
    const map = new Map()
    const cfg = hooks[phase]
    if (!cfg) return map

    for (const [key, fns] of Object.entries(cfg)) {
      const arr = Array.isArray(fns) ? fns : [fns]
      if (key === 'all') {
        // Apply to every operation
        for (const op of [...SETTER_OPS, ...GETTER_OPS]) {
          if (!map.has(op)) map.set(op, [])
          map.get(op).push(...arr)
        }
      } else if (key === 'setters') {
        for (const op of SETTER_OPS) {
          if (!map.has(op)) map.set(op, [])
          map.get(op).push(...arr)
        }
      } else if (key === 'getters') {
        for (const op of GETTER_OPS) {
          if (!map.has(op)) map.set(op, [])
          map.get(op).push(...arr)
        }
      } else {
        // Exact operation name
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(...arr)
      }
    }
    return map
  }

  const before = expand('before')
  const after  = expand('after')

  return {
    // Run before hooks — mutates ctx.args in place, returns ctx
    runBefore(hctx, clientCtx) {
      const fns = before.get(hctx.operation) ?? []
      for (const fn of fns) {
        const result = fn(clientCtx, hctx)
        if (result && typeof result === 'object') Object.assign(hctx, result)
      }
      return hctx
    },
    // Run after hooks — mutates hctx.result in place, returns hctx
    runAfter(hctx, clientCtx) {
      const fns = after.get(hctx.operation) ?? []
      for (const fn of fns) {
        const result = fn(clientCtx, hctx)
        if (result && typeof result === 'object' && 'result' in result) {
          hctx.result = result.result
        }
      }
      return hctx
    },
    hasBefore: (op) => (before.get(op)?.length ?? 0) > 0,
    hasAfter:  (op) => (after.get(op)?.length ?? 0) > 0,
  }
}

// ─── installHooks — the one call site of the runner ───────────────────────────
//
// Wraps a built table so every declared operation runs its hooks, in one place
// rather than sixteen hand-written pairs inside the methods (five of which were
// ever written — FJS-288).
//
// A hook fires ONCE per call the caller made, named for the method they named.
// That is what the two `this` bindings below decide:
//
//   a hooked operation  → runs against the RAW table, so its own internal calls
//                         (upsert → create/update, findMany({recursive}) →
//                         findMany) do not announce a second time
//   everything else     → runs against the WRAPPER, so a delegating helper
//                         (transition → update, findFirstOrThrow → findFirst)
//                         reaches the hook of the operation it delegates to
//
// `search` is the one method that is not (argsObject) — a before hook rewriting
// `args.query` rewrites the search text, which is the useful thing to be able
// to do there.
export function installHooks(table, ctx, modelName) {
  const runner = ctx.hookRunner
  if (!runner) return table

  const outer = {}
  for (const key of Object.keys(table)) {
    const fn = table[key]
    if (typeof fn !== 'function') { outer[key] = table[key]; continue }

    const op = HOOKED_METHODS.get(key)
    if (!op) { outer[key] = (...a) => fn.apply(outer, a); continue }
    if (!runner.hasBefore(op) && !runner.hasAfter(op)) { outer[key] = (...a) => fn.apply(table, a); continue }

    const isSearch = key === 'search'
    outer[key] = async (...a) => {
      const hctx = {
        model:     modelName,
        operation: op,
        args:      isSearch ? { query: a[0], ...(a[1] ?? {}) } : (a[0] ?? {}),
        schema:    ctx.models[modelName],
      }
      if (runner.hasBefore(op)) runner.runBefore(hctx, ctx)
      const result = isSearch
        ? await fn.call(table, hctx.args.query, hctx.args)
        : await fn.call(table, hctx.args, ...a.slice(1))
      if (!runner.hasAfter(op)) return result
      hctx.result = result
      runner.runAfter(hctx, ctx)
      return hctx.result
    }
  }
  return outer
}

export function buildEventEmitter(onEvent) {
  if (!onEvent) return null
  // Normalize: onEvent.create, onEvent.update, onEvent.remove, onEvent.change
  // Each can be a single function or array of functions
  const listeners = {}
  for (const [event, fns] of Object.entries(onEvent)) {
    listeners[event] = Array.isArray(fns) ? fns : [fns]
  }

  // Precompute the merged (event + change) listener array per event —
  // previously two array spreads ran on every single write.
  const merged = {}
  for (const event of Object.keys(listeners)) {
    if (event === 'change') continue
    merged[event] = [...(listeners[event] ?? []), ...(listeners.change ?? [])]
  }
  const changeOnly = listeners.change ?? []

  return {
    emit(event, eventCtx, clientCtx) {
      // Fire-and-forget — never blocks the caller
      const fns = merged[event] ?? changeOnly
      if (!fns.length) return
      // setImmediate fires after the caller's await resolves, without the
      // timer-heap overhead and ~1ms clamping of setTimeout(0)
      setImmediate(() => {
        for (const fn of fns) {
          try { fn(eventCtx, clientCtx) } catch (e) { console.warn(`litestone event listener error (${event}):`, e) }
        }
      })
    }
  }
}
