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
    const doInit = () => {
      _provider.init?.(config)
      // Wire pageview to afterNavigate
      afterNavigate(({ to }) => {
        _provider.pageview?.({
          url: window.location.href,
          path: to.path,
          meta: to.node?.meta ?? {},
        })
      })
    }

    if (config.trackLocalhost === false && window.location.hostname === 'localhost') {
      return  // Skip on localhost
    }

    // Lazy load — after idle or first interaction
    if ('requestIdleCallback' in window) {
      requestIdleCallback(doInit, { timeout: 3000 })
    } else {
      const events = ['scroll', 'mousemove', 'keydown', 'touchstart']
      const handler = () => {
        doInit()
        events.forEach(e => window.removeEventListener(e, handler))
      }
      events.forEach(e => window.addEventListener(e, handler, { once: true, passive: true }))
      setTimeout(doInit, 5000)  // hard fallback
    }
  }
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
