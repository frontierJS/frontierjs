/**
 * hooks — the four-phase hook pipeline a resource runs a call through.
 *
 * `@frontierjs/toolbelt/hooks`. Pure: these are combinators over lists of
 * functions. What the hooks themselves do is the caller's business.
 *
 * The phases are the API realm's, so that a hook written against a Junction
 * service reads the same on the browser side of the wire:
 *
 *   before  — before the call. Validate, guard, attach context.
 *   after   — after a successful call. Transform the result.
 *   around  — wraps the whole operation, the call included. Receives
 *             `(ctx, next)` and must call `next()` to continue.
 *   error   — anything above threw. Clearing `ctx.error` recovers and returns
 *             `ctx.result`.
 *
 *   around:enter → before → [the call] → after → around:exit
 *                                ↓ (on throw)
 *                             error
 *
 * Two callers: Sierra's `createResource` and jetty's. They were a hand copy of
 * each other (`FJS-059`); what still differs between them is the transport,
 * which is not a fact with two owners but two facts.
 */

/** Run a list of hooks in order, awaiting each. An empty or absent list is a no-op. */
export async function runHooks(list, ctx) {
  if (!list?.length) return
  for (const hook of list) await hook(ctx)
}

/**
 * Compose around-hooks into a nested chain, innermost call being `inner`.
 * A hook that never calls `next()` short-circuits the operation, which is the
 * point of the phase.
 */
export async function runAroundHooks(list, ctx, inner) {
  if (!list?.length) return inner()
  let i = 0
  async function next() {
    const hook = list[i++]
    if (!hook) return inner()
    return hook(ctx, next)
  }
  return next()
}

/** One phase for one method: `phase.all` first, then `phase[method]`. */
export async function runPhase(hookMap, phase, method, ctx) {
  const p = hookMap?.[phase]
  if (!p) return
  await runHooks(p.all, ctx)
  await runHooks(p[method], ctx)
}

/**
 * Merge two hook maps, existing hooks first.
 *
 * Returns a NEW map and mutates neither argument — this package's license is
 * that every export is pure (`FJS-D26`), and both callers hold their map in a
 * variable they can reassign. The older in-place spelling read as `mergeHooks(a,
 * b)` with the result discarded, so a caller who now forgets the assignment
 * gets a map that never grew rather than one silently rewritten.
 */
export function mergeHooks(target, incoming) {
  const out = {}
  for (const phase of ['before', 'after', 'around', 'error']) {
    const t = target?.[phase]
    const i = incoming?.[phase]
    if (!t && !i) continue
    out[phase] = {}
    for (const method of new Set([...Object.keys(t ?? {}), ...Object.keys(i ?? {})])) {
      out[phase][method] = [...(t?.[method] ?? []), ...(i?.[method] ?? [])]
    }
  }
  return out
}
