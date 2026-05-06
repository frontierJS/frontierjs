// core/app.ts
// The framework entry point — createApp() wires all subsystems together.
// Lifecycle: configure → start → ready → (running) → shutdown
// Plugin system: Option C hybrid — simple fn or full lifecycle object.

import { HttpTransport }            from '../transport/http.ts'
import { bridge, type ServiceContext, type ServiceMethod } from '../transport/bridge.ts'
import { ServiceRegistry, callService } from './service.ts'
import { createEventBus }           from '../events/index.ts'
import { createMemoryCache }        from '../cache/index.ts'
import { createScheduler }          from '../plugins/scheduler/index.ts'
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
import type { AIRegistry }          from '../plugins/ai/index.ts'
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

  // Database — bun:sqlite, WAL mode, foreign keys

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
  //     open(ctx)           { ctx.send({ type: 'welcome', room: ctx.params.roomId }) },
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
  mail?:        IMail
  ai?:          AIRegistry
  autoload?:    string    // path to services/ dir — enables auto-discovery
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

// ─── Params shape for internal service calls ─────────────────────────────
export type ServiceParams = Partial<Omit<ServiceContext['params'], 'query'>>

export interface ServiceCaller {
  find(query?: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  get(id: string | number, params?: ServiceParams): Promise<unknown>
  get(query: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  create(data: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  patch(id: string | number, data: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  patch(query: Record<string, unknown>, data: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  remove(id: string | number, params?: ServiceParams): Promise<unknown>
  remove(query: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  restore(id: string | number, params?: ServiceParams): Promise<unknown>
  restore(query: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  call(name: string, id?: string | number | null, data?: Record<string, unknown> | null, params?: ServiceParams): Promise<unknown>

  // ── Hook-bypass methods ────────────────────────────────────────────────────
  // Skip the hook pipeline — call the raw method directly.
  // Use when you explicitly don’t want side-effects (publish, audit, cache-bust).
  // For everything else, use the unprefixed methods.
  _find(query?: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  _get(id: string | number, params?: ServiceParams): Promise<unknown>
  _get(query: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  _create(data: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  _patch(id: string | number, data: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  _patch(query: Record<string, unknown>, data: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  _remove(id: string | number, params?: ServiceParams): Promise<unknown>
  _remove(query: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
  _restore(id: string | number, params?: ServiceParams): Promise<unknown>
  _restore(query: Record<string, unknown>, params?: ServiceParams): Promise<unknown>
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
  const events    = createEventBus()
  const telemetry = createEventBus()
  const cache     = createMemoryCache({
    defaultTtl: config.cache.defaultTtl,
    maxSize:    config.cache.maxSize,
  })
  const scheduler = createScheduler()
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
      function makeCtx(
        method: ServiceMethod,
        id:     string | number | null,
        data:   Record<string, unknown> | null,
        query:  Record<string, unknown> = {},
        params: ServiceParams = {}
      ): ServiceContext {
        return {
          service:   name,
          method,
          type:      'before',
          transport: 'internal',
          model:     name,
          id:        id ?? null,
          query,
          data,
          params: {
            headers: {},
            ip:      '127.0.0.1',
            user:    null,
            ...params,
          },
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
        return ctx.result
      }

      return {
        find(query?: Record<string, unknown>, params?: ServiceParams) {
          return call(makeCtx('find', null, null, query ?? {}, params))
        },
        get(idOrQuery: string | number | Record<string, unknown>, params?: ServiceParams) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('get', null, null, idOrQuery, params))
          }
          return call(makeCtx('get', idOrQuery, null, {}, params))
        },
        create(data: Record<string, unknown>, params?: ServiceParams) {
          return call(makeCtx('create', null, data, {}, params))
        },
        patch(idOrQuery: string | number | Record<string, unknown>, data: Record<string, unknown>, params?: ServiceParams) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('patch', null, data, idOrQuery, params))
          }
          return call(makeCtx('patch', idOrQuery, data, {}, params))
        },
        remove(idOrQuery: string | number | Record<string, unknown>, params?: ServiceParams) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('remove', null, null, idOrQuery, params))
          }
          return call(makeCtx('remove', idOrQuery, null, {}, params))
        },
        restore(idOrQuery: string | number | Record<string, unknown>, params?: ServiceParams) {
          if (typeof idOrQuery === 'object') {
            return call(makeCtx('restore', null, null, idOrQuery, params))
          }
          return call(makeCtx('restore', idOrQuery, null, {}, params))
        },
        call(methodName: string, id?: string | number | null, data?: Record<string, unknown> | null, params?: ServiceParams) {
          const ctx = makeCtx(methodName as import('../transport/bridge.ts').ServiceMethod, id ?? null, data ?? null, {}, params)
          ctx.method = methodName
          return call(ctx)
        },

        // ── Hook-bypass methods ─────────────────────────────────────────────────
        // Calls the raw underlying method directly — no hook pipeline.
        // Intentional escape hatch: reading inside a hook without re-triggering
        // hooks, job handlers that don’t want side-effects, migration scripts.

        async _find(query?: Record<string, unknown>, params?: ServiceParams) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          const ctx = makeCtx('find', null, null, query ?? {}, params)
          return svc._find(ctx)
        },
        async _get(idOrQuery: string | number | Record<string, unknown>, params?: ServiceParams) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('get', null, null, idOrQuery, params)
            return svc._get(ctx)
          }
          const ctx = makeCtx('get', idOrQuery, null, {}, params)
          return svc._get(ctx)
        },
        async _create(data: Record<string, unknown>, params?: ServiceParams) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          const ctx = makeCtx('create', null, data, {}, params)
          return svc._create(ctx)
        },
        async _patch(idOrQuery: string | number | Record<string, unknown>, data: Record<string, unknown>, params?: ServiceParams) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('patch', null, data, idOrQuery, params)
            return svc._patch(ctx)
          }
          const ctx = makeCtx('patch', idOrQuery, data, {}, params)
          return svc._patch(ctx)
        },
        async _remove(idOrQuery: string | number | Record<string, unknown>, params?: ServiceParams) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('remove', null, null, idOrQuery, params)
            return svc._remove(ctx)
          }
          const ctx = makeCtx('remove', idOrQuery, null, {}, params)
          return svc._remove(ctx)
        },
        async _restore(idOrQuery: string | number | Record<string, unknown>, params?: ServiceParams) {
          const svc = services.get(name)
          if (!svc) throw new NotFound(`Service '${name}' not found`)
          if (typeof idOrQuery === 'object') {
            const ctx = makeCtx('restore', null, null, idOrQuery, params)
            return svc._restore(ctx)
          }
          const ctx = makeCtx('restore', idOrQuery, null, {}, params)
          return svc._restore(ctx)
        },
      }
    },

    hooks(map: HookMap): void {
      appHooks = mergeHookMaps(appHooks, map)
      app._appHooks = appHooks
    },

    _appHooks: appHooks,
    _plugins:  [],

    _metricsProviders: new Map<string, () => unknown>(),

    setAuth(auth: import('../auth/types.ts').IAuth): void {
      // Patch auth into the HTTP transport — must be called before start()
      ;(http as Record<string, unknown>)._opts =
        Object.assign((http as Record<string, unknown>)._opts as object, { auth })
      // Mirror onto app.auth so plugins reading app.auth at register/boot
      // see the patched implementation (channels, custom plugins, etc.)
      app.auth = auth
    },

    configure(plugin: PluginInput): App {
      const p: Plugin = typeof plugin === 'function'
        ? { name: plugin.name || 'anonymous', register: plugin }
        : plugin

      if (started) {
        // App is already running — run register() immediately so plugins
        // that add routes or hooks still work. Log a warning because boot()
        // and ready() will NOT run — those lifecycle phases are already past.
        console.warn(
          `[Junction] configure('${p.name}') called after app.start() — ` +
          `register() will run now, but boot() and ready() will NOT. ` +
          `Move configure() calls before start() to avoid this.`
        )
        if (p.register) {
          Promise.resolve(p.register(app)).catch(err =>
            console.error(`[Junction] Plugin '${p.name}' register() failed:`, err)
          )
        }
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

      // Phase 1: register all plugins (adds middleware, healthPlugin routes, etc.)
      for (const plugin of plugins) {
        await plugin.register?.(app)
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
      } catch {
        // No junction.config.js found — use defaults, no error
      }

      // Phase 0b: apply security headers — opt-out via config.http.helmet = false
      if ((config.http as Record<string, unknown>)?.helmet !== false) {
        helmet()(app)
      }

      // Phase 1: register all plugins
      for (const plugin of plugins) {
        try {
          await plugin.register?.(app)
        } catch (err) {
          throw new Error(`Plugin "${plugin.name}" register failed: ${(err as Error).message}`)
        }
      }

      // Phase 3: auto-load services
      // opts.autoload → explicit path wins
      // _junction.services.dir → from junction.config.js
      // Neither → skip
      const rawServicesDir = opts.autoload
        ?? (config as Record<string, unknown>)._junction?.services?.dir as string | undefined

      // Resolve relative to CWD — import() inside loader.ts would resolve
      // relative to the junction package otherwise
      const { resolve: resolvePath } = await import('node:path')
      const servicesDir = rawServicesDir
        ? resolvePath(process.cwd(), rawServicesDir)
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

      // Phase 7: register shutdown handler
      process.on('SIGTERM', () => app.stop())
      process.on('SIGINT',  () => app.stop())

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

      logger.info('[App] Shutdown complete.')
      process.exit(0)
    }
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
    const wrap   = (ctx.query as Record<string, unknown>)?.['$wrap'] === 'true'
    const svcCtx = bridge.toContext(ctx, serviceName, model, 'http', app)

    try {
      await callService(service, svcCtx, app._appHooks, app.events, app.telemetry)
      return bridge.toResponse(svcCtx, wrap)
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
