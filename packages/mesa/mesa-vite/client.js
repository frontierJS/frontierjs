/**
 * @frontierjs/mesa-vite/client — HMR client runtime (runs in the browser).
 *
 * DOM structure after mount:
 *   [label node]
 *   <!--mesa:hmr:Name-->   ← hmrMark  (stable, lives in old module closure)
 *   ... rendered DOM ...
 *   <!---->                ← anchor   (runtime comment, passed as __anchor)
 *
 * Hot update: clear everything between hmrMark and anchor, re-call newFn.
 * We pass the existing hmrMark from the registry into the new render so
 * the new module's __hmrMark variable doesn't need to be set.
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
    console.warn(`[Mesa HMR] No registered instances for ${id}`)
    return
  }

  // Snapshot entries — re-rendering will add new registrations to the set,
  // so we work from a copy and remove stale entries after each update.
  const snapshot = [...entries]
  let count = 0

  for (const entry of snapshot) {
    const { hmrMark, anchor, props, block } = entry
    if (!anchor.isConnected) {
      entries.delete(entry)
      continue
    }

    const parent = anchor.parentNode
    if (!parent) {
      entries.delete(entry)
      continue
    }

    if (!hmrMark) {
      entries.delete(entry)
      continue
    }

    // Remove all nodes between hmrMark and anchor (exclusive)
    let node = hmrMark.nextSibling
    while (node && node !== anchor) {
      const next = node.nextSibling
      parent.removeChild(node)
      node = next
    }

    // Remove this entry before re-rendering — the new render will register a fresh one
    entries.delete(entry)

    try {
      if (typeof newFn.__setMark === 'function') {
        newFn.__setMark(hmrMark)
      }
      newFn(anchor, props, block)
      count++
    } catch (err) {
      console.error(`[Mesa HMR] Remount error (${id.split('/').pop()}):`, err)
    }
  }

  if (count > 0) {
    console.debug(`[Mesa HMR] ♻ ${id.split('/').pop()} — ${count} instance(s) updated`)
  } else {
    console.warn(`[Mesa HMR] ${id.split('/').pop()} — no connected instances found`)
  }
}
