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
 * This is the low-level entry point: it takes an already-compiled component
 * factory. To go from `.mesa` source or a file path, use `render-component.js`
 * (`renderComponent` / `renderFile`), which compiles, resolves imports and
 * collects CSS, then renders through this module.
 *
 * Usage:
 *   import { initRenderer, renderToHTML } from '@frontierjs/mesa/render'
 *   initRenderer()                                // install DOM globals FIRST
 *   const { default: MyComp } = await import('./MyComp.mesa.js')
 *   const html = await renderToHTML(MyComp, { title: 'Hello' })
 *
 * Ordering is not a style preference: compiled components call
 * htmlToFragment() at module-load time, so `initRenderer()` must run before the
 * `import()`, not merely before the render.
 *
 * SSR semantics:
 *   - $onMount, watchProxy and path watches are inert (RULE 19). Effects, memos
 *     and block directives run, then are disposed when the render returns.
 *   - {#await} renders its {:pending} branch — nothing settles mid-render.
 *   - {#virtual each} renders its first window plus spacers — no viewport can be
 *     measured here, so the window comes from the row height.
 *   - Comment anchors are stripped unless `{ keepAnchors: true }`.
 *   - Renders are serial by construction; see renderToHTML and renderAll.
 *   - The window is process-global. For true concurrency, run one worker per
 *     window rather than sharing this module across requests.
 *
 * See docs/STATIC_RENDERING.md for the full model and the Sierra integration status.
 */

import { Window } from 'happy-dom'
import { setRenderEnvironment, createRoot, flushSync } from './runtime.js'

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

  // Tell the Mesa runtime the DOM is now available — but that this is NOT a
  // client runtime. RULE 19 hangs off the second flag: no reactive graph is
  // built, $onMount is a no-op, path watches stay inert. Passing a single
  // `true` here used to enable client behaviour too, so every server render ran
  // $onMount callbacks and built proxies and signals that nothing disposed.
  setRenderEnvironment(true, false)
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

// Mesa's compiled output is full of comment nodes: a root anchor, plus one
// placeholder or anchor per block directive. They carry no meaning in a static
// page — hydration does not exist yet (v1.1) — so they are stripped. When
// hydration lands it will need them, and this is the single place that decides.
//
// The patterns are deliberately narrow. `<!--[if mso]>` and friends survive:
// they have no space after `<!--`, and email templates emit them through
// `{@html}` on purpose.
const _ANCHOR_PATTERNS = [
  /<!--mesa-root-->/g,   // the root anchor this renderer inserts
  /<!---->/g,            // empty block anchors and markers
  /<!-- [^>]* -->/g,     // named anchors, e.g. <!-- mesa:hmr:App -->
]

function _stripAnchors(html) {
  let out = html
  for (const re of _ANCHOR_PATTERNS) out = out.replace(re, '')
  return out.trim()
}

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
 *
 * `initRenderer()` must have been called before the component module was
 * imported — compiled components call `htmlToFragment()` at module load, so the
 * DOM has to exist by then, not merely by render time.
 *
 * The component is called the way the compiler emits it — `Comp(anchor, props,
 * block)`, appending its DOM before `anchor` and returning nothing. It runs
 * inside a `createRoot` scope that is disposed the moment the HTML is
 * serialized, so a render is a lifetime with an end: nothing it created stays
 * subscribed to module-scope state after this function returns. That matters at
 * SSG scale, where one process renders many pages against the same imported
 * modules.
 *
 * What does NOT happen during a server render (RULE 19, via
 * `setRenderEnvironment(true, false)` in `initRenderer`): `$onMount` callbacks,
 * `watchProxy`/`watchPath` proxies, and path watches. Effects, memos and block
 * directives DO run — that is how the markup gets built — they are simply
 * disposed before this returns. `{#await}` renders its `{:pending}` branch: a
 * promise cannot settle inside a synchronous render. `{#virtual each}` renders
 * its first window plus the spacers that carry the rest of the list's height.
 *
 * The body is synchronous end to end despite the `async` signature. That is
 * load-bearing: the reactive core (`_owner`, `_listener`) and the happy-dom
 * window are process-global, so two interleaved renders would corrupt each
 * other. Because there is no `await` between the first line and the last, a
 * render runs to completion before any other can start — which is what makes
 * `renderAll()` safe. Do not introduce an `await` into this function.
 *
 * @param {Function} ComponentFactory — default export of a compiled .mesa file
 * @param {object}   [props={}]
 * @param {object}   [options={}]
 * @param {boolean}  [options.full]  — wrap in a full <!DOCTYPE html> page
 * @param {boolean}  [options.keepAnchors] — keep Mesa's comment anchors in the
 *                                           output (needed once hydration lands)
 * @returns {Promise<string>}
 */
export async function renderToHTML(ComponentFactory, props = {}, options = {}) {
  if (!_win) {
    throw new Error(
      '[Mesa renderToHTML] initRenderer() must be called before renderToHTML(). ' +
      'See render.js usage docs.'
    )
  }
  if (typeof ComponentFactory !== 'function') {
    throw new Error(
      '[Mesa renderToHTML] Expected the default export of a compiled .mesa file, got ' +
      (ComponentFactory === null ? 'null' : typeof ComponentFactory) + '. ' +
      'Pass the component function itself, not a module namespace.'
    )
  }

  // Use global.document (= _win.document installed by initRenderer) so the
  // container shares a document with the component's nodes — happy-dom throws
  // on cross-document adoption. The container is attached to the body because
  // block directives read `anchor.parentNode` and bail when it is null.
  const doc       = global.document
  const container = doc.createElement('div')
  const anchor    = doc.createComment('mesa-root')
  container.appendChild(anchor)
  doc.body.appendChild(container)

  let html = ''
  try {
    createRoot((dispose) => {
      try {
        ComponentFactory(anchor, props ?? {}, null)
      } catch (e) {
        dispose()
        throw new Error(`[Mesa renderToHTML] Component threw during render: ${e.message}`)
      }
      // Settle the graph before serializing. Derivations and render effects run
      // eagerly on creation, but anything a block queued during setup is still
      // pending, and an unflushed queue would also outlive the dispose below.
      flushSync()
      html = container.innerHTML
      dispose()
    })
  } finally {
    try { doc.body.removeChild(container) } catch (_) {}
  }

  if (!options.keepAnchors) html = _stripAnchors(html)
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
 * Render many pages, in order, and resolve with all their HTML.
 *
 * "In parallel" would be a lie and a bug: the happy-dom window and the reactive
 * core are process-global, so overlapping renders would share `_owner` and
 * `document`. This is safe only because `renderToHTML` is synchronous inside —
 * each render completes before the next begins, and `Promise.all` merely
 * collects results that are already settled. Should `renderToHTML` ever gain an
 * `await`, this function becomes a race and must be rewritten as a sequential
 * loop (and, for real concurrency, one window per worker rather than one
 * process).
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
