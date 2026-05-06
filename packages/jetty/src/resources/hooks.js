// hooks.js — 4-phase resource hook pipeline.
//
// Ported from @frontierjs/sierra/junction/resource.js (Sierra v0.1.0).
// Pure logic; no transport coupling. Will move to @frontierjs/resources-core
// in the Option B refactor (see docs/future-refactors.md).
//
// Phases (matches the Junction/Litestone "API realm" semantics exactly):
//
//   before  — runs before the network call. Validate, guard, attach context.
//   after   — runs after a successful call. Transform data, format dates.
//   around  — wraps the entire operation including the network call.
//             Receives (ctx, next) — must call next() to continue.
//   error   — runs when any phase or the network call throws.
//             Clear ctx.error to recover and return ctx.result.
//
// Pipeline:
//   around:enter → before → [network call] → after → around:exit
//                                  ↓ (on throw)
//                               error

/**
 * Run a list of sync/async hooks sequentially. No-op for empty/missing list.
 */
export async function runHooks(list, ctx) {
  if (!list?.length) return
  for (const hook of list) await hook(ctx)
}

/**
 * Run around-hooks composed as a nested chain. Each hook receives (ctx, next);
 * the innermost call invokes the wrapped operation. Empty list short-circuits.
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

/**
 * Run a single phase's hooks for a method: phase.all first, then phase[method].
 */
export async function runPhase(hookMap, phase, method, ctx) {
  const p = hookMap?.[phase]
  if (!p) return
  await runHooks(p.all, ctx)
  await runHooks(p[method], ctx)
}

/**
 * Merge incoming hooks into a target hook map, preserving order:
 * existing hooks run first, then new ones.
 *
 * Mutates `target`. Returns nothing.
 */
export function mergeHooks(target, incoming) {
  for (const phase of ['before', 'after', 'around', 'error']) {
    if (!incoming[phase]) continue
    if (!target[phase]) target[phase] = {}
    for (const method of Object.keys(incoming[phase])) {
      target[phase][method] = [
        ...(target[phase][method] ?? []),
        ...(incoming[phase][method] ?? []),
      ]
    }
  }
}
