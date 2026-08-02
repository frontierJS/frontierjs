/**
 * router/index.js — Sierra router
 *
 * Public API for sierra/router:
 *
 *   Signals (Mesa prefix $ in templates):
 *     params, activeRoute, pendingRoute, meta, node, nodes
 *
 *   Navigation:
 *     goto(path, params?, options?)
 *     back(), forward()
 *     setParams(obj), updateParams(fn)
 *
 *   Guards/hooks:
 *     beforeNavigate(fn), afterNavigate(fn)
 *
 *   Utilities:
 *     isActive(path, options?), getDirection()
 *     url(path, params?)
 *
 *   Internal (called by virtual:sierra):
 *     initRouter(tree, components, options)
 */

import { watchProxy } from '@frontierjs/mesa/runtime'
import { matchRoute, normalizePath, buildUrl, parseQueryParams } from './match.js'
import {
  registerModule, buildLayoutMap, registerFileComponent, hmrInvalidate, getComponents,
  loadLayoutChain,
} from './internals.js'
import { sierraFetch } from '../fetch/index.js'
import {
  initPrefetch,
  prefetch as _prefetch,
  _prefetchCacheTake,
  _prefetchCacheHas,
  scanPrefetchLinks,
} from './prefetch.js'

/** Programmatic prefetch — preloads route chunk + data */
export { _prefetch as prefetch }
// The Mesa Vite plugin compiles RouterView.mesa when it's imported
export { default as RouterView } from '../components/RouterView.mesa'
export { default as ChainRenderer } from '../components/ChainRenderer.mesa'

// Internal exports (used by RouterView.mesa only — not public API)
export * from './internals.js'

// Route tree from config/routes.js — set by initRouter
let _tree = null
let _components = {}
let _loaders = {}
let _options = {}
let _layouts = {}

// Scroll position storage — keyed by history.state.index
const _scrollPositions = new Map()

// Guard/hook registries
const _beforeGuards = []
const _afterHooks = []

// ─── Signals ─────────────────────────────────────────────────────────────────

/** Current URL params — path segments + query string, type-coerced */
// ── Dev error reporter ───────────────────────────────────────────────────────
// In dev, forwards errors to the Sierra overlay + terminal.
// In prod, just console.errors.
function _reportError(type, context, err) {
  const message = err?.message ?? String(err)
  const data = { type, file: context, message, stack: err?.stack }
  if (typeof window !== 'undefined' && window.__sierraReportError) {
    window.__sierraReportError(data)
  } else {
    console.error(`[Sierra] ${context}: ${message}`, err)
  }
}

/**
 * The page — a plain object holding everything about the current route.
 *
 * Not a signal. Components make the fields they use reactive with a `$:` path
 * watch (VISION §4.1, RULE 43):
 *
 *   import { page } from '@frontierjs/sierra/router'
 *   $: (page.params, page.data)
 *   <h1>{page.title}</h1>
 *   <p>{page.params.slug}</p>
 *
 * This replaces the eight separate signals that preceded it — params,
 * activeRoute, pendingRoute, meta, data, loadError, pageSlots and the old page
 * descriptor. One object means one thing to import, one thing to watch, and
 * nothing for the compiler's externalSignals map to know about.
 *
 * ── Reserved field names ──────────────────────────────────────────────────
 * A route's frontmatter is spread onto this object, so `{page.title}` works
 * directly. The fields below are set by the router and therefore reserved —
 * frontmatter using one of these names is overwritten, and the scanner warns.
 *
 * @property {string}      path     current pathname + search
 * @property {object}      params   route params — { slug: 'x' }
 * @property {object}      meta     the raw frontmatter object, un-spread
 * @property {object|null} route    the matched route node (was `activeRoute`)
 * @property {object|null} pending  in-flight route during navigation, else null
 * @property {*}           data     value returned by the route's load()
 * @property {Error|null}  error    error thrown by the most recent load()
 * @property {object}      slots    named slots registered via provideSlot()
 */
export const page = {
  path:    '/',
  params:  {},
  meta:    {},
  route:   null,
  pending: null,
  data:    null,
  error:   null,
  slots:   {},
}

// Field names the router owns. Frontmatter keys matching these are shadowed —
// the scanner reports it. Defined in its own dependency-free module so the
// build pipeline can read it without importing the client router.
export { PAGE_RESERVED } from './page-fields.js'
import { PAGE_RESERVED } from './page-fields.js'

// The router's write handle. Every mutation goes through this so path watches
// fire — assigning `page.x` directly would update the object and notify nobody
// (RULE 45).
//
// Resolved per write rather than captured at import time. watchProxy is a
// no-op when there is no DOM (RULE 19), so a handle taken at module load in a
// non-browser environment is the raw object forever — even if the environment
// changes afterwards, which is exactly what mesa-render and the test suite do
// via setRenderEnvironment(). watchProxy caches per object, so this is a
// WeakMap hit.
const _w = () => watchProxy(page)

/**
 * Reset `page` to its initial state.
 *
 * Test seam. `page` is module-scoped for the lifetime of the module, so without
 * this a test's state leaks into the next one — the same hazard `_resetInternals`
 * and `_resetPrefetch` exist for.
 *
 * Writes go through the proxy so any live watchers see the reset.
 */
export function _resetPage() {
  _w().path    = '/'
  _w().params  = {}
  _w().meta    = {}
  _w().route   = null
  _w().pending = null
  _w().data    = null
  _w().error   = null
  _w().slots   = {}
  // Drop any frontmatter keys a previous route spread onto the object.
  for (const k of Object.keys(page)) {
    if (!PAGE_RESERVED.includes(k)) delete page[k]
  }
}

/**
 * Register a named slot from the current page component.
 * Called as a template side-effect expression: {provideSlot('sidebar', sidebar)}
 *
 * Returns null so it renders as an empty text node (no visible output).
 * The slot function must be a Mesa snippet function: (anchor) => void
 *
 * @param {string} name         — slot name, e.g. 'sidebar'
 * @param {Function} snippetFn  — Mesa snippet fn compiled from {#snippet name()}
 * @returns {null}
 */
export function provideSlot(name, snippetFn) {
  if (typeof snippetFn !== 'function') return null
  const current = _w().slots
  _w().slots = { ...current, [name]: snippetFn }
  return null
}

/** Full route tree (not a signal — static) */
export let nodes = null

// ─── Router object (for escape-hatch access) ─────────────────────────────────

export const router = {
  get history() { return window.history },
  setReturnPath(path) {
    sessionStorage.setItem('sierra_return_path', path)
  },
  consumeReturnPath() {
    const path = sessionStorage.getItem('sierra_return_path')
    sessionStorage.removeItem('sierra_return_path')
    return path
  },
  get meta() { return page.meta },
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Boot the router. Called by virtual:sierra before app mounts.
 *
 * @param {object} tree       — from config/routes.js
 * @param {object} components — lazy component map from config/routes.js
 * @param {object} loaders    — lazy loader map from config/routes.js
 * @param {object} options
 * @param {'always'|'never'|'preserve'} [options.trailingSlash='always']
 * @param {string} [options.base='/']
 * @param {object} [layouts]  — lazy layout map { filePath → () => import(...) }
 */
export function initRouter(tree, components, loaders = {}, options = {}, layouts = {}) {
  _tree = tree
  _components = components
  _loaders = loaders
  _options = options
  nodes = tree

  // Build the layout hierarchy map for RouterView's chain resolution
  buildLayoutMap(tree, components)

  _layouts = layouts

  // Layouts are NOT loaded eagerly.
  //
  // This used to invoke every factory in the layouts map on boot, so an app with
  // a dozen section layouts pulled a dozen chunks onto the critical path — and
  // did it even for routes with `reset: true`, which render no layout at all.
  // The justification was that resolveChain() would otherwise see
  // component === undefined on first visit to a layout-using route.
  //
  // That is a sequencing problem, not a preloading one. _navigate() already
  // awaits the page component before committing signals; loadLayoutChain()
  // below awaits the layouts that route actually needs, in the same place. The
  // chain is complete before activeRoute is set, so resolveChain() never sees a
  // hole, and layouts a session never visits are never fetched.

  // Boot the prefetch system with the same tree/components/loaders
  if (typeof window !== 'undefined') {
    initPrefetch(tree, components, loaders, options, layouts)
  }

  // Take control of scroll restoration
  if (typeof window !== 'undefined') {
    window.history.scrollRestoration = 'manual'

    // Assign index to first history entry if not present
    if (window.history.state?.index === undefined) {
      window.history.replaceState(
        { ...window.history.state, index: 0 },
        ''
      )
    }

    // Listen for browser back/forward
    window.addEventListener('popstate', _handlePopstate)

    // Delegate link clicks
    document.addEventListener('click', _handleClick)

    // Navigate to current URL on boot.
    //
    // Deferred by one microtask on purpose. initRouter() runs during
    // virtual:sierra's module evaluation, which completes *before* the app
    // entry mounts the root component — so any guard registered in component
    // setup (the usual place: App.mesa's <script>) would not yet be in
    // _beforeGuards when the guard loop runs, and the initial navigation would
    // commit unguarded. That made auth guards protect client-side navigation to
    // a route while leaving a direct load or refresh of it wide open.
    //
    // Static imports and the mount call that follows them run in the same
    // synchronous turn, so a microtask scheduled here lands after the app has
    // mounted and registered its guards.
    queueMicrotask(() => {
      _navigate(window.location.pathname + window.location.search, {
        replace: true,
        scroll: false,
        isPopstate: false,
      })
    })
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

/**
 * Navigate to a path.
 *
 * @param {string} path
 * @param {Record<string, unknown>} [queryParams={}]
 * @param {{ scroll?: boolean | string, replace?: boolean }} [options={}]
 */
export async function goto(path, queryParams = {}, options = {}) {
  const { scroll = true, replace = false } = options
  const url = buildUrl(path, queryParams, _options.trailingSlash ?? 'always')
  await _navigate(url, { replace, scroll })
}

/** Navigate back in history */
export function back() {
  window.history.back()
}

/** Navigate forward in history */
export function forward() {
  window.history.forward()
}

/**
 * Replace all query params in the URL.
 * @param {Record<string, unknown>} obj
 */
export function setParams(obj) {
  const current = normalizePath(window.location.pathname, _options.trailingSlash)
  goto(current, obj, { replace: true, scroll: false })
}

/**
 * Merge partial query params into the current URL.
 * @param {(current: Record<string, unknown>) => Record<string, unknown>} fn
 */
export function updateParams(fn) {
  const current = parseQueryParams(window.location.search)
  const next = fn(current)
  setParams(next)
}

// ─── Guards & hooks ───────────────────────────────────────────────────────────

/**
 * Register a before-navigation guard.
 * Return a path string to redirect, false to cancel, true/undefined to allow.
 *
 * @param {(context: { from: object|null, to: object }) => Promise<string|boolean|undefined>|string|boolean|undefined} fn
 * @returns {() => void} unsubscribe
 */
export function beforeNavigate(fn) {
  _beforeGuards.push(fn)
  return () => {
    const idx = _beforeGuards.indexOf(fn)
    if (idx !== -1) _beforeGuards.splice(idx, 1)
  }
}

/**
 * Register an after-navigation hook.
 * @param {(context: { from: object|null, to: object }) => void} fn
 * @returns {() => void} unsubscribe
 */
export function afterNavigate(fn) {
  _afterHooks.push(fn)
  return () => {
    const idx = _afterHooks.indexOf(fn)
    if (idx !== -1) _afterHooks.splice(idx, 1)
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Check if a path matches the current active route.
 *
 * @param {string} path
 * @param {{ exact?: boolean }} [options={}]
 * @returns {boolean}
 */
export function isActive(path, options = {}) {
  const { exact = false } = options
  // Reading page.route through the proxy makes this function reactive — a
  // template expression calling isActive() re-evaluates whenever the route
  // changes, because the read subscribes the calling effect to that path.
  // Requires the caller's component to declare `$: page.route`.
  _w().route
  const current = normalizePath(window.location.pathname, _options.trailingSlash)
  const target = normalizePath(path, _options.trailingSlash)

  if (exact) return current === target
  return current.startsWith(target)
}

/**
 * Get the navigation direction relative to the active route.
 * @returns {'next'|'prev'|'higher'|'lower'|'first'}
 */
export function getDirection() {
  // Compare history state indices
  const currentIndex = window.history.state?.index ?? 0
  const previousIndex = _previousHistoryIndex ?? 0

  if (currentIndex > previousIndex) return 'next'
  if (currentIndex < previousIndex) return 'prev'
  return 'first'
}

/**
 * Build an absolute URL string from a path and params.
 * @param {string} path
 * @param {Record<string, unknown>} [queryParams={}]
 * @returns {string}
 */
export function url(path, queryParams = {}) {
  return buildUrl(path, queryParams, _options.trailingSlash ?? 'always')
}

// ─── Internal navigation engine ──────────────────────────────────────────────

let _currentHistoryIndex = 0
let _previousHistoryIndex = 0
let _navigating = false

/**
 * Core navigation function. All navigation goes through here.
 */
async function _navigate(url, { replace = false, scroll = true, isPopstate = false, _hmr = false } = {}) {
  if (!_tree) return

  const pathname = url.split('?')[0].split('#')[0]
  const search = url.includes('?') ? '?' + url.split('?')[1] : ''
  const hash = url.includes('#') ? '#' + url.split('#')[1] : ''

  const normalized = normalizePath(pathname, _options.trailingSlash ?? 'always')
  const match = matchRoute(normalized, _tree, _options)

  if (!match) {
    console.warn(`[Sierra] No route found for: ${normalized}`)
    return
  }

  const _fromNode = page.route
  const toNode = match.node

  // Build from context with the actual current URL (not just the route pattern).
  // page.route has .path = the pattern (/blog/:slug/), but the real URL
  // is window.location.pathname + window.location.search.
  const fromContext = _fromNode
    ? {
        // Spread the route node so callers can access .id, .file, etc. directly
        ..._fromNode,
        // Override .path with the actual resolved URL (e.g. /blog/routing-signals/)
        // not the route pattern (/blog/:slug/)
        path: normalizePath(window.location.pathname, _options.trailingSlash)
          + window.location.search,
        params: page.params,
        node: _fromNode,
      }
    : null

  // Build pending route context
  const toContext = {
    path: normalized + search,
    params: {
      ...match.params,
      ...parseQueryParams(search),
    },
    node: toNode,
  }

  // Run before-navigation guards (skip during HMR re-navigation).
  // Snapshot the array: guards may await, and a registration landing during
  // that await would otherwise be picked up by the in-flight loop, so the same
  // navigation would be judged by a guard set that changed underneath it.
  if (!isPopstate && !_hmr) {
    for (const guard of [..._beforeGuards]) {
      const result = await guard({ from: fromContext, to: toContext })

      if (result === false) return  // cancelled

      if (typeof result === 'string') {
        // Redirect
        return _navigate(result, { replace: true, scroll })
      }
    }
  }

  // Save current scroll position before navigating away
  if (!isPopstate && !_hmr) {
    const currentIndex = window.history.state?.index ?? _currentHistoryIndex
    _scrollPositions.set(currentIndex, window.scrollY)
  }

  // Handle redirects from route meta
  if (toNode.meta?.redirect) {
    return _navigate(toNode.meta.redirect, { replace: true, scroll })
  }

  // Set pending route
  _w().pending = toContext
  _navigating = true

  // Load the layout chain and the page component together — they're independent
  // network requests, so serialising them would add a round-trip to every first
  // visit. Started here, awaited below.
  const layoutsReady = loadLayoutChain(toNode, _layouts, _reportError)

  // Load component (lazy) and register with internals
  const componentFactory = _components[toNode.id]
  if (componentFactory && !toNode._componentLoaded) {
    try {
      const mod = await componentFactory()
      toNode._componentLoaded = true
      // Register the module so RouterView can access named exports (snippets)
      registerModule(toNode.id, mod)
      // Register the component factory by file path for layout resolution
      if (toNode.file && mod.default) {
        registerFileComponent(toNode.file, mod.default)
      }
    } catch (err) {
      _reportError('component', toNode.file ?? toNode.id, err)
      _w().pending = null
      _navigating = false
      return
    }
  }

  // Chain must be complete before activeRoute is committed below, or
  // ChainRenderer renders a layout depth with component === undefined.
  await layoutsReady

  // Run load() if this route has a .meta.js companion
  let loadedData = null
  const loaderFactory = _loaders[toNode.id]
  if (loaderFactory) {
    try {
      // Check prefetch cache first — avoids a second round-trip when the user
      // hovered or moused-down on the link before clicking.
      // Cached payloads expire (see PREFETCH_CACHE_TTL) so a route prefetched
      // long ago doesn't serve stale data on eventual navigation.
      const cacheKey = `${toNode.id}:${normalized}${search}`
      if (_prefetchCacheHas(cacheKey)) {
        loadedData = _prefetchCacheTake(cacheKey)   // consume once
      } else {
        // Lazy-import the loader module
        const loaderMod = await loaderFactory()
        const loadFn = loaderMod?.load ?? loaderMod?.default?.load

        if (typeof loadFn === 'function') {
          loadedData = await loadFn({
            params: toContext.params,
            url: normalized + search,
            meta: toNode.meta ?? {},
            fetch: sierraFetch,
          })

          // load() can return a redirect string
          if (typeof loadedData === 'string' && loadedData.startsWith('/')) {
            _w().pending = null
            _navigating = false
            return _navigate(loadedData, { replace: true, scroll })
          }
        }
      }

      _w().error = null
    } catch (err) {
      // load() errors are data-layer failures (e.g. "not found", API error).
      // They are NOT framework errors — don't show the dev overlay.
      // The page handles them via the loadError signal ({#if loadError}).
      // Only log to console in dev so the terminal/agent can see it.
      if (import.meta.env?.DEV) {
        console.warn(`[Sierra] load() error for ${toNode.file ?? toNode.id}:`, err?.message ?? err)
      }
      _w().error = err

      // Stay on this route — let the page render its loadError state.
      // Do NOT redirect to catch-all (that's for route-not-found, not data errors).
      loadedData = null
    }
  }

  // Update history
  if (!isPopstate) {
    _previousHistoryIndex = _currentHistoryIndex

    if (replace) {
      const idx = window.history.state?.index ?? _currentHistoryIndex
      window.history.replaceState({ index: idx }, '', normalized + search + hash)
    } else {
      _currentHistoryIndex++
      window.history.pushState({ index: _currentHistoryIndex }, '', normalized + search + hash)
    }
  } else {
    _previousHistoryIndex = _currentHistoryIndex
    _currentHistoryIndex = window.history.state?.index ?? 0
  }

  // Commit all signals atomically
  // Commit. Written field by field rather than replacing the object, so each
  // path watch fires only for what actually changed — a component watching
  // `page.params` doesn't re-render because `page.data` arrived.
  //
  // Frontmatter is spread first; the router's own fields are assigned after and
  // therefore win. PAGE_RESERVED lists them, and the scanner warns when a route
  // declares one.
  const _meta = toNode.meta ?? {}
  for (const [k, v] of Object.entries(_meta)) {
    if (PAGE_RESERVED.includes(k)) continue
    if (page[k] !== v) _w()[k] = v
  }

  _w().meta    = _meta
  _w().path    = normalized + search
  _w().params  = toContext.params
  _w().route   = toNode
  _w().data    = loadedData
  _w().pending = null
  _w().slots   = {}   // cleared — the new page repopulates during its render
  _navigating = false

  // Scroll behavior
  _handleScroll(scroll, hash, isPopstate)

  // Re-scan for eager prefetch links in the newly rendered page. Delegation
  // covers hover/mousedown without any registration, but `visible` and
  // `immediate` need to find their elements. Deferred so the new route's DOM
  // exists by the time we query.
  if (typeof window !== 'undefined') queueMicrotask(scanPrefetchLinks)

  // Run after-navigation hooks
  for (const hook of [..._afterHooks]) {
    hook({ from: fromContext, to: toContext })
  }
}

/**
 * Handle scroll after navigation.
 */
function _handleScroll(scroll, hash, isPopstate) {
  if (scroll === false) return

  if (hash) {
    // Scroll to hash element
    const target = document.getElementById(hash.slice(1))
    if (target) {
      target.scrollIntoView()
      return
    }
  }

  if (typeof scroll === 'string' && scroll.startsWith('#')) {
    // goto('/path', {}, { scroll: '#id' })
    const target = document.getElementById(scroll.slice(1))
    if (target) {
      target.scrollIntoView()
      return
    }
  }

  if (isPopstate) {
    // Restore saved scroll position for this history entry
    const idx = window.history.state?.index ?? 0
    const savedY = _scrollPositions.get(idx) ?? 0
    window.scrollTo(0, savedY)
    return
  }

  // Default: scroll to top
  window.scrollTo(0, 0)
}

/**
 * Find the catch-all ([...xxx]) route node in the tree.
 * Returns null if no catch-all exists.
 * Exported for testing.
 */
/**
 * HMR: called by the client-side hot update handler when a .mesa file changes.
 * Invalidates the component and re-navigates to the current route.
 *
 * @param {string} filePath — relative file path from project root
 * @param {object[]} nodes  — flat list of route nodes to find which route matches
 */
export async function hmrReload(filePath, nodes) {
  // Invalidate the file from all caches
  hmrInvalidate(filePath)

  // Find route nodes that use this file (as page or layout) and clear their
  // loaded flags so the router re-imports the updated module on next navigation.
  for (const node of nodes) {
    if (node.file === filePath) {
      node._componentLoaded = false
      // Also remove from the loaded components map so resolveChain
      // won't find a stale component reference
      getComponents().delete(node.id)
    }
    // If this file is a layout used by the node, the layout map handles it
    // via hmrInvalidate clearing _fileToComponent
  }

  // Re-navigate to current route — forces fresh dynamic import + remount
  const current = window.location.pathname + window.location.search
  await _navigate(current, { replace: true, scroll: false, _hmr: true })
}

export function _findCatchAll(node) {
  return findCatchAll(node)
}

function findCatchAll(node) {
  if (node.meta?.spread) return node
  for (const child of node.children ?? []) {
    const found = findCatchAll(child)
    if (found) return found
  }
  return null
}

/**
 * Handle browser back/forward button.
 */
function _handlePopstate(event) {
  const url = window.location.pathname + window.location.search
  _navigate(url, { isPopstate: true, scroll: true })
}

/**
 * Document-level click delegation for <a> tags.
 * Intercepts same-origin links and routes them through the SPA router.
 */
function _handleClick(event) {
  // Ignore modified clicks
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (event.defaultPrevented) return
  if (event.button !== 0) return

  // Find closest <a> tag
  const a = event.composedPath().find(el => el.tagName === 'A')
  if (!a) return

  const href = a.getAttribute('href')
  if (!href) return

  // Skip non-navigation attributes
  if (a.hasAttribute('target')) return
  if (a.hasAttribute('download')) return

  // Parse the href
  let url
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return
  }

  // Only intercept same-origin links
  if (url.origin !== window.location.origin) return

  // Skip mailto/tel etc
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  event.preventDefault()

  const path = url.pathname + url.search + url.hash
  _navigate(path, { scroll: true })
}
