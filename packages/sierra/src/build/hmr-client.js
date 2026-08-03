/**
 * build/hmr-client.js — browser-side HMR registry.
 *
 * Ported from @frontierjs/mesa-vite/client.js. Sierra reimplements the Mesa
 * Vite plugin rather than wrapping it (it needs frontmatter stripping, the code
 * fence preprocessor, slot rewriting, auto-imports and externalSignals), so the
 * HMR half has to come along too. Keep this in sync with mesa-vite/client.js.
 *
 * DOM layout after mount:
 *   <!--mesa:hmr:Name-->    hmrMark — stable, captured in the old module closure
 *   ...rendered DOM...
 *   <!---->                 anchor  — runtime comment, passed as __anchor
 *
 * On update: remove everything between hmrMark and anchor, then re-invoke the
 * new component function with the props captured at mount.
 *
 * NOTE ON SCOPE: this is not state-preserving. The component's own signals are
 * rebuilt from scratch — a counter inside the edited component resets. What
 * survives is everything around it: router state, scroll position, sibling
 * components, and the rest of the page. That is the whole win over a full
 * reload, and it is worth being precise about.
 */

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
    console.warn(`[Sierra HMR] No registered instances for ${id} — falling back to reload`)
    import.meta.hot?.invalidate?.()
    return
  }

  // Re-rendering registers new entries into the same Set, so work from a
  // snapshot and drop stale entries as we go.
  const snapshot = [...entries]
  let count = 0

  for (const entry of snapshot) {
    const { hmrMark, anchor, props, block } = entry

    if (!anchor?.isConnected || !anchor.parentNode || !hmrMark) {
      entries.delete(entry)
      continue
    }

    const parent = anchor.parentNode
    let node = hmrMark.nextSibling
    while (node && node !== anchor) {
      const next = node.nextSibling
      parent.removeChild(node)
      node = next
    }

    // Remove before re-rendering — the new render registers a fresh entry.
    entries.delete(entry)

    try {
      if (typeof newFn.__setMark === 'function') newFn.__setMark(hmrMark)
      newFn(anchor, props, block)
      count++
    } catch (err) {
      console.error(`[Sierra HMR] Remount failed (${id.split('/').pop()}):`, err)
    }
  }

  if (count > 0) {
    console.debug(`[Sierra HMR] ♻ ${id.split('/').pop()} — ${count} instance(s)`)
  } else {
    console.warn(`[Sierra HMR] ${id.split('/').pop()} — no connected instances`)
  }
}
