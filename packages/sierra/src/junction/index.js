/**
 * sierra/junction — Junction WebSocket client integration
 *
 * Initialised by virtual:sierra at boot.
 * Exposes connected and reconnecting signals for use in components.
 *
 * import { connected, reconnecting, login, logout, useStore } from 'sierra/junction'
 */

import { signal } from '../router/signals.js'
import { beforeNavigate, goto } from '../router/index.js'
import { configureFetch } from '../fetch/index.js'
import { createSignal } from '@frontierjs/mesa/runtime'
import { createJunctionClient } from '@frontierjs/junction/client'

// Resource factory — re-exported from the resource module
export { createResource, createStore, createMakeFromSchema } from './resource.js'

// ─── Module-level refs (set by initJunction) ──────────────────────────────────

/** @type {object|null} */
let _client = null
let _tokenKey = 'junction_token'

// ─── Public signals ───────────────────────────────────────────────────────────

/** Mesa signal — true when Junction WebSocket is connected */
export const connected = signal(false)

/** Mesa signal — null when stable, { attempt, delay } when reconnecting */
export const reconnecting = signal(null)

// ─── Client accessor ──────────────────────────────────────────────────────────

/**
 * Return the active JunctionClient instance.
 * Only available after initJunction() has run (i.e. after the app boots).
 * Returns null if Junction is not configured.
 *
 * @returns {object|null}
 */
export function getClient() {
  return _client
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Save a token and authenticate the Junction client.
 * Call this after a successful login API response.
 *
 * @param {string} token
 */
export function login(token) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(_tokenKey, token)
  }
  _client?.setToken(token)
}

/**
 * Clear the stored token and deauthenticate the Junction client.
 * Redirect handling is left to the caller — call goto() after logout().
 *
 * Note: setToken(null) may trigger a server-side 'unauthorized' event,
 * which will fire the redirectTo guard again. If you call goto() after
 * logout(), that navigation takes priority and the double-redirect is harmless.
 */
export function logout() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(_tokenKey)
  }
  // Clear token and close the socket entirely — don't reopen as stranger.
  // The app is navigating away; an anonymous connection serves no purpose
  // and would incorrectly fire 'connect' after a deliberate sign-out.
  if (_client) {
    _client.token = null
    _client.disconnect()
  }
}

// ─── Store bridge ─────────────────────────────────────────────────────────────

/**
 * Wrap a Junction Store<T> as a Mesa-reactive signal.
 * Call this once per component instance (in the <script> block, not in
 * a reactive computation) so the subscription is created only once.
 *
 * Returns an unsubscribe function — pass it to $onDestroy() to avoid leaks:
 *
 *   const { get, unsubscribe } = useStore(leadsStore)
 *   $onDestroy(unsubscribe)
 *
 * @template T
 * @param {{ get(): T, subscribe(fn: (v: T) => void): () => void }} store
 * @returns {{ get: () => T, value: T, unsubscribe: () => void }}
 */
export function useStore(store) {
  const [read, write] = createSignal(store.get())
  const unsubscribe = store.subscribe(v => write(v))
  return {
    get: read,
    get value() { return read() },
    unsubscribe,
  }
}

// ─── Debug wrapper ────────────────────────────────────────────────────────────

/**
 * Wraps a JunctionClient's service proxies with a dev-mode request logger.
 * Mutates the proxy in place (so .on() / _receive() EventEmitter still works).
 *
 * Output style:
 *   ◆ [ab3f] leads.find()              ← green, outgoing
 *   ◆ [ab3f] leads.find() 42ms         ← orange, response
 *   ✗ [ab3f] leads.create() 12ms       ← red, error
 *   ◆ [ab3f] leads.find() 310ms !!!    ← slow request flag (>250ms)
 */
function _wrapDebug(client) {
  const _origService = client.service.bind(client)

  client.service = function(name) {
    const proxy = _origService(name)
    if (proxy._debugWrapped) return proxy
    proxy._debugWrapped = true

    const methods = ['find', 'get', 'create', 'patch', 'remove', 'restore', 'call']
    for (const method of methods) {
      if (typeof proxy[method] !== 'function') continue
      const _orig = proxy[method].bind(proxy)

      proxy[method] = async function(...args) {
        const start = Date.now()
        // Use a random 4-char hex ID — no base64 padding, always distinct
        const id = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')

        // For .call(method, id, data) show the actual inner method name
        const label = method === 'call' && typeof args[0] === 'string'
          ? `${name}.${args[0]}` : `${name}.${method}`

        console.debug(
          `%c ◆ [${id}] ${label}()`,
          'background:#111;color:#34d399;font-weight:bold;padding:1px 4px;border-radius:3px',
          args.length && args[0] != null ? { request: args } : ''
        )

        try {
          const result = await _orig(...args)
          const ms = Date.now() - start
          console.debug(
            `%c ◆ [${id}] ${label}() ${ms}ms${ms > 250 ? ' !!!' : ''}`,
            'background:#111;color:#DE911D;font-weight:bold;padding:1px 4px;border-radius:3px',
            { response: result }
          )
          return result
        } catch (err) {
          const ms = Date.now() - start
          console.debug(
            `%c ✗ [${id}] ${label}() ${ms}ms`,
            'background:#111;color:#f87171;font-weight:bold;padding:1px 4px;border-radius:3px',
            { error: err }
          )
          throw err
        }
      }
    }

    return proxy
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Boot Junction integration. Called by virtual:sierra.
 * @param {object} config — junction config from sierra.config.js
 */
export async function initJunction(config) {
  if (!config?.url) return

  const client = createJunctionClient({ url: config.url })
  const auth = config.auth ?? {}
  const services = config.services ?? {}
  const tokenKey = config.tokenKey ?? 'junction_token'

  // Capture for login() / logout()
  _client = client
  _tokenKey = tokenKey

  // Wrap with debug logger — enabled if config.debug is true,
  // or automatically in Vite dev mode.
  if (config.debug || import.meta.env?.DEV) {
    _wrapDebug(client)
  }

  // Configure the fetch wrapper to auto-attach auth token
  configureFetch({
    tokenKey,
    baseUrl: config.baseUrl,
  })

  // ── Connection signals ───────────────────────────────────────────────────
  // Note: connected and reconnecting are already Mesa-bridged by virtual:sierra
  // before initJunction is called — so these .set() calls propagate to Mesa.

  // Sync initial value from client.connected (avoids flash on first render)
  connected.set(client.connected ?? false)

  client.on('connect', () => {
    connected.set(true)
    reconnecting.set(null)
  })

  client.on('disconnect', () => {
    connected.set(false)
  })

  client.on('reconnecting', (info) => {
    reconnecting.set(info)
  })

  // ── Auth ──────────────────────────────────────────────────────────────────

  // Restore token from storage if present
  const storedToken = typeof localStorage !== 'undefined'
    ? localStorage.getItem(tokenKey)
    : null

  if (storedToken) {
    client.setToken(storedToken)
    // Wait for the WS to open before we return — this ensures the first
    // resource load() sees _wsReady=true and goes WS rather than HTTP.
    // 2s timeout: if the API is unreachable the app still boots via HTTP.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000)
      client.once('connect', () => { clearTimeout(timer); resolve() })
      client.connect()
    })
  }

  // Mid-session expiry — 401 from any service call
  client.on('unauthorized', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(tokenKey)
    }
    if (auth.redirectTo) {
      goto(auth.redirectTo)
    }
  })

  // ── Auth guard (beforeNavigate) ───────────────────────────────────────────

  if (auth.publicRoutes) {
    beforeNavigate(async ({ to }) => {
      const isPublic = auth.publicRoutes.some(r =>
        r.endsWith('*')
          ? to.path.startsWith(r.slice(0, -1))
          : to.path === r
      )

      if (isPublic) return true

      // Token presence check — not validity (see spec §13.3)
      const hasToken = typeof localStorage !== 'undefined'
        ? !!localStorage.getItem(tokenKey)
        : false

      if (!hasToken) {
        if (auth.returnPath) {
          sessionStorage?.setItem('sierra_return_path', to.path)
        }
        return auth.redirectTo ?? '/login'
      }

      return true
    })
  }

  // ── Declarative service event handlers ───────────────────────────────────

  for (const [key, handler] of Object.entries(services)) {
    const [service, event] = key.split(':')
    if (service && event) {
      // Handlers on ServiceProxy survive reconnects automatically
      client.service(service).on(event, handler)
    }
  }

  // ── Lifecycle hooks ───────────────────────────────────────────────────────

  if (config.onConnect) client.on('connect', config.onConnect)
  if (config.onDisconnect) client.on('disconnect', config.onDisconnect)
  if (config.onReconnect) client.on('reconnecting', config.onReconnect)

  // ── Dev mode — wildcard event logging ────────────────────────────────────

  if (import.meta.env?.DEV) {
    client.on('*', (event, ...args) => {
      console.log(`[Junction] ${event}`, ...args)
    })
  }
}
