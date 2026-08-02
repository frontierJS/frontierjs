// core/app.ts
// The framework entry point — createApp() wires all subsystems together.
// Lifecycle: configure → start → ready → (running) → shutdown
// Plugin system: Option C hybrid — simple fn or full lifecycle object.

import { HttpTransport }            from '../transport/http.ts'
import { bridge } from '../transport/bridge.ts'
import { freezeUser, runWithMeta, type ServiceContext, type ServiceMethod, type CallOptions, type RequestMeta } from './context.ts'
import { ServiceRegistry, callService } from './service.ts'
import { unwrapResult } from './envelope.ts'
import { withLitestoneDb } from './litestone.ts'
import { createEventBus }           from '../events/index.ts'
import { createMemoryCache }        from '../cache/index.ts'
import { createScheduler }          from '../scheduler/index.ts'
import { createDatabase, type DatabaseClient } from '../storage/database/index.ts'
import { autoloadServices }         from './loader.ts'
import { mergeHookMaps, type HookMap } from './hooks.ts'
import { toFrameworkError, NotFound }   from './errors.ts'
import { helmet }                       from '../transport/middleware.ts'
import { defaultConfig, deepMerge, loadConfig } from '../config/index.ts'
import { createLogger, noopLogger }             from './logger.ts'
import type { ILogger, LoggerOptions }          from './logger.ts'
import type { AppConfig }                          from '../config/index.ts'
import type { IAuth }               from '../auth/types.ts'
import type { IMail }               from '../mail/index.ts'
import type { IFileStorage }        from '../storage/filestorage/index.ts'
import type { ICache }              from '../cache/index.ts'
import type { IEventBus }           from '../events/index.ts'
import type { AIRegistry }          from '../ai/index.ts'
import type { RouteHandler, MiddlewareFn, WsHandlerSet } from '../transport/types.ts'

// ─── Plugin interface ─────────────────────────────────────────────────────

export type PluginFn = (app: App) => void | Promise<void>

export interface Plugin {
  name:       string
  register?:  (app: App) => void | Promise<void>
  boot?:      (app: App) => void | Promise<void>
  ready?:     (app: App) => void | Promise<void>
  shutdown?:  (app: App) => void | Promise<void>
}

export type PluginInput = PluginFn | Plugin

// ─── App interface ────────────────────────────────────────────────────────

export interface App {
  // Config
  config:    AppConfig

  /**
   * The application's database client.
   *
   * Whatever was passed as `createApp({ db })`, or a raw bun:sqlite handle when
   * only `config.database.url` was set. Typed loosely because both a Litestone
   * client and a plain table-shaped object are valid — `createBaseService`
   * adapts the latter.
   */
  db?:       unknown

  // Subsystems — accessed directly
  logger:    ILogger
  services:  ServiceRegistry
  events:    IEventBus
  telemetry: IEventBus   // low-level instrumentation bus — subscribe to 'junction.call'
  cache:     ICache
  scheduler: ReturnType<typeof createScheduler>
  http:      HttpTransport

  // Optional — registered via configure()
  auth?:     IAuth
  mail?:     IMail
  ai?:       AIRegistry
  email?:    import('../plugins/email/types.ts').IEmail
  // Conduit is provided by @frontierjs/conduit. Declared here as
  // unknown? so in-tree code (email/campaign) can read app.conduit
  // without requiring the conduit package as a hard dep. Conduit
  // augments this with the real type at the package boundary.
  conduit?:  unknown

  // Real-time channels — available after app.configure(channels(...))
  channels?:    ReturnType<typeof import('../transport/channels.ts').createChannelManager>
  channel?:     (name: string) => import('../transport/channels.ts').Channel
  presence?:        (channelId: string) => import('../transport/channels.ts').PresenceMember[]
  presenceOf?:      (userId: string | number) => import('../transport/channels.ts').PresenceMember[]
  addOpenApiPaths?: (paths: Record<string, unknown>) => void

  // Webhooks manager — available after app.configure(webhooks(...)).
  // Typed here so plugins attach via plain assignment, not type-erasing
  // casts (the standard plugin-attachment pattern).
  webhooks?: import('../plugins/webhooks/index.ts').WebhookManager

  // ── Internal plugin/subsystem attachment points (typed, not casts) ──
  /** OpenAPI extra paths registered via addOpenApiPaths(). */
  _openapiExtraPaths?: Record<string, unknown>
  /** Per-app service cache — created lazily by cache-declaring services,
   *  destroyed by stop(). See resolveCache in core/service.ts. */
  _serviceCache?: ICache

  // File storage factory
  filestorage: (name: string) => Promise<IFileStorage>

  // ── Service caller — Feathers-style internal service calls ────────
  //
  // Call any registered service from inside a hook, another service,
  // a scheduler job, or anywhere else that has access to app.
  //
  // Passing params threads the caller's context through (user, workspaceId,
  // query, etc.) — same as Feathers's default behaviour.
  // Omitting params makes an anonymous system call (user: null).
  //
  //   // From inside a service method — thread user context:
  //   const owner = await app.service('users').get(ctx.data.userId, ctx.params)
  //
  //   // Anonymous system call — no user, bypasses auth hooks:
  //   await app.service('audit').create({ action: 'x' })
  //
  //   // Custom method:
  //   await app.service('servers').call('reboot', serverId, ctx.params)
  service: (name: string) => ServiceCaller

  // App-level hooks — applied to every service call
  hooks:     (map: HookMap) => void

  // Plugin registration — can be called anytime before start()
  configure: (plugin: PluginInput) => App
  setAuth:   (auth: import('../auth/types.ts').IAuth) => void

  // Route shortcuts (delegate to http.router)
  get:     (path: string, handler: RouteHandler, mw?: MiddlewareFn[]) => App
  post:    (path: string, handler: RouteHandler, mw?: MiddlewareFn[]) => App
  put:     (path: string, handler: RouteHandler, mw?: MiddlewareFn[]) => App
  patch:   (path: string, handler: RouteHandler, mw?: MiddlewareFn[]) => App
  delete:  (path: string, handler: RouteHandler, mw?: MiddlewareFn[]) => App

  // WebSocket route — same {param} syntax as HTTP routes
  // Handlers receive WsContext: params, query, headers, user, send(), close()
  // Auth is resolved before open() is called — ctx.user is populated if a
  // token was present and valid, null for anonymous connections.
  //
  //   app.ws('/chat/{roomId}', {
  //     open(ctx)           { ctx.send({ type: 'welcome', room: ctx.route.roomId }) },
  //     message(ctx, msg)   { ... },
  //     close(ctx, code)    { ... },
  //   })
  ws: (path: string, handlers: WsHandlerSet) => App

  // Lifecycle
  start:    () => Promise<void>
  stop:     () => Promise<void>

  // Internal
  _appHooks: HookMap
  _plugins:  string[]   // names of all configured plugins
  /** Plugin-registered metrics providers — keyed by plugin name.
   *  Each provider returns an object merged into GET /metrics.
   *  Plugins like Caravan register here to expose their stats. */
  _metricsProviders: Map<string, () => unknown>
  /** Test-only: runs plugin register(), registerServiceRoutes, and setAppHooks
   *  without binding a port. Call once before the first request() in tests. */
  _startForTest: () => Promise<void>
}

// ─── createApp ────────────────────────────────────────────────────────────

export interface AppOptions {
  config?:      Partial<AppConfig>  // merged over defaults + junction.config.js
  configPath?:  string              // path to junction.config.js dir, default './api/config'
  logger?:      ILogger             // custom logger — defaults to createLogger()
  logLevel?:    import('./logger.ts').LogLevel   // override log level
  auth?:        IAuth
  /**
   * The application's database client, exposed as `app.db`.
   *
   * Accepts a Litestone client or any plain table-shaped object —
   * `createBaseService` adapts the latter. When the client exposes `$setAuth`,
   * per-request scoping is installed automatically as an app-level around hook,
   * so `ctx.locals.db` is always the caller-scoped client and row policies see
   * who is asking.
   *
   * That used to be a manual step:
   *
   *   app.hooks({ around: { all: [withLitestoneDb(db)] } })
   *
   * which is an option with exactly one correct answer — omitting it left
   * services running against an unscoped client. Passing `db` here does it.
   *
   * Takes precedence over `config.database.url`, which creates a raw bun:sqlite
   * handle and is the older, lower-level path.
   */
  db?:          unknown
  mail?:        IMail
  ai?:          AIRegistry
  /**
   * Service auto-discovery. ON by default: the `services/` directory next
   * to your entry file (Bun.main) is scanned for *.service.ts files.
   * Pass a string to point somewhere else (resolved relative to CWD), or
   * `false` to disable auto-discovery entirely.
   */
  autoload?:    string | false
  filestorage?: string   // path to storage root dir
}

// ─── ServiceCaller — returned by app.service(name) ───────────────────────
// The canonical way to call a service from inside a hook, another service,
// a scheduler job, or anywhere else that has access to app.
//
//   ctx.app.service('users').get(userId, ctx.params)   ← thread caller context
//   ctx.app.service('audit').create({ action: 'x' })   ← anonymous system call
//   ctx.app.service('servers').call('reboot', id)      ← call a custom method
//
// Mirrors Feathers’ app.service(name).method(id, params) API.
// call() is consistent with client.service(name).call() on the browser client.

// ─── Internal service call options ───────────────────────────────────────
// CallOptions is defined in bridge.ts (single source). Re-exported here
// for the public surface. ServiceParams is GONE — there is no params bag.
export type { CallOptions } from './context.ts'

export interface ServiceCaller {
  /**
   * Returns the LIST ENVELOPE — `{ kind:'list', object, data, errors, total?, limit?, offset? }`
   * — not a bare array. The rows are `result.data`.
   *
   * Pass directives to paginate:
   *   app.service('posts').find({ status: 'open' }, { directives: { limit: 10 } })
   */
  find(query?: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  get(id: string | number, opts?: CallOptions): Promise<unknown>
  get(query: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  create(data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  patch(id: string | number, data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  patch(query: Record<string, unknown>, data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  update(id: string | number, data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  update(query: Record<string, unknown>, data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  remove(id: string | number, opts?: CallOptions): Promise<unknown>
  remove(query: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  restore(id: string | number, opts?: CallOptions): Promise<unknown>
  restore(query: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  call(name: string, id?: string | number | null, data?: Record<string, unknown> | null, opts?: CallOptions): Promise<unknown>

  // ── Hook-bypass methods ────────────────────────────────────────────────────
  // Skip the hook pipeline — call the raw method directly.
  // Use when you explicitly don’t want side-effects (publish, audit, cache-bust).
  // For everything else, use the unprefixed methods.
  _find(query?: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  _get(id: string | number, opts?: CallOptions): Promise<unknown>
  _get(query: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  _create(data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  _patch(id: string | number, data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  _patch(query: Record<string, unknown>, data: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  _remove(id: string | number, opts?: CallOptions): Promise<unknown>
  _remove(query: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
  _restore(id: string | number, opts?: CallOptions): Promise<unknown>
  _restore(query: Record<string, unknown>, opts?: CallOptions): Promise<unknown>
}

export function createApp(opts: AppOptions = {}): App {

  // Build config: defaultConfig → junction.config.js (loaded in start()) → opts.config
  // opts.config overrides are applied now synchronously.
  // junction.config.js is merged in start() — the first async opportunity.
  const config: AppConfig = opts.config
    ? deepMerge(defaultConfig, opts.config) as AppConfig
    : { ...defaultConfig } as AppConfig
  const _configPath = opts.configPath ?? './api/config'

  // ── Subsystems ───────────────────────────────────────────────────────
  const logger    = opts.logger ?? createLogger({ level: opts.logLevel })
  const services  = new ServiceRegistry()
  // app.service(name) caller memo — see service() below.
  const _serviceCallers = new Map<string, ServiceCaller>()
  // Signal handler installed by start(), removed by stop() — kept here so
  // repeated start() calls never register duplicates.
  let _signalHandler: (() => void) | null = null
  // Async plugin register() rejections, captured by configure() and
  // rethrown by start() — a half-registered plugin must not boot.
  const _registerFailures: Array<{ plugin: string; err: unknown }> = []
  const events    = createEventBus()
  const telemetry = createEventBus()
  const cache     = createMemoryCache({
    defaultTtl: config.cache.defaultTtl,
    maxSize:    config.cache.maxSize,
  })
  const scheduler = createScheduler()

  // ── Database (optional) ──────────────────────────────────────────────
  // Two ways in, in priority order:
  //
  //   1. opts.db            — a client you built (Litestone, or anything
  //                           table-shaped that createBaseService can adapt)
  //   2. config.database.url — creates a raw bun:sqlite handle
  //
  // Either way it lands on app.db, so services and hooks have one place to
  // look. If the client supports $setAuth, per-request scoping is installed
  // further down — see "Litestone scoping".
  let db: unknown = opts.db
  if (!db && config.database?.url) {
    db = createDatabase({ path: config.database.url, log: config.database.log })
  }

  const http      = new HttpTransport({
    port:        config.port,
    hostname:    config.hostname,
    maxBodySize: config.http.maxBodySize,
    compress:    config.http.compress,
    ddos:        config.http.ddos,
    static:      config.http.static,
    auth:        opts.auth,
    powered:     config.http.powered,
    onError:     (err) => {
      console.error('[HTTP Error]', err)
      events.emit('error', err)
    }
  })

  // ── File storage factory ─────────────────────────────────────────────
  const storageRoot = opts.filestorage ?? './storage'
  const storageCache = new Map<string, IFileStorage>()

  async function getFileStorage(name: string): Promise<IFileStorage> {
    if (storageCache.has(name)) return storageCache.get(name)!
    const { createFileStorage } = await import('../storage/filestorage/index.ts')
    const store = createFileStorage(name, storageRoot)
    storageCache.set(name, store)
    return store
  }

  // ── Plugin registry ──────────────────────────────────────────────────
  const plugins: Plugin[] = []
  let started = false   // set to true once app.start() completes

  // ── App-level hooks ──────────────────────────────────────────────────
  let appHooks: HookMap = {}

  // ── Build the app object ─────────────────────────────────────────────
  const app: App = {
    config,
    db,
    logger,
    services,
    events,
    telemetry,
    cache,
    scheduler,
    http,
    auth:    opts.auth,
    mail:    opts.mail,
    ai:      opts.ai,

    filestorage: getFileStorage,

    // ── Service caller ────────────────────────────────────────────────
    service(name: string): ServiceCaller {
      // Callers are pure over (name, app) — memoize so hot paths that call
      // app.service('x') per request/hook don't rebuild the ~20-method
      // caller object and its closures every time. Service lookup stays
      // lazy (inside call()/bypasses), so a caller obtained before the
      // service registers still works afterwards.
      const memoized = _serviceCallers.get(name)
      if (memoized) return memoized

      // Builds an internal-call ServiceContext. auth propagated as a frozen
      // shared reference (see freezeUser), locals fresh {} (never inherits
      // caller's — kills the shared-mutation footgun). Request-wide metadata
      // is NOT passed here; it rides AsyncLocalStorage (requestMeta()).
      function makeCtx(
        method: ServiceMethod,
        id:     string | number | null,
        data:   Record<string, unknown> | null,
        query:  Record<string, unknown> = {},
        opts:   CallOptions = {}
      ): ServiceContext {
        return {
          service:   name,
          method,
          type:      'before',
          transport: opts.transport ?? 'internal',
          model:     name,
          id:        id ?? null,
          query,
          // Internal callers paginate through CallOptions:
          //   app.service('posts').find({}, { directives: { limit: 10 } })
          directives: opts.directives ?? {},
          data,
          auth: {
            user: opts.auth?.user ? freezeUser(opts.auth.user) : null,
          },
          client: {
            headers: {},
          },
          route:  {},
          locals: opts.locals ? { ...opts.locals } : {},
          app:       app,
          result:    null,
          error:     null,
          statusCode: undefined,
          dispatch:   undefined,
          $raw:       null,
        }
      }

      async function call(ctx: ServiceContext): Promise<unknown> {
        const svc = services.get(name)
        if (!svc) throw new NotFound(`Service '${name}' not found`)
        await callService(svc, ctx, app._appHooks, app.events, app.telemetry)
        // Same rule as the HTTP boundary: a list keeps its envelope, a single
        // unwraps to the record.
        //
        // This used to flat-unwrap to `.data` for every method, so
        // `app.service('posts').find()` returned a bare array and total/limit/
        // offset were unreachable from anywhere except curl. Identical call,
        // two different answers depending on who was asking.
        return unwrapResult(ctx.result)
      }

      const caller: ServiceCaller = {
        find(query?: Record<string, unknown>, opts?: CallOptions) {
          return call(makeCtx('find', null, null, query ?? {}, opts))
        },
        get(idOrQuery: string | number | Record<string, unknown>, opts?: CallOptions) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('get', null, null, idOrQuery, opts))
          }
          return call(makeCtx('get', idOrQuery, null, {}, opts))
        },
        create(data: Record<string, unknown>, opts?: CallOptions) {
          return call(makeCtx('create', null, data, {}, opts))
        },
        patch(idOrQuery: string | number | Record<string, unknown>, data: Record<string, unknown>, opts?: CallOptions) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('patch', null, data, idOrQuery, opts))
          }
          return call(makeCtx('patch', idOrQuery, data, {}, opts))
        },
        update(idOrQuery: string | number | Record<string, unknown>, data: Record<string, unknown>, opts?: CallOptions) {
          // update is patch's full-replace sibling; same routing.
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('update' as ServiceMethod, null, data, idOrQuery, opts))
          }
          return call(makeCtx('update' as ServiceMethod, idOrQuery, data, {}, opts))
        },
        remove(idOrQuery: string | number | Record<string, unknown>, opts?: CallOptions) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('remove', null, null, idOrQuery, opts))
          }
          return call(makeCtx('remove', idOrQuery, null, {}, opts))
        },
        restore(idOrQuery: string | number | Record<string, unknown>, opts?: CallOptions) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('restore', null, null, idOrQuery, opts))
          }
          return call(makeCtx('restore', idOrQuery, null, {}, opts))
        },
        call(methodName: string, id?: string | number | null, data?: Record<string, unknown> | null, opts?: CallOptions) {
          const ctx = makeCtx(methodName as import('../transport/bridge.ts').ServiceMethod, id ?? null, data ?? null, {}, opts)
          ctx.method = methodName
          return call(ctx)
        },

        // ── Hook-bypass methods ─────────────────────────────────────────────────
        // Calls the raw underlying method directly — no hook pipeline.
        // Intentional escape hatch: reading inside a hook without re-triggering
        // hooks, job handlers that don’t want side-effects, migration scripts.

        async _find(query?: Record<string, unknown>, opts?: CallOptions) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          const ctx = makeCtx('find', null, null, query ?? {}, opts)
          return svc._find(ctx)
        },
        async _get(idOrQuery: string | number | Record<string, unknown>, opts?: CallOptions) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('get', null, null, idOrQuery, opts)
            return svc._get(ctx)
          }
          const ctx = makeCtx('get', idOrQuery, null, {}, opts)
          return svc._get(ctx)
        },
        async _create(data: Record<string, unknown>, opts?: CallOptions) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          const ctx = makeCtx('create', null, data, {}, opts)
          return svc._create(ctx)
        },
        async _patch(idOrQuery: string | number | Record<string, unknown>, data: Record<string, unknown>, opts?: CallOptions) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('patch', null, data, idOrQuery, opts)
            return svc._patch(ctx)
          }
          const ctx = makeCtx('patch', idOrQuery, data, {}, opts)
          return svc._patch(ctx)
        },
        async _remove(idOrQuery: string | number | Record<string, unknown>, opts?: CallOptions) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('remove', null, null, idOrQuery, opts)
            return svc._remove(ctx)
          }
          const ctx = makeCtx('remove', idOrQuery, null, {}, opts)
          return svc._remove(ctx)
        },
        async _restore(idOrQuery: string | number | Record<string, unknown>, opts?: CallOptions) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('restore', null, null, idOrQuery, opts)
            return svc._restore(ctx)
          }
          const ctx = makeCtx('restore', idOrQuery, null, {}, opts)
          return svc._restore(ctx)
        },
      }

      _serviceCallers.set(name, caller)
      return caller
    },

    hooks(map: HookMap): void {
      appHooks = mergeHookMaps(appHooks, map)
      app._appHooks = appHooks
      // If start() has already compiled per-service pipelines, recompile them
      // with the new app-level hooks — otherwise the stale compiled pipelines
      // win in callService() and hooks added after start() silently never run.
      if (services.hasAppHooks) services.setAppHooks(appHooks)
    },

    _appHooks: appHooks,
    _plugins:  [],

    _metricsProviders: new Map<string, () => unknown>(),

    setAuth(auth: import('../auth/types.ts').IAuth): void {
      // Patch auth into the HTTP transport via its public API — must be
      // called before start()
      http.setAuth(auth)
      // Mirror onto app.auth so plugins reading app.auth at register/boot
      // see the patched implementation (channels, custom plugins, etc.)
      app.auth = auth
    },

    configure(plugin: PluginInput): App {
      const p: Plugin = typeof plugin === 'function'
        ? { name: plugin.name || 'anonymous', register: plugin }
        : plugin

      // Run register() synchronously now. boot()/ready()/shutdown() are
      // queued and run during start() / _startForTest() / stop().
      // Run register sync so plugins that add routes / configure middleware
      // are visible immediately. This matches the documented contract:
      // "configure() runs register() synchronously".
      if (p.register) {
        try {
          const result = p.register(app)
          // If register returned a promise, the user opted into async setup —
          // we don't await it (synchronous contract), but its rejection is
          // RECORDED and rethrown by start(): a plugin that failed to
          // register must not let the app boot half-configured.
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).catch(err => {
              console.error(`[Junction] Plugin '${p.name}' register() rejected:`, err)
              _registerFailures.push({ plugin: p.name, err })
            })
          }
        } catch (err) {
          // Sync failure — fail LOUDLY at the configure() call site.
          // (Previously console.error'd and continued half-configured.)
          throw new Error(
            `Plugin "${p.name}" register() failed: ${err instanceof Error ? err.message : err}`,
            { cause: err }
          )
        }
      }

      if (started) {
        // App is already running — register() ran above. boot()/ready() can't,
        // their lifecycle is past. Warn so it's not silent.
        console.warn(
          `[Junction] configure('${p.name}') called after app.start() — ` +
          `register() ran, but boot() and ready() will NOT. ` +
          `Move configure() calls before start() to avoid this.`
        )
        return app
      }

      plugins.push(p)
      ;(app as Record<string, unknown>)._plugins = plugins.map(p => p.name)
      return app
    },

    // ── Route shortcuts ──────────────────────────────────────────
    get(path, handler, mw)    { http.router.get(path, handler, mw);    return app },
    post(path, handler, mw)   { http.router.post(path, handler, mw);   return app },
    put(path, handler, mw)    { http.router.put(path, handler, mw);    return app },
    patch(path, handler, mw)  { http.router.patch(path, handler, mw);  return app },
    delete(path, handler, mw) { http.router.delete(path, handler, mw); return app },

    // ── WebSocket shortcut ────────────────────────────────────────
    ws(path, handlers)        { http.ws(path, handlers);               return app },

    // ── _startForTest — test-only lifecycle without port binding ────
    // Mirrors phases 1, 4.5, 4.6 of start() so tests can call
    // app.configure() freely and then have routes + pipelines ready.
    // Never call this in production — use start() instead.
    async _startForTest(): Promise<void> {
      if (started) return  // idempotent — safe to call multiple times

      // Phase 0: security headers
      if ((config.http as Record<string, unknown>)?.helmet !== false) {
        helmet()(app)
      }

      // Phase 1: plugin register() already ran synchronously in configure().
      // Async register() rejections were captured — refuse to boot on them.
      if (_registerFailures.length) {
        const f = _registerFailures[0]
        throw new Error(`Plugin "${f.plugin}" register() rejected: ${f.err instanceof Error ? f.err.message : f.err}`, { cause: f.err })
      }
      // boot() runs here so plugins can do async setup that needs the full app.
      for (const plugin of plugins) {
        await plugin.boot?.(app)
      }

      // Phase 4.5: register service routes AFTER plugins so middleware wraps them
      registerServiceRoutes(app, config.apiPrefix ?? '')

      // Phase 4.6: compile hook pipelines
      services.setAppHooks(app._appHooks)

      started = true
    },

    // ── Start ────────────────────────────────────────────────────
    async start(): Promise<void> {

      // Phase 0a: load junction.config.js and deep-merge into live config.
      // Final priority: defaultConfig < junction.config.js < opts.config.
      //
      // loadConfig() already returns defaultConfig deep-merged with the file
      // config. We then deep-merge opts.config on top so call-site overrides
      // win at the leaf level — opts.config = { http: { compress: false } }
      // no longer clobbers the entire http block from junction.config.js.
      //
      // The previous implementation shallow-assigned only top-level keys
      // missing from opts.config — which silently broke nested overrides.
      try {
        const junctionCfg = await loadConfig(_configPath)
        const merged = deepMerge(
          junctionCfg as Partial<AppConfig>,
          (opts.config ?? {}) as Partial<AppConfig>,
        ) as AppConfig & Record<string, unknown>

        // Mutate `config` in place — preserve the object identity that other
        // subsystems already captured at createApp time.
        for (const key of Object.keys(merged)) {
          (config as Record<string, unknown>)[key] = merged[key]
        }
      } catch (err) {
        // loadConfig/tryImport already treat "file not found" as a normal
        // miss (defaults apply). Reaching this catch means a config file
        // EXISTS but is broken — that must abort startup, not silently
        // boot the app on defaults.
        throw new Error(`[Junction] Failed to load configuration: ${err instanceof Error ? err.message : err}`)
      }

      // Phase 0b: apply security headers — opt-out via config.http.helmet = false
      if ((config.http as Record<string, unknown>)?.helmet !== false) {
        helmet()(app)
      }

      // Phase 1: plugin register() already ran synchronously in configure().
      // Async register() rejections were captured — refuse to boot on them.
      if (_registerFailures.length) {
        const f = _registerFailures[0]
        throw new Error(`Plugin "${f.plugin}" register() rejected: ${f.err instanceof Error ? f.err.message : f.err}`, { cause: f.err })
      }
      // boot() / ready() run later — see phases below.

      // Phase 3: auto-load services — ON BY DEFAULT.
      // Resolution order:
      //   autoload: false            → disabled entirely
      //   opts.autoload (string)     → explicit path (relative to CWD)
      //   _junction.services.dir     → from junction.config.js (relative to CWD)
      //   default                    → './services' next to the ENTRY FILE
      //                                (Bun.main), so `services/` beside your
      //                                app.ts just works with zero config.
      // A missing directory is a silent no-op (the loader returns []), so
      // the default costs nothing for apps without a services/ folder.
      const { resolve: resolvePath, dirname: dirnamePath } = await import('node:path')

      const explicitDir = opts.autoload === false
        ? undefined
        : (opts.autoload
            ?? (config as Record<string, unknown>)._junction?.services?.dir as string | undefined)

      const servicesDir = opts.autoload === false
        ? undefined
        : explicitDir
          ? resolvePath(process.cwd(), explicitDir)        // explicit → CWD-relative
          : typeof Bun !== 'undefined' && Bun.main
            ? resolvePath(dirnamePath(Bun.main), 'services') // default → beside the entry file
            : undefined

      if (servicesDir) {
        await autoloadServices({
          dir:      servicesDir,
          app,
          registry: services,
        })
      }

      // Phase 4: boot plugins
      for (const plugin of plugins) {
        try {
          await plugin.boot?.(app)
        } catch (err) {
          throw new Error(`Plugin "${plugin.name}" boot failed: ${(err as Error).message}`)
        }
      }

      // Phase 4.5: register built-in service routes NOW — after plugins have
      // called configure() and patchRouterWithMiddleware() during Phase 1.
      // Registering earlier (at createApp() time) means these routes are added
      // before CORS/helmet/rateLimit middleware patches the router, so they'd
      // never receive those headers.
      registerServiceRoutes(app, config.apiPrefix ?? '')

      // Phase 4.6: tell the registry about app-level hooks so it can compile
      // merged pipelines for every service now, and for any service registered
      // later (e.g. inside a plugin's ready() or by user code after start()).
      // This replaces the old manual loop and also covers the staleness bug
      // where services registered after start() never got compiled pipelines.
      services.setAppHooks(app._appHooks)

      // Phase 5: start HTTP server (builds route cache)
      const server = http.start()

      // Phase 6: ready hooks
      for (const plugin of plugins) {
        try {
          await plugin.ready?.(app)
        } catch (err) {
          console.error(`Plugin "${plugin.name}" ready error:`, err)
        }
      }

      started = true

      // Phase 7: register shutdown handlers — exactly once per app, and
      // removable on stop(). Process exit belongs HERE (a signal means
      // "terminate"), not inside stop() itself: stop() must be callable
      // by tests and embedders without killing their process. Repeated
      // start() calls no longer stack additional listeners.
      if (!_signalHandler) {
        _signalHandler = () => {
          app.stop()
            .then(() => process.exit(0))
            .catch(() => process.exit(1))
        }
        process.on('SIGTERM', _signalHandler)
        process.on('SIGINT',  _signalHandler)
      }

      events.emit('app:ready', { port: config.port })

      const _base   = `http://${config.hostname}:${config.port}`
      const _prefix = config.apiPrefix ?? ''
      const _hasHealth = http.router.hasRoute?.('GET', '/health') ?? http.router.hasRoute?.('GET', `${_prefix}/health`)
      const _hasDocs   = http.router.hasRoute?.('GET', '/docs')   ?? http.router.hasRoute?.('GET', `${_prefix}/docs`)

      logger.info(`🚀 ${config.name} v${config.version}`, {
        url:      _base,
        routes:   http.router.routeCount,
        services: services.list().length,
        prefix:   _prefix || undefined,
        health:   _hasHealth ? `${_base}/health` : undefined,
        docs:     _hasDocs   ? `${_base}/docs`   : undefined,
        mode:     config.debug ? 'debug' : 'production',
      })
    },

    // ── Stop ─────────────────────────────────────────────────────
    async stop(): Promise<void> {

      logger.info('[App] Shutting down...')

      events.emit('app:shutdown')

      // Stop accepting new connections immediately, then give in-flight
      // requests a grace period to complete before tearing down subsystems.
      // Bun's server.stop() without force:true waits for open connections —
      // we couple that with a timeout so a hung connection can't stall shutdown.
      const drainMs = config.http?.drainTimeout ?? 5_000
      await Promise.race([
        http.stop(),
        new Promise<void>(resolve => setTimeout(resolve, drainMs))
      ])

      // Shutdown plugins in reverse order
      for (const plugin of [...plugins].reverse()) {
        try {
          await plugin.shutdown?.(app)
        } catch (err) {
          console.error(`Plugin "${plugin.name}" shutdown error:`, err)
        }
      }

      scheduler.destroy()
      cache.destroy()

      // Destroy the per-app service cache (entries + GC timer). Created
      // lazily by cache-declaring services — see resolveCache in service.ts.
      const svcCache = (app as unknown as { _serviceCache?: { destroy(): void } })._serviceCache
      if (svcCache) {
        try { svcCache.destroy() } catch {}
        ;(app as unknown as { _serviceCache?: unknown })._serviceCache = undefined
      }

      // Detach signal handlers so a stopped app can be garbage-collected
      // and repeated app lifecycles in one process don't accumulate
      // listeners (MaxListeners warnings, stale apps kept alive).
      if (_signalHandler) {
        process.removeListener('SIGTERM', _signalHandler)
        process.removeListener('SIGINT',  _signalHandler)
        _signalHandler = null
      }

      started = false

      logger.info('[App] Shutdown complete.')
      // NOTE: stop() no longer calls process.exit(). Standalone apps exit
      // via the signal handler installed in start(); tests and embedders
      // get a clean, non-fatal shutdown.
    }
  }

  // ── Litestone scoping ──────────────────────────────────────────────────
  // A client exposing $setAuth is a Litestone client, and every request must
  // run against a caller-scoped copy of it — that is what makes @@gate and
  // @@allow see who is asking. Installing it is not a decision: without it
  // services run against the root client, policies compare against a null
  // auth() and match nothing, so the app looks broken rather than insecure.
  //
  // Installed here, after app.hooks() exists, so it composes with anything the
  // application adds later. ctx.auth.user is populated by the transport bridge
  // before callService(), so it is always available by the time this runs.
  //
  // withLitestoneDb does the $setAuth itself, so this covers services built
  // for every service. Scoping used to live in one of two service factories,
  // so which one you chose silently decided whether your row policies worked.
  if (db && typeof (db as { $setAuth?: unknown }).$setAuth === 'function') {
    app.hooks({ around: { all: [withLitestoneDb(db as never)] } })
  }

  return app
}

// ─── Auto service routing ─────────────────────────────────────────────────
// Maps {prefix}/users → services.users (CRUD)
// Maps {prefix}/users/123 → services.users (with id=123)
// Maps {prefix}/servers/123/reboot → servers.reboot (custom method)

export function registerServiceRoutes(app: App, prefix: string): void {

  // Normalise — strip surrounding slashes, re-add leading slash
  const stripped = prefix.replace(/^\/|\/$/g, '')
  const p = stripped ? `/${stripped}` : ''

  // ── CRUD handler ──────────────────────────────────────────────────
  const crudHandler: RouteHandler = async (ctx) => {
    const serviceName = ctx.params.service
    const service     = app.services.get(serviceName)

    if (!service)
      return ctx.json({ name: 'NotFound', message: `Service '${serviceName}' not found`, code: 404 }, 404)

    const model  = (service as unknown as { model?: string }).model ?? serviceName
    // $wrap is a three-state request, not a boolean:
    //   absent      → the default rule (list keeps its envelope, single unwraps)
    //   'true'      → envelope the single too
    //   'false'     → unwrap the list to a bare array (Feathers' paginate:false)
    // It used to be read as `=== 'true'`, so $wrap=false on a list was silently
    // ignored — the only way to get a bare array out of find() was not to ask.
    const rawWrapParam = (ctx.query as Record<string, unknown>)?.['$wrap']
    const wrap: boolean | undefined =
      rawWrapParam === undefined ? undefined : rawWrapParam !== 'false'
    const svcCtx = bridge.toContext(ctx, serviceName, model, 'http', app)

    // Build request-wide metadata once and wrap the whole pipeline run
    // in the ALS store so requestMeta() works at any depth, including
    // across internal app.service() calls — without threading it.
    const meta: RequestMeta = {
      correlationId:  ctx.headers['x-request-id']
        ?? (ctx as unknown as { requestId?: string }).requestId
        ?? crypto.randomUUID(),
      idempotencyKey: ctx.headers['idempotency-key'],
      locale:         ctx.headers['accept-language']?.split(',')[0]?.trim(),
      origin:         'http',
    }

    try {
      return await runWithMeta(meta, async () => {
        await callService(service, svcCtx, app._appHooks, app.events, app.telemetry)
        return bridge.toResponse(svcCtx, wrap)
      })
    } catch (err) {
      const fe = toFrameworkError(err)
      return ctx.json(fe.toJSON(), fe.code)
    }
  }

  // ── Restore handler ───────────────────────────────────────────────
  // PUT /{service}/{id} + X-Service-Method: restore
  // POST /{service}/{id} + X-Service-Method: {action} — custom actions
  // All dispatched via crudHandler — bridge reads the header and sets ctx.method.

  // ── Route registration ────────────────────────────────────────────

  // Collection — find, create, bulk patch/delete, upsert
  app.get(`${p}/{service}`,        crudHandler)
  app.post(`${p}/{service}`,       crudHandler)
  app.patch(`${p}/{service}`,      crudHandler)
  app.delete(`${p}/{service}`,     crudHandler)
  app.put(`${p}/{service}`,        crudHandler)   // bulk restore

  // Resource — get, patch, delete, restore, custom actions (via X-Service-Method)
  app.get(`${p}/{service}/{id}`,    crudHandler)
  app.post(`${p}/{service}/{id}`,   crudHandler)  // custom actions
  app.patch(`${p}/{service}/{id}`,  crudHandler)
  app.put(`${p}/{service}/{id}`,    crudHandler)  // restore via header
  app.delete(`${p}/{service}/{id}`, crudHandler)
}
