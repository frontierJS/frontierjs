/**
 * sierra/analytics — analytics integration
 *
 * Initialized by virtual:sierra at boot.
 * App code uses track() to fire events.
 *
 * Providers:
 *   'plausible' — Plausible Analytics
 *   'gtm'       — Google Tag Manager
 *   object      — custom provider { init, pageview, track }
 */

import { afterNavigate } from '../router/index.js'

let _provider = null

/**
 * Boot analytics. Called by virtual:sierra.
 * @param {object} config — analytics config from sierra.config.js
 */
export function initAnalytics(config) {
  if (!config?.provider) return

  // Resolve provider
  if (typeof config.provider === 'object') {
    _provider = config.provider
  } else if (config.provider === 'plausible') {
    _provider = buildPlausibleProvider(config)
  } else if (config.provider === 'gtm') {
    _provider = buildGtmProvider(config)
  } else {
    console.warn(`[Sierra] Unknown analytics provider: ${config.provider}`)
    return
  }

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
      // Wire pageview to afterNavigate
      afterNavigate(({ to }) => {
        _provider.pageview?.({
          // The ADDRESS, not the address bar. `location.href` carries the search
          // string, and a password-reset or verification link is
          // `/reset?token=…&email=…` — handed whole to whatever a custom
          // provider does with it. The built-in providers only ever used `path`;
          // a custom one is the third documented kind and receives this contract
          // too.
          url: pageUrl(),
          path: to.path,
          meta: to.node?.meta ?? {},
        })
      })
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

function buildPlausibleProvider(config) {
  return {
    init(cfg) {
      const script = document.createElement('script')
      script.defer = true
      script.dataset.domain = cfg.domain
      script.src = `${cfg.apiHost ?? 'https://plausible.io'}/js/script.js`
      document.head.appendChild(script)
    },
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

function buildGtmProvider(config) {
  return {
    init(cfg) {
      window.dataLayer = window.dataLayer || []
      const script = document.createElement('script')
      script.src = `https://www.googletagmanager.com/gtm.js?id=${cfg.containerId}`
      document.head.appendChild(script)
    },
    pageview({ path }) {
      window.dataLayer?.push({ event: 'pageview', page: path })
    },
    track(event, props) {
      window.dataLayer?.push({ event, ...props })
    },
  }
}
