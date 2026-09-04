/*
 * page.js — the in-page half of the runtime drive.
 *
 * The node side (run.mjs) holds the assertions and drives real input; this
 * side owns the one job the node side cannot do, which is mounting a compiled
 * component into a real document. The DOM probes come from `../probes.js`,
 * shared with every other drive.
 *
 * ── The delegation root ───────────────────────────────────────────────
 *
 * `mount()` registers the anchor's parent as the delegation root (Invariant
 * 11), so every fixture gets the SAME `#stage` and the root is torn down with
 * it. A component reached by calling it directly renders and handles no events
 * at all, which reads as "the click did nothing" — `mountBare` exists so a
 * spec can assert exactly that.
 */
import { mount } from '@frontierjs/mesa/runtime.js'
import { installProbes, captureWarnings } from '/mesa/test/browser/probes.js'

const stage = document.getElementById('stage')

let current = null

installProbes()
// A warning is behavior: mesa reports a render it survived but corrupted —
// a duplicate {#each} key above all — through console.warn, so a spec has to
// be able to assert one by text.
const resetWarnings = captureWarnings('mesaWarnings')

/** Mount a fixture, replacing whatever was there.
 *
 *  Returns after a macrotask, not a microtask: mesa flushes its effects on a
 *  microtask, and `{@attach}` handlers that measure or animate run after that.
 *  A probe on the same tick reads a half-built tree. */
window.mesaMount = async (specifier, props = {}) => {
  window.mesaUnmount()
  resetWarnings()

  const mod = await import(specifier)
  if (!mod.default)
    throw new Error(`fixture ${specifier} has no default export — a fixture is a component`)

  const label = document.createComment('fixture')
  stage.appendChild(label)
  current = mount(label, mod.default, { props, root: stage })

  await new Promise((r) => setTimeout(r, 0))
  return true
}

/** Render a fixture by CALLING it, the way a page that forgot `mount()` does.
 *
 *  The tree is built and no delegation root is registered, so nothing routed
 *  through delegation fires. A spec uses this to prove that the root is what
 *  makes events work, rather than assuming it. */
window.mesaMountBare = async (specifier, props = {}) => {
  window.mesaUnmount()
  resetWarnings()

  const mod = await import(specifier)
  const anchor = document.createComment('bare')
  stage.appendChild(anchor)
  mod.default(anchor, props)

  await new Promise((r) => setTimeout(r, 0))
  return true
}

window.mesaUnmount = () => {
  if (current) { current.destroy(); current = null }
  stage.replaceChildren()
  // Anything a fixture put outside its own tree — a portal, a node appended to
  // <body> — is not destroyed with it, and the NEXT fixture's first
  // querySelector would find the previous test's node.
  for (const el of document.body.children) {
    if (el.id !== 'stage' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') el.remove()
  }
  return true
}

/** Every `<style>` mesa has injected, as authored text.
 *
 *  `addStyles` keys on a content hash and appends to `<head>`, so scoped rules
 *  accumulate across fixtures within one page. A spec asserting that a rule
 *  EXISTS reads this; one asserting that it APPLIES reads `matchedRules`. */
window.mesaStyles = () =>
  [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n')

window.__mesaReady = true
