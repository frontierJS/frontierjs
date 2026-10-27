/**
 * mesa-vite/inspect-client — click a rendered element, open the line that wrote it.
 *
 * Two halves. The compiler stamps `data-fjs-loc="src/pages/Home.mesa:12:3"` on
 * every template element in a dev build; this is the browser half that reads it
 * and asks Vite's own `/__open-in-editor` middleware to launch the editor.
 *
 * Served as a STRING at a virtual id, the way the HMR client is, so both this
 * package's plugin and Sierra's can hand out one implementation (`FJS-D16`).
 * The root is baked in at serve time because the attribute holds a path
 * relative to the app, and only the plugin knows what it is relative to.
 *
 * Shift with the modifier PICKS rather than opens: the element goes to whatever
 * registered with `__fjsInspect.onPick(fn)`, and to the editor when nothing
 * did. The picker is somebody else's — this client knows no more about what a
 * pick is for than it knows about the editor `/__open-in-editor` launches.
 *
 * PICK MODE latches shift+modifier, for picking one element after another
 * without holding two keys: a plain click picks and the modifier alone still
 * opens. It survives a reload in sessionStorage, because an edit HMR cannot
 * swap reloads the page between picks, and it draws a badge while on, because
 * a page whose clicks have stopped working with nothing on screen to say why
 * reads as a broken app. Escape or the badge leaves it.
 *
 * A path holding a backtick or `${` would break the template literal it is
 * embedded in, so both are JSON-encoded rather than interpolated raw.
 */

import { LOC_ATTR, PLACED_PROP } from '../src/compiler.js'

const MODIFIERS = { alt: 'altKey', meta: 'metaKey', ctrl: 'ctrlKey', shift: 'shiftKey' }

/**
 * @param {object}  opts
 * @param {string}  opts.root  absolute path the stamped paths are relative to
 * @param {string} [opts.key]  held modifier that arms the inspector — alt (default), meta, ctrl, shift
 * @returns {string} browser source, ready to serve
 */
export function inspectClientSource({ root = '', key = 'alt' } = {}) {
  const flag = MODIFIERS[key] ?? MODIFIERS.alt
  return `
// Mesa inspector — injected in dev by @frontierjs/mesa-vite.
(function () {
  if (typeof window === 'undefined' || window.__fjsInspect) return

  const ROOT = ${JSON.stringify(root)}
  const FLAG = ${JSON.stringify(flag)}
  const KEY  = ${JSON.stringify(flag.replace(/Key$/, ''))}
  const ATTR = ${JSON.stringify(LOC_ATTR)}
  const PLACED = ${JSON.stringify(PLACED_PROP)}

  // The element a pointer is over, in the shadow trees too: composedPath()[0]
  // is the real target, and walking out of a shadow root means stepping to its
  // host rather than to a parentElement that is null there. A widget mounted in
  // a shadow root is otherwise a dead zone.
  //
  const up = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null

  // A picker's own UI, which never picks. Inside a modal dialog the walk out
  // of it reaches the line that placed the dialog, so pick mode would swallow
  // every press on the picker as a pick of the dialog.
  const ignored = []
  const skip = (node) => ignored.some((root) => root.contains(node))

  // The topmost open modal dialog, else the body: showModal() draws the dialog
  // in the top layer over any z-index and makes the rest of the page inert, so
  // an overlay on the body paints beneath it. The kit's overlayHost() rule (FJS-D904).
  const host = () => { const open = document.querySelectorAll('dialog:modal'); return open[open.length - 1] || document.body }
  const lift = (el) => { const h = host(); if (el && el.parentNode !== h) h.appendChild(el) }

  // What a pointer over a node edits: { el, loc, via }, or null when nothing
  // can be opened, so nothing is painted and the click goes to the page.
  //
  // A component from a package (the kit's Button, a framework layout) stamps
  // its own file, so the innermost stamp under the pointer is usually the
  // package's and almost never what the person is editing. The walk goes on to
  // the nearest element the app wrote. A layout's own chrome (Shell's topbar,
  // its padding) has none above it, since the app's page renders inside the
  // layout, so the target is the app line that PLACED the component, with the
  // package's stamp kept as via. An installed copy under the root opens only
  // when no app line placed it.
  function locatedFrom(node) {
    if (!node || skip(node)) return null
    let el = node, first = null
    for (; el; el = up(el)) {
      if (el.nodeType !== 1 || !el.hasAttribute(ATTR)) continue
      const loc = el.getAttribute(ATTR)
      if (own(loc)) return { el, loc, via: null }
      first = first || el
    }
    if (!first) return null
    const via = first.getAttribute(ATTR)
    const placed = placedBy(first)
    if (placed) return { el: first, loc: placed, via }
    return absolute(via) ? { el: first, loc: via, via: null } : null
  }

  // A component's nodes sit before its anchor comment, so the first anchor the
  // app placed after the element or an ancestor of it is the call. One the
  // package placed is passed over. An app component slotted in beside the
  // element answers first; it is written in the same file, a few lines off.
  function placedBy(node) {
    for (let el = node; el; el = up(el)) {
      for (let s = el.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === 8 && own(s[PLACED])) return s[PLACED]
      }
    }
    return null
  }

  // The attribute is app-controlled — {@html} renders whatever the app was
  // handed — and the value ends up on the editor's command line, so an
  // absolute path is never taken from it. Only a relative path to a compiled
  // source, no traversal, always joined onto the root the plugin baked in.
  // A file outside the root is stamped absolute, which joined onto the root
  // names a file that does not exist; it is refused with the rest.
  const LOC = /^(?!\\/)[\\w./-]+\\.(mesa|md):\\d+:\\d+$/

  // Under the root but installed: an editable copy of somebody else's file.
  const own = (loc) => !!absolute(loc) && !/(^|\\/)node_modules\\//.test(loc)

  function absolute(loc) {
    if (!ROOT) return null
    if (typeof loc !== 'string' || !LOC.test(loc) || loc.indexOf('..') !== -1) return null
    return ROOT.replace(/[\\\\/]+$/, '') + '/' + loc
  }

  function open(target) {
    const loc = target && target.loc
    if (!loc) return false
    const file = absolute(loc)
    if (!file) { console.warn('[mesa] refusing to open', loc); return false }
    fetch('/__open-in-editor?file=' + encodeURIComponent(file))
      .catch((err) => console.warn('[mesa] open-in-editor failed', err))
    return true
  }

  // ── overlay ────────────────────────────────────────────────────────────────
  // pointer-events:none throughout — the overlay must never become the thing
  // the next mousemove reports as the target.

  let box = null, label = null, current = null, armed = false
  const pickers = []
  const modeWatchers = []
  const MODE_KEY = 'fjs:inspect:pick-mode'
  let mode = false, badge = null

  // A picker that throws must not leave the click swallowed and nothing done.
  // The opener rides on the pick rather than the global: a page script reaches it
  // only after a person picked something.
  function pick(target) {
    const { el, loc, via } = target
    if (!pickers.length || !absolute(loc)) return open(target)
    let took = false
    for (const fn of pickers) {
      try { fn({ el, loc, via, file: absolute(loc), key: KEY, open: () => open(target) }); took = true } catch (err) { console.warn('[mesa] picker failed', err) }
    }
    return took || open(target)
  }

  function paint(target) {
    current = target
    if (!target) { if (box) box.style.display = 'none'; return }
    const el = target.el
    if (!box) {
      box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:1px solid #38bdf8;background:rgba(56,189,248,.15);border-radius:2px'
      label = document.createElement('div')
      label.style.cssText = 'position:absolute;left:0;bottom:100%;margin-bottom:2px;padding:1px 5px;border-radius:3px;background:#0f172a;color:#e2e8f0;font:11px/1.6 ui-monospace,monospace;white-space:nowrap'
      box.appendChild(label)
    }
    lift(box)
    lift(badge)
    const r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.top    = r.top + 'px'
    box.style.left   = r.left + 'px'
    box.style.width  = r.width + 'px'
    box.style.height = r.height + 'px'
    label.textContent = target.via ? target.loc + ' · places ' + target.via.split('/').pop() : target.loc
  }

  function disarm() {
    armed = false
    paint(null)
    document.documentElement.style.cursor = ''
  }

  function drawBadge() {
    if (!mode) { if (badge) { badge.remove(); ignored.splice(ignored.indexOf(badge), 1) } badge = null; return }
    if (badge || !document.body) return
    badge = document.createElement('button')
    badge.type = 'button'
    badge.textContent = 'Pick mode — click an element · Esc to leave'
    badge.title = 'Leave pick mode'
    badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:5px 10px;border-radius:999px;border:1px solid #0369a1;background:#0f172a;color:#e2e8f0;font:12px/1.4 ui-sans-serif,system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)'
    badge.onclick = () => setMode(false)
    ignored.push(badge)
    lift(badge)
  }

  function setMode(on) {
    on = !!on
    if (on === mode) return mode
    mode = on
    try { on ? sessionStorage.setItem(MODE_KEY, '1') : sessionStorage.removeItem(MODE_KEY) } catch {}
    if (!on) disarm()
    drawBadge()
    for (const fn of modeWatchers) { try { fn(mode) } catch (err) { console.warn('[mesa] pick-mode watcher failed', err) } }
    return mode
  }

  window.addEventListener('mousemove', (e) => {
    if (!mode && !e[FLAG]) { if (armed) disarm(); return }
    armed = true
    const target = locatedFrom(e.composedPath()[0])
    // Pick mode leaves the crosshair off what cannot be picked, the ask panel
    // among it, so its own buttons still look like buttons.
    document.documentElement.style.cursor = mode && !target ? '' : 'crosshair'
    paint(target)
  }, true)

  // Capture phase, and both halves of the click: a mousedown the app handles is
  // enough to navigate away before the click ever lands. An element with no
  // location is let through, which is what keeps a picker's own panel usable.
  const swallow = (e) => {
    if (!mode && (!armed || !e[FLAG])) return
    const target = locatedFrom(e.composedPath()[0])
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    if (e.type !== 'click') return
    const shifted = e.shiftKey && FLAG !== 'shiftKey'
    const opens = mode ? e[FLAG] && !shifted : !shifted
    opens ? open(target) : pick(target)
    disarm()
  }
  window.addEventListener('mousedown', swallow, true)
  window.addEventListener('click',     swallow, true)

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarm() }, true)
  // Bubble phase: an Escape something on the page already answered — a
  // picker's text box cancelling, a dialog closing — is not a request to leave.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode && !e.defaultPrevented) setMode(false) })
  window.addEventListener('blur', disarm)

  // Also reachable from the console, and from a keyboard: the focused element
  // is what a screen-reader user is on, and a hold-and-click has no equivalent.
  // Capture runs before the page's own listeners, so the answer is read once
  // dispatch is over: an app binding Alt+Z (basecamp's workbench zoom) calls
  // preventDefault, and opening the editor as well makes one press do both.
  window.addEventListener('keydown', (e) => {
    if (!e[FLAG] || e.key !== 'z' && e.key !== 'Z') return
    const target = locatedFrom(document.activeElement)
    if (target) setTimeout(() => { if (!e.defaultPrevented) open(target) })
  }, true)

  window.__fjsInspect = {
    locate: (el) => { const f = locatedFrom(el); return f && f.loc },
    root:   ROOT,
    onPick: (fn) => { pickers.push(fn); return () => { const i = pickers.indexOf(fn); if (i !== -1) pickers.splice(i, 1) } },
    // No argument reads the mode; a boolean sets it. Either way, the mode is returned.
    pickMode: (on) => on === undefined ? mode : setMode(on),
    onPickMode: (fn) => { modeWatchers.push(fn); return () => { const i = modeWatchers.indexOf(fn); if (i !== -1) modeWatchers.splice(i, 1) } },
    // A picker's panel: never painted, never picked, its presses its own.
    ignore: (el) => { ignored.push(el); return () => { const i = ignored.indexOf(el); if (i !== -1) ignored.splice(i, 1) } },
    // Where an overlay mounts so a modal dialog does not cover it.
    host,
  }

  try { if (sessionStorage.getItem(MODE_KEY)) mode = true } catch {}
  if (mode) document.body ? drawBadge() : document.addEventListener('DOMContentLoaded', drawBadge, { once: true })

  console.log('%c[mesa] inspector ready — hold ${key} and click an element to open its source', 'color:#38bdf8')
})()
`
}
