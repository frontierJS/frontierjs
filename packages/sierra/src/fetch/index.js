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
 *     const data = await fetch(`/api/leads/${params.leadId}`)
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
 * @param {string} [options.tokenKey]  — localStorage key for the auth token
 * @param {string} [options.baseUrl]   — optional base URL prefix for relative paths
 */
export function configureFetch(options = {}) {
  _config = options

  _fetch = async (input, init = {}) => {
    const url = resolveUrl(input, options.baseUrl)

    // Auto-attach Junction auth token if configured
    const headers = new Headers(init.headers ?? {})

    if (options.tokenKey) {
      const token = typeof localStorage !== 'undefined'
        ? localStorage.getItem(options.tokenKey)
        : null

      if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
      }
    }

    return globalThis.fetch(url, { ...init, headers })
  }
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
