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
 * for external URLs or URLs that don't match any route.
 *
 * ⚠️  Auth limitation: prefetch uses window.fetch directly, not sierraFetch.
 * The auth token is NOT attached during prefetch load() calls. load() functions
 * that hit protected endpoints will silently fail or receive 401 responses during
 * prefetch. Navigation itself still works correctly because the router uses
 * sierraFetch. See the fetch call in runPrefetch() for workaround options.
 */

import { matchRoute, normalizePath } from './match.js'

// Set of route IDs already prefetched this session
const _prefetched = new Set()

// Cache of prefetched load() results — keyed by routeId:pathname+search
// The router checks this cache before running load() on navigation.
export const _prefetchCache = new Map()

// Shared references set by initPrefetch
let _tree = null
let _components = {}
let _loaders = {}
let _options = {}

/**
 * Boot the prefetch system.
 * Called by initRouter — shares the same tree/components/loaders.
 *
 * @param {object} tree
 * @param {object} components
 * @param {object} loaders
 * @param {object} options
 */
export function initPrefetch(tree, components, loaders, options) {
  _tree = tree
  _components = components
  _loaders = loaders
  _options = options

  // Observe DOM for prefetch attributes (handles SPA-rendered links too)
  if (typeof window === 'undefined') return

  // MutationObserver watches for newly added prefetch links
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue  // elements only
        processPrefetchNode(node)
        // Also check descendants
        if (node.querySelectorAll) {
          node.querySelectorAll('a[prefetch]').forEach(processPrefetchNode)
        }
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })

  // Process any prefetch links already in the DOM
  document.querySelectorAll('a[prefetch]').forEach(processPrefetchNode)
}

/**
 * Wire up prefetch behaviour for a single <a> element.
 */
function processPrefetchNode(el) {
  if (el.tagName !== 'A') return
  if (el.dataset.prefetchWired) return  // already wired

  const mode = el.getAttribute('prefetch') || 'immediate'

  el.dataset.prefetchWired = '1'

  if (mode === 'hover') {
    el.addEventListener('mouseenter', () => prefetchHref(el.href), { once: true, passive: true })
    el.addEventListener('touchstart',  () => prefetchHref(el.href), { once: true, passive: true })
  } else if (mode === 'mousedown') {
    el.addEventListener('mousedown', () => prefetchHref(el.href), { once: true, passive: true })
    el.addEventListener('touchstart', () => prefetchHref(el.href), { once: true, passive: true })
  } else if (mode === 'visible') {
    observeVisible(el)
  } else {
    // 'immediate' or bare `prefetch` attribute — fire ASAP
    // Use requestIdleCallback so it doesn't block the main thread
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => prefetchHref(el.href), { timeout: 2000 })
    } else {
      setTimeout(() => prefetchHref(el.href), 100)
    }
  }
}

// Shared IntersectionObserver for visible-mode links
let _visibleObserver = null

function observeVisible(el) {
  if (!_visibleObserver) {
    _visibleObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          prefetchHref(entry.target.href)
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
    url = new URL(href, window.location.origin)
  } catch {
    return
  }

  // Only same-origin
  if (url.origin !== window.location.origin) return

  const pathname = normalizePath(url.pathname, _options.trailingSlash ?? 'always')
  const match = matchRoute(pathname, _tree, _options)
  if (!match) return

  const { node } = match

  // Skip if already prefetched or currently active
  if (_prefetched.has(node.id)) return
  _prefetched.add(node.id)

  // 1. Preload the component chunk
  const componentFactory = _components[node.id]
  if (componentFactory && !node._componentLoaded) {
    try {
      await componentFactory()
    } catch {
      // Prefetch failures are silent
    }
  }

  // 2. Preload the data (run load() silently)
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
          // ⚠️  Prefetch uses window.fetch directly, not sierraFetch.
          // This means the auth token is NOT attached during prefetch.
          // load() functions that call protected API endpoints will silently
          // fail (or return 401 data) during prefetch — navigation still works
          // correctly because the router uses sierraFetch.
          //
          // If your load() hits a protected endpoint and you need prefetch to
          // work, pattern options:
          //   1. Make the endpoint public and filter results post-auth
          //   2. Skip prefetch on that route (omit the prefetch attribute)
          //   3. Guard inside load() — return empty/null when fetch returns 401
          //
          // V2: prefetch will use sierraFetch once the auth token is accessible
          // at module init time without a circular dependency on initJunction.
          fetch: window.fetch?.bind(window) ?? (() => Promise.resolve(new Response('{}'))),
        })
        // Cache the result so the router can use it on navigation
        // instead of re-running load() and making a second round-trip.
        const cacheKey = `${node.id}:${pathname}${url.search}`
        _prefetchCache.set(cacheKey, result)
      }
    } catch {
      // Prefetch failures are silent
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
