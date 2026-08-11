/**
 * router/signals.js — reactive signals for the router
 *
 * These are Mesa signals. Sierra does not implement its own reactivity.
 *
 * HISTORY — worth reading before changing this file.
 *
 * This module used to contain a parallel pub/sub signal implementation,
 * justified by a comment claiming the router could not import
 * @frontierjs/mesa/runtime because "Mesa compiles components that import the
 * router" and that would be circular.
 *
 * It isn't. runtime.js has zero imports — it is a standalone module, and
 * compiler.js is a separate entry point that only the Vite plugin loads. The
 * compiler transforms .mesa files at build time; the runtime is what the output
 * imports at execution time. router → runtime and component → runtime is a
 * diamond, not a cycle.
 *
 * The cost of that mistaken belief was a second signal system plus a runtime
 * bridge generated into virtual:sierra, which monkey-patched `.get` on each
 * exported signal to point at a Mesa read function. That bridge left `.value`
 * pointing at the old closure, so `sig.value` was a silently untracked read —
 * an effect reading it never re-ran — while `sig.get()` tracked correctly. In
 * templates it was worse: the compiler's accessor rewrite turned
 * `{params.value}` into `params.get().value`, a property lookup on the params
 * object.
 *
 * Using Mesa signals directly removes the bridge, the ordering hazard around
 * when the patch had to be applied, and the `.value` trap. Reads are tracked by
 * Mesa's own `_listener`, and writes coalesce through its microtask scheduler,
 * so the eight signal commits at the end of a navigation produce one render
 * rather than eight. (Measured at one both before and after this change — the
 * bridge was not defeating the scheduler, it was just redundant.)
 *
 * NOTHING HERE IS EXPORTED AT MODULE SCOPE ANY MORE, and that is load-bearing.
 * A module-level signal is only reactive in a template if the consuming build
 * names it in an `externalSignals` map — in another package, by hand — and the
 * map is gone (`FJS-060`). `page`, `status` and `theme` are plain objects a
 * component watches with `$:`. The one caller left is `presence(channelId)`,
 * which returns a signal from a function call: no map could ever have described
 * that, and the caller holds the object rather than importing a name.
 * `tests/no-module-signals.test.js` is what keeps it that way.
 */

import { createSignal, createEffect } from '@frontierjs/mesa/runtime.js'

/**
 * Create a reactive signal.
 *
 * @template T
 * @param {T} initial
 * @returns {{ get(): T, set(v: T): void, subscribe(fn: (v: T) => void): () => void }}
 */
export function signal(initial) {
  const [read, write] = createSignal(initial)

  return {
    /** Tracked read — registers with Mesa's reactive graph inside an effect. */
    get: read,

    /** Write. Notifies on the next microtask flush, coalesced with other writes. */
    set: write,

    /**
     * Subscribe to changes. Calls fn immediately with the current value and
     * returns an unsubscribe function.
     *
     * Retained for API compatibility; nothing inside Sierra uses it now that the
     * virtual:sierra bridge is gone. Prefer reading the signal inside a Mesa
     * component and letting the compiler wire the dependency.
     */
    subscribe(fn) {
      return createEffect(() => fn(read()))
    },
  }
}

// NOTE: `derived()` was removed. It was exported, imported once by
// router/index.js, and never called. Its implementation also had two defects
// worth not resurrecting: it recomputed k+1 times at creation for k sources
// (each `subscribe` fires immediately), and it had no unsubscribe path.
// Use Mesa's `createMemo` instead — lazy, cached, and owner-scoped.
