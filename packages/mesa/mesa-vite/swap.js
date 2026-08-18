/**
 * mesa-vite/swap — the DOM swap a hot update performs, and the one owner of it.
 *
 * Exported as `@frontierjs/mesa/vite/swap`.
 *
 * A mounted component leaves two markers in the document:
 *
 *   <!--mesa:hmr:Name-->   ← hmrMark  (stable, held by the old module's closure)
 *   ... rendered DOM ...
 *   <!---->                ← anchor   (the runtime comment passed as __anchor)
 *
 * Swapping in a new version means removing every node between the two and
 * re-calling the new component function against the SAME anchor and the same
 * mark — which is why `__setMark` is seeded first: the new module's wrapper
 * would otherwise create a second mark and the next update would clear the
 * wrong range.
 *
 * This module carries no `import.meta` and imports nothing. Both are load-
 * bearing: jetty calls it from a dev client that is bundled into MV3 content
 * scripts, which are CLASSIC scripts — an `import.meta` token anywhere in the
 * bundle is a parse error before a line of it runs (`FJS-030`).
 *
 * Not state-preserving, and that is the contract: the component's own signals
 * are rebuilt, so a counter inside the edited component resets. What survives
 * is everything around it — router state, scroll position, siblings, the rest
 * of the page.
 */

/**
 * Re-render every live instance in `entries` against the new function.
 *
 * `entries` is the live registry Set and is MUTATED: an instance whose anchor
 * has left the document is dropped, and one that is re-rendered is dropped too
 * because the new render registers a fresh entry of its own. Working from a
 * snapshot is what makes that safe — re-rendering adds to the same Set.
 *
 * @param {Set<{hmrMark: Node, anchor: Node, props: any, block: any}>} entries
 * @param {Function} newFn        the new component fn — `(anchor, props, block)`
 * @param {Function} [newSetMark] the new module's `__setMark`, seeded before each call
 * @param {string} [label]        what to name in a remount error
 * @returns {number} how many instances were re-rendered
 */
export function swapInstances(entries, newFn, newSetMark, label = 'component') {
  const snapshot = [...entries]
  let count = 0

  for (const entry of snapshot) {
    const { hmrMark, anchor, props, block } = entry

    // An instance whose anchor has been detached is gone for good — the page
    // navigated, a parent block tore it down. Dropping it here is what keeps
    // the registry from growing across a session of edits.
    if (!hmrMark || !anchor.isConnected || !anchor.parentNode) {
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

    // Before re-rendering, not after: the new render registers its own entry,
    // and removing afterwards would delete the fresh one.
    entries.delete(entry)

    try {
      if (typeof newSetMark === 'function') newSetMark(hmrMark)
      newFn(anchor, props, block)
      count++
    } catch (err) {
      // One instance throwing must not cost the others their update — the
      // page would then hold a mix of old and new renders with nothing saying
      // which is which.
      console.error(`[Mesa HMR] Remount error (${label}):`, err)
    }
  }

  return count
}
