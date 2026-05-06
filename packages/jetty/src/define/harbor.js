// defineHarbor — service worker entrypoint
//
// Phase 2 changes vs Phase 1:
//   - Junction adapter wired into ctx (config-supplied or default placeholder)
//   - Schema cache: load from storage, reconcile on connect, broadcast `schema`
//   - Auth flow: hydrate stored token, expose login/logout via service:call routing
//   - Message router for framework-level types: init, service:call, channel:subscribe,
//     channel:unsubscribe (channels are stub in Phase 2 — Phase 2.5 wires real pubsub)
//   - Real session payload (user, authenticated, expiresAt, protocolVersion)
//
// Listener registration remains SYNCHRONOUS — MV3 wake-time delivery requires
// onConnect listener at top of SW file before any await boundary.

import { makeStorage }                           from '../runtime/storage.js'
import { parsePortName, PROTOCOL_VERSION }       from '../runtime/protocol.js'
import { makeHarborRegistry, makePagesApi }      from '../runtime/harbor-registry.js'
import { makeChannelRegistry, makeChannelsApi }  from '../runtime/channel-registry.js'
import { registerAllIslands, registerIsland,
         unregisterIsland, reloadIslandTabs }    from '../island/registration.js'
import { validateAdapter, safeOn,
         createDefaultJunctionAdapter,
         makeSchemaCache,
         makeAuthFlow }                          from '../junction/index.js'

export function defineHarbor(config = {}) {
  const { plugins = [], run, junction: junctionConfig = {}, islands: islandsConfig = {} } = config

  const isExtensionContext =
    (typeof globalThis !== 'undefined' && globalThis.chrome?.runtime?.id) ||
    (typeof globalThis !== 'undefined' && globalThis.browser?.runtime?.id)

  const registry = makeHarborRegistry()

  // Lifecycle hooks for run() ctx — Phase 2.5 supports 'connection'.
  // Future events: 'disconnect', 'wake', 'sleep' (predicted SW termination).
  const lifecycleHooks = {
    connection: new Set(),
  }

  // --- SYNCHRONOUS: onConnect listener ---
  // Boot context is shared between SYNC listener and ASYNC boot via closure.
  // The listener references state that boot() populates; before boot completes,
  // the router uses fallback behavior (queue or no-op as appropriate).
  let bootContext = null

  if (isExtensionContext) {
    const runtime = globalThis.chrome?.runtime ?? globalThis.browser?.runtime
    runtime.onConnect.addListener((port) => handleConnect(port, registry, () => bootContext, lifecycleHooks))
  }

  // --- ASYNC: full boot ---
  const boot = async () => {
    const storage = makeStorage()
    const pages   = makePagesApi(registry)

    // 1. Junction adapter — config-supplied or default placeholder.
    const adapterFactory = junctionConfig.adapter ?? createDefaultJunctionAdapter
    const adapter        = validateAdapter(adapterFactory(junctionConfig), 'junctionAdapter')

    // 2. Schema cache — load from disk, reconcile after Junction connects.
    const schemaCache = makeSchemaCache({ adapter, storage })
    await schemaCache.load()

    // 3. Auth flow — hydrate stored token if present.
    const authFlow = makeAuthFlow({
      adapter,
      storage,
      pages,
      tokenKey: junctionConfig.tokenKey ?? 'jetty_token',
    })

    // 4. Connect Junction. Failure here is non-fatal — Harbor still runs,
    //    but service calls will throw until reconnect succeeds.
    if (junctionConfig.url) {
      try {
        // Pull stored token (if any) so initial connection is authenticated.
        const stored = await storage.local.get(junctionConfig.tokenKey ?? 'jetty_token')
        const initialToken = stored?.[junctionConfig.tokenKey ?? 'jetty_token'] ?? null
        await adapter.connect({ url: junctionConfig.url, token: initialToken })
        console.log('[harbor] junction connected:', junctionConfig.url)
      } catch (e) {
        console.warn('[harbor] junction connect failed (will retry):', e.message)
      }
    } else {
      console.warn('[harbor] no junction.url configured — running offline')
    }

    // 5. Hydrate auth from stored token (verifies w/ server).
    if (adapter.isConnected()) {
      await authFlow.hydrate()
    }

    // 6. Reconcile schema. If server has newer version, refetch + broadcast.
    if (adapter.isConnected()) {
      const before = schemaCache.current?.version
      await schemaCache.reconcile()
      const after = schemaCache.current?.version
      if (after && after !== before) {
        pages.broadcast('schema', schemaCache.current)
      }
    }

    // 7. Listen for Junction reconnect events to re-broadcast session.
    safeOn(adapter, 'reconnect', () => {
      console.log('[harbor] junction reconnected')
      pages.broadcast('session', buildSessionPayload(authFlow))
    })
    safeOn(adapter, 'disconnect', () => {
      console.log('[harbor] junction disconnected')
    })

    // 8. Set boot context — the message router can now use real components.
    const channelRegistry = makeChannelRegistry({ adapter })
    bootContext = { storage, pages, adapter, schemaCache, authFlow, channelRegistry, islandsConfig }

    // 9. Register islands. Idempotent across SW wakes (upsert-safe).
    const scriptingApi = (globalThis.chrome ?? globalThis.browser)?.scripting
    const islandsApi = makeIslandsApi(scriptingApi, islandsConfig)
    if (Object.keys(islandsConfig).length > 0) {
      try {
        await islandsApi.registerAll()
      } catch (e) {
        console.warn('[harbor] island registration failed (non-fatal):', e.message)
      }
    }

    const runCtx = {
      junction: adapter,
      channels: makeChannelsApi({ adapter, channelRegistry, lifecycleHooks }),
      islands:  islandsApi,
      pages,
      storage,
    }

    for (const plugin of plugins) {
      if (typeof plugin === 'function') await plugin(runCtx)
    }
    if (typeof run === 'function') await run(runCtx)

    // After run() completes, deliver session (and schema) to any ports that
    // connected during boot. Their `init` requests, if sent before boot
    // finished, were no-op'd; this catches them up.
    pages.broadcast('session', buildSessionPayload(authFlow))
    if (schemaCache.current) {
      pages.broadcast('schema', schemaCache.current)
    }

    return runCtx
  }

  let bootPromise = null
  if (isExtensionContext) {
    bootPromise = Promise.resolve().then(boot).catch((e) => {
      console.error('[harbor] boot failed:', e)
      throw e
    })
  }

  return {
    _boot:     boot,
    _ready:    bootPromise,
    _registry: registry,
    config,
  }
}

// --- connect handling ---

export function handleConnect(port, registry, getBootContext = () => null, lifecycleHooks = {}) {
  const parsed = parsePortName(port.name)
  if (!parsed) {
    console.warn('[harbor] rejected port — invalid name:', port.name)
    safeDisconnect(port)
    return
  }

  if (parsed.version < PROTOCOL_VERSION) {
    console.log(`[harbor] protocol mismatch (client v${parsed.version} < harbor v${PROTOCOL_VERSION}) → protocol:upgrade`)
    try { port.postMessage({ type: 'protocol:upgrade', payload: { harborVersion: PROTOCOL_VERSION } }) } catch {}
    safeDisconnect(port)
    return
  }

  if (parsed.version > PROTOCOL_VERSION) {
    console.log(`[harbor] protocol mismatch (client v${parsed.version} > harbor v${PROTOCOL_VERSION}) → runtime:reload-tab`)
    try { port.postMessage({ type: 'runtime:reload-tab', payload: {} }) } catch {}
    safeDisconnect(port)
    return
  }

  console.log('[harbor] port connected:', port.name)
  registry.add(port, parsed)

  // Fire 'connection' lifecycle event for harbor.run() listeners.
  if (lifecycleHooks?.connection) {
    for (const fn of lifecycleHooks.connection) {
      try { fn({ type: parsed.type, id: parsed.id, port }) }
      catch (e) { console.error('[harbor] connection hook threw:', e) }
    }
  }

  port.onDisconnect.addListener(async () => {
    console.log('[harbor] port disconnected:', port.name)
    registry.remove(port, parsed)
    // Cleanup channel subscriptions for this port.
    const ctx = getBootContext()
    if (ctx?.channelRegistry) {
      try { await ctx.channelRegistry.unsubscribeAllForPort(port) }
      catch (e) { console.warn('[harbor] channel cleanup on disconnect threw:', e.message) }
    }
  })

  port.onMessage.addListener((msg) => {
    routeMessage(port, parsed, msg, getBootContext()).catch((e) => {
      console.error('[harbor] message routing error:', e)
      if (msg?.payload?._requestId) {
        try {
          port.postMessage({
            type: `response:${msg.payload._requestId}`,
            payload: { _error: e.message },
          })
        } catch {}
      }
    })
  })

  // Initial session ack — sent immediately, before boot might have completed.
  try {
    port.postMessage({ type: 'session', payload: { user: null, authenticated: false, protocolVersion: PROTOCOL_VERSION } })
  } catch {}
}

async function routeMessage(port, parsed, msg, ctx) {
  if (!msg || typeof msg !== 'object' || !msg.type) return

  // If boot hasn't finished, defer messages that need the boot context.
  // Phase 2 simplification: just respond with not-ready error for service:call.
  // Phase 3+ will add a queue.
  if (!ctx) {
    if (msg.payload?._requestId) {
      port.postMessage({
        type: `response:${msg.payload._requestId}`,
        payload: { _error: 'Harbor still booting; retry shortly' },
      })
    }
    return
  }

  switch (msg.type) {
    case 'init':
      // Reply with current session + schema.
      try {
        port.postMessage({ type: 'session', payload: buildSessionPayload(ctx.authFlow) })
        if (ctx.schemaCache?.current) {
          port.postMessage({ type: 'schema', payload: ctx.schemaCache.current })
        }
      } catch {}
      break

    case 'service:call':
      await handleServiceCall(port, msg, ctx)
      break

    case 'channel:subscribe': {
      const channel = msg.payload?.channel
      if (typeof channel !== 'string' || !channel) {
        respond(port, msg, { _error: 'channel:subscribe requires { channel: string }' })
        return
      }
      try {
        await ctx.channelRegistry.subscribePort(port, channel)
        respond(port, msg, { value: { ok: true, channel } })
      } catch (e) {
        respond(port, msg, { _error: e.message })
      }
      break
    }

    case 'channel:unsubscribe': {
      const channel = msg.payload?.channel
      if (typeof channel !== 'string' || !channel) {
        respond(port, msg, { _error: 'channel:unsubscribe requires { channel: string }' })
        return
      }
      try {
        await ctx.channelRegistry.unsubscribePort(port, channel)
        respond(port, msg, { value: { ok: true, channel } })
      } catch (e) {
        respond(port, msg, { _error: e.message })
      }
      break
    }

    default:
      // Unknown framework type — log only. App-level types should arrive via
      // service:call envelope, not bare top-level types.
      console.log('[harbor] unhandled msg type:', msg.type, 'from', port.name)
  }
}

async function handleServiceCall(port, msg, ctx) {
  const { service, method, args, _requestId } = msg.payload || {}
  if (!service || !method) {
    respond(port, msg, { _error: 'service:call requires { service, method }' })
    return
  }

  // Special-case auth: jetty owns the side effects (token storage, broadcast).
  if (service === 'auth' && method === 'login') {
    try {
      const result = await ctx.authFlow.login(args)
      respond(port, msg, { value: result })
    } catch (e) {
      respond(port, msg, { _error: e.message })
    }
    return
  }
  if (service === 'auth' && method === 'logout') {
    try {
      const result = await ctx.authFlow.logout()
      respond(port, msg, { value: result })
    } catch (e) {
      respond(port, msg, { _error: e.message })
    }
    return
  }

  // Generic service call → forward to Junction.
  try {
    if (!ctx.adapter.isConnected()) {
      throw new Error('Junction not connected')
    }
    const value = await ctx.adapter.call(service, method, args)
    respond(port, msg, { value })
  } catch (e) {
    respond(port, msg, { _error: e.message })
  }
}

function respond(port, originalMsg, payload) {
  const requestId = originalMsg?.payload?._requestId
  if (!requestId) return
  try {
    port.postMessage({ type: `response:${requestId}`, payload })
  } catch {}
}

function buildSessionPayload(authFlow) {
  const s = authFlow?.session ?? { user: null, authenticated: false, expiresAt: null }
  return { ...s, protocolVersion: PROTOCOL_VERSION }
}

function safeDisconnect(port) {
  try { port.disconnect() } catch {}
}

// --- islands API factory ---

function makeIslandsApi(scriptingApi, islandsConfig) {
  return {
    /** Register all islands defined in jetty.config.js. Upsert-safe. */
    async registerAll() {
      return registerAllIslands(scriptingApi, islandsConfig)
    },
    /** Register or replace a single island by id. */
    async register(id) {
      const cfg = islandsConfig[id]
      if (!cfg) throw new Error(`islands.register: unknown id "${id}"`)
      return registerIsland(scriptingApi, id, cfg)
    },
    /** Unregister a single island by id. */
    async unregister(id) {
      return unregisterIsland(scriptingApi, id)
    },
    /** List currently-configured island ids. */
    list() {
      return Object.keys(islandsConfig)
    },
    /** Reload all tabs matching this island's match patterns. */
    async reloadTabsFor(id) {
      const cfg = islandsConfig[id]
      if (!cfg) throw new Error(`islands.reloadTabsFor: unknown id "${id}"`)
      const tabsApi = (globalThis.chrome ?? globalThis.browser)?.tabs
      return reloadIslandTabs(tabsApi, cfg.matches)
    },
  }
}
