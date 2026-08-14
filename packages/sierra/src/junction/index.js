/**
 * sierra/junction — Junction WebSocket client integration
 *
 * Initialised by virtual:sierra at boot.
 * Exposes a plain `status` object for use in components — see below.
 *
 * import { status, login, logout, useStore } from 'sierra/junction'
 */

import { beforeNavigate, goto } from '../router/index.js'
import { configureFetch } from '../fetch/index.js'
import { createSignal, watchProxy } from '@frontierjs/mesa/runtime'

// Model schemas generated from the .lite file — see build/schema-plugin.js.
export {
  registerSchemas, schemaFor, modelNameFor, allSchemas, allDefs, hasSchemas,
  resolveRef, suggestModel,
} from './schema-registry.js'
import { createJunctionClient } from '@frontierjs/junction/client'

// Resource factory — re-exported from the resource module
export {
  createResource, createStore, createMakeFromSchema,
  buildFieldRules, buildRelations, buildGate, canAtLevel,
  buildTransitions, transitionsAt,
  validateAgainstFields, normalizeBlanks, coerceToSchema, ResourceValidationError,
} from './resource.js'

// ─── Module-level refs (set by initJunction) ──────────────────────────────────

/** @type {object|null} */
let _client = null
let _tokenKey = 'junction_token'

/**
 * Resolves once the Junction WebSocket has been confirmed by the server, or
 * after a 2 s grace period, whichever comes first. Already resolved when there
 * is no stored token (nothing to wait for).
 *
 * Await this only if you specifically need the WebSocket transport. You almost
 * certainly don't: the client's _wsCall() falls back to HTTP whenever the
 * socket isn't ready, so service calls made during connection work fine — they
 * just take the HTTP path for the first request or two.
 *
 * initJunction used to await this internally, and virtual:sierra emitted
 * `await initJunction(...)` at the top level of the app entry — so every
 * returning visitor (i.e. anyone with a stored token) had first paint blocked
 * on a full round-trip plus the server's verifySession, up to a 2 s cap, purely
 * to make the first service call prefer WebSocket over HTTP.
 *
 * @type {Promise<void>}
 */
export let whenReady = Promise.resolve()

// ─── Public state ───────────────────────────────────────────────────────────

/**
 * Connection state — a plain object, not signals.
 *
 * Components make the fields they care about reactive with a `$:` path watch:
 *
 *   import { status } from '@frontierjs/sierra/junction'
 *   $: status.connected
 *   <span>{status.connected ? 'online' : 'offline'}</span>
 *
 * Nothing here is reactive on its own — that is the point. Mesa's VISION §5 and
 * RULE 8 put shared state in plain JavaScript, and RULE 43 makes replacement the
 * reactive operation. This module is the writer, so it holds its own proxy
 * handle below and mutates through that (RULE 45).
 *
 * @property {boolean} connected     true when the WebSocket is open
 * @property {object|null} reconnecting  null when stable, { attempt, delay } otherwise
 */
export const status = {
  connected: false,
  reconnecting: null,
}

// The writer's handle. watchProxy is cached per object and idempotent, so this
// is the same proxy instance every component's `$:` watch resolves to — a write
// through it fires exactly the paths that are watched, and nothing else.
const _status = watchProxy(status)

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
 *
 * Synchronous — see the note on `whenReady` above. Returns nothing; the
 * WebSocket connects in the background.
 *
 * @param {object} config              junction config from sierra.config.js
 * @param {string} [config.apiPrefix]  URL prefix for service routes. Must match
 *        the server's `apiPrefix`. Default '' — services at /{service}.
 * @param {string} [config.authPrefix] The auth plugin's own prefix, default
 *        '/auth' — relative to apiPrefix, as the plugin's option is.
 * @param {boolean|'verbose'} [config.debug]
 *        `true`      — log every service call with request/response payloads
 *        `'verbose'` — additionally log every client event
 *        Both retain payloads in the console; leave off unless debugging.
 */
export function initJunction(config) {
  if (!config?.url) return

  // apiPrefix must match the server's `apiPrefix` config. Both default to ''
  // — Junction registers services at /{service} unless an app opts into a
  // prefix — so a default Sierra app talking to a default Junction app needs
  // no configuration here at all.
  const client = createJunctionClient({
    url:        config.url,
    apiPrefix:  config.apiPrefix,
    authPrefix: config.authPrefix,
  })
  const auth = config.auth ?? {}
  const services = config.services ?? {}
  const tokenKey = config.tokenKey ?? 'junction_token'

  // Capture for login() / logout()
  _client = client
  _tokenKey = tokenKey

  // Request logger — opt-in via `junction: { debug: true }`.
  //
  // This used to be `config.debug || import.meta.env?.DEV`, i.e. on for every
  // dev session. It wraps all seven service methods and console.debug()s
  // `{ request: args }` and `{ response: result }` for each call. Objects
  // logged to the console are retained by devtools, so on a WebSocket-heavy
  // app every response payload stayed reachable for the lifetime of the tab —
  // enough to skew memory profiling and to make the console itself sluggish.
  //
  // Set debug: true when you want it.
  if (config.debug) {
    _wrapDebug(client)
  }

  // Configure the fetch wrapper to auto-attach auth token
  configureFetch({
    tokenKey,
    baseUrl: config.baseUrl,
  })

  // ── Connection state ─────────────────────────────────────────────────────
  // Writes go through _status so path watches fire. Assigning `status.connected`
  // directly would update the object but notify nobody (RULE 45).

  // Sync initial value from client.connected (avoids flash on first render)
  _status.connected = client.connected ?? false

  client.on('connect', () => {
    _status.connected = true
    _status.reconnecting = null
  })

  client.on('disconnect', () => {
    _status.connected = false
  })

  client.on('reconnecting', (info) => {
    _status.reconnecting = info
  })

  // ── Auth ──────────────────────────────────────────────────────────────────

  // Restore token from storage if present
  const storedToken = typeof localStorage !== 'undefined'
    ? localStorage.getItem(tokenKey)
    : null

  if (storedToken) {
    // setToken opens the socket itself when none is open, so there is no
    // separate connect() call here — it would return early anyway.
    client.setToken(storedToken)

    // Expose the readiness promise instead of awaiting it. Boot continues
    // immediately; anything that genuinely needs the WebSocket transport can
    // await whenReady. See the note on its declaration above.
    whenReady = new Promise(resolve => {
      const timer = setTimeout(resolve, 2000)
      client.once('connect', () => { clearTimeout(timer); resolve() })
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

  // Wildcard event logging — also opt-in, for the same reason. Every event on
  // the client, with its full payload, held by the console.
  if (config.debug === 'verbose') {
    client.on('*', (event, ...args) => {
      console.log(`[Junction] ${event}`, ...args)
    })
  }
}
