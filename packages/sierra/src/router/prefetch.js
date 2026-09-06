/**
 * router/prefetch.js — prefetch attribute handling
 *
 * Three trigger modes:
 *   prefetch          — immediate (on parse / DOM ready)
 *   prefetch="hover"  — on mouseenter / touchstart
 *   prefetch="visible"— on IntersectionObserver entry
 *
 * Prefetch preloads both:
 *   1. The route's JS chunk (via dynamic import)
 *   2. The route's data (by running load() with a no-op fetch)
 *
 * Already-prefetched routes are skipped. Prefetch never fires
 * for external URLs, for URLs that don't match any route, or for a route the
 * router would never render at that URL — one carrying `meta.redirect` or
 * `meta.spread`. Guards are NOT run; see prefetchHref().
 *
 * A prefetched load() runs with the same `fetch` a navigated one does —
 * `sierraFetch`, which attaches the session token. It used to be handed
 * `window.fetch` instead, so the request went out signed-out, and the refusal
 * was CACHED and then served: hovering a link could make the page you navigated
 * to render as if you were signed out (`FJS-041`). What the payload means
 * depends on who asked for it, so the cache is dropped whenever the identity
 * changes — see invalidatePrefetch(), called from sierra/junction whenever the
 * client's token changes and on mid-session expiry.
 */

import { matchRoute, normalizePath } from './match.js'
import { loadLayoutChain, linkHrefOf } from './internals.js'
import { sierraFetch } from '../fetch/index.js'

// URLs already prefetched this session.
//
// Keyed by the full cache key (route id + pathname + search), NOT by route id.
// Keying by id meant a dynamic route like /blog/:slug/ prefetched exactly once
// per session — the first slug hovered blocked every other one — while the
// cache it populated was keyed per-URL. The gate and the thing it gated
// disagreed.
const _prefetched = new Set()

// Route ids whose component chunk has already been imported. Separate from
// _prefetched because the two have different natural keys: every /blog/:slug/
// shares one JS chunk, but each slug has its own load() payload. The old
// route-id gate conflated them — it deduped the chunk correctly by accident
// while wrongly blocking data prefetch for every slug after the first.
//
// dynamic import() is itself idempotent, so this saves a redundant call rather
// than a network round-trip; the point is that the two concerns stay separable.
const _prefetchedChunks = new Set()

// Cache of prefetched load() results, keyed by `${routeId}:${pathname}${search}`.
// The router checks this before running load() on navigation.
//
// Bounded and time-limited. Entries were previously removed only when consumed
// by a navigation, so anything prefetched but never visited held its full
// load() payload for the lifetime of the session — and a route prefetched at
// t=0 would serve ten-minute-old data if visited at t=10min.
export const _prefetchCache = new Map()

/** Max cached payloads. Oldest is evicted first (insertion order). */
const PREFETCH_CACHE_MAX = 32

/** How long a prefetched payload stays usable, in ms. */
const PREFETCH_CACHE_TTL = 30_000

function _cacheSet(key, value) {
  // Re-inserting moves the key to the end of Map iteration order, so eviction
  // below stays true FIFO on last-write.
  _prefetchCache.delete(key)
  while (_prefetchCache.size >= PREFETCH_CACHE_MAX) {
    const oldest = _prefetchCache.keys().next().value
    if (oldest === undefined) break
    _prefetchCache.delete(oldest)
  }
  _prefetchCache.set(key, { value, at: Date.now() })
}

/**
 * Read a prefetched payload and consume it. Returns `undefined` for a miss or
 * an expired entry — callers must distinguish that from a cached `undefined`
 * using _prefetchCacheHas() first, or just treat undefined as a miss.
 *
 * Exported for the router's navigation path.
 */
export function _prefetchCacheTake(key) {
  const entry = _prefetchCache.get(key)
  if (!entry) return undefined
  _prefetchCache.delete(key)
  if (Date.now() - entry.at > PREFETCH_CACHE_TTL) {
    _prefetched.delete(key)   // allow a fresh prefetch of this URL later
    return undefined
  }
  return entry.value
}

/** Is there a live (unexpired) cached payload for this key? */
export function _prefetchCacheHas(key) {
  const entry = _prefetchCache.get(key)
  if (!entry) return false
  if (Date.now() - entry.at > PREFETCH_CACHE_TTL) {
    _prefetchCache.delete(key)
    _prefetched.delete(key)
    return false
  }
  return true
}

/**
 * Drop every prefetched PAYLOAD and the gate that stops a URL being fetched
 * again. Call it whenever the identity behind the requests changes — a sign-in,
 * a sign-out, a session that expired mid-page. A payload is an answer to *what
 * may this person see*, so serving one across that line is how a signed-in user
 * lands on a page rendered signed-out, and the other way round.
 *
 * The component chunks are kept: a route's JavaScript is the same file whoever
 * asks for it, and re-importing it would throw away the half of prefetch that
 * is never wrong.
 */
export function invalidatePrefetch() {
  _prefetchCache.clear()
  _prefetched.clear()
}

/** Test seam — drop all prefetch state. */
export function _resetPrefetch() {
  _prefetched.clear()
  _prefetchedChunks.clear()
  _prefetchCache.clear()
}

// The document whose delegated listeners this module already holds. Four
// listeners were added on every initPrefetch call, so three inits gave three of
// each (Invariant 11). Keyed on the document rather than a boolean for the same
// reason the router keys on the window: swapping globalThis is a test seam.
let _boundDocument = null

// Shared references set by initPrefetch
let _tree = null
let _components = {}
let _loaders = {}
let _options = {}
let _layouts = {}

/**
 * Boot the prefetch system.
 * Called by initRouter — shares the same tree/components/loaders.
 *
 * @param {object} tree
 * @param {object} components
 * @param {object} loaders
 * @param {object} options
 */
export function initPrefetch(tree, components, loaders, options, layouts = {}) {
  _tree = tree
  _components = components
  _loaders = loaders
  _options = options
  _layouts = layouts

  if (typeof window === 'undefined') return

  // ── Event delegation ──────────────────────────────────────────────────────
  //
  // This used to be a MutationObserver on document.body with subtree: true,
  // which ran `node.querySelectorAll('a[prefetch]')` for every element inserted
  // anywhere in the app, then attached listeners and wrote a data attribute per
  // link. Rendering a 1 000-row list meant 1 000 subtree queries, 1 000 DOM
  // writes and up to 2 000 addEventListener calls.
  //
  // Hover and mousedown modes need no per-element setup at all — three
  // delegated listeners on the document cover every link that will ever exist,
  // including ones added later. Only `visible` mode still needs per-element
  // registration, because IntersectionObserver has to observe specific nodes.

  const modeOf = (a) => a.getAttribute('prefetch') || 'immediate'

  const onIntent = (e) => {
    const a = e.target?.closest?.('a[prefetch]')
    if (!a) return
    // Not `a.href`: the selector `a[prefetch]` matches an SVG anchor too, and
    // its `.href` is a truthy SVGAnimatedString rather than a string — so the
    // old guard passed and `[object SVGAnimatedString]` went out as a URL.
    const href = absoluteHrefOf(a)
    if (!href) return
    const mode = modeOf(a)
    if (mode === 'hover' || mode === 'mousedown' || mode === 'immediate') {
      prefetchHref(href)
    }
  }

  // capture: true so we still see the event when something downstream stops
  // propagation. passive: true because we never preventDefault here.
  if (_boundDocument !== document) {
    _boundDocument = document
    document.addEventListener('mouseover',  onIntent, { capture: true, passive: true })
    document.addEventListener('focusin',    onIntent, { capture: true, passive: true })
    document.addEventListener('touchstart', onIntent, { capture: true, passive: true })
    document.addEventListener('mousedown',  onIntent, { capture: true, passive: true })
  }

  // ── visible + immediate ───────────────────────────────────────────────────
  // Both need to find links without user intent. Sweep once now, and again
  // after each navigation commits, rather than watching every DOM mutation.
  scanPrefetchLinks()
}

/**
 * Find links needing eager treatment — `visible` (IntersectionObserver) and
 * `immediate` (idle-time fetch). Safe to call repeatedly; each element is
 * wired at most once.
 *
 * Called on boot and after each navigation. Exported so the router can drive it.
 */
/*
 * Where does this link point, absolutely?
 *
 * `a[prefetch]` matches an SVG anchor as readily as an HTML one, and an SVG
 * anchor's `.href` is a truthy `SVGAnimatedString` — so every reader below used
 * to pass its guard and hand `[object SVGAnimatedString]` to the fetcher. There
 * are three of them (delegated intent, the idle queue, the intersection
 * observer) and fixing the one the bug was reported at would have left two.
 */
function absoluteHrefOf(el) {
  const href = linkHrefOf(el)
  if (!href) return null
  try {
    return new URL(href, window.location.href).href
  } catch {
    return null
  }
}

export function scanPrefetchLinks() {
  if (typeof document === 'undefined') return
  for (const el of document.querySelectorAll('a[prefetch]')) {
    const mode = el.getAttribute('prefetch') || 'immediate'
    if (mode === 'hover' || mode === 'mousedown') continue   // handled by delegation
    if (el.dataset.prefetchWired) continue
    el.dataset.prefetchWired = '1'

    if (mode === 'visible') {
      observeVisible(el)
    } else {
      // 'immediate' or a bare `prefetch` attribute. Queue through a shared
      // worklist so a page with 100 such links doesn't fire 100 idle callbacks
      // that all time out together and stampede the network.
      _immediateQueue.push(el)
      _drainImmediate()
    }
  }
}

// ── immediate-mode worklist ─────────────────────────────────────────────────
const _immediateQueue = []
const IMMEDIATE_CONCURRENCY = 3
let _immediateActive = 0

function _drainImmediate() {
  while (_immediateActive < IMMEDIATE_CONCURRENCY && _immediateQueue.length) {
    const el = _immediateQueue.shift()
    _immediateActive++
    const run = () => {
      Promise.resolve(prefetchHref(absoluteHrefOf(el)))
        .catch(() => {})
        .finally(() => { _immediateActive--; _drainImmediate() })
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 })
    else setTimeout(run, 100)
  }
}

// processPrefetchNode() was removed. It attached per-element listeners and set
// a data-prefetch-wired attribute on every matching link; hover and mousedown
// are now handled by the delegated listeners in initPrefetch(), and the eager
// modes by scanPrefetchLinks().

// Shared IntersectionObserver for visible-mode links
let _visibleObserver = null

function observeVisible(el) {
  if (!_visibleObserver) {
    _visibleObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          prefetchHref(absoluteHrefOf(entry.target))
          _visibleObserver.unobserve(entry.target)
        }
      }
    }, { rootMargin: '200px' })  // 200px lookahead
  }
  _visibleObserver.observe(el)
}

/**
 * Prefetch a URL — load the route chunk and run load() in the background.
 *
 * @param {string} href — absolute URL
 */
export async function prefetchHref(href) {
  if (!href || !_tree) return

  let url
  try {
    // Resolved against the current URL for the same reason _handleClick is:
    // `location.origin` carries no path. Callers hand this `a.href`, already
    // absolute, so nothing here depended on the difference — the two readers of
    // one concept now say it the same way.
    url = new URL(href, window.location.href)
  } catch {
    return
  }

  // Only same-origin
  if (url.origin !== window.location.origin) return

  const pathname = normalizePath(url.pathname, _options.trailingSlash ?? 'always')
  const match = matchRoute(pathname, _tree, _options)
  if (!match) return

  const { node } = match

  // Two kinds of route the router will never render at this URL, so warming
  // them is a round trip spent on a page nobody lands on.
  //
  //   • `meta.redirect` — _navigate replaces the URL before it renders anything,
  //     so the payload cached here is keyed to a URL that is never committed.
  //   • `meta.spread`   — _handleClick declines to intercept it at all, so the
  //     click that follows the hover is a full page load.
  //
  // A GUARD is deliberately not consulted, and this is the boundary rather than
  // an oversight: `_beforeGuards` are app functions that may await, may redirect
  // and may have side effects, so running them on hover is worse than the fetch
  // it would save. A guard does not gate a prefetch — an app that must not issue
  // the request at all puts the check inside `load()`, which is the one function
  // both paths run. What protects the DATA is the server, which grades the
  // request either way; a refusal makes load() throw and is never cached.
  if (node.meta?.redirect || node.meta?.spread) return

  const cacheKey = `${node.id}:${pathname}${url.search}`

  // Skip if this URL was already prefetched. Keyed per-URL so every slug of a
  // dynamic route gets its own chance — see the note on _prefetched above.
  if (_prefetched.has(cacheKey)) return
  _prefetched.add(cacheKey)

  // 1. Preload the component chunk. Deduped on the route id, not the URL:
  // every /blog/:slug/ shares one chunk, so importing it once is correct.
  const componentFactory = _components[node.id]
  if (componentFactory && !node._componentLoaded && !_prefetchedChunks.has(node.id)) {
    _prefetchedChunks.add(node.id)
    try {
      await componentFactory()
    } catch {
      // Silent, but release the gate so a later attempt can retry.
      _prefetchedChunks.delete(node.id)
    }
  }

  // 2. Warm the layout chain. Layouts are loaded per-route now, so a prefetch
  // that skipped them would leave the navigation blocking on a layout chunk —
  // exactly the latency prefetch exists to remove.
  await loadLayoutChain(node, _layouts).catch(() => {})

  // 3. Preload the data (run load() silently)
  const loaderFactory = _loaders[node.id]
  if (loaderFactory) {
    try {
      const loaderMod = await loaderFactory()
      const loadFn = loaderMod?.load ?? loaderMod?.default?.load

      if (typeof loadFn === 'function') {
        const params = {
          ...match.params,
        }
        const result = await loadFn({
          params,
          url: pathname + url.search,
          meta: node.meta ?? {},
          // The same fetch the router passes a navigated load(), so a prefetch
          // asks as the person who is signed in. It reads the token per call
          // rather than at module init, which is why importing it here costs no
          // dependency on initJunction.
          fetch: sierraFetch,
        })
        // Cache the result so the router can use it on navigation instead of
        // re-running load() and making a second round-trip.
        _cacheSet(cacheKey, result)
      }
    } catch {
      // Prefetch failures are silent — but release the gate so a later hover or
      // an explicit prefetch() call can retry rather than being blocked by a
      // one-off network error.
      _prefetched.delete(cacheKey)
    }
  }
}

/**
 * Manually prefetch a path programmatically.
 * Useful for prefetching on intent before navigation.
 *
 * @param {string} path — e.g. '/leads/123/'
 */
export function prefetch(path) {
  const url = new URL(path, window.location.origin)
  return prefetchHref(url.href)
}
