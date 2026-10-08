/**
 * sierra/analytics — analytics integration
 *
 * Initialized by virtual:sierra at boot. A static page never loads that, so
 * the build writes the vendor tag into its <head> (`postbuild/inject-analytics.js`)
 * and the island entry calls `configureAnalytics` so `track()` reaches it.
 * App code uses track() to fire events.
 *
 * Providers:
 *   'plausible' — Plausible Analytics
 *   'gtm'       — Google Tag Manager
 *   object      — custom provider { init, pageview, track }
 */

import { vendorTag } from './tag.js'

let _provider = null

/**
 * Resolve the provider `track()` calls, and load nothing. For a page whose
 * vendor tag is already in the HTML.
 * @param {object} config — analytics config from sierra.config.js
 * @returns {boolean} whether a provider was resolved
 */
export function configureAnalytics(config) {
  if (!config?.provider) return false

  if (typeof config.provider === 'object') {
    _provider = config.provider
    return true
  }
  let tag
  try { tag = vendorTag(config) } catch (err) {
    console.warn(err.message)
    return false
  }
  if (!tag) {
    console.warn(`[Sierra] Unknown analytics provider: ${config.provider}`)
    return false
  }
  _provider = config.provider === 'plausible' ? buildPlausibleProvider(tag) : buildGtmProvider(tag)
  return true
}

/**
 * Boot analytics. Called by virtual:sierra.
 * @param {object} config — analytics config from sierra.config.js
 */
export function initAnalytics(config) {
  if (!configureAnalytics(config)) return

  // Defer init until after first user interaction or idle
  if (typeof window !== 'undefined') {
    // Two paths race to start this — an interaction and a hard timer — and
    // whichever loses used to run anyway: the handler removed its listeners and
    // left the timer standing, so a person who scrolled inside five seconds got
    // two vendor script tags and two afterNavigate handlers, and every
    // navigation after that reported two pageviews. Inflated traffic in a
    // dashboard, which nobody debugs as a framework bug (FJS-813). The guard is
    // here rather than at each call site because the number of racing paths is
    // the thing that changes.
    let started = false
    const doInit = () => {
      if (started) return
      started = true
      _provider.init?.(config)
      // Imported here and not at the top: the island entry reaches this module
      // for `track()`, and a static import would put the router in every
      // island page. On an SPA the router is already loaded, so this resolves
      // to the same instance.
      import('../router/index.js').then(({ afterNavigate }) => afterNavigate(({ to }) => {
        _provider.pageview?.({
          // The ADDRESS, not the address bar. `location.href` carries the search
          // string, and a password-reset or verification link is
          // `/reset?token=…&email=…` — handed whole to whatever a custom
          // provider does with it. The built-in providers only ever used `path`;
          // a custom one is the third documented kind and receives this contract
          // too.
          //
          // `pathname` is what makes that distinction TRUE. It was `to.path`,
          // which the router built as pathname + search, so the token this
          // comment warns about rode along under both keys (`FJS-1083`).
          url: pageUrl(),
          path: to.pathname,
          meta: to.node?.meta ?? {},
        })
      }))
    }

    if (config.trackLocalhost === false && isLocalHost(window.location.hostname)) {
      return  // Skip in development
    }

    // Lazy load — after idle or first interaction
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(doInit, { timeout: 3000 })
    } else {
      const events = ['scroll', 'mousemove', 'keydown', 'touchstart']
      const fallback = setTimeout(doInit, 5000)  // hard fallback
      const handler = () => {
        clearTimeout(fallback)
        doInit()
        events.forEach(e => window.removeEventListener(e, handler))
      }
      events.forEach(e => window.addEventListener(e, handler, { once: true, passive: true }))
    }
  }
}

/** The page's address with the query string and fragment removed. */
function pageUrl() {
  const loc = window.location
  return `${loc.origin ?? ''}${loc.pathname ?? ''}`
}

/**
 * Is this hostname this machine?
 *
 * `=== 'localhost'` was the whole test, so `trackLocalhost: false` sent every
 * page of a dev session to the vendor from `127.0.0.1` and from
 * `example.localhost` — which is how `fli proxy` names every dev surface in this
 * workspace. A LAN address is deliberately NOT here: the option is named for
 * localhost and a suppression that quietly covers 10.x is a different option.
 */
function isLocalHost(hostname) {
  if (!hostname) return false
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') ||
         h === '127.0.0.1' || h === '::1'
}

/**
 * Track a custom event.
 * @param {string} event
 * @param {Record<string, unknown>} [props={}]
 */
export function track(event, props = {}) {
  _provider?.track?.(event, props)
}

// ─── Built-in providers ───────────────────────────────────────────────────────

function buildPlausibleProvider(tag) {
  return {
    init() { mountTag(tag) },
    pageview({ path, meta }) {
      window.plausible?.('pageview', {
        u: path,
        props: meta,
      })
    },
    track(event, props) {
      window.plausible?.(event, { props })
    },
  }
}

function buildGtmProvider(tag) {
  return {
    init() { mountTag(tag) },
    pageview({ path }) {
      window.dataLayer?.push({ event: 'pageview', page: path })
    },
    track(event, props) {
      window.dataLayer?.push({ event, ...props })
    },
  }
}

function mountTag(tag) {
  tag.before?.()
  const script = document.createElement('script')
  for (const [k, v] of Object.entries(tag.attrs)) {
    if (v === true) script[k] = true
    else script.setAttribute(k, v)
  }
  script.src = tag.src
  document.head.appendChild(script)
}
