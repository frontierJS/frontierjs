/*
 * page.js — the in-page half of the kit drive.
 *
 * The node side (run.mjs) holds the assertions and drives real input; this
 * side owns one job the node side cannot do, which is mounting a Mesa
 * component into a real document. The DOM probes a spec reads through
 * (`waitVisible`, `isVisible`, `matchedRules`, …) are generic and come from
 * mesa's `test/browser/probes.js`, served here at `/@mesa/`.
 *
 * ── Why a fixture is a component and not a props object ───────────────
 *
 * Everything interesting in this kit is a composition — a Tabs with its
 * TabList and Tabs, a Form with its fields, a DropdownMenu with its items —
 * and a slot cannot be expressed as a props object. So a fixture is a `.mesa`
 * file: the caller writes the markup an app would write, and this file mounts
 * its default export.
 *
 * ── The delegation root ───────────────────────────────────────────────
 *
 * `mount()` registers the anchor's parent as the delegation root (Invariant
 * 11), so every fixture gets the SAME `#stage` and the root is torn down with
 * it. A component reached by calling it directly renders and handles no
 * events at all, which reads as "the click did nothing".
 */
import { mount } from '@frontierjs/mesa/runtime.js'
import { installProbes, captureWarnings } from '/@mesa/test/browser/probes.js'

const stage = document.getElementById('stage')

let current = null

installProbes()
// Specs read `window.kitWarnings` — a component that reports by warning and
// carries on is stating a contract, so it has to be assertable.
const resetWarnings = captureWarnings('kitWarnings')

/** Mount a fixture, replacing whatever was there.
 *
 *  Returns after a macrotask, not a microtask: mesa flushes its effects on a
 *  microtask, and `{@attach}` handlers that measure or animate run after
 *  that. A probe on the same tick reads a half-built tree. */
window.kitMount = async (specifier, props = {}) => {
  window.kitUnmount()
  resetWarnings()

  const mod = await import(specifier)
  if (!mod.default)
    throw new Error(`fixture ${specifier} has no default export — a fixture is a component`)

  const label = document.createComment('kit')
  stage.appendChild(label)
  current = mount(label, mod.default, { props, root: stage })

  await new Promise((r) => setTimeout(r, 0))
  return true
}

window.kitUnmount = () => {
  if (current) { current.destroy(); current = null }
  stage.replaceChildren()
  // Overlays leave the stage. A `<dialog>` opened with showModal(), a
  // [popover], a toast stack appended to <body> — none of them are inside the
  // fixture's tree, so destroying it leaves them on screen and the NEXT
  // fixture's first querySelector finds the previous test's node.
  for (const el of document.body.children) {
    if (el.id !== 'stage' && el.tagName !== 'SCRIPT') el.remove()
  }
  return true
}

window.__kitReady = true
