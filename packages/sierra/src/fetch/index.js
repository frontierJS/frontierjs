/**
 * sierra/fetch — fetch wrapper for load() functions
 *
 * Provides a fetch instance that automatically attaches the Junction
 * auth token when Junction is configured, and falls back to native
 * fetch when it isn't.
 *
 * load() always receives this as its `fetch` argument — the page
 * never needs to know whether Junction is wired.
 *
 * Usage (internal — called by initJunction and the router):
 *   import { sierraFetch, configureFetch } from 'sierra/fetch'
 *
 * Usage (in .meta.js):
 *   export async function load({ params, url, fetch }) {
 *     const data = await fetch(`/leads/${params.leadId}`)
 *     return data.json()
 *   }
 */

// The active fetch implementation — starts as native fetch
let _fetch = typeof globalThis.fetch !== 'undefined' ? globalThis.fetch.bind(globalThis) : null

// Config — set by configureFetch
let _config = null

/**
 * Configure the fetch wrapper.
 * Called by initJunction when Junction is present, or at boot when it isn't.
 *
 * @param {object} options
 * @param {object} [options.client]    — the Junction client. It owns the token
 *        and it knows whether the app is in cookie mode; both questions are
 *        asked of it rather than of storage.
 * @param {string} [options.tokenKey]  — localStorage key for the auth token.
 *        Only for a caller that has no client: with one, storage is a SECOND
 *        owner of the token and the two halves of "signed in" can disagree.
 * @param {string} [options.baseUrl]   — optional base URL prefix for relative paths
 */
export function configureFetch(options = {}) {
  _config = options

  _fetch = async (input, init = {}) => {
    const url = resolveUrl(input, options.baseUrl)

    const headers = new Headers(init.headers ?? {})
    const mine = isOwnAudience(url, options)

    // A credential has ONE audience, and it is not "whoever this request is
    // addressed to". `load()` is handed this fetch and the docs tell a page to
    // use it, so a page geocoding a postcode or reading a CDN's JSON was handing
    // that vendor a replayable session (FJS-788). Relative URLs cannot leave
    // this origin; an absolute one is checked against the app's own origin, the
    // API's, and the configured baseUrl's.
    if (mine && !headers.has('Authorization')) {
      const token = options.client
        ? options.client.token
        : (options.tokenKey && typeof localStorage !== 'undefined'
            ? localStorage.getItem(options.tokenKey)
            : null)

      if (token) headers.set('Authorization', `Bearer ${token}`)
    }

    // Cookie mode carries no token, so without this every load() is anonymous
    // the moment the API is a separate origin — which is the deployed
    // arrangement, and for a list is a 200 with an empty array rather than a
    // refusal anybody notices. Scoped to our own audience for the same reason
    // the header is.
    const credentials = mine && options.client?.hasCredential && !options.client?.token
      ? 'include'
      : init.credentials

    return globalThis.fetch(url, {
      ...init,
      headers,
      ...(credentials ? { credentials } : {}),
    })
  }
}

/**
 * Is this request addressed to the app itself?
 *
 * A relative URL is, by construction — it resolves against the document and
 * cannot name another host. An absolute one is only if it names an origin the
 * credential is for: the page's own, the API the client talks to, or the
 * configured baseUrl's. Anything unresolvable answers false, because the cost
 * of guessing wrong is a session handed to a stranger.
 */
function isOwnAudience(url, options) {
  const href = typeof url === 'string' ? url : (url?.url ?? url?.href ?? null)
  if (typeof href !== 'string') return false
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(href) && !href.startsWith('//')) return true

  const here = globalThis.location?.href
  let target
  try {
    target = new URL(href, here)
  } catch {
    return false
  }

  const allowed = new Set()
  const add = (v) => {
    if (!v) return
    try { allowed.add(new URL(v, here).origin) } catch { /* not an origin */ }
  }
  add(globalThis.location?.origin)
  add(options.baseUrl)
  add(options.client?.origin)

  return allowed.has(target.origin)
}

/**
 * The Sierra fetch function — use this in load() functions.
 * Auto-attaches auth token when Junction is configured.
 *
 * @type {typeof fetch}
 */
export async function sierraFetch(input, init = {}) {
  if (!_fetch) {
    throw new Error('[Sierra] fetch is not available in this environment')
  }
  return _fetch(input, init)
}

/**
 * Resolve a URL, optionally prepending a base URL.
 */
function resolveUrl(input, baseUrl) {
  if (!baseUrl) return input
  if (typeof input !== 'string') return input

  // Don't prefix absolute URLs
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('//')) {
    return input
  }

  return baseUrl.replace(/\/$/, '') + '/' + input.replace(/^\//, '')
}
