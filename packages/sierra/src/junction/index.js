/**
 * sierra/junction — Junction WebSocket client integration
 *
 * Initialized by virtual:sierra at boot.
 * Exposes a plain `status` object for use in components — see below.
 *
 * import { status, session, signIn, signOut, useStore } from 'sierra/junction'
 */

import { beforeNavigate, goto } from '../router/index.js'
import { invalidatePrefetch } from '../router/prefetch.js'
import { configureFetch } from '../fetch/index.js'
import { createSignal, watchProxy } from '@frontierjs/mesa/runtime'

// Model schemas generated from the .lite file — see build/schema-plugin.js.
export {
  registerSchemas, schemaFor, modelNameFor, allSchemas, allDefs, hasSchemas,
  resolveRef, suggestModel,
} from './schema-registry.js'
import { createJunctionClient, localTokenStore } from '@frontierjs/junction/client'

// The session — who the browser thinks you are. Re-exported here rather than
// on its own subpath, because `status` and `session` are the two things a
// component asks this module for and splitting them would be two imports for
// one subject.
export { session, ready, refresh, signIn, signUp, signOut, oauthErrorMessage, OAUTH_ERRORS } from './session.js'
import { initSession, _onUnauthorized, session, ready as sessionReady } from './session.js'

// Resource factory — re-exported from the resource module
export {
  createResource, createStore, createMakeFromSchema,
  buildFieldRules, buildRelations, buildGate, canAtLevel,
  buildTransitions, transitionsAt, buildVersion,
  validateAgainstFields, normalizeBlanks, coerceToSchema, ResourceValidationError, ResourceHookError,
  // A thrown value → per-field messages, and the two questions a 409 raises.
  // `resource.fieldErrors(err)` is the same function reached through a
  // resource; these are for the screens that have no resource to reach it
  // through — a form over a CUSTOM METHOD, which is most checkouts. Without
  // them an app holding a 400 from `input:` validation has to re-implement
  // the unwrapping (three shapes, because each hop wraps once) to put the
  // server's own sentence under the right box.
  toFieldErrors, isStaleWrite, toConflict, STALE_WRITE_MESSAGE, matchesQuery,
  // The control table and the registry over it — how an app or a kit says which
  // control a column gets. The other half of a contribution is the component,
  // which is the kit's to bind (`@frontierjs/ui/controls`).
  controlFor, defaultControlFor, formFieldList, labelFieldFor, labelFieldInfo,
  registerControl, unregisterControl, registeredControls,
} from './resource.js'
// The live stores' half of a token change — see _tokenChanged below.
import { resetResourcesForIdentityChange } from './resource.js'

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
 * @property {{client: string, server: string}|null} stale
 *        null until the server states a build this bundle is not, then the two
 *        ids. A shell renders it the way it renders `connected` —
 *        `{#if status.stale}<a href="/">A new version is available</a>{/if}`.
 *        Set at most once per page: the client fires `stale` once, because a
 *        banner that reappears on every request is one nobody reads.
 */
export const status = {
  connected: false,
  reconnecting: null,
  stale: null,
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
//
// `login(token)` and `logout()` were here, and both were token plumbing wearing
// the names of the operations: login() never signed anybody in — the app was
// expected to fetch /auth/login itself and hand the token over — and logout()
// never told the server, so the session row stayed valid until it expired.
// `signIn` / `signOut` in ./session.js do the whole thing. What the client
// cannot know is kept here, and hangs off the client's own token change:

/** A payload prefetched as somebody else must not be served to whoever is here
 *  now — in either direction (`FJS-041`). */
function _tokenChanged(token) {
  invalidatePrefetch()
  // And the same for every live store, for the same reason one layer over: a
  // Resource is created once at import (Invariant 18), so its store lives for
  // the tab and any component still mounted keeps rendering it. On a shared
  // machine that is the previous person's rows on the next person's screen,
  // until their own load() resolves and indefinitely on any screen whose load()
  // never runs — sign-out is a goto(), not a reload (FJS-786).
  resetResourcesForIdentityChange()
  // A deliberate sign-out closes the socket rather than reopening it as a
  // stranger: an anonymous connection serves no purpose and would fire
  // 'connect' after the person has left.
  if (!token) _client?.disconnect()
}

// ─── Store bridge ─────────────────────────────────────────────────────────────

/**
 * Wrap a Junction Store<T> as a Mesa-reactive signal.
 * Call this once per component instance (in the <script> block, not in
 * a reactive computation) so the subscription is created only once.
 *
 * Returns an unsubscribe function — pass it to onDestroy() to avoid leaks:
 *
 *   const { get, unsubscribe } = useStore(leadsStore)
 *   onDestroy(unsubscribe)
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
 * @param {boolean} [config.cookieAuth]
 *        Which credential the server issues. Forwarded verbatim to
 *        `createJunctionClient` and it MUST match
 *        `createAuthPlugin(auth, { cookieAuth: true })` on the API — the browser
 *        cannot see the server's source and there is nothing here to derive it
 *        from, so it is declared. Left false, the client answers
 *        `hasCredential === !!token`, which is false for a signed-in cookie-mode
 *        caller: no boot restore, no socket, and a sign-out that never reaches
 *        the server (FJS-787).
 * @param {boolean|'verbose'} [config.debug]
 *        `true`      — log every service call with request/response payloads
 *        `'verbose'` — additionally log every client event
 *        Both retain payloads in the console; leave off unless debugging.
 */
/**
 * The build this bundle was compiled as, or null.
 *
 * `import.meta.env` is vite's, replaced at build time, so this is a literal in
 * the shipped bundle and not a lookup. Read through a function and guarded,
 * because the same module is imported by the prerender, which runs in Node
 * where `import.meta.env` does not exist.
 */
function buildId() {
  try {
    const v = import.meta.env?.VITE_FJS_BUILD
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/**
 * Does `path` fall under a declared public route?
 *
 * A trailing `*` is a SEGMENT boundary, not a string prefix. It was the latter,
 * so `/blog*` covered `/blogadmin` and `/blog-internal` — and the guard's
 * public branch returns before the boot restore is awaited, so a route that
 * merely shared a prefix skipped the whole guard. Invariant 6 caps what that
 * costs (the Data boundary refuses the same caller whatever this decides), but
 * a list whose only job is to name exceptions must not widen itself.
 *
 * The base matches on its own too: `'/docs*'` covers `/docs` and `/docs/a`.
 */
export function isPublicRoute(rule, path) {
  const p = String(path ?? '')
  if (!String(rule ?? '').endsWith('*')) return p === rule
  const base = String(rule).slice(0, -1)
  return p === base || p === `${base}/` || p.startsWith(base.replace(/\/?$/, '/'))
}

export function initJunction(config) {
  if (!config?.url) return

  // apiPrefix must match the server's `apiPrefix` config. Both default to ''
  // — Junction registers services at /{service} unless an app opts into a
  // prefix — so a default Sierra app talking to a default Junction app needs
  // no configuration here at all.
  const auth = config.auth ?? {}
  const services = config.services ?? {}
  const tokenKey = config.tokenKey ?? 'junction_token'

  const client = createJunctionClient({
    url:        config.url,
    apiPrefix:  config.apiPrefix,
    authPrefix: config.authPrefix,
    // The token has ONE owner, and it is the client — it holds the token, it
    // opens the socket, and it is what a 401 clears. This module used to write
    // localStorage in its own login() while the client kept its copy in
    // memory, so the two halves of "signed in" could disagree.
    tokenStorage:  localTokenStore(tokenKey),
    // Which credential the server issues. The client's `hasCredential` is the
    // one question three mechanisms here ask — the boot restore, the socket
    // branch below, and junction's own signOut — and without this it answers
    // `!!token`, which is false for a signed-in cookie-mode caller.
    cookieAuth:    config.cookieAuth === true,
    // Only when the app renamed them on the server — see AuthPluginOptions.services.
    ...(config.authServices ? { authServices: config.authServices } : {}),
    // Which build this bundle IS.
    //
    // `03-build-web` stamps `VITE_FJS_BUILD` at build time and vite inlines it,
    // so it travels inside the bundle rather than being fetched — which is what
    // makes it true for a browser still running the previous deploy's code. The
    // server states its own on every response and on the socket's `connected`
    // frame, and the CLIENT compares (`FJS-D160`).
    //
    // Absent in dev and in any build nobody deployed, and the client is inert
    // on that: nothing to compare, so `stale` never fires.
    ...(buildId() ? { build: buildId() } : {}),
  })

  // Capture for the session module and the navigation guard
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

  // Configure the fetch wrapper to auto-attach auth token.
  //
  // The CLIENT is handed over, not the storage key. Reading localStorage here
  // was the second owner the comment above refuses — the same bug under a
  // different name — and it is also the half that cannot answer cookie mode,
  // where there is no token to read and the credential rides a cookie.
  configureFetch({
    client,
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

  // This bundle is not the build the server is on. The whole `x-fjs-build`
  // channel — the CLI's stamp, the response header, the socket's `connected`
  // frame — exists so a browser left open across a deploy can be told, and it
  // ended here: `build:` was passed so `stale` COULD fire and nothing listened
  // (FJS-812). Recorded rather than acted on, because whether that is a banner,
  // a prompt or a silent reload is the app's answer and not this module's.
  client.on('stale', (builds) => {
    _status.stale = builds
  })

  // ── Auth ──────────────────────────────────────────────────────────────────

  // A token in storage is restored by the client's constructor, so there is no
  // read of localStorage here — that read was the second owner of the token.
  if (client.token) {
    // The socket needs opening for a token the constructor adopted: setToken
    // does it on a CHANGE, and this one was there from the start.
    client.connect?.()

    // Expose the readiness promise instead of awaiting it. Boot continues
    // immediately; anything that genuinely needs the WebSocket transport can
    // await whenReady. See the note on its declaration above.
    whenReady = new Promise(resolve => {
      const timer = setTimeout(resolve, 2000)
      client.once('connect', () => { clearTimeout(timer); resolve() })
    })
  }

  client.on('token', _tokenChanged)

  // Ask the server who this caller is — and resolve `ready` either way, which
  // is what the navigation guard below waits on.
  initSession(client)

  // The socket, in cookie mode. The branch above opens it on the strength of a
  // token the constructor adopted, and in cookie mode there is never one — so
  // without this a cookie-mode app has no WebSocket after any reload, for the
  // life of the page, and nothing says so. The same root cause as FJS-474: a
  // credential that cannot be read is not a credential that is absent.
  //
  // It waits for the restore rather than opening on `hasCredential`, because
  // that is true for a stranger too — the cookie is unreadable either way — and
  // opening a socket for every anonymous visitor to a public page is a cost the
  // Bearer path never pays.
  if (!client.token && client.hasCredential) {
    whenReady = sessionReady.then(() => {
      if (!session.user) return
      client.connect?.()
      return new Promise(resolve => {
        const timer = setTimeout(resolve, 2000)
        client.once('connect', () => { clearTimeout(timer); resolve() })
      })
    })
  }

  // Mid-session expiry — 401 from any service call. The client clears its own
  // token (and therefore storage); what is left is this app's own state.
  client.on('unauthorized', () => {
    // 401 means the token is not a session — expired, revoked, or issued by a
    // database that has since been reset. Not 403, which is a caller who IS
    // authenticated and may not do this; that one must not sign anybody out.
    client.setToken(null)
    _onUnauthorized()
    invalidatePrefetch()
    if (auth.redirectTo) {
      goto(auth.redirectTo)
    }
  })

  // ── Auth guard (beforeNavigate) ───────────────────────────────────────────

  if (auth.publicRoutes) {
    beforeNavigate(async ({ to }) => {
      const isPublic = auth.publicRoutes.some(r => isPublicRoute(r, to.path))

      if (isPublic) return true

      // Wait for the boot restore rather than judging on token PRESENCE, which
      // is what this did and is a different question: a token that expired
      // between visits passed the guard, the page rendered, and its first
      // service call 401'd — a redirect after the fact, which is the flash both
      // dogfood apps solved by hand. `ready` resolves signed in or not.
      await sessionReady

      if (!session.user) {
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
