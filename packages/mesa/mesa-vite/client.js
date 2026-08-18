/**
 * mesa-vite/client — HMR client runtime (runs in the browser).
 *
 * Exported as `@frontierjs/mesa/vite/client`, and served by both this package's
 * Vite plugin and Sierra's at their own virtual ids (`FJS-D16`).
 *
 * DOM structure after mount:
 *   <!--mesa:hmr:Name-->   ← hmrMark  (stable, lives in old module closure)
 *   ... rendered DOM ...
 *   <!---->                ← anchor   (runtime comment, passed as __anchor)
 *
 * What this module owns is the REGISTRY and Vite's side of the handshake. The
 * swap itself — clear between the two markers, seed the mark, re-call — is
 * `./swap.js`, because jetty performs the same swap from its own dev client
 * and two copies of one algorithm drift (`FJS-259`).
 *
 * NOTE ON SCOPE: this is not state-preserving. The component's own signals are
 * rebuilt from scratch — a counter inside the edited component resets. What
 * survives is everything around it: router state, scroll position, sibling
 * components, and the rest of the page. That is the whole win over a full
 * reload, and it is worth being precise about.
 */

import { swapInstances } from './swap.js'

const _registry = new Map()   // id → Set<entry>

export function __mesa_register(id, hmrMark, anchor, props, block, fn) {
  if (!_registry.has(id)) _registry.set(id, new Set())
  const entry = { hmrMark, anchor, props, block, fn }
  _registry.get(id).add(entry)
  return () => {
    const set = _registry.get(id)
    if (set) { set.delete(entry); if (!set.size) _registry.delete(id) }
  }
}

export function __mesa_hot_update(id, newFn) {
  const entries = _registry.get(id)
  if (!entries?.size) {
    // Nothing to swap in place. Invalidating this module escalates to the full
    // reload Vite would have done anyway — without it the edit is simply lost,
    // and the page keeps rendering the previous version with only a console
    // warning to say so.
    console.warn(`[Mesa HMR] No registered instances for ${id} — falling back to reload`)
    import.meta.hot?.invalidate?.()
    return
  }

  const count = swapInstances(entries, newFn, newFn.__setMark, id.split('/').pop())

  if (count > 0) {
    console.debug(`[Mesa HMR] ♻ ${id.split('/').pop()} — ${count} instance(s) updated`)
  } else {
    console.warn(`[Mesa HMR] ${id.split('/').pop()} — no connected instances found`)
  }
}
