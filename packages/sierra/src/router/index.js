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
import {
  matchRoute, normalizePath, buildUrl, parseQueryParams, caseInsensitiveNearMiss,
} from './match.js'
import { splitParams } from '@frontierjs/toolbelt/directives'
import {
  registerModule, buildLayoutMap, registerFileComponent, hmrInvalidate, getComponents,
  loadLayoutChain, linkHrefOf,
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
// Routes already told about in dev — one note each, not one per navigation.
const _prerenderNoted = new Set()

// What index.html hardcoded. Read once, before any navigation can move it, so a
// route that declares no title puts the app's own name back rather than leaving
// the previous page's — the failure a per-navigation title has that a static
// one does not.
let _bootTitle = null
let _options = {}
let _layouts = {}

// Scroll position storage — keyed by history.state.index.
//
// Bounded, because nothing else empties it: one entry per navigation for the
// life of the tab, which a long session or a synthetic-entry SPA grows without
// limit. Two evictions, and they answer different halves — a pushState DESTROYS
// forward history, so every entry above the current index is unreachable and
// deleting it is exact; the cap is for depth alone, and 50 is chosen because
// browsers cap the session history around there, so an entry evicted by it is
// one the Back button can no longer reach either.
const _scrollPositions = new Map()
const SCROLL_MEMORY = 50

/* Test seams. The cap is invisible to every behavioral assertion about
   scrolling — a map that grew without limit restores exactly the same offsets —
   so its size is the only thing that can be asked. */
export function _scrollMemorySize() { return _scrollPositions.size }
export function _scrollMemoryHas(index) { return _scrollPositions.has(index) }

function _rememberScroll(index, y) {
  _scrollPositions.set(index, y)
  for (const key of _scrollPositions.keys()) {
    if (key > index) _scrollPositions.delete(key)
  }
  // Insertion order is not index order — a Back followed by a fresh navigation
  // rewrites an earlier key — so the oldest ENTRY is not the deepest one.
  while (_scrollPositions.size > SCROLL_MEMORY) {
    _scrollPositions.delete(Math.min(..._scrollPositions.keys()))
  }
}

// The window whose click and popstate listeners this module already holds.
let _boundWindow = null

// Guard/hook registries
const _beforeGuards = []
const _afterHooks = []

// ─── Signals ─────────────────────────────────────────────────────────────────

/** Current URL params — path segments + query string, type-coerced */
// ── Dev error reporter ───────────────────────────────────────────────────────
// In dev, forwards errors to the Sierra overlay + terminal.
// In prod, just console.errors.
/*
 * A path that resolved to the catch-all, or to nothing, when a route exists
 * that differs from it only in case. Matching is case-sensitive (`FJS-D210`)
 * and stays that way; what this adds is the sentence § IV asks for when a
 * deliberate difference meets muscle memory — name the equivalent rather than
 * refusing in silence. Empty string when there is nothing to say, so it
 * concatenates into an existing message without a branch at the call site.
 */
function _nearMiss(normalized) {
  const near = caseInsensitiveNearMiss(normalized, _tree)
  return near ? ` — did you mean ${near}? Route matching is case-sensitive.` : ''
}

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
 * descriptor. One object means one thing to import and one thing to watch. It
 * was also the first of the three moves that emptied the compiler's
 * `externalSignals` map (`FJS-060`); `status` and `theme` followed.
 *
 * ── Reserved field names ──────────────────────────────────────────────────
 * A route's frontmatter is spread onto this object, so `{page.title}` works
 * directly. The fields below are set by the router and therefore reserved —
 * frontmatter using one of these names is overwritten, and the scanner warns.
 *
 * @property {string}      path     current pathname + search
 * @property {object}      params   route params — { slug: 'x' }. PATH captures
 *                                  only; the search string is `query`
 * @property {object}      query    the URL's filters — { status: 'active' }
 * @property {object}      directives  the URL's `$` params, structured —
 *                                  { limit, offset, orderBy, select, … }
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
  query:      {},
  directives: {},
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
  _w().query      = {}
  _w().directives = {}
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

    // Bound once. initRouter used to add a click and a popstate listener on
    // every call, and initPrefetch four more, so three inits — HMR of the boot
    // module, a re-mounted micro-frontend, a test that boots twice — meant one
    // click running three concurrent navigations (Invariant 11). Keyed on the
    // window rather than a boolean because swapping globalThis.window is a test
    // seam, and a bare flag would leave the new environment with no listeners.
    if (_boundWindow !== window) {
      _boundWindow = window
      window.addEventListener('popstate', _handlePopstate)
      document.addEventListener('click', _handleClick)
    }

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
      // The FRAGMENT is part of the URL and was dropped here. `_navigate`
      // rebuilds the address bar as `normalized + search + hash`, so an absent
      // hash was written back as an absent hash: every direct load or refresh
      // of `/docs/#install` silently lost its anchor, did not scroll, and left
      // the reader with a URL that no longer says where they were. Clicking the
      // same link inside the app worked, because that path carries the hash —
      // so it fails only for the person who pasted a link, which is the person
      // a deep link is for.
      //
      // `scroll` follows: at boot it is false so the router does not fight
      // scroll restoration, but a hash IS an instruction about where to be, and
      // the browser's own handling of it is what `scrollRestoration = 'manual'`
      // above took away.
      // `|| ''` because a test double is a plain object and a missing `hash`
      // would concatenate the string "undefined" onto every boot URL — which
      // is a 404 on a route that plainly exists.
      const hash = window.location.hash || ''
      _navigate(window.location.pathname + window.location.search + hash, {
        replace: true,
        scroll: !!hash,
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
 * Are these two parameter bags the same? One level deep, which is all a search
 * string can produce past `parseQueryParams` — a nested value there is an
 * `a[b]=` object of scalars, compared by its own scalars.
 */
function _sameParams(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => {
    const [x, y] = [a[k], b[k]]
    if (x === y) return true
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return false
    const kx = Object.keys(x)
    return kx.length === Object.keys(y).length && kx.every(i => x[i] === y[i])
  })
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
  // This read subscribes to the route path, but that is NOT enough to make a
  // call site reactive, and the comment here used to claim it was. Mesa decides
  // what an expression depends on from the expression's own text, so a template
  // that only says `isActive('/leads/')` is evaluated once at mount and the
  // highlight never moves — the read happens inside a function Mesa never
  // looked into. Name the path in the expression as well:
  //
  //   aria-current={(page.route, isActive('/leads/')) ? 'page' : null}
  //
  // (and keep the component's `$: page.route` watch, which is what makes that
  // read a tracked one). Verified by clicking through the example app.
  _w().route
  const current = normalizePath(window.location.pathname, _options.trailingSlash)
  const target = normalizePath(path, _options.trailingSlash)

  if (exact) return current === target
  if (current === target) return true
  // A prefix must end at a segment boundary. Under `trailingSlash: 'never'`
  // nothing supplied one and a bare `startsWith` made `/leads` active on
  // `/leads-archive`, so the wrong nav item highlighted; under 'always' the
  // trailing slash was supplying it by accident, which is why it was invisible.
  return current.startsWith(target.endsWith('/') ? target : target + '/')
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
// ─── the document title ───────────────────────────────────────────────────────
//
// The SAME two sources the static target reads, in the same order: `head()` off
// the route's companion, then frontmatter. Two halves of one feature that
// disagreed about where a title comes from would be worse than the bug.
//
// No template and no site name is appended, for the same reason: the static
// half composes neither, and an app that wants "Page · Acme" says so in head(),
// which is the one place that can see both. `title` also stays an ordinary
// frontmatter key rather than joining PAGE_RESERVED — every example in the docs
// renders {page.title} in a heading, and claiming the name would empty them.
async function _applyTitle(node, loaderModule, params, url, data) {
  if (typeof document === 'undefined') return
  if (_bootTitle === null) _bootTitle = document.title

  let title = null
  const head = loaderModule?.head ?? loaderModule?.default?.head
  if (typeof head === 'function') {
    try {
      const answered = await head({ params, data, url })
      if (answered?.title) title = answered.title
    } catch (err) {
      // The static build refuses to emit the page. Here the page is already on
      // screen, so falling back to frontmatter is the only honest move — said
      // out loud, because a silent catch is how a head() that always throws
      // looks exactly like one nobody wrote.
      if (import.meta.env?.DEV) {
        console.warn(`[Sierra] head() threw for ${node.file ?? node.id}:`, err?.message ?? err)
      }
    }
  }

  title = title ?? node.meta?.title ?? node.meta?.frontmatter?.title ?? _bootTitle
  if (title != null && document.title !== title) document.title = String(title)
}

let _navigating = false

// How many redirects one navigation may make before the router calls it a
// loop. Two guards that redirect to each other — an auth guard sending /admin/
// to /login/ and a signed-in guard sending it back — recursed unbounded: 501
// invocations in 7 ms, no error, a tab that never settles.
const MAX_REDIRECTS = 10

// Which navigation is the live one. _navigate has four await points, so the
// last one to FINISH used to commit rather than the last one STARTED: a slow
// load() from a route the reader had already left overwrote the page they were
// on and pushed its own URL into the address bar. The same stamp createResource
// applies to its own loads (`FJS-082`) and junction's store applies to a push.
let _navSeq = 0

/**
 * A redirect target is a path on this origin.
 *
 * `//evil.example.com/` and `http://evil.example.com/` are refused by the
 * browser's own pushState, which left `page.pending` set — RouterView's loading
 * snippet forever — and rejected `goto` with nothing catching it. Refused here
 * by name instead. `/\` is protocol-relative to some browsers, so both slash
 * shapes go.
 */
function _validRedirect(target) {
  return typeof target === 'string' && target.charCodeAt(0) === 47 /* '/' */
    && target[1] !== '/' && target[1] !== '\\'
}

/**
 * Put the address bar back after a guard refuses a popstate.
 *
 * The browser has already moved by the time popstate fires, so a refusal that
 * does not undo it leaves the URL naming the page the guard just declined —
 * the same lie as not guarding at all. `history.go` fires a second popstate for
 * the return trip, which navigates to the page the reader is already on; the
 * guard sees that page and allows it, and the delta is then zero so a guard
 * that refuses everything settles rather than looping.
 */
function _restoreHistory(index) {
  const now = window.history.state?.index ?? 0
  if (now !== index) window.history.go?.(index - now)
}

/**
 * Core navigation function. All navigation goes through here.
 */
async function _navigate(url, { replace = false, scroll = true, isPopstate = false, _hmr = false, _hops = 0 } = {}) {
  if (!_tree) return

  if (_hops > MAX_REDIRECTS) {
    _reportError('redirect', url, new Error(
      `Redirect loop: more than ${MAX_REDIRECTS} redirects without landing, last to ${url}. ` +
      'Two guards redirecting to each other is the usual cause.',
    ))
    _w().pending = null
    _navigating = false
    return
  }

  const seq = ++_navSeq

  // Split the FRAGMENT off first, then the search. Splitting on '?' against the
  // whole URL puts the fragment inside `search`, so `/leads/?status=open#top`
  // was rewritten as `?status=open#top#top` and `page.query.status` came out as
  // `open#top`. It was unreachable while the boot navigation dropped the hash
  // and every internal link carried one only rarely, which is why a URL with
  // both a query and an anchor is the shape that finds it.
  const beforeHash = url.split('#')[0]
  const pathname   = beforeHash.split('?')[0]
  const search     = beforeHash.includes('?') ? '?' + beforeHash.slice(beforeHash.indexOf('?') + 1) : ''
  const hash       = url.includes('#') ? '#' + url.slice(url.indexOf('#') + 1) : ''

  const normalized = normalizePath(pathname, _options.trailingSlash ?? 'always')
  const match = matchRoute(normalized, _tree, _options)

  if (!match) {
    console.warn(`[Sierra] No route found for: ${normalized}${_nearMiss(normalized)}`)
    return
  }

  const _fromNode = page.route
  const toNode = match.node

  // The catch-all swallowing a case-only miss is the quiet half: `match` is
  // truthy, nothing warns, and the reader gets a Not Found page for a route
  // that exists. Said once, here, rather than at each of the two call sites
  // that reach a spread node.
  if (toNode.meta?.spread) {
    const near = _nearMiss(normalized)
    if (near) console.warn(`[Sierra] ${normalized} matched the catch-all${near}`)
  }

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

  // ── The search string is two things ────────────────────────────────────
  // The same split the API realm makes at its own boundary, over the same table
  // (`@frontierjs/toolbelt/directives`): the FILTERS a page asks with, and the
  // DIRECTIVES saying how much of the answer and in what order. So a filtered,
  // sorted, paginated list is URL-driven with nothing to translate —
  // `resource.load(page.query, page.directives)` — and it survives a reload, a
  // back button and a pasted link because the URL is where it lives.
  //
  // `params` is PATH captures alone now. It used to carry the search params
  // merged in, so one value had two homes and neither said which kind it was.
  const { query, directives } = splitParams(parseQueryParams(search))

  // Build pending route context
  const toContext = {
    path:   normalized + search,
    params: { ...match.params },
    query,
    directives,
    node:   toNode,
  }

  // Run before-navigation guards (skip during HMR re-navigation).
  //
  // Popstate is NOT exempt. It was, inside the same condition as the two blocks
  // below, and only the HMR half was ever justified: the Back button walked past
  // every guard an app had registered, while `meta.redirect` — sitting three
  // lines lower, outside the fence — did fire on Back. One kind of routing
  // refusal survived Back and the other did not. README §Guards promises the
  // opposite and `FJS-D06` files `beforeNavigate` under Hook, the tier that may
  // halt the operation. The server is still the boundary (Invariant 6); what was
  // broken is the affordance, silently.
  //
  // Snapshot the array: guards may await, and a registration landing during
  // that await would otherwise be picked up by the in-flight loop, so the same
  // navigation would be judged by a guard set that changed underneath it.
  const historyIndexBefore = _currentHistoryIndex
  if (!_hmr) {
    for (const guard of [..._beforeGuards]) {
      const result = await guard({ from: fromContext, to: toContext })

      if (result === false) {
        if (isPopstate) _restoreHistory(historyIndexBefore)
        return  // cancelled
      }

      if (typeof result === 'string') {
        if (!_validRedirect(result)) {
          _reportError('redirect', toNode.file ?? toNode.id, new Error(
            `A guard returned ${JSON.stringify(result)} — a redirect target must be a path ` +
            'on this origin.',
          ))
          return
        }
        // Redirect. On popstate the entry the browser moved to is the one being
        // replaced, which is what a guard redirect means: the reader pressed
        // Back to a page they may not have and lands on the one they may.
        return _navigate(result, { replace: true, scroll, _hops: _hops + 1 })
      }
    }
  }

  // A newer navigation started while a guard was awaiting.
  if (seq !== _navSeq) return

  // Save current scroll position before navigating away
  if (!isPopstate && !_hmr) {
    const currentIndex = window.history.state?.index ?? _currentHistoryIndex
    _rememberScroll(currentIndex, window.scrollY)
  }

  // Handle redirects from route meta
  if (toNode.meta?.redirect) {
    if (!_validRedirect(toNode.meta.redirect)) {
      _reportError('redirect', toNode.file ?? toNode.id, new Error(
        `redirect: ${JSON.stringify(toNode.meta.redirect)} — a redirect target must be a path ` +
        'on this origin.',
      ))
      return
    }
    return _navigate(toNode.meta.redirect, { replace: true, scroll, _hops: _hops + 1 })
  }

  // Set pending route
  _w().pending = toContext
  _navigating = true

  // Load the layout chain and the page component together — they're independent
  // network requests, so serializing them would add a round-trip to every first
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

  // Nothing registered a component for this route. The navigation used to commit
  // anyway — no build error, no load error, `page.error` null — and then
  // ChainRenderer threw on `chain[0].component`, naming an internal expression
  // and no file. A route file that is all `<script module>` (the Resource shape,
  // Invariant 18, dropped into routes/ by mistake) arrives exactly this way.
  // Refused here because this is the last frame that still knows which FILE it
  // was; ChainRenderer's own guard is the belt.
  if (!getComponents().has(toNode.id)) {
    _reportError('component', toNode.file ?? toNode.id, new Error(
      `Route ${toNode.id} registered no component — a route file needs a default export.`,
    ))
    _w().pending = null
    _navigating = false
    return
  }

  // Chain must be complete before activeRoute is committed below, or
  // ChainRenderer renders a layout depth with component === undefined.
  await layoutsReady

  // Run load() if this route has a .meta.js companion
  let loadedData   = null
  let loaderModule = null
  const loaderFactory = _loaders[toNode.id]

  // A prerendered route has a companion and no loader here, deliberately: its
  // `load()` runs in Node at build time and is where an app reads its own
  // database, so it is not in the client table (`FJS-543`). What that leaves in
  // dev is `data: null` and a page with nothing on it, which looks exactly like
  // a page whose query returned nothing — so it is said once, per route.
  //
  // Dev only. In the built output this is not a state anybody reaches: the page
  // is a file with its data already in it.
  if (import.meta.env?.DEV && !loaderFactory && toNode.meta?.render === 'static' && toNode.companion) {
    if (!_prerenderNoted.has(toNode.id)) {
      _prerenderNoted.add(toNode.id)
      console.info(
        `[Sierra] ${toNode.file ?? toNode.id} declares \`render: static\`, so its ` +
        `load() runs at BUILD time — \`data\` is null here and the page renders empty. ` +
        `Run the build to see it with data.`
      )
    }
  }

  if (loaderFactory) {
    try {
      // Check prefetch cache first — avoids a second round-trip when the user
      // hovered or moused-down on the link before clicking.
      // Cached payloads expire (see PREFETCH_CACHE_TTL) so a route prefetched
      // long ago doesn't serve stale data on eventual navigation.
      const cacheKey = `${toNode.id}:${normalized}${search}`
      if (_prefetchCacheHas(cacheKey)) {
        loadedData = _prefetchCacheTake(cacheKey)   // consume once
        // The data came from the cache, so the module was never imported on
        // this navigation — but head() lives in it. The import is already
        // resolved (the prefetch did it), so asking again costs a map lookup.
        loaderModule = await loaderFactory().catch(() => null)
      } else {
        // Lazy-import the loader module
        const loaderMod = loaderModule = await loaderFactory()
        const loadFn = loaderMod?.load ?? loaderMod?.default?.load

        if (typeof loadFn === 'function') {
          loadedData = await loadFn({
            params: toContext.params,
            url: normalized + search,
            meta: toNode.meta ?? {},
            fetch: sierraFetch,
          })

          // load() can return a redirect string. Anything that is not a path on
          // this origin stays DATA — a load() returning a plain string is legal,
          // so this is a shape test rather than a refusal.
          if (_validRedirect(loadedData)) {
            _w().pending = null
            _navigating = false
            return _navigate(loadedData, { replace: true, scroll, _hops: _hops + 1 })
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

  // Superseded while load() was in flight. Everything below is irreversible —
  // the address bar, then the commit — and `pending` is left alone because the
  // navigation that overtook this one owns it now.
  if (seq !== _navSeq) return

  // Update history. Wrapped because pushState is the one call here a browser can
  // refuse: a target it reads as cross-origin throws SecurityError, and an
  // unwrapped throw left `pending` set, so RouterView rendered the app's loading
  // snippet forever and `goto` rejected with nothing catching it.
  try {
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
  } catch (err) {
    _reportError('navigation', normalized + search + hash, err)
    _w().pending = null
    _navigating = false
    return
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
  // Only when they changed. `page` fields are assigned every navigation, which
  // is right for the ones a navigation always changes — but a LAYOUT outlives
  // one, and a filter bar watching `page.query` would re-ask the server on
  // every navigation under it if a fresh object arrived each time.
  if (!_sameParams(page.query,      query))      _w().query      = query
  if (!_sameParams(page.directives, directives)) _w().directives = directives
  _w().route   = toNode
  _w().data    = loadedData

  // The tab, the bookmark, the history entry and what a screen reader announces
  // on arrival. The static target has written a real <title> per page since it
  // existed and the SPA wrote none at all, so every route of an app showed
  // whatever index.html hardcoded — one string for the whole app, and the worst
  // shape is an app that prerenders AND hydrates, where the title is right on
  // first paint and stale from the first client navigation (FJS-389).
  _w().pending = null
  _w().slots   = {}   // cleared — the new page repopulates during its render
  _navigating = false

  // AFTER the navigation state is settled, not between the commit and it: this
  // awaits `head()`, and holding `pending` open across a dynamic import would
  // make every route with a companion look like it was still navigating for an
  // extra tick. Awaited rather than fired, so a caller that awaited the
  // navigation can read the title.
  await _applyTitle(toNode, loaderModule, toContext.params, normalized + search, loadedData)

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
  // The FRAGMENT, for the same reason the boot navigation carries it: without
  // it `_handleScroll` takes the isPopstate branch and restores a saved offset,
  // so Back to `/docs/#install` lands on the page and not on the anchor.
  // `FJS-447` fixed the boot half and left this one. `|| ''` because a test
  // double is a plain object and a missing `hash` concatenates the string
  // "undefined" onto every URL.
  const hash = window.location.hash || ''
  const url = window.location.pathname + window.location.search + hash
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

  // Find the closest link — HTML or SVG. `linkHrefOf` owns the difference; an
  // SVG anchor's tagName is lowercase and its `.href` is not a string.
  const a = event.composedPath().find(el => linkHrefOf(el) !== null)
  if (!a) return

  const href = linkHrefOf(a)
  if (!href) return

  // Skip non-navigation attributes
  if (a.hasAttribute('target')) return
  if (a.hasAttribute('download')) return

  // Parse the href against the CURRENT URL, not the origin. `location.origin`
  // is scheme and host with no path, so every relative and every fragment href
  // resolved to the site root — `<a href="#comments">` clicked on /blog/my-post/
  // navigated to `/`, and so did `./`, `../other/`, `?draft=1` and `edit/`.
  // prefetch.js is handed `a.href`, which the DOM has already resolved, and is
  // right about the same concept for that reason.
  let url
  try {
    url = new URL(href, window.location.href)
  } catch {
    return
  }

  // Only intercept same-origin links
  if (url.origin !== window.location.origin) return

  // Skip mailto/tel etc
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  const trailingSlash = _options.trailingSlash ?? 'always'
  const normalized = normalizePath(url.pathname, trailingSlash)

  // A fragment on the page the reader is already on is not a navigation. Run
  // through _navigate it re-imports the route, re-runs load() and remounts
  // nothing — an in-page table of contents re-fetching the page it is a table
  // of contents for.
  if (
    url.hash &&
    normalized === normalizePath(window.location.pathname, trailingSlash) &&
    url.search === window.location.search
  ) {
    event.preventDefault()
    _previousHistoryIndex = _currentHistoryIndex
    _currentHistoryIndex++
    window.history.pushState(
      { index: _currentHistoryIndex }, '', normalized + url.search + url.hash,
    )
    const target = document.getElementById(url.hash.slice(1))
    if (target) target.scrollIntoView()
    return
  }

  // Match BEFORE cancelling the browser's own navigation. preventDefault used to
  // run above the match, so a click on any same-origin URL the route table does
  // not cover — a file the app serves at /downloads/report.csv, a link into a
  // sibling surface — was eaten: the catch-all rendered, or in an app without
  // one nothing happened at all and the console said `No route found`.
  //
  // The catch-all does not count as cover here. It is the answer for a URL
  // somebody TYPED or a goto the app made, not for a link the app itself wrote
  // to a URL it does not route — and an app that serves its own index.html for
  // unknown paths still lands on the catch-all, one full page load later.
  if (!_tree) return
  const match = matchRoute(normalized, _tree, _options)
  if (!match || match.node.meta?.spread) return

  event.preventDefault()

  _navigate(normalized + url.search + url.hash, { scroll: true })
}
