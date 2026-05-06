// unocss-mirror.js — Shadow-DOM ↔ Light-DOM class mirror for UnoCSS scanner.
//
// Problem: UnoCSS's runtime/scanner observes the host document for class
// attributes to scan. Classes inside shadow roots are invisible to that
// observation. Result: utility classes used inside an island's shadow root
// produce no CSS rules.
//
// Solution: maintain a hidden mirror element in the host document whose
// className is the union of all class names used inside the island's
// shadow root. UnoCSS scans the host doc, sees the mirror, generates the
// rules. Then we copy the resulting <style> tags from the host doc into
// the shadow root so the rules actually apply to the shadowed elements.
//
// This approach is the spec's "DOM-mirror" pattern. It's the right tradeoff
// in v1: works with UnoCSS unmodified, doesn't require config changes from
// the consumer, and the mirror element is invisible (display: none).
//
// Two MutationObservers:
//   1. shadow → mirror: classes inside the shadow root → mirror.className
//   2. host docs <style> → shadow root: copy generated UnoCSS sheets in
//
// Both observers are debounced via microtasks to coalesce bursts.

const MIRROR_ATTR  = 'data-jetty-mirror'
const MIRROR_STYLE = 'position:absolute;width:0;height:0;pointer-events:none;visibility:hidden;'

let _scheduledMirrorUpdate = false
let _scheduledStyleSync    = false

/**
 * Bootstrap UnoCSS DOM-mirror for an island's shadow root.
 *
 * @param {ShadowRoot} shadow            — the island's shadow root
 * @param {Element}    hostDocAnchor     — element in document.body that hosts the mirror
 * @param {Object}     [opts]
 * @param {string}     [opts.styleSelector='style[data-vite-dev-id], style[data-uno]'] —
 *                     CSS selector for style elements to copy into the shadow root.
 *                     UnoCSS dev/prod tags vary; defaults cover both.
 * @returns {{ destroy: () => void }} cleanup handle
 */
export function bootstrapUnoMirror(shadow, hostDocAnchor, opts = {}) {
  const styleSelector = opts.styleSelector ?? 'style[data-vite-dev-id], style[data-uno], style[data-uno-css]'

  // 1. Create mirror element in host doc
  const mirror = document.createElement('div')
  mirror.setAttribute(MIRROR_ATTR, '')
  mirror.style.cssText = MIRROR_STYLE
  hostDocAnchor.appendChild(mirror)

  // 2. Initial scan of shadow root → mirror.className
  updateMirrorClasses(shadow, mirror)

  // 3. Observe shadow root for class changes
  const shadowObserver = new MutationObserver(() => {
    if (_scheduledMirrorUpdate) return
    _scheduledMirrorUpdate = true
    queueMicrotask(() => {
      _scheduledMirrorUpdate = false
      updateMirrorClasses(shadow, mirror)
    })
  })
  shadowObserver.observe(shadow, {
    subtree:        true,
    childList:      true,
    attributes:     true,
    attributeFilter: ['class'],
  })

  // 4. Initial sync of host styles → shadow
  syncHostStylesToShadow(shadow, styleSelector)

  // 5. Observe document.head for new style tags being added/changed by UnoCSS
  const headObserver = new MutationObserver(() => {
    if (_scheduledStyleSync) return
    _scheduledStyleSync = true
    queueMicrotask(() => {
      _scheduledStyleSync = false
      syncHostStylesToShadow(shadow, styleSelector)
    })
  })
  headObserver.observe(document.head, {
    subtree:    true,
    childList:  true,
    characterData: true,
  })

  return {
    destroy() {
      shadowObserver.disconnect()
      headObserver.disconnect()
      try { mirror.remove() } catch {}
    },
  }
}

function updateMirrorClasses(shadow, mirror) {
  const classes = new Set()
  // walk ALL elements with a class attribute
  const elements = shadow.querySelectorAll('[class]')
  for (const el of elements) {
    for (const cls of el.classList) {
      classes.add(cls)
    }
  }
  const next = Array.from(classes).join(' ')
  if (mirror.className !== next) {
    mirror.className = next
  }
}

function syncHostStylesToShadow(shadow, selector) {
  const sheets = document.head.querySelectorAll(selector)
  for (const sheet of sheets) {
    const id = sheet.getAttribute('data-vite-dev-id') || sheet.getAttribute('data-uno') || sheet.textContent.slice(0, 20)
    // Find or create a clone in the shadow root keyed by data-jetty-uno-source.
    let clone = shadow.querySelector(`style[data-jetty-uno-source="${cssEscape(id)}"]`)
    if (!clone) {
      clone = document.createElement('style')
      clone.setAttribute('data-jetty-uno-source', id)
      shadow.appendChild(clone)
    }
    if (clone.textContent !== sheet.textContent) {
      clone.textContent = sheet.textContent
    }
  }
}

function cssEscape(s) {
  // Minimal — most generated UnoCSS ids are safe; escape quotes just in case.
  return String(s).replace(/"/g, '\\"')
}
