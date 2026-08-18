/*
 * probes.js — the in-page half of a browser drive.
 *
 * Loaded by the page a drive navigates to, over HTTP, so the node side can ask
 * questions that only make sense inside the document: is this thing laid out,
 * opaque and hit-testable, has it stopped moving, which rules match it.
 *
 * Every one of these is here because the obvious probe reports the wrong
 * answer — the reasons are on each function. They are DOM-generic and know
 * nothing about a component kit or a dev server; mounting, teardown and
 * whatever else a page owns stay in that page's own script.
 */

/** Install the probes on `window`. Call once, from the page's own module. */
export function installProbes(win = window) {
  win.waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now()
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn.toString())
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  win.byText = (sel, text, root = document) =>
    [...root.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(text))

  win.click = (el) => {
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
  win.matchedRules = (el) => {
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
   *  An overlay that is PRESENT is not an overlay that is VISIBLE: an overlay
   *  fades in with `el.animate(…, { fill: 'forwards' })`, so a probe that only
   *  asks `querySelector` passes against a fully invisible full-screen
   *  backdrop. */
  win.isVisible = (el) => {
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
   *  An overlay is animated in, so the instant after it opens it is at
   *  keyframe zero: opacity 0, translated off its own edge. A probe that reads
   *  geometry right there measures the entry, not the result, and reports a
   *  working overlay as invisible. */
  win.waitVisible = async (sel, ms = 4000) => {
    const el = await win.waitFor(() => document.querySelector(sel), ms)
    const t0 = Date.now()
    for (;;) {
      // Awaiting this element's own animations is not enough — a disclosure
      // body is opened by a transition on its ANCESTOR, so the paragraph
      // inside it is fully opaque with a zero-height box the whole time. Poll.
      await Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished))
      if (win.isVisible(el)) return true
      if (Date.now() - t0 > ms) return false
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Wait until nothing under `sel` is still animating, so LAYOUT has stopped.
   *
   *  `waitVisible` answers "can this be seen"; that is not the same question
   *  as "has it stopped moving". A coordinate click reads a rect and then
   *  clicks that point, so a neighbour still growing into place puts the
   *  target somewhere else by the time the press lands — the click hits
   *  whatever moved under it and the assertion reports a component that
   *  ignored a click. It only shows up under load, which is the worst way for
   *  it to show up. */
  win.waitSettled = async (sel = 'body', ms = 4000) => {
    const el = document.querySelector(sel) ?? document.body
    const t0 = Date.now()
    for (;;) {
      // An animation with `fill: 'forwards'` stays in `getAnimations()` after
      // it ends — it is still in effect, holding its last frame — so the raw
      // list never empties and this answered `false` a full timeout later on
      // every page that has one. Settled is nothing still MOVING.
      const running = el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running')
      if (!running.length) return true
      await Promise.allSettled(running.map((a) => a.finished))
      if (Date.now() - t0 > ms) return false
      // One more turn: finishing a transition can start the next one.
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

/** Capture `console.warn` into `window[name]`, keeping the original.
 *
 *  A warning is behaviour, not noise: several components report by warning and
 *  carry on — `<Form>` names a column it has no control for rather than
 *  dropping it in silence — so a spec has to be able to assert one. The
 *  original is still called, so the node side sees the same message: a
 *  `[Mesa]` warning fails the run, and everything else is a string a spec can
 *  look for. */
export function captureWarnings(name, win = window) {
  win[name] = []
  const original = console.warn.bind(console)
  console.warn = (...args) => {
    win[name].push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    original(...args)
  }
  return () => { win[name] = [] }
}
