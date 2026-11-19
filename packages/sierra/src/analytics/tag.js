/**
 * analytics/tag.js — the vendor's own tag, as data.
 *
 * Two readers put it on a page: the runtime provider's `init` (an SPA, after
 * idle) and the static build, which writes it into every prerendered page's
 * <head> because a static page never loads `virtual:sierra` (`FJS-2058`). One
 * description, so the two cannot disagree about what Plausible or GTM is.
 *
 * Node-safe: no DOM, no router. The build imports this file and nothing else
 * from analytics/.
 */

import { refusal } from '../build/refusal.js'

/**
 * The tag a named provider loads, or null for a custom provider.
 *
 * @param {object} config — `analytics` from sierra.config.js
 * @returns {{ src: string, attrs: Record<string, string|true>, before?: () => void } | null}
 */
export function vendorTag(config) {
  const proxied = proxiedPaths(config)
  if (config?.provider === 'plausible') {
    if (!config.domain) throw refusal(`[Sierra] analytics: provider 'plausible' needs a domain`)
    return {
      src:    proxied ? PLAUSIBLE_SCRIPT : plausibleUpstream(config).script,
      attrs:  { defer: true, 'data-domain': config.domain, ...(proxied && { 'data-api': PLAUSIBLE_EVENT }) },
      before: plausibleStart,
    }
  }
  if (config?.provider === 'gtm') {
    if (!config.containerId) throw refusal(`[Sierra] analytics: provider 'gtm' needs a containerId`)
    return {
      src:    `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(config.containerId)}`,
      attrs:  { async: true },
      before: gtmStart,
    }
  }
  return null
}

// ─── the same-origin proxy (FJS-D1037) ───────────────────────────────────────

// The two paths Plausible's own proxy guide uses. Fixed, so the tag and the
// function entry cannot name different ones.
const PLAUSIBLE_SCRIPT = '/js/script.js'
const PLAUSIBLE_EVENT  = '/api/event'

// The manual build, not `script.js`: the auto-capturing one reads
// `location.href` itself, query string included, so a token in a link that is
// not Sierra's scaffold reached the vendor whatever Sierra sent (`FJS-3317`).
// The proxy serves this same build at `/js/script.js`.
function plausibleUpstream(config) {
  const host = config.apiHost ?? 'https://plausible.io'
  return { script: `${host}/js/script.manual.js`, event: `${host}/api/event` }
}

/**
 * The paths `analytics.proxy` answers on the site's own origin, each mapped to
 * the upstream URL it forwards to; null with the proxy off.
 *
 * Refused on any provider but Plausible: GTM and a custom module have no
 * proxy, and a key that did nothing would leave the tag cross-origin unnoticed.
 *
 * @param {object} [config]  `analytics` from sierra.config.js
 * @returns {Record<string, string> | null}
 */
export function proxiedPaths(config) {
  if (!config?.proxy) return null
  if (config.provider !== 'plausible') {
    throw refusal(`[Sierra] analytics: proxy is Plausible's same-origin proxy, and provider is ${JSON.stringify(config.provider)} — drop proxy, or use provider 'plausible'`)
  }
  const up = plausibleUpstream(config)
  return { [PLAUSIBLE_SCRIPT]: up.script, [PLAUSIBLE_EVENT]: up.event }
}

// The manual script sends nothing by itself, so the first pageview is queued
// here, before the script loads, with the address minus its search and
// fragment. Called by the runtime and serialized by `vendorTagHtml`, so it
// reads globals only and carries its own address expression.
function plausibleStart() {
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments)
  }
  window.plausible('pageview', { u: window.location.origin + window.location.pathname })
}

// GTM's own snippet pushes this before loading. Without it the container never
// sees a `gtm.js` event, so every Page View trigger stays silent. `page_location`
// is the address without its search: a container whose tags read it, rather
// than the built-in Page URL variable, never sees a token (`FJS-3317`). Called
// by the runtime and serialized by `vendorTagHtml`, so it reads globals only.
function gtmStart() {
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push({
    'gtm.start': Date.now(),
    event: 'gtm.js',
    page_location: window.location.origin + window.location.pathname,
  })
}

/**
 * The same tag as HTML, for a page written to disk.
 *
 * A custom provider is a module of functions, and a prerendered page has
 * nothing to run them. Refused by name, since the alternative is a site
 * that builds clean and reports nothing.
 *
 * @param {object} config
 * @returns {string}
 */
export function vendorTagHtml(config) {
  const tag = vendorTag(config)
  if (!tag) {
    throw refusal(
      `[Sierra] analytics: a static page can carry 'plausible' or 'gtm', not ${JSON.stringify(config?.provider)} — ` +
      `a prerendered page has nothing to run a provider's functions`)
  }
  const attrs = Object.entries(tag.attrs)
    .map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)
    .join('')
  const inline = tag.before ? `<script>(${tag.before})()</script>` : ''
  return `${inline}<script id="sierra-analytics"${attrs} src="${escapeAttr(tag.src)}"></script>`
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
