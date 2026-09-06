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

/*
 * Did anything actually produce an answer?
 *
 * Three ordinary hook mistakes end the pipeline with nothing having run: an
 * `around` that returns without calling `next()`, an `around` that catches the
 * failure and does not rethrow, and an `error` hook that clears `ctx.error`
 * without setting a result. All three then resolve the call to the `result`
 * the context was BORN with — `null` — which reads to a caller as an answer.
 * `(await r.service.find()).data` is a TypeError one hop from the mistake, and
 * the stack names the app's own screen.
 *
 * `null` is also a legitimate answer (a `get` for a row that is not there), so
 * the value cannot be the test. What separates them is whether anything ever
 * ASSIGNED it, which is why `result` is an accessor rather than a field: an
 * assignment by the transport, by an `around` short-circuiting on purpose, or
 * by a recovering `error` hook all count, and only a chain nobody completed
 * leaves it untouched.
 */
const TOUCHED = Symbol('toolbelt.hooks.resultAssigned')

/**
 * A hook context whose `result` remembers whether it was ever set.
 *
 * Pure: answers a NEW object and does not touch `base`. `result` stays
 * enumerable and reads back as an ordinary property, so a hook spreading the
 * context still copies the value — it just copies it as a plain field, which
 * is what a spread of any accessor does.
 *
 * @param {object} base  the context's fields, `result` included
 * @returns {object}
 */
export function hookContext(base) {
  let value = base?.result ?? null
  const ctx = { ...base }
  Object.defineProperty(ctx, TOUCHED, { value: false, writable: true, enumerable: false })
  Object.defineProperty(ctx, 'result', {
    enumerable: true,
    configurable: true,
    get: () => value,
    set: (v) => { value = v; ctx[TOUCHED] = true },
  })
  return ctx
}

/**
 * Has anything set `ctx.result`? False for a context from anywhere but
 * `hookContext`, so a caller that has not adopted it is never told its
 * pipeline broke.
 *
 * @param {object} ctx
 * @returns {boolean}
 */
export function answered(ctx) {
  return ctx?.[TOUCHED] === true
}

/**
 * What to tell someone whose pipeline ended without an answer.
 *
 * The WORDS live here and the Error class does not: this package's license is
 * that every export is a pure function (`FJS-D26`), and both callers want an
 * error of their own type carrying their own fields. What would drift between
 * two hand-written messages is the half that matters — which phase, and the
 * two ways out — so that is the half with one owner.
 *
 * @param {string} service
 * @param {string} method
 * @param {'around'|'error'} phase
 * @returns {string}
 */
export function hookChainMessage(service, method, phase) {
  const way = phase === 'error'
    ? 'An error hook cleared ctx.error but set no ctx.result, so the failure was '
      + 'discarded and nothing replaced it. Set ctx.result to what the call should '
      + 'resolve to, or leave ctx.error alone to let it throw.'
    : 'An around hook returned without calling next(), or caught the failure and did '
      + 'not rethrow. Call next(), set ctx.result to short-circuit with an answer, or '
      + 'rethrow.'
  return `${service}.${method}: the ${phase} hooks ended the call without an answer. ${way}`
}

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
