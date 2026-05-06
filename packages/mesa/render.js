/**
 * @frontierjs/mesa-render — server-side and static-site rendering for Mesa components.
 *
 * Uses happy-dom as a lightweight virtual DOM so compiled Mesa components
 * run in Node.js without modification. Result is serialized to an HTML string.
 *
 * IMPORTANT: Call initRenderer() once before importing any compiled .mesa files.
 * Mesa compiled components call htmlToFragment() at module-load time (top-level),
 * so the DOM environment must be installed before dynamic import().
 *
 * Usage:
 *   import { initRenderer, renderToHTML } from '@frontierjs/mesa-render'
 *   await initRenderer()                          // install DOM globals once
 *   const { default: MyComp } = await import('./MyComp.mesa.js')
 *   const html = await renderToHTML(MyComp, { title: 'Hello' })
 *
 * SSR notes (v2):
 *   - $onMount is a no-op during server render
 *   - Each renderToHTML call uses the same global window (build-time is single-threaded)
 *   - For concurrent SSR, call initRenderer() per-request with its own window
 */

import { Window } from 'happy-dom'
import { setRenderEnvironment } from './runtime.js'

// ─── Global render window ─────────────────────────────────────────────────────

let _win = null

// All browser globals happy-dom provides — including parent/top which
// happy-dom references internally during DOM operations like appendChild.
const GLOBALS = [
  'document', 'window', 'navigator', 'location', 'history',
  'parent', 'top', 'self',
  'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'Text', 'Comment',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback',
  'CustomEvent', 'Event', 'NodeFilter',
  'getComputedStyle',
]

/**
 * Initialize the render environment.
 * MUST be called before importing any compiled Mesa component files.
 * Safe to call multiple times — idempotent after first call.
 *
 * @param {object} [options]
 * @param {string} [options.url]    — base URL for the virtual window
 * @param {Window} [options.window] — provide your own happy-dom Window
 */
export function initRenderer(options = {}) {
  if (_win && !options.window) return   // already initialized

  _win = options.window ?? new Window({
    url:    options.url ?? 'http://localhost',
    width:  1280,
    height: 800,
  })

  // Install all browser globals into the Node.js process so compiled
  // component modules can reference them at the top level.
  for (const key of GLOBALS) {
    try {
      const val = _win[key] ?? _win.document?.[key]
      if (val !== undefined) global[key] = val
    } catch (_) {}
  }

  // parent and top are always self-referential outside an iframe
  global.parent = _win
  global.top    = _win

  // Tell the Mesa runtime the DOM is now available
  setRenderEnvironment(true)
}

/**
 * Reset the render environment (useful for testing).
 */
export function resetRenderer() {
  _win = null
  setRenderEnvironment(false)
  for (const key of GLOBALS) {
    try { delete global[key] } catch (_) {}
  }
}

// ─── Serialization ────────────────────────────────────────────────────────────

export function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render a compiled Mesa component to an HTML string.
 * initRenderer() must have been called before the component was imported.
 *
 * @param {Function} ComponentFactory — default export of a compiled .mesa file
 * @param {object}   [props={}]
 * @param {object}   [options={}]
 * @param {boolean}  [options.full]  — wrap in a full <!DOCTYPE html> page
 * @returns {Promise<string>}
 */
export async function renderToHTML(ComponentFactory, props = {}, options = {}) {
  if (!_win) {
    throw new Error(
      '[Mesa renderToHTML] initRenderer() must be called before renderToHTML(). ' +
      'See render.js usage docs.'
    )
  }

  let instance
  try {
    instance = ComponentFactory({ props: props ?? {}, slots: {} })
  } catch (e) {
    throw new Error(`[Mesa renderToHTML] Component threw during render: ${e.message}`)
  }

  if (!instance?.$dom) return options.full ? wrapPage('', options) : ''

  // Use global.document (= _win.document installed by initRenderer) for the
  // container — this ensures the container is in the same document as the
  // component's DOM nodes, preventing cross-document adoption errors.
  const container = global.document.createElement('div')
  const $dom = instance.$dom

  if ($dom.nodeType === global.Node.DOCUMENT_FRAGMENT_NODE) {
    container.appendChild($dom.cloneNode(true))
  } else {
    container.appendChild($dom)
  }

  const html = container.innerHTML
  try { instance.destroy?.() } catch (_) {}

  return options.full ? wrapPage(html, options) : html
}

// ─── Full page wrapper ────────────────────────────────────────────────────────

export function wrapPage(bodyHTML, options = {}) {
  const {
    title        = 'Mesa',
    css          = '',
    scripts      = [],
    islandLoader = '',
    meta         = {},
  } = options

  const cssTag     = css ? `  <link rel="stylesheet" href="${css}">` : ''
  const metaTags   = Object.entries(meta)
    .map(([n, c]) => `  <meta name="${escapeHTML(n)}" content="${escapeHTML(c)}">`)
    .join('\n')
  const scriptTags = scripts
    .map((s) => `  <script type="module" src="${s}"></script>`)
    .join('\n')
  const loaderTag  = islandLoader
    ? `  <script type="module" src="${islandLoader}"></script>`
    : ''

  const headExtras  = [metaTags, cssTag].filter(Boolean).join('\n')
  const bodyClosing = [scriptTags, loaderTag].filter(Boolean).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
${headExtras ? headExtras + '\n' : ''}</head>
<body>
${bodyHTML}
${bodyClosing ? bodyClosing + '\n' : ''}</body>
</html>`
}

// ─── Batch rendering ──────────────────────────────────────────────────────────

/**
 * Render multiple components in parallel.
 * Each render uses the same global window — safe for single-threaded build tools.
 *
 * @param {Array<{ component, props, options }>} pages
 * @returns {Promise<string[]>}
 */
export async function renderAll(pages) {
  return Promise.all(
    pages.map(({ component, props, options }) =>
      renderToHTML(component, props, options)
    )
  )
}
