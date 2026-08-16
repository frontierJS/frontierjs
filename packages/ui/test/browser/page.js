/*
 * page.js — the in-page half of the kit drive.
 *
 * The node side (run.mjs) holds the assertions and drives real input; this
 * side owns one job the node side cannot do, which is mounting a Mesa
 * component into a real document.
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

const stage = document.getElementById('stage')

let current = null

/** Mount a fixture, replacing whatever was there.
 *
 *  Returns after a macrotask, not a microtask: mesa flushes its effects on a
 *  microtask, and `{@attach}` handlers that measure or animate run after
 *  that. A probe on the same tick reads a half-built tree. */
window.kitMount = async (specifier, props = {}) => {
  window.kitUnmount()

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

/* ─── probes ──────────────────────────────────────────────────────────
 *
 * These mirror the ones `example/web/test/verify-ui.mjs` installs, so a spec
 * written against one drive reads the same in the other. They are here rather
 * than injected because this page controls its own boot; the node side still
 * injects nothing.
 */

window.waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn.toString())
    await new Promise((r) => setTimeout(r, 25))
  }
}

window.byText = (sel, text, root = document) =>
  [...root.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(text))

window.click = (el) => {
  if (!el) throw new Error('click(): no element')
  el.click()
  return true
}

/** The rules that MATCH an element, as authored text.
 *
 *  `getComputedStyle` goes stale after a class change in headless Chrome —
 *  `matches()` and the CSSOM report the new state while computed styles stay
 *  frozen, and forcing layout does not help. Anything asking "did this class
 *  change take effect" has to read the rules, not the computed value. */
window.matchedRules = (el) => {
  const out = []
  const walk = (rules) => {
    for (const r of rules) {
      if (r.styleSheet) { try { walk(r.styleSheet.cssRules) } catch {} ; continue }
      if (r.cssRules && r.type !== 1) { walk(r.cssRules); continue }
      if (r.selectorText) {
        try { if (el.matches(r.selectorText)) out.push(r.cssText) } catch {}
      }
    }
  }
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules) } catch {}
  }
  return out
}

/** Is this element actually on screen — laid out, opaque and hit-testable?
 *
 *  An overlay that is PRESENT is not an overlay that is VISIBLE: the kit's
 *  overlays fade in with `el.animate(…, { fill: 'forwards' })`, so a probe
 *  that only asks `querySelector` passes against a fully invisible
 *  full-screen backdrop. */
window.isVisible = (el) => {
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const cs = getComputedStyle(el)
  if (cs.visibility === 'hidden' || cs.display === 'none') return false
  if (Number(cs.opacity) === 0) return false
  // A hit test is the right question for an overlay and the wrong one for
  // anything deliberately transparent to the pointer: `.tooltip` is
  // `pointer-events: none` so the control underneath stays clickable, and
  // elementFromPoint therefore answers with the trigger — which reads as a
  // tooltip that never appeared.
  if (cs.pointerEvents === 'none') return true
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1)
  const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
  const hit = document.elementFromPoint(x, y)
  return !!hit && (hit === el || el.contains(hit) || hit.contains(el))
}

/** Wait for an overlay to finish arriving, then answer whether it is visible.
 *
 *  An overlay is animated in — a `<dialog>` by `overlays.css`, a popover by an
 *  `el.animate(…, { fill: 'forwards' })` attachment — so the instant after it
 *  opens it is at keyframe zero: opacity 0, translated off its own edge. A
 *  probe that reads geometry right there measures the entry, not the result,
 *  and reports a working overlay as invisible. */
window.waitVisible = async (sel, ms = 4000) => {
  const el = await window.waitFor(() => document.querySelector(sel), ms)
  const t0 = Date.now()
  for (;;) {
    // Awaiting this element's own animations is not enough — a disclosure
    // body is opened by a transition on its ANCESTOR, so the paragraph inside
    // it is fully opaque with a zero-height box the whole time. Poll.
    await Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished))
    if (window.isVisible(el)) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Wait until nothing under `sel` is still animating, so LAYOUT has stopped.
 *
 *  `waitVisible` answers "can this be seen"; that is not the same question as
 *  "has it stopped moving". A coordinate click reads a rect and then clicks
 *  that point, so a neighbour still growing into place puts the target
 *  somewhere else by the time the press lands — the click hits whatever moved
 *  under it and the assertion reports a component that ignored a click. It
 *  only shows up under load, which is the worst way for it to show up. */
window.waitSettled = async (sel = 'body', ms = 4000) => {
  const el = document.querySelector(sel) ?? document.body
  const t0 = Date.now()
  for (;;) {
    const running = el.getAnimations({ subtree: true })
    if (!running.length) return true
    await Promise.allSettled(running.map((a) => a.finished))
    if (Date.now() - t0 > ms) return false
    // One more turn: finishing a transition can start the next one.
    await new Promise((r) => setTimeout(r, 25))
  }
}

window.__kitReady = true
