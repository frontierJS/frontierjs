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
 *   - $.onMount, watchProxy and path watches are inert (RULE 19). Effects, memos
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

// The browser globals compiled output may reach for, installed when the window
// has one — `requestIdleCallback` and `cancelIdleCallback` are on the list and
// happy-dom 20 has neither, so naming a global here is a request rather than a
// promise. parent/top are here because happy-dom references them internally
// during DOM operations like appendChild.
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
  // built, $.onMount is a no-op, path watches stay inert. Passing a single
  // `true` here used to enable client behavior too, so every server render ran
  // $.onMount callbacks and built proxies and signals that nothing disposed.
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
// Stripped in the DOM, and never over the serialized string. A regex cannot
// tell an anchor from those same characters inside an attribute VALUE, which
// legitimately carries raw `<` and `>` — happy-dom escapes only `&` and `"`
// there, correctly per HTML5. An alt text or a product description holding a
// comment lost it, and because a match could span the closing quote, the
// attribute BETWEEN two such values was deleted whole. Text nodes escape, so
// they were safe, which is what made the server and the client disagree about
// the same data.

// An anchor by its comment data. `mesa-island` markers and `[if mso]`
// conditionals have no leading space and survive — the first is read by a
// loader, the second is what an email template emitted `{@html}` for.
function _isAnchorComment(data) {
  if (data === 'mesa-root' || data === '') return true
  // A named anchor is written `<!-- name -->`, so its data is space-padded.
  return data.length >= 2 && data.startsWith(' ') && data.endsWith(' ')
}

// A hand walk rather than a TreeWalker: happy-dom changed what `SHOW_COMMENT`
// filters to between the versions this package has pinned, and a walker that
// quietly matches nothing leaves every anchor in the page.
function _collectAnchors(node, out) {
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 8) {
      if (_isAnchorComment(n.data)) out.push([n, n.parentNode, n.nextSibling])
    } else if (n.nodeType === 1) {
      _collectAnchors(n, out)
    }
  }
}

// Lift the anchors out, serialize, put them back. They go back because the
// render is disposed after this returns and a block directive's cleanup reads
// `anchor.parentNode` — serializing is not a reason to tear its DOM out from
// under it. Reverse order on the way back, so an anchor whose recorded next
// sibling is another anchor finds it already reinserted.
function _serializeWithoutAnchors(container) {
  const found = []
  _collectAnchors(container, found)
  for (const [n, parent] of found) parent.removeChild(n)
  const html = container.innerHTML
  for (let i = found.length - 1; i >= 0; i--) {
    const [n, parent, next] = found[i]
    parent.insertBefore(n, next)
  }
  return html.trim()
}

// The one owner of "this value is going into HTML". `'` is in the set because
// the name promises safety anywhere and an attribute may be single-quoted; a
// caller that has to remember which sinks this covers is a sink somebody forgets.
export function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Render failures ──────────────────────────────────────────────────────────

// A component that throws mid-render used to arrive as a bare `new Error(msg)`:
// the original stack was dropped, so the one frame that names the compiled
// module — and therefore the `.mesa` file and the component function — was gone
// by the time anyone read it. The message named the identifier or the attribute
// and nothing else, which for a prerender of hundreds of pages is a failure with
// no address. The cause is kept and its stack appended.

const _MISSING_GLOBAL = /^(\w+) is not defined$/

// `initRenderer` installs what happy-dom can answer for; anything else a browser
// has is absent, and the ReferenceError does not say that a build has no
// browser. Two shapes need a different sentence, so the hint is per shape rather
// than a list of global names, which would go stale against happy-dom.
function _hintFor(err) {
  const missing = err instanceof ReferenceError && _MISSING_GLOBAL.exec(err.message)?.[1]
  if (missing) {
    return `\n\n\`${missing}\` does not exist during a server render — a build has no browser. ` +
      `Guard the read with \`typeof ${missing} !== 'undefined'\` and render the server branch, ` +
      'or move it into `$.onMount`, which does not run here (RULE 19).'
  }
  if (/setAttribute/.test(err.message ?? '')) {
    return '\n\nA spread carried an attribute NAME the DOM refuses. A browser refuses the same ' +
      'name, so nothing was injected — the cost is the whole page. Drop or rename the key where ' +
      'the spread is built.'
  }
  return ''
}

export function renderFailure(cause, label) {
  const where = label ? ` in ${label}` : ''
  const err = new Error(
    `[Mesa renderToHTML] Component threw during render${where}: ${cause?.message ?? cause}${_hintFor(cause)}`,
    { cause }
  )
  if (cause?.stack) err.stack += '\n\nCaused by: ' + cause.stack
  return err
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
 * `setRenderEnvironment(true, false)` in `initRenderer`): `$.onMount` callbacks,
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
 * @param {string}   [options.label] — what to call this component in a failure
 *                                     message. Diagnostic only; nothing reads it
 *                                     otherwise.
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
  // container shares a document with the component's nodes: the compiled
  // templates were cloned from whatever `global.document` was at module load,
  // and happy-dom 20 adopts across documents without complaining, so a
  // mismatch here is a wrong page rather than a throw. The container is
  // attached to the body because block directives read `anchor.parentNode` and
  // bail when it is null.
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
        throw renderFailure(e, options.label)
      }
      // Settle the graph before serializing. Derivations and render effects run
      // eagerly on creation, but anything a block queued during setup is still
      // pending, and an unflushed queue would also outlive the dispose below.
      flushSync()
      html = options.keepAnchors ? container.innerHTML : _serializeWithoutAnchors(container)
      dispose()
    })
  } finally {
    try { doc.body.removeChild(container) } catch (_) {}
  }

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

  // Every attribute sink here escapes. `title` and `meta` did and the three URL
  // sinks did not, so a `"` in a stylesheet path closed the attribute and the
  // rest of the value became markup — in a file a static build serves to
  // everyone, and beside an escaped value that made the omission look deliberate.
  const cssTag     = css ? `  <link rel="stylesheet" href="${escapeHTML(css)}">` : ''
  const metaTags   = Object.entries(meta)
    .map(([n, c]) => `  <meta name="${escapeHTML(n)}" content="${escapeHTML(c)}">`)
    .join('\n')
  const scriptTags = scripts
    .map((s) => `  <script type="module" src="${escapeHTML(s)}"></script>`)
    .join('\n')
  const loaderTag  = islandLoader
    ? `  <script type="module" src="${escapeHTML(islandLoader)}"></script>`
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
