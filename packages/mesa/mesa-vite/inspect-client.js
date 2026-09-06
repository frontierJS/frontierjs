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
 * A path holding a backtick or `${` would break the template literal it is
 * embedded in, so both are JSON-encoded rather than interpolated raw.
 */

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
  const ATTR = 'data-fjs-loc'

  // The element a pointer is over, in the shadow trees too: composedPath()[0]
  // is the real target, and walking out of a shadow root means stepping to its
  // host rather than to a parentElement that is null there. A widget mounted in
  // a shadow root is otherwise a dead zone.
  function locatedFrom(node) {
    let el = node
    while (el) {
      if (el.nodeType === 1 && el.hasAttribute(ATTR)) return el
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null
    }
    return null
  }

  // The attribute is app-controlled — {@html} renders whatever the app was
  // handed — and the value ends up on the editor's command line, so an
  // absolute path is never taken from it. Only a relative path to a compiled
  // source, no traversal, always joined onto the root the plugin baked in.
  const LOC = /^[\\w./-]+\\.(mesa|md):\\d+:\\d+$/

  function absolute(loc) {
    if (!ROOT) return null
    if (typeof loc !== 'string' || !LOC.test(loc) || loc.indexOf('..') !== -1) return null
    return ROOT.replace(/[\\\\/]+$/, '') + '/' + loc
  }

  function open(el) {
    const loc = el && el.getAttribute && el.getAttribute(ATTR)
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

  function paint(el) {
    current = el
    if (!el) { if (box) box.style.display = 'none'; return }
    if (!box) {
      box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:1px solid #38bdf8;background:rgba(56,189,248,.15);border-radius:2px'
      label = document.createElement('div')
      label.style.cssText = 'position:absolute;left:0;bottom:100%;margin-bottom:2px;padding:1px 5px;border-radius:3px;background:#0f172a;color:#e2e8f0;font:11px/1.6 ui-monospace,monospace;white-space:nowrap'
      box.appendChild(label)
      document.body.appendChild(box)
    }
    const r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.top    = r.top + 'px'
    box.style.left   = r.left + 'px'
    box.style.width  = r.width + 'px'
    box.style.height = r.height + 'px'
    label.textContent = el.getAttribute(ATTR)
  }

  function disarm() {
    armed = false
    paint(null)
    document.documentElement.style.cursor = ''
  }

  window.addEventListener('mousemove', (e) => {
    if (!e[FLAG]) { if (armed) disarm(); return }
    armed = true
    document.documentElement.style.cursor = 'crosshair'
    paint(locatedFrom(e.composedPath()[0]))
  }, true)

  // Capture phase, and both halves of the click: a mousedown the app handles is
  // enough to navigate away before the click ever lands.
  const swallow = (e) => {
    if (!armed || !e[FLAG]) return
    const el = locatedFrom(e.composedPath()[0])
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'click') { open(el); disarm() }
  }
  window.addEventListener('mousedown', swallow, true)
  window.addEventListener('click',     swallow, true)

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarm() }, true)
  window.addEventListener('blur', disarm)

  // Also reachable from the console, and from a keyboard: the focused element
  // is what a screen-reader user is on, and a hold-and-click has no equivalent.
  window.addEventListener('keydown', (e) => {
    if (!e[FLAG] || e.key !== 'z' && e.key !== 'Z') return
    const el = locatedFrom(document.activeElement)
    if (el) { e.preventDefault(); open(el) }
  }, true)

  window.__fjsInspect = { locate: (el) => { const f = locatedFrom(el); return f && f.getAttribute(ATTR) }, root: ROOT }

  console.log('%c[mesa] inspector ready — hold ${key} and click an element to open its source', 'color:#38bdf8')
})()
`
}
