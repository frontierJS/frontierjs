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
 * The tag a named provider loads, or null for a custom provider object.
 *
 * @param {object} config — `analytics` from sierra.config.js
 * @returns {{ src: string, attrs: Record<string, string|true>, before?: () => void } | null}
 */
export function vendorTag(config) {
  if (config?.provider === 'plausible') {
    if (!config.domain) throw refusal(`[Sierra] analytics: provider 'plausible' needs a domain`)
    return {
      src:   `${config.apiHost ?? 'https://plausible.io'}/js/script.js`,
      attrs: { defer: true, 'data-domain': config.domain },
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

// GTM's own snippet pushes this before loading. Without it the container never
// sees a `gtm.js` event, so every Page View trigger stays silent. Called by the
// runtime and serialized by `vendorTagHtml`, so it reads globals only.
function gtmStart() {
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' })
}

/**
 * The same tag as HTML, for a page written to disk.
 *
 * A custom provider is an object with functions in it, and a prerendered page
 * has nothing to run them. Refused by name, since the alternative is a site
 * that builds clean and reports nothing.
 *
 * @param {object} config
 * @returns {string}
 */
export function vendorTagHtml(config) {
  const tag = vendorTag(config)
  if (!tag) {
    const got = typeof config?.provider === 'object' ? 'a custom provider object' : JSON.stringify(config?.provider)
    throw refusal(
      `[Sierra] analytics: a static page can carry 'plausible' or 'gtm', not ${got} — ` +
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
