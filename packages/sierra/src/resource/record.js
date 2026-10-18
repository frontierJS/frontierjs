/**
 * sierra/resource/record — `resource.record(id)` as a component reads it.
 *
 * Junction's view of one row is a subscription: `subscribe`, `ready`, and an
 * `error()` that is a plain function. A screen built on that alone restates the
 * same dozen lines — a `let` for the row, a subscribe writing it, a `ready`
 * handler turning `error()` into a sentence, a `loaded` flag so a missing row
 * does not spin forever, and an `$.onDestroy` releasing it. This is those, once,
 * on the same terms `list()` gives a list:
 *
 *   const row = orders.record(id)          // released with the component
 *   $: record = row.value                  // moves on a push
 *   $: if (row.loaded && !row.value) failed = row.error()
 *
 * Everything the view already answered is still there — `subscribe`, `ready`,
 * `get`, `refresh`, `release` — so a screen written against the view is
 * unchanged by this.
 *
 * ─── Released with its OWNER, never with its owner's next run ──────────────
 *
 * `list()` releases from inside an effect. That cannot be copied here: a `$:`
 * re-run disposes the effects its body created, and a screen that calls
 * `record(id)` from a `$:` and keeps the view while the id is unchanged would
 * be released under itself and go deaf to pushes with nothing said. A root is
 * an inert owner node, which a re-run leaves alone and a teardown disposes. A
 * view made where nothing owns it — module scope, after an `await` — is
 * released by the caller, as before.
 */

import { createSignal, createRoot, onCleanup } from '@frontierjs/mesa/runtime'

/**
 * @param {object} view  junction's `RecordResult`
 * @returns {object} the view, plus `value` and `loaded`; `error()` is tracked
 */
export function liveRecord(view) {
  return createRoot((dispose) => {
    const [value,   setValue]   = createSignal(view.get())
    const [loaded,  setLoaded]  = createSignal(false)
    // `error()` keeps its shape and becomes tracked. A refresh that fails after
    // the first read re-emits the SAME row, which the value signal swallows as
    // unchanged — so without this a screen never hears that the row went away.
    const [failure, setFailure] = createSignal(view.error())

    const off = view.subscribe((v) => {
      setValue(v)
      setFailure(view.error())
    })
    onCleanup(() => { off(); view.release() })

    // `ready` resolves null on a refusal rather than rejecting, so `finally` is
    // the one place both outcomes pass.
    Promise.resolve(view.ready)
      .catch(() => null)
      .finally(() => {
        setFailure(view.error())
        setLoaded(true)
      })

    return {
      ...view,
      /** The row, or `null` — tracked, so a `$:` reading it moves on a push. */
      get value()  { return value() },
      /** The first read has FINISHED, whatever it found. Tracked. */
      get loaded() { return loaded() },
      error:   () => (failure(), view.error()),
      // A read that succeeds over an unchanged row moves no entry, so nothing
      // emits and a cleared failure would otherwise stay on screen.
      refresh: () => view.refresh().finally(() => setFailure(view.error())),
      release: dispose,
    }
  })
}
