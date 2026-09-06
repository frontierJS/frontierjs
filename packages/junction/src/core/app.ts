// core/app.ts
// The framework entry point — createApp() wires all subsystems together.
// Lifecycle: configure → start → ready → (running) → shutdown
// Plugin system: Option C hybrid — simple fn or full lifecycle object.

import { HttpTransport }            from '../transport/http.ts'
import { bridge, errorResponse } from '../transport/bridge.ts'
import { freezeUser, enterRequest, requestMeta, currentCall, resolvePrincipal, inheritedClient, withCallEffects, type ServiceContext, type ServiceMethod, type CallOptions } from './context.ts'
import { ServiceRegistry, callService } from './service.ts'
import { unwrapResult } from './envelope.ts'
import { withLitestoneDb, withTenantDb, tenantClaimGuard, describeDataRealm, announceDataWrites, installLogContext, installQueryTelemetry, registerAuditMetrics, PRINCIPAL_RESOLVER, TENANT_REGISTRY } from './litestone.ts'
import { configFor, createTenantConfigStore } from './config-scope.ts'
import type { TenantConfigOptions, TenantConfigStore } from './config-scope.ts'
import { createEventBus }           from '../events/index.ts'
import { createMemoryCache }        from '../cache/index.ts'
import { createScheduler }          from '../scheduler/index.ts'
import { createDatabase, type DatabaseClient } from '../storage/database/index.ts'
import { autoloadServices }         from './loader.ts'
import { resolveServicesDir, describeServicesDir, type ServicesDirResolution } from './services-dir.ts'
import { checkAttachments, formatAttachmentRefusal, formatAttachmentSkips } from './attachments.ts'
import { resolveBuildId } from './build-id.ts'
import { mergeHookMaps, type HookMap } from './hooks.ts'
import { toFrameworkError, NotFound }   from './errors.ts'
import { helmet, cors }                 from '../transport/middleware.ts'
import { defaultConfig, deepMerge, loadConfig, unknownSections } from '../config/index.ts'
import type { DeepPartial }                     from '../config/index.ts'
import { createLogger, noopLogger }             from './logger.ts'
import type { ILogger, LoggerOptions }          from './logger.ts'
import type { AppConfig }                          from '../config/index.ts'
import type { IAuth, SessionVerifier } from '../auth/types.ts'
import type { IMail }               from '../mail/index.ts'
import type { IFileStorage }        from '../storage/filestorage/index.ts'
import type { ICache }              from '../cache/index.ts'
import type { IEventBus }           from '../events/index.ts'
import type { AIRegistry }          from '../ai/index.ts'
import type { RouteHandler, MiddlewareFn, WsHandlerSet } from '../transport/types.ts'

// ─── Shutdown ─────────────────────────────────────────────────────────────

/**
 * Wait for `work`, or give up after `ms` and carry on.
 *
 * Nothing in JavaScript cancels a promise, so a step that eventually settles
 * does so into a void. That is the honest shape and it is why `onTimeout` says
 * so out loud — a step silently not running is the failure this exists for.
 *
 * The timer is REF'd. An unref'd one is the bug itself: with every remaining
 * timer unref'd the loop empties and node exits **0**, which is what an
 * orchestrator reads as a clean stop (`FJS-693`).
 */
async function withDeadline(work: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms) })
  try {
    if (await Promise.race([work.then(() => 'done' as const), deadline]) === 'timeout') onTimeout()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ─── Plugin interface ─────────────────────────────────────────────────────

/**
 * The simplest plugin: a function. `app.configure(app => { ... })`.
 *
 * Returns `void`, not `void | Promise<void>` — see Plugin.register below for why.
 */
export type PluginFn = (app: App) => void

export interface Plugin {
  name:       string

  /**
   * Synchronous setup, run immediately by configure().
   *
   * Declared `=> void` deliberately. configure() does NOT await this — the
   * documented contract is "configure() runs register() synchronously", so
   * routes and middleware are visible the moment configure() returns. The
   * signature used to say `void | Promise<void>`, advertising exactly the
   * opposite of what happens: an async register()'s side effects might not
   * have landed before the next configure() ran or before start() read state.
   *
   * TypeScript's void-return rule still *permits* passing an async function
   * here, so this is a statement of contract rather than a hard barrier —
   * configure() therefore also warns at runtime if register() returns a
   * thenable, and still records its rejection so start() can fail loudly.
   *
   * Anything async belongs in boot().
   */
  register?:  (app: App) => void

  boot?:      (app: App) => void | Promise<void>
  ready?:     (app: App) => void | Promise<void>
  shutdown?:  (app: App) => void | Promise<void>

  /**
   * Names of plugins that must already be configured when this one boots.
   *
   * Checked once at startup against app._plugins, before any boot() runs, and
   * throws naming both the dependent and what is missing. Ordering used to be
   * nothing but the sequence of configure() calls, so a requirement like
   * "mailerPlugin must be configured before notificationsPlugin" could only
   * live in prose — and was discovered at first send, not at startup.
   *
   * @example requires: ['mailer']
   */
  requires?:  string[]
}

export type PluginInput = PluginFn | Plugin

// ─── App interface ────────────────────────────────────────────────────────

/**
 * The shape of `app.conduit`.
 *
 * Empty here on purpose: Junction must not depend on @frontierjs/conduit.
 * That package augments this interface with its full `IConduit`, so a project
 * that installs conduit gets real types on `app.conduit` everywhere, and a
 * project that doesn't sees an empty object rather than a lie.
 *
 * Augment it, don't redeclare `App.conduit` — see the note on the field.
 */
export interface AppConduit {}

/**
 * The shape of `app.db`.
 *
 * Empty here for the same reason as `AppConduit` above and with the opposite
 * problem: Junction genuinely does not know what the client is — a Litestone
 * client and a plain table-shaped object are both valid, and `createBaseService`
 * adapts the latter. It was `unknown`, which is honest and unusable: an app
 * cannot narrow it, because Invariant 5 rules that a property is typed by
 * AUGMENTING an exported interface and never by redeclaring it (declaration
 * merging requires identical types, so a redeclaration silently loses). So the
 * largest app in this repo claimed a SECOND name for the identical object —
 * `app.data` — and read it 29 times against `app.db`'s three (`FJS-532`).
 *
 * Empty accepts any object, so assignment stays as permissive as `unknown` was.
 * The augmenter here is usually the APP rather than a package, which changes
 * nothing about how it works:
 *
 *   declare module '@frontierjs/junction' {
 *     interface AppDb extends MyLitestoneClient {}
 *   }
 */
export interface AppDb {}

/**
 * The shape of `app.jobs`.
 *
 * Same contract as AppConduit above: empty here so Junction keeps no dependency
 * on @frontierjs/caravan, and that package augments this interface with its
 * full `CaravanInstance`. Augment it, don't redeclare `App.jobs`.
 */
export interface AppJobs {}

/**
 * The shape of `app.notify`.
 *
 * Same contract as AppConduit / AppJobs: empty here so Junction keeps no
 * dependency on @frontierjs/notifications, and that package augments this
 * interface with its real call signature. Augment it, don't redeclare
 * `App.notify`.
 *
 * It is an interface rather than a function type because only an interface can
 * be augmented across packages — the augmenting package adds a call signature:
 *
 *   declare module '@frontierjs/junction' {
 *     interface AppNotify {
 *       (user: User, notification: Notification): Promise<void>
 *     }
 *   }
 *
 * Until something augments it, calling `app.notify(...)` is a type error
 * (TS2349, "this expression is not callable") — verified, not assumed. That is
 * the honest result: an app that has not installed the notifications package
 * has no notify to call, and the empty interface says so rather than widening
 * to `any` and letting a wrong call through.
 */
export interface AppNotify {}

/** What `app.runAs` may be told beyond the principal. */
export interface RunAsOptions {
  /**
   * WHICH TENANT this work is for.
   *
   * Absent inherits the tenant in scope; `null` states that the work belongs
   * to no tenant, which is the app's own work — the same absent-is-not-null
   * rule `auth` follows one field over.
   */
  tenant?: string | null
}

/**
 * A second listener the app started beside itself — announced, never managed.
 *
 * `note` is what a person does with it once they have the URL, in the app's own
 * words: an inbox to open, the one endpoint worth curling. Nothing parses it.
 */
export interface DevService {
  name:  string
  url:   string
  note?: string
}

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
   *
   * Augment `AppDb`, don't redeclare this field.
   */
  db?:       AppDb

  /** The tenant registry, when `createApp({ tenants })` was given one. */
  tenants?:  import('./litestone.ts').TenantRegistryLike

  // Subsystems — accessed directly
  logger:    ILogger
  services:  ServiceRegistry
  events:    IEventBus
  telemetry: IEventBus   // low-level instrumentation bus — subscribe to 'junction.call'
  cache:     ICache
  scheduler: ReturnType<typeof createScheduler>
  http:      HttpTransport

  // Optional — registered via configure()
  auth?:     SessionVerifier
  mail?:     IMail
  ai?:       AIRegistry
  email?:    import('../plugins/email/types.ts').IEmail
  // Conduit is provided by @frontierjs/conduit. Typed as the augmentable
  // AppConduit below rather than `unknown`, so in-tree code (email/campaign)
  // can read app.conduit without a hard dep AND the conduit package can
  // contribute the real type.
  //
  // This must stay an interface reference, not a redeclared property:
  // declaration merging requires every declaration of a property to have
  // an identical type, so `conduit?: unknown` here plus `conduit?: IConduit`
  // in the augmenting package is an error (TS2717) and the augmentation
  // silently loses — which is exactly what used to happen.
  conduit?:  AppConduit

  // Job queue is provided by @frontierjs/caravan. Same augmentable-interface
  // rule as `conduit` above — never redeclare this property in the plugin.
  jobs?:     AppJobs

  // The outbox relay, when `app.configure(outbox())` installed one. Declared
  // concretely rather than as an augmentable slot: unlike conduit and caravan
  // this plugin ships inside junction, so there is no dependency to avoid.
  // `ctx.enqueue` refuses when it is absent — a row nothing delivers is worse
  // than a refusal.
  outbox?:   import('./outbox.ts').OutboxApi

  // Notifications are provided by @frontierjs/notifications, which attaches
  // app.notify in its register(). Same augmentable-interface rule: the plugin
  // adds the call signature to AppNotify, it does not redeclare this property.
  //
  // Without this field the plugin had no typed seam at all, so it declared its
  // OWN `App` shape instead — which is how its `MailMessage` came to disagree
  // with junction's `IMail` (authoring shape `{subject, lines}` vs wire shape
  // `{subject, html, text}`) with no compiler anywhere to notice. Every
  // notification email went out with an empty body.
  notify?:   AppNotify

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
  // query, etc.) — same as Feathers's default behavior.
  // The principal PROPAGATES: a call that names none inherits the one in scope,
  // at any depth. There is nothing to thread — passing `ctx.params` was the old
  // advice and `ctx.params` is not a thing a ServiceContext has.
  //
  //   // Inherits the caller — the ordinary case:
  //   const owner = await app.service('users').get(ctx.data.userId)
  //
  //   // Deliberately as nobody. Absent is not null:
  //   await app.service('audit').create({ action: 'x' }, { auth: { user: null } })
  //
  //   // Deliberately as someone else:
  //   await app.service('servers').call('reboot', serverId, { auth: { user: SYSTEM } })
  service: (name: string) => ServiceCaller

  /**
   * WHO is in scope right now — the request-wide principal, or null.
   *
   * The same value `ctx.auth.user` shows, asked from somewhere that holds no
   * ctx: a plugin's own route, a scheduler tick, the code that enqueues a job.
   * Reading it is how work that outlives the request records who asked for it.
   */
  principal: () => import('../auth/types.ts').SessionContext | null

  /**
   * WHICH TENANT is in scope right now, or null.
   *
   * The sibling of `principal()` and asked in the same place: the code that
   * enqueues a job records both, because work that outlives the request has to
   * be told both when it runs. Null where the app declares no tenancy.
   */
  tenant: () => string | null

  /**
   * The id of the request in scope right now, or null.
   *
   * Third sibling of `principal()` and `tenant()`, asked in the same place and
   * for the same reason: work that outlives the request has to be able to name
   * the request it came from, or a job and the call that queued it share no id
   * in any log.
   */
  correlationId: () => string | null

  /**
   * What this app is configured with, for a tenant.
   *
   * The no-call half of `$.config`: a job, a boot task, a raw route or a script
   * holds no service call, and `$` refuses outside one by design. Defaults to
   * the tenant in scope.
   *
   * **Read-only, deep.** A write throws by name rather than landing, because a
   * value written into a shared config is visible to the next caller — who may
   * be a different tenant. That is the one rule the whole arrangement rests on,
   * and it is the rule the per-request-rebind implementations of this cannot
   * have (`core/config-scope.ts` has the argument).
   *
   * Today it answers `app.config` for every tenant, identically — where the
   * value comes from is `FJS-D126` and unruled. Adopting it is a statement about
   * WHEN a value is read and none about what it is.
   */
  /** The tenant-config store, or null where the app declared none. Read by
   *  `configFor` and by `junction principal`. */
  tenantConfig: TenantConfigStore | null

  configFor: (tenantId?: string | null) => AppConfig

  /**
   * Resolve and memoise a tenant's configuration.
   *
   * The async half of `configFor`, which is a property read and cannot await.
   * Called for you by the hook that establishes the tenant and by `runAs`, so an
   * ordinary request and an ordinary job both find it warm; call it by hand from
   * anything that reaches a tenant another way.
   */
  loadTenantConfig: (tenantId: string) => Promise<AppConfig>

  /** Forget a tenant's memoised config, or every tenant's. The explicit
   *  invalidation, because a memo with no way out is a config change that needs
   *  a restart. */
  invalidateTenantConfig: (tenantId?: string) => void

  /**
   * Run `fn` on behalf of a principal, RESOLVED NOW.
   *
   * The seam deferred work runs through. A job, a retry or a scheduled sweep
   * executes long after the request that asked for it, and until it opens a
   * scope it has no principal at all — which is STRANGER(0), refused by the
   * model's own `@@gate`, and the reason every job used to carry a hand-written
   * `{ auth: { user: SYSTEM } }`.
   *
   *   a userId → re-resolved through `auth.sessionFor()`. Deliberately not a
   *              stored snapshot: a caller demoted between asking and running
   *              must be graded at the standing they hold NOW, and a snapshot
   *              is a captured privilege that outlives the revocation.
   *   null     → the app's own system principal, `createApp({ system })`.
   *              Nobody, if the app declared none.
   *
   * Inside, `auth` propagates as it does anywhere else, so a service call made
   * by `fn` names no principal and inherits this one.
   *
   * **`{ tenant }` is the other half of the same question**, and it is a
   * separate argument because it is a separate fact: WHO is re-resolved and
   * WHERE is stated. Under `strategy database` it selects the client every
   * call inside `fn` runs through; under `strategy row` it is what the
   * principal resolver reads when a job has no header to read one from. A
   * tenant is a pointer to a set of rows and never an authority — the standing
   * that decides what may be done with them is still re-derived from the
   * principal, which is why storing one alongside a job is not the captured
   * privilege a stored session would be.
   */
  runAs: <T>(
    userId: string | null,
    optsOrFn: RunAsOptions | ((user: import('../auth/types.ts').SessionContext | null) => T | Promise<T>),
    fn?: (user: import('../auth/types.ts').SessionContext | null) => T | Promise<T>,
  ) => Promise<T>

  // App-level hooks — applied to every service call
  hooks:     (map: HookMap) => void

  // Plugin registration — can be called anytime before start()
  configure: (plugin: PluginInput) => App
  setAuth:   (auth: import('../auth/types.ts').SessionVerifier) => void

  /**
   * Claim a namespace on the app, failing loudly if it is already taken.
   *
   * Plugins attach their surface by plain assignment — `app.conduit = instance`,
   * `app.jobs = caravan`, `app.notify = fn`. Two plugins claiming one name is a
   * silent last-write-wins, and the loser simply stops working with no error
   * anywhere. This is the runtime complement to the augmentable-interface
   * pattern (AppConduit / AppJobs / AppNotify) that already handles the types.
   *
   * It assigns the REAL property, so augmented types keep resolving:
   * `app.claim('conduit', c)` still leaves `app.conduit` typed as AppConduit.
   *
   *   app.claim('conduit', instance)   // throws if anything already claimed it
   *
   * The verb is `claim` and not `provide` because nothing is provided here — a
   * Provider is a third party the app speaks to (`FJS-D06`), and this only takes
   * a name on the app object.
   */
  claim:     (name: string, value: unknown) => void

  /**
   * Contribute a section to `GET /metrics`, keyed by plugin name.
   *
   * The blessed replacement for reaching into `app._metricsSources` — a plugin
   * doing that is guessing at a private field, and the guess fails SILENTLY:
   * caravan and conduit both guarded with `instanceof Map`, so a renamed field
   * meant metrics quietly stopped appearing with no error anywhere.
   */
  registerMetricsSource: (name: string, fn: () => unknown) => void

  /**
   * Contribute a readiness check to `GET /health`, keyed by plugin name.
   *
   * The sibling of `registerMetricsSource`, and it did not exist: `checks` was
   * an option on `healthPlugin()` alone, so the only thing that could declare a
   * check was the app author — a plugin owning the resource that fails (a job
   * queue's own database, an outbox relay that has stopped passing) had no way
   * to say so, and every app hand-wrote the probe or went without.
   *
   * `false` or a throw is a failing check; a throw's message is reported.
   */
  registerHealthCheck: (name: string, fn: () => boolean | Promise<boolean>) => void

  /**
   * Announce a SECOND LISTENER this app started — a dev mail catcher, a stand-in
   * payment provider, an identity provider running for the dev flow.
   *
   * The banner is derived from MOUNTED ROUTES, and a second listener has none:
   * it is its own server on its own port, so the one place an app says what it
   * is serving could not name it. `_devtools` is the same problem solved once
   * for one case; this is the general one, because the app itself is the only
   * thing that knows a sidecar exists.
   *
   * Announcing is all it does. Junction does not start, stop, health-check or
   * own the process — a register that implied otherwise would be a supervisor,
   * and the caller already holds the handle it needs to stop it.
   *
   * Keyed by name, so a re-register replaces rather than duplicates.
   */
  registerDevService: (svc: DevService) => void

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
  /** Plugin-registered metrics sources — keyed by plugin name. Each returns an
   *  object merged into GET /metrics. Write through `registerMetricsSource`;
   *  this is the store, not the seam. */
  _metricsSources: Map<string, () => unknown>
  /** Plugin-registered readiness checks — keyed by plugin name. Write through
   *  `registerHealthCheck`; this is the store, not the seam. */
  _healthChecks: Map<string, () => boolean | Promise<boolean>>
  /** The checks the APP declared, through `healthPlugin({ checks })`. Kept
   *  apart from the plugin registry rather than merged into it, because the
   *  precedence between them is by OWNER and not by who configured first: an
   *  app naming `db` means its own probe, whether it configured the health
   *  plugin before or after the plugin that registered one. Held on the app so
   *  every reader sees the same set — the devtools console answers readiness on
   *  its own port, and an option living in a plugin closure made it answer a
   *  smaller one than `/health` did. */
  _healthChecksApp: Map<string, () => boolean | Promise<boolean>>
  /** True from the first line of `stop()` until the process goes away.
   *
   *  Readiness has to answer differently while a process is leaving, or a load
   *  balancer keeps sending it traffic: measured, a request arriving during the
   *  drain was answered 200 and `/health` stayed 200 throughout (`FJS-693`).
   *  Held on the APP for `_healthChecksApp`'s reason — two surfaces answer
   *  readiness, `/health` and the devtools console on its own port, and a flag
   *  in one closure makes them disagree about whether this process is up. */
  draining: boolean
  /** Whether the devtools console is up, and where.
   *
   *  The startup banner is derived from MOUNTED ROUTES, and the console has
   *  none — it runs its own server on its own port — so it was absent from the
   *  one place an app says what it is serving, and an app with it switched off
   *  was indistinguishable from an app whose console had quietly refused to
   *  bind. `off` and `refused` are separate for that reason.
   *
   *  Junction's own plugin, so the banner may name it unprompted; a third-party
   *  sidecar announces itself. */
  _devtools: { status: 'off' | 'on' | 'refused', url?: string, reason?: string }
  /** The second listeners the app announced. Write through
   *  `registerDevService`; this is the store, not the seam. */
  _devServices: Map<string, DevService>
  /** Test-only: runs plugin register(), registerServiceRoutes, and setAppHooks
   *  without binding a port. Call once before the first request() in tests. */
  _startForTest: () => Promise<void>

  /**
   * Read `junction.config.js` and merge it under `opts.config`.
   *
   * This IS the `load-config` start phase, exposed because the phase is
   * `needsHost` and `_startForTest()` therefore skips it — so anything a plugin
   * reads out of that file is absent for every caller that boots an app without
   * a port. The snapshot tools are exactly that caller, and `example` declares
   * its `jobsDir` in the file: `junction jobs` reported **no handlers
   * registered** for an app with three (`FJS-418`).
   *
   * Same shape as the autoload workaround beside it in `tools/app-module.ts` —
   * a phase named explicitly and run in the position production runs it, which
   * is BEFORE `_startForTest()`, or a plugin's `boot()` reads the config as it
   * was without the file.
   *
   * Idempotent in effect: the merge is over the same two inputs every time.
   */
  applyConfigFile: () => Promise<void>
}

// ─── createApp ────────────────────────────────────────────────────────────

export interface AppOptions {
  // Deep-partial because that is what the merge does: `http: { helmet: false }`
  // keeps the rest of the http block. A one-level Partial demanded every key
  // of a section back.
  config?:      DeepPartial<AppConfig>  // merged over defaults + junction.config.js
  configPath?:  string              // path to junction.config.js dir, default './api/config'
  logger?:      ILogger             // custom logger — defaults to createLogger()
  logLevel?:    import('./logger.ts').LogLevel   // override log level
  auth?:        SessionVerifier

  /**
   * The principal the app's OWN background work runs as.
   *
   * Deferred work started by nobody — a cron sweep, a boot-time reconciliation
   * — has no caller to inherit, and no caller is STRANGER(0). This is the one
   * place an app says who it is when it acts on its own behalf, and it is
   * graded by the app's own `getLevel` like any other principal:
   *
   *   createApp({ system: { userId: 'system', role: 'system', … } })
   *
   * Declaring none is a valid answer — an app whose background work touches
   * nothing gated needs no system identity, and inventing one would hand every
   * app a privileged principal it never asked for.
   */
  system?:      import('../auth/types.ts').SessionContext

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
  /**
   * Claims resolved per REQUEST and put on the principal, before the Data
   * boundary scopes the client from it (`FJS-D113`).
   *
   * A tenant claim and a per-request standing are the same thing — a value this
   * caller holds for THIS call, one read by a tenancy predicate and one by the
   * gate — and until this existed the only route onto the principal was
   * `sessionFields`, fixed at sign-in. That is one tenant per session, which
   * cannot express a person who belongs to several accounts and holds a
   * different authority in each.
   *
   *   createApp({ db, principal: async (ctx, user) => ({ workspaceId, memberRole }) })
   *
   * Runs only for an authenticated caller, and may not set `userId`/`id` — a
   * claim says what a caller holds, never who they are. `membershipClaim()` is
   * the shipped resolver for the common shape, and it cannot emit a claim it
   * did not verify.
   */
  principal?:   import('./litestone.ts').PrincipalResolver

  /**
   * This tenant's configuration, resolved per tenant and memoised (`FJS-D126`).
   *
   * A resolver rather than a declaration, on `FJS-D113`'s ground: the source is
   * a row for one app, a file for another and a control plane for a third.
   *
   *   createApp({
   *     tenantConfig:     id => db.asSystem().tenantSettings.findUnique({ where: { id } }),
   *     tenantConfigKeys: ['name', 'mail.from', 'branding.logo'],
   *   })
   *
   * `tenantConfigKeys` is required with it and is the half that makes it safe:
   * only the paths it names apply, a resolver answering anything else is refused
   * by name, and `RESERVED_CONFIG_PATHS` is refused at boot.
   */
  tenantConfig?:     TenantConfigOptions['resolve']
  /** The dotted config paths a tenant may override. Required with `tenantConfig`. */
  tenantConfigKeys?: string[]
  /**
   * The tenant registry, for a schema declaring `tenancy { strategy database }`
   * — one SQLite file per tenant, so the CLIENT changes per request.
   *
   * Passing it installs `withTenantDb` in place of `withLitestoneDb`: each call
   * resolves its tenant the way the schema's `resolve` declares (a subdomain, a
   * header, a claim), and `ctx.locals.db` is that tenant's caller-scoped
   * client. A call with no request behind it names its tenant with
   * `{ locals: { tenantId } }`.
   *
   * `db` and `tenants` are alternatives, not a pair: one `ctx.locals.db` cannot
   * be assigned by two hooks. `strategy row` needs neither — the schema's own
   * policies scope every query — so pass `db` there as usual.
   */
  tenants?:     import('./litestone.ts').TenantRegistryLike
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
//   ctx.app.service('users').get(userId)               ← inherits the caller
//   ctx.app.service('audit').create({ action: 'x' },
//                   { auth: { user: null } })          ← deliberately as nobody
//   ctx.app.service('servers').call('reboot', id)      ← call a custom method
//
// The second argument is CallOptions, not Feathers' `params`. What varies per
// call goes there — auth, directives, locals — and identity is not one of those
// things by default, because it belongs to the request rather than the call.
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

  // Built here rather than in a start phase, because `assertOverridable` is a
  // BOOT-time refusal by design — a reserved path caught per request is a
  // production incident and one caught at construction is a failed start.
  //
  // The floor is passed as a thunk: `junction.config.js` is deep-merged into
  // `config` during the `load-config` phase, long after this runs, so a captured
  // reference would resolve every tenant over the pre-file defaults.
  if (opts.tenantConfig && !opts.tenantConfigKeys?.length)
    throw new Error(
      '[Junction] createApp({ tenantConfig }) needs tenantConfigKeys — the dotted ' +
      'config paths a tenant may override. Without it the resolver could reach any ' +
      'key at all, and which keys a tenant may set is the half that makes per-tenant ' +
      'configuration safe rather than the half that makes it work.'
    )

  const tenantConfigStore: TenantConfigStore | null = opts.tenantConfig
    ? createTenantConfigStore(() => config, { resolve: opts.tenantConfig, keys: opts.tenantConfigKeys ?? [] })
    : null

  // Every route registered through app.get/post/put/patch/delete is mounted
  // under this. Normalized once — an app may write 'api', '/api' or '/api/'.
  const _apiPrefix = normalizePrefix(config.apiPrefix)
  const prefixPath = (path: string): string => `${_apiPrefix}${path}`

  /**
   * A raw route handler, run inside the request scope.
   *
   * `enterRequest` is the one owner of that store and the service dispatch has
   * opened one for years; a route registered with `app.get`/`app.post` never
   * did, so `requestMeta()` answered `undefined` inside `/auth/login`, inside a
   * webhook, inside any callback URL a plugin mounts — and every reader that
   * has no `ctx` in hand was blind exactly there.
   *
   * The principal is deliberately absent: a raw route is below the service
   * pipeline and `ctx.user` is the transport's own answer, which the route can
   * read directly. What this puts in reach is the REQUEST — its headers, its
   * correlation id, its client — which is what a tenant is resolved from.
   */
  const scoped = <H extends (ctx: any, ...rest: any[]) => unknown>(handler: H): H =>
    (async function scopedRoute(ctx: any, ...rest: any[]) {
      return enterRequest({
        origin:        'http',
        headers:       ctx?.headers ?? {},
        correlationId: ctx?.headers?.['x-request-id'] ?? ctx?.requestId,
        user:          ctx?.user ?? null,
        client:        { ip: ctx?.ip, userAgent: ctx?.headers?.['user-agent'], headers: ctx?.headers ?? {} },
      }, () => handler(ctx, ...rest))
    }) as unknown as H

  // ── Subsystems ───────────────────────────────────────────────────────
  const logger    = opts.logger ?? createLogger({ level: opts.logLevel })
  const services  = new ServiceRegistry()
  // app.service(name) caller memo — see service() below.
  const _serviceCallers = new Map<string, ServiceCaller>()
  // Signal handler installed by start(), removed by stop() — kept here so
  // repeated start() calls never register duplicates.
  // Authoring mistakes found while starting, reported together by the
  // `check-authoring` phase. Collected rather than thrown where they are found:
  // an app has a config, N service files and a hook table, so throwing on the
  // first makes fixing them serial — one boot per typo (`FJS-D199`).
  const _authoringFindings: string[] = []
  // start() is once per app, and this is not `started`: `stop()` clears that
  // one, and a second start() then reached `security-headers` and died on
  // `Cannot add middleware after the router is built` — an internal sentence
  // about a router for a caller whose mistake was calling start() again.
  let _everStarted = false
  let _signalHandler: (() => void) | null = null
  let _rejectionHandler: ((reason: unknown) => void) | null = null
  let _exceptionHandler: ((err: Error) => void) | null = null

  // One way out of a crash, shared by both handlers. Exits 1 whichever way it
  // goes — a crash that shut down tidily is still a crash, and reporting 0
  // there is the same lie the deadline exists to stop.
  // Shut a set of plugins down, reverse order, each bounded. Two callers and
  // they are not the same list: `stop()` passes every plugin, and a `boot()`
  // that threw passes the ones that had already booted — which is why this is a
  // parameter rather than a closure over `plugins`.
  //
  // Bounded and logged rather than thrown: a plugin whose `shutdown()` never
  // settles used to take the whole list with it, so the caravan pool, the
  // outbox relay and the litestone close never ran. A step that silently did
  // not run is the failure this exists to stop.
  const shutdownPlugins = async (list: Plugin[]): Promise<void> => {
    const pluginMs = config.shutdown?.pluginTimeout ?? 5_000
    for (const plugin of [...list].reverse()) {
      if (!plugin.shutdown) continue
      try {
        await withDeadline(
          Promise.resolve(plugin.shutdown(app)),
          pluginMs,
          () => logger.error(
            `plugin '${plugin.name}' shutdown did not finish within ${pluginMs}ms — skipped`),
        )
      } catch (err) {
        logger.error(`plugin '${plugin.name}' shutdown failed`, err as Error)
      }
    }
  }

  const crashStop = () => {
    const ms = config.shutdown?.timeout ?? 15_000
    withDeadline(app.stop(), ms, () => {})
      .then(() => process.exit(1))
      .catch(() => process.exit(1))
  }
  // Async plugin register() rejections, captured by configure() and
  // rethrown by start() — a half-registered plugin must not boot.
  const _registerFailures: Array<{ plugin: string; err: unknown }> = []
  // What `autoload-services` decided, kept so the banner can report a miss.
  // The report is on the banner rather than beside the decision because that
  // phase needs a host: every app mounted by a test runner or a snapshot tool
  // resolves the entry to the runner's own file and finds nothing, which is
  // not news — an app about to SERVE with no services anywhere is.
  let _servicesDir: ServicesDirResolution = { dir: null, source: 'none', probed: [] }
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
    // Both timers, from the config an app already writes. The runtime's own
    // was reachable from nowhere, so its 10-second default reset every slower
    // request with no status and no log line (`FJS-756`).
    idleTimeout:    config.http.idleTimeout,
    requestTimeout: config.http.requestTimeout,
    ddos:        config.http.ddos,
    static:      config.http.static,
    // Which forwarding headers to believe. Declared, never guessed: absent
    // behind a proxy means every caller shares the proxy's bucket, and this
    // was passed from nowhere at all until `FJS-744` — so the transport's
    // option was unreachable and that was the state every deployed app was in.
    trustProxy:  config.http.trustProxy,
    // How much junction holds for a socket that is not draining before it
    // closes it. See outbox.ts — past Bun's own buffer a frame is DROPPED,
    // which is silent at every layer above it.
    wsMaxQueued: config.http.wsMaxQueued,
    ws:          config.http.ws,
    auth:        opts.auth,
    // Cookie mode is normally declared by the auth plugin, which calls
    // http.setAuthCookie() from its own register(). This is the path for a
    // hand-rolled IAuth that issues its own cookie.
    authCookie:  (config as Record<string, unknown>).auth
      ? ((config as { auth?: { cookie?: string } }).auth?.cookie ?? null)
      : null,
    powered:     config.http.powered,
    onError:     (err) => {
      // Through the app's logger, not console: in production the logger is
      // JSON and this was the one thing in the stream that was not, so the
      // errors were the lines a log query could not reach.
      logger.error('http error', err)
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
    // The OPTION stays `unknown` and the field is `AppDb`, which is the one
    // place those two meet. Narrowing the option too would mean an app that
    // augments `AppDb` could no longer pass the plain table-shaped object
    // `createBaseService` adapts — permissive in, typed out.
    db: db as AppDb,
    tenants: opts.tenants,
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
        return withCallEffects({
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
          // PROPAGATES. A caller that says nothing inherits the request's
          // principal from the ALS store the bridge already wraps the whole
          // pipeline in; a caller that says `{ user: null }` means *as
          // nobody* and gets it. Absent ≠ null, tested with `in` rather than
          // `??` — the same rule Invariant 9 makes about a patch, and here it
          // is what lets a service deliberately read as a stranger would.
          auth: { user: resolvePrincipal(opts) },
          // Propagates, like the principal and for the same reason: an audit
          // hook three calls deep has no other route to the IP of the request
          // that caused the write. `{}` when there is no request at all.
          client: inheritedClient(),
          route:  {},
          locals: opts.locals ? { ...opts.locals } : {},
          // Fresh, like locals: a transient value belongs to the call that
          // carried it, and an internal call carries its own payload.
          transients: {},
          reserved:   {},
          app:       app,
          result:    null,
          error:     null,
          statusCode: undefined,
          dispatch:   undefined,
          $raw:       null,
        })
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

    principal(): import('../auth/types.ts').SessionContext | null {
      return requestMeta()?.user ?? null
    },

    tenant(): string | null {
      // The CALL first, then the request. Under `strategy row` the tenant is
      // resolved per call — a claim on the principal, which a service may
      // legitimately re-resolve mid-request against a second tenant — so a
      // request-wide answer would be the wrong one for exactly the caller that
      // has two. Under `strategy database` and for work `runAs` opened, the
      // request-wide answer is the only one there is.
      return currentCall()?.locals?.tenantId ?? requestMeta()?.tenant ?? null
    },

    correlationId(): string | null {
      // The third of the three read at dispatch. Request-wide, unlike the
      // tenant: a correlation id names the REQUEST, and a service that
      // re-resolves a tenant mid-request is still inside the same one.
      return requestMeta()?.correlationId ?? null
    },

    loadTenantConfig(tenantId: string): Promise<AppConfig> {
      return tenantConfigStore
        ? tenantConfigStore.load(tenantId)
        : Promise.resolve(configFor(app, null))
    },

    invalidateTenantConfig(tenantId?: string): void {
      tenantConfigStore?.invalidate(tenantId)
    },

    // Read by `configFor` through its structural `ConfigHost`, and by
    // `junction principal`, which commits the allow-list.
    tenantConfig: tenantConfigStore,

    configFor(tenantId?: string | null): AppConfig {
      // Defaults to the tenant in scope, so the common call is `app.configFor()`
      // and naming one is the deliberate act. Same shape as `tenant()` above and
      // for the same reason: a caller who has to pass what the runtime already
      // knows will eventually pass the wrong one.
      return configFor(app, tenantId === undefined ? app.tenant() : tenantId)
    },

    async runAs<T>(
      userId: string | null,
      optsOrFn: RunAsOptions | ((user: import('../auth/types.ts').SessionContext | null) => T | Promise<T>),
      maybeFn?: (user: import('../auth/types.ts').SessionContext | null) => T | Promise<T>,
    ): Promise<T> {
      // Two arities rather than an options bag on every call: naming a tenant
      // is the uncommon half, and `runAs(id, fn)` is what every existing caller
      // and every job that has no tenancy writes.
      const runOpts = typeof optsOrFn === 'function' ? {} : optsOrFn
      const fn      = typeof optsOrFn === 'function' ? optsOrFn : maybeFn
      if (!fn) throw new Error('[Junction] app.runAs — no function to run')

      let user: import('../auth/types.ts').SessionContext | null = null

      if (userId !== null) {
        // ── The app's own principal is not a user and must not be looked up ──
        //
        // `createApp({ system })` declares who the app is when it acts on its
        // own behalf, and that principal is deliberately not a row anything can
        // log in as — `example`'s says so in as many words. So work enqueued
        // while it is in scope records its id, and `sessionFor` cannot answer:
        // every such job failed its full retry ladder with *no such principal*,
        // which reads as a deleted user and is the app saying its own name
        // (`FJS-467`).
        //
        // This is an identity check against a value the app itself supplied,
        // not the fallback the comment below refuses. The difference is the
        // whole point: falling back to `system` for an id that failed to
        // resolve would run a demoted user's work with authority they never
        // had, while matching the declared id runs the app's own work as the
        // app — which is what "no enqueuer resolves to createApp({ system })"
        // already promises for the case where nobody asked at all.
        const declared = opts.system as { userId?: string } | undefined
        if (declared && declared.userId !== undefined && String(declared.userId) === String(userId)) {
          user = opts.system as import('../auth/types.ts').SessionContext
        } else {

        // Re-resolved, never restored from a snapshot — see the doc on App.runAs.
        // A provider that cannot answer says so by name rather than falling back:
        // falling back to the system principal would run a demoted user's work
        // with more authority than they ever had, and falling back to nobody
        // reinstates the STRANGER(0) refusal this exists to remove.
        const resolve = app.auth?.sessionFor
        if (!resolve) throw new Error(
          `[Junction] app.runAs('${userId}') — the auth provider has no sessionFor(), ` +
          `so a principal cannot be re-resolved. Implement IAuth.sessionFor, or run ` +
          `this work as the app itself with runAs(null, …).`
        )
        user = await resolve.call(app.auth, userId)
        if (!user) throw new Error(
          `[Junction] app.runAs('${userId}') — no such principal. The user was ` +
          `resolvable when this work was enqueued and is not now (deleted, or ` +
          `disabled). Deferred work outlives the caller; handle the absence.`
        )
        }
      } else {
        user = opts.system ?? null
      }

      const frozen = user ? freezeUser(user) : null
      const tenant = 'tenant' in runOpts ? runOpts.tenant : requestMeta()?.tenant

      // Warmed here for the same reason the request hooks warm it: `$.config`
      // and `configFor` are property reads, so a job that names a tenant must
      // find the answer already resolved. A job is the caller most likely to
      // need one — a nightly mail run reads the from-address — and the least
      // likely to have a request behind it.
      if (tenant != null && tenantConfigStore) await tenantConfigStore.load(String(tenant))

      return enterRequest(
        // An absent tenant INHERITS the one in scope, on the same rule `auth`
        // follows: saying nothing means say nothing, and `{ tenant: null }`
        // means this work belongs to no tenant deliberately.
        { origin: 'internal', user: frozen, tenant },
        () => Promise.resolve(fn(frozen)),
      )
    },

    _appHooks: appHooks,
    _plugins:  [],

    _metricsSources: new Map<string, () => unknown>(),
    _healthChecks:    new Map<string, () => boolean | Promise<boolean>>(),
    _healthChecksApp: new Map<string, () => boolean | Promise<boolean>>(),
    draining: false,
    _devtools:        { status: 'off' as const },
    _devServices:     new Map<string, DevService>(),

    registerMetricsSource(name: string, fn: () => unknown): void {
      app._metricsSources.set(name, fn)
    },

    registerHealthCheck(name: string, fn: () => boolean | Promise<boolean>): void {
      app._healthChecks.set(name, fn)
    },

    registerDevService(svc: DevService): void {
      if (!svc?.name || !svc?.url) {
        throw new Error('registerDevService: a dev service needs a name and a url')
      }
      app._devServices.set(svc.name, svc)
    },

    async applyConfigFile(): Promise<void> {
      try {
        const junctionCfg = await loadConfig(_configPath)
        const merged = deepMerge(
          junctionCfg as Partial<AppConfig>,
          (opts.config ?? {}) as Partial<AppConfig>,
        ) as AppConfig & Record<string, unknown>

        // Mutate `config` in place — preserve the object identity other
        // subsystems already captured at createApp time.
        for (const key of Object.keys(merged)) {
          (config as Record<string, unknown>)[key] = merged[key]
        }

        // A section nothing reads. Recorded rather than thrown here, so one
        // boot reports every one of them.
        for (const miss of unknownSections(merged._junction)) {
          _authoringFindings.push(
            `junction.config.js declares '${miss.key}', which nothing reads` +
            (miss.nearest ? ` — did you mean '${miss.nearest}'?` : '.')
          )
        }
      } catch (err) {
        // loadConfig treats "file not found" as a normal miss. Reaching this
        // catch means a config file EXISTS but is broken — abort startup
        // rather than silently booting on defaults.
        throw new Error(`[Junction] Failed to load configuration: ${err instanceof Error ? err.message : err}`)
      }
    },

    claim(name: string, value: unknown): void {
      const existing = (app as unknown as Record<string, unknown>)[name]
      if (existing !== undefined) {
        throw new Error(
          `[Junction] app.claim('${name}') — that name is already claimed. ` +
          `Two plugins cannot both own app.${name}; the second used to win ` +
          `silently and the first would stop working. Rename one, or have the ` +
          `owning plugin expose the other's surface deliberately.`
        )
      }
      ;(app as unknown as Record<string, unknown>)[name] = value
    },

    setAuth(auth: import('../auth/types.ts').SessionVerifier): void {
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
          const result = p.register(app) as unknown
          // register() is typed `=> void`, but TypeScript's void-return rule
          // still lets an async function through. Say so out loud rather than
          // silently not awaiting it: its side effects may not have landed
          // before the next configure() or before start() reads state.
          //
          // The rejection is still RECORDED and rethrown by start(): a plugin
          // that failed to register must not let the app boot half-configured.
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            console.warn(
              `[Junction] Plugin '${p.name}' register() returned a Promise. ` +
              `configure() does not await register() — move async setup into boot().`
            )
            ;(result as Promise<unknown>).catch(err => {
              logger.error(`plugin '${p.name}' register() rejected`, err as Error)
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
      app._plugins = plugins.map(p => p.name)
      return app
    },

    // ── Route shortcuts ──────────────────────────────────────────
    // apiPrefix is applied HERE, and nowhere else. It used to be applied by
    // registerServiceRoutes alone, so a plugin's app.get() landed at the root
    // while every service beside it moved: four plugins hand-resolved
    // config.apiPrefix to compensate, @frontierjs/auth did not, and an app with
    // apiPrefix: '/api' served its services under /api and its login at /auth
    // (FJS-012). A route that must sit at the root — a fixed callback URL, a
    // probe path an orchestrator owns — goes through app.http.router directly,
    // which is the layer beneath this one and applies nothing.
    //
    // The handler also runs inside the REQUEST SCOPE. A service call has opened
    // one since `enterRequest` got an owner; a raw route never did, so
    // `requestMeta()` was undefined inside every route an app or a plugin
    // registers — `/auth/login`, a webhook, a callback URL — and everything
    // that reads the request without holding a `ctx` was blind there. Under
    // `tenancy { strategy database }` that is the difference between a sign-in
    // reaching the caller's own shop and reaching whichever one the provider
    // was built against.
    get(path, handler, mw)    { http.router.get(prefixPath(path), scoped(handler), mw);    return app },
    post(path, handler, mw)   { http.router.post(prefixPath(path), scoped(handler), mw);   return app },
    put(path, handler, mw)    { http.router.put(prefixPath(path), scoped(handler), mw);    return app },
    patch(path, handler, mw)  { http.router.patch(prefixPath(path), scoped(handler), mw);  return app },
    delete(path, handler, mw) { http.router.delete(prefixPath(path), scoped(handler), mw); return app },

    // ── WebSocket shortcut ────────────────────────────────────────
    ws(path, handlers)        { http.ws(path, handlers);               return app },

    // ── Startup ──────────────────────────────────────────────────
    // Both entry points run ONE ordered, named phase list (see startPhases
    // below). There used to be two hand-maintained sequences — start() and
    // _startForTest(), the latter documented as mirroring "phases 1, 4.5, 4.6"
    // — so the test path reimplemented a subset of production ordering and
    // drifted from it silently. Phases were also numbered 0, 0a, 0b, 0c, 1, 3,
    // 4, 4.5, 4.6, 5, 6, 7: decimals and gaps are what a sequence looks like
    // after it has been patched rather than redesigned. They are named now.

    /** Test-only lifecycle: every phase except the ones needing a port,
     *  a config file on disk, or process signal handlers.
     *  Never call this in production — use start() instead. */
    async _startForTest(): Promise<void> {
      if (started) return          // idempotent — safe to call multiple times
      await runStartPhases(false)
    },

    async start(): Promise<void> {
      await runStartPhases(true)
    },

    // ── Stop ─────────────────────────────────────────────────────
    async stop(): Promise<void> {

      logger.info('[App] Shutting down...')

      // Before anything closes. Readiness answers 503 from here on, so a load
      // balancer stops choosing this process while it still has a drain's worth
      // of work to finish — the whole window this flag exists for (`FJS-693`).
      app.draining = true
      http.setDraining?.(true)

      events.emit('app:shutdown')

      // Stop accepting new connections, close the live ones, and give an
      // in-flight request a grace period to finish.
      //
      // The timeout is the TRANSPORT's now rather than a race out here, and the
      // difference is that losing it does something. The race resolved on the
      // timer and closed nothing: `stop()` reported *Shutdown complete* with a
      // client's socket still open, after waiting the full drain every time,
      // because Bun's graceful stop never resolves once a socket has been
      // upgraded. `http.stop(drainMs)` says goodbye to each socket, waits for
      // what is genuinely outstanding, and forces the server down (`FJS-460`).
      await http.stop(config.http?.drainTimeout ?? 5_000)

      // Shutdown plugins in reverse order, each bounded.
      //
      // A `shutdown()` that never settles used to take the whole list with it:
      // the loop stopped at that plugin and the caravan pool, the outbox relay
      // and the litestone close never ran. Bounded, one plugin hanging costs
      // its own step and nothing else — and it is LOGGED, because a step that
      // silently did not run is the failure this whole change is about.
      await shutdownPlugins(plugins)

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
      if (_rejectionHandler) {
        process.removeListener('unhandledRejection', _rejectionHandler)
        _rejectionHandler = null
      }
      if (_exceptionHandler) {
        process.removeListener('uncaughtException', _exceptionHandler)
        _exceptionHandler = null
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
  //
  // A tenant registry takes the same slot: the client is per REQUEST rather
  // than per app, so `withTenantDb` resolves it and assigns the same
  // `ctx.locals.db`. Installing both would leave the assignment to hook order.
  if (opts.tenants) {
    app.hooks({ around: { all: [withTenantDb(opts.tenants, opts.principal)] } })
    Object.defineProperty(app, TENANT_REGISTRY, { value: opts.tenants })
    // Parked where `junction principal` can read it back. A resolver is wired
    // in application code, so nothing about a file tree can answer which one an
    // app ended up with — and that is the input every tenancy predicate in the
    // committed access snapshot compares against (`FJS-514`).
    if (opts.principal) Object.defineProperty(app, PRINCIPAL_RESOLVER, { value: opts.principal })
  } else if (db && typeof (db as { $setAuth?: unknown }).$setAuth === 'function') {
    app.hooks({ around: { all: [withLitestoneDb(db as never, opts.principal)] } })
    // Where a write came from, for the audit trail. Not a decision either: the
    // trail recorded who and what and nothing about the request, so an audit
    // row and the log lines from the same request could not be joined.
    installLogContext(db)
    registerAuditMetrics(app, db)
    if (opts.principal) Object.defineProperty(app, PRINCIPAL_RESOLVER, { value: opts.principal })
    // Row tenancy scopes with policies rather than with a second database, so
    // there is nothing to swap — the failure mode is the opposite one, a
    // principal with no claim seeing an empty version of every screen.
    //
    // Installed only when the schema DECLARES row tenancy. A hook that no-ops
    // is not free: it is a line in every app's `surface.snapshot.md` and a
    // frame in every stack trace, for a question most apps never ask. Probed
    // inside a try because reading an unknown property off a Litestone client
    // throws rather than answering undefined.
    let rowTenancy = false
    try { rowTenancy = (db as { $tenancy?: { strategy?: string } }).$tenancy?.strategy === 'row' } catch { /* not a Litestone client */ }
    if (rowTenancy) app.hooks({ before: { all: [tenantClaimGuard(db)] } })

    // A write that never went through a service announces nothing, so a job
    // writing with asSystem() left every open tab holding the stale row
    // (FJS-010). Not installed for a tenant registry: there the client is per
    // request rather than per app, so there is no single client to tap.
    announceDataWrites(app, db)
    // Every query on the telemetry bus, tapped once on the root client. It used
    // to be installed per request off `ctx.locals.db`, which is a `$setAuth`
    // proxy for a signed-in caller and throws on the probe (`FJS-673`).
    installQueryTelemetry(app, db)
  }


  // ─── Startup phases ──────────────────────────────────────────────────────
  //
  // ONE ordered list, shared by start() and _startForTest(). Phases marked
  // `needsHost` are skipped by the test lifecycle: they bind a port, read a
  // config file from disk, install process signal handlers, or announce.
  // Everything else runs identically in both, which is the point — the test
  // path can no longer drift from production ordering, because there is only
  // one ordering.

  interface StartPhase {
    name:       string
    /** Skipped by _startForTest(): needs a port, the filesystem, or signals. */
    needsHost?: boolean
    run:        () => void | Promise<void>
  }

  /**
   * Fails startup when a plugin's `requires` is unmet — before ANY boot() runs,
   * so nothing is half-initialized when it throws.
   *
   * Checks order, not just presence: register() side effects land in configure()
   * order, so a dependency configured *after* its dependent is as broken as one
   * that is missing. That is exactly the notifications-after-mailer case, which
   * previously surfaced as a failed send long after startup.
   */
  function assertPluginRequirements(): void {
    const positionOf = new Map(plugins.map((p, i) => [p.name, i]))

    plugins.forEach((p, i) => {
      for (const need of p.requires ?? []) {
        const at = positionOf.get(need)
        if (at === undefined) {
          throw new Error(
            `[Junction] Plugin "${p.name}" requires "${need}", which is not configured. ` +
            `Add it with app.configure(...) before "${p.name}". ` +
            `Configured plugins: ${plugins.map(x => x.name).join(', ') || '(none)'}`
          )
        }
        if (at > i) {
          throw new Error(
            `[Junction] Plugin "${p.name}" requires "${need}", but "${need}" is ` +
            `configured AFTER it. Move app.configure() for "${need}" above "${p.name}".`
          )
        }
      }
    })
  }

  async function runStartPhases(bindHost: boolean): Promise<void> {

    // A second start() used to reach `security-headers` and die on `Cannot add
    // middleware after the router is built` — an internal sentence about a
    // router, for a caller whose actual mistake was calling this twice. Refused
    // by name instead: an app is started once, and the way to start it again is
    // to stop it first.
    if (_everStarted) {
      throw new Error(
        `[Junction] this app has already been started` +
        (started ? ` and is still running${app.http?.port ? ` on ${app.http.port}` : ''}` : ' and stopped') +
        `. start() runs the whole phase list — middleware is applied, plugins ` +
        `boot, routes are registered — and none of it is repeatable: the router ` +
        `is built once and refuses middleware afterwards. A STOPPED app cannot ` +
        `be restarted either (\`FJS-949\`); build a new one with createApp().`
      )
    }
    _everStarted = true

    const startPhases: StartPhase[] = [

      // Load junction.config.js and deep-merge into the live config.
      // Final priority: defaultConfig < junction.config.js < opts.config.
      { name: 'load-config', needsHost: true, run: () => app.applyConfigFile() },

      // Security headers — opt out via config.http.helmet = false.
      { name: 'security-headers', run: () => {
        if (config.http?.helmet !== false) helmet()(app)
      }},

      // CORS declared in config. Must run after load-config, which is where
      // middleware.cors is merged in, and before service routes are registered.
      //
      // Ordering note: cors() must precede csrf() so preflights short-circuit
      // before the origin check. An app calling app.configure(csrf(...)) itself
      // registers it during configure(), so an app using BOTH should keep
      // configuring cors() by hand, ahead of csrf(), rather than via config.
      { name: 'cors', run: () => applyConfiguredCors(app, config) },

      // register() already ran synchronously in configure(); async rejections
      // were captured there. Refuse to boot on one rather than run half-configured.
      { name: 'check-register-failures', run: () => {
        if (_registerFailures.length) {
          const f = _registerFailures[0]
          throw new Error(
            `Plugin "${f.plugin}" register() rejected: ${f.err instanceof Error ? f.err.message : f.err}`,
            { cause: f.err }
          )
        }
      }},

      { name: 'check-plugin-requires', run: assertPluginRequirements },

      // The build this process serves, stated on every response and once per
      // socket. After `load-config`, because `config.build` may come from the
      // file; inert when nothing set one, which is every app nobody deployed.
      { name: 'resolve-build-id', run: () => {
        const id = resolveBuildId(config)
        if (id) config.build = id
        http.setBuildId(id)
      }},

      // An attached service the environment does not bind is a refusal HERE,
      // where it names the service — not a 500 on the first request that
      // reaches it, hours after the deploy that caused it.
      //
      // After `load-config`, because the declaration usually arrives from
      // junction.config.js. NOT `needsHost`, so an app stating attachments in
      // `createApp({ config })` is graded under a test runner too — the same
      // split `autoload-services` reasons about, and for the same reason: the
      // check that only runs in production is the one nobody sees fail.
      { name: 'check-attachments', run: () => {
        const report = checkAttachments(config.attachments)
        for (const line of formatAttachmentSkips(report.skipped)) logger.warn(line)
        for (const r of report.results)
          for (const w of r.warnings) logger.warn(`[Junction] attachment ${r.name}: ${w}`)
        if (report.fatal.length) throw new Error(formatAttachmentRefusal(report.fatal))
      }},

      // Auto-load services — ON BY DEFAULT. Resolution order:
      //   autoload: false        → disabled
      //   opts.autoload (string) → explicit path, CWD-relative
      //   _junction.services.dir → from junction.config.js, CWD-relative
      //   default                → probed beside the ENTRY FILE (Bun.main):
      //                            `./services`, then `./src/services`
      // `resolveServicesDir` is the one owner of that list — the snapshot tools
      // ask it the same question, where `Bun.main` is the tool.
      //
      // NOT needsHost. Registering services reads a directory and builds
      // objects; it binds nothing. It was grouped with the host phases and the
      // cost was invisible until an app was mounted by @frontierjs/testing:
      // `_startForTest` skips needsHost, so every app that autoloads had ZERO
      // services in a test env and every call answered `Service 'x' not found`
      // — a 404 that reads like a wrong name rather than an unloaded app.
      //
      // The one thing a test cannot reach is `_junction.services.dir`:
      // `load-config` IS needsHost, so junction.config.js is not read, and an
      // app that wants its services in a test states `autoload:` directly —
      // an ABSOLUTE path, because the entry under `bun test` is the test file.
      { name: 'autoload-services', run: async () => {
        const declared = opts.autoload === false
          ? false
          : (opts.autoload
              ?? (config as { _junction?: { services?: { dir?: string } } })._junction?.services?.dir)

        _servicesDir = resolveServicesDir({
          entry:    typeof Bun !== 'undefined' ? Bun.main : null,
          declared,
        })

        // A declared directory that is not there is a statement that failed,
        // so it is loud wherever it happens — including in a test, where the
        // app is the thing that stated it. What it names is the RESOLVED path:
        // a relative one is resolved against the cwd, and a command run from
        // the wrong directory is most of how this goes wrong.
        if (_servicesDir.source === 'declared-missing') {
          logger.warn(
            `[Junction] No services directory at ${_servicesDir.probed[0]} — ` +
            `declared as "${_servicesDir.declared}", and nothing will be autoloaded from it. ` +
            `A relative path is resolved against the working directory.`
          )
        }

        if (_servicesDir.dir) {
          await autoloadServices({
            dir: _servicesDir.dir, app, registry: services,
            // Keyed like every other authoring finding, so one file that
            // exports two factories AND throws is two sentences and not four.
            report: (_key, finding) => _authoringFindings.push(finding),
          })
        }
      }},

      // Plugins do their async setup here — the full app exists by now.
      // Every authoring mistake this start() found, in one verdict, before any
      // plugin boots — so nothing is half-initialized when it refuses, and an
      // author fixes a config in one pass rather than one boot per typo
      // (`FJS-D199`). Refuse rather than warn: `warnings: []` is the shape
      // being replaced (`FJS-431`), and there is no permitting flag, because a
      // key that ought to be legal is a missing feature.
      { name: 'check-authoring', run: () => {
        // Services are collected HERE rather than pushed at construction: a
        // service is built at import and registered later, so the app has no
        // hold on it until now — and autoload runs one phase above, so a
        // service loaded off disk is in the registry by the time this asks.
        for (const svc of services.values()) {
          for (const f of (svc as { _authoringFindings?: string[] })._authoringFindings ?? [])
            _authoringFindings.push(f)
        }
        if (_authoringFindings.length === 0) return
        throw new Error(
          `[Junction] ${_authoringFindings.length} authoring mistake(s) — this app declares ` +
          `things nothing reads:\n` +
          _authoringFindings.map(f => `    ${f}`).join('\n')
        )
      }},

      { name: 'boot-plugins', run: async () => {
        const booted: Plugin[] = []
        for (const plugin of plugins) {
          try {
            await plugin.boot?.(app)
            booted.push(plugin)
          } catch (err) {
            // Unwind. A boot that failed halfway left every earlier plugin's
            // pool, timer and connection alive with `shutdown()` never called,
            // so `start()` threw and the process went on holding them.
            //
            // The FAILING plugin is included: it is the one most likely to have
            // opened something before it threw, and a `shutdown()` that assumes
            // a completed boot throws into the same catch every other one does.
            booted.push(plugin)
            await shutdownPlugins(booted)
            throw new Error(`Plugin "${plugin.name}" boot failed: ${(err as Error).message}`)
          }
        }
      }},

      // Service routes are registered AFTER plugins so plugin middleware wraps
      // them. Registering at createApp() time would add them before
      // CORS/helmet/rateLimit patched the router, so they'd never get those headers.
      { name: 'service-routes', run: () => registerServiceRoutes(app) },

      // Compile merged hook pipelines for every service now, and for any service
      // registered later (e.g. in a plugin's ready(), or by user code after start()).
      { name: 'compile-hook-pipelines', run: () => services.setAppHooks(app._appHooks) },

      { name: 'listen', needsHost: true, run: () => { http.start() } },

      { name: 'ready-hooks', needsHost: true, run: async () => {
        for (const plugin of plugins) {
          try {
            await plugin.ready?.(app)
          } catch (err) {
            logger.error(`plugin '${plugin.name}' ready failed`, err as Error)
          }
        }
      }},

      { name: 'mark-started', run: () => { started = true } },

      // Process exit belongs HERE, not in stop(): a signal means "terminate",
      // but stop() must be callable by tests and embedders without killing the
      // process. Registered once per app and removed on stop(), so repeated
      // start() calls don't stack listeners.
      { name: 'signal-handlers', needsHost: true, run: () => {
        if (_signalHandler) return

        // `stop()` is raced against a whole-shutdown deadline, and the race is
        // the point rather than a nicety: a plugin whose `shutdown()` never
        // settles used to leave the loop empty with every timer unref'd, and
        // node exited **0** in 54ms with the queue, the outbox and the database
        // close all skipped and *Shutdown complete* never printed. Zero is a
        // clean stop to an orchestrator, so nothing anywhere reported it
        // (`FJS-693`). Past the deadline this exits 1, which is a statement.
        _signalHandler = () => {
          const ms = config.shutdown?.timeout ?? 15_000
          let timedOut = false
          withDeadline(app.stop(), ms, () => {
            timedOut = true
            logger.error(`[App] Shutdown did not finish within ${ms}ms — exiting 1 with steps outstanding`)
          })
            .then(() => process.exit(timedOut ? 1 : 0))
            .catch(() => process.exit(1))
        }
        process.on('SIGTERM', _signalHandler)
        process.on('SIGINT',  _signalHandler)

        // A rejected promise in a timer killed the process with `stop()` never
        // running at all — no drain, no plugin shutdown, no close. Installed
        // only where the app has NOT already stated its own policy: a framework
        // replacing an application's crash handling is worse than not having
        // any, and `listenerCount` is the only way to ask.
        if (config.shutdown?.crashHandlers !== false) {
          if (process.listenerCount('unhandledRejection') === 0) {
            _rejectionHandler = (reason: unknown) => {
              logger.error('[App] Unhandled rejection — shutting down', reason as Error)
              crashStop()
            }
            process.on('unhandledRejection', _rejectionHandler)
          }
          if (process.listenerCount('uncaughtException') === 0) {
            _exceptionHandler = (err: Error) => {
              logger.error('[App] Uncaught exception — shutting down', err)
              crashStop()
            }
            process.on('uncaughtException', _exceptionHandler)
          }
        }
      }},

      { name: 'announce', needsHost: true, run: () => {
        events.emit('app:ready', { port: config.port })

        const _base   = `http://${config.hostname}:${config.port}`
        const _prefix = config.apiPrefix ?? ''

        // hasExactRoute, not hasRoute: hasRoute asks "would this path match
        // something", and `GET /{service}` matches everything — so every app
        // used to advertise /health and /docs whether or not they were mounted,
        // and the URLs it printed 404'd.
        //
        // `||`, not `??`: hasRoute returns a boolean, so `false ?? x` is false
        // and the prefixed fallback never ran. An app with an apiPrefix checked
        // only the unprefixed path and never advertised either endpoint.
        // Find where the endpoint is actually mounted, rather than guessing a
        // location and testing it. healthPlugin({ path: '/internal' }) puts it
        // at /internal/health, and probing only '/health' left the banner
        // silent about a working endpoint. Returning the real path also means
        // the advertised URL is the one that answers — it used to print the
        // unprefixed URL regardless of where the route lived.
        //
        // Templated paths are excluded: a dynamic route like `/{service}/health`
        // ends with the suffix but is not a URL anyone can visit.
        const _mountedAt = (suffix: string): string | null =>
          (http.router.routePaths?.('GET') ?? [])
            .filter(p => !p.includes('{'))
            .find(p => p === suffix || p.endsWith(suffix))
          ?? null

        const _healthPath = _mountedAt('/health')
        const _docsPath   = _mountedAt('/docs')

        logger.info(`🚀 ${config.name} v${config.version}`, {
          url:      _base,
          routes:   http.router.routeCount,
          services: services.list().length,
          // Where the autoloaded ones came from, and — this is the half that
          // costs a day when it is missing — what was looked at when none did.
          // `services=3` on an app with twelve reads as an app with three, and
          // every route the other nine would have mounted is a 404, which
          // reads as a wrong URL rather than as a directory nobody found
          // (`FJS-458`). A field rather than a warning: an app that registers
          // its services by hand is not doing anything wrong, and a framework
          // that shouts at a correct app teaches everyone to stop reading.
          autoload: describeServicesDir(_servicesDir),
          prefix:   _prefix || undefined,
          health:   _healthPath ? `${_base}${_healthPath}` : undefined,
          docs:     _docsPath   ? `${_base}${_docsPath}`   : undefined,
          // Always stated, including when it is off. The field is here so the
          // answer to *where is the console* is on screen at boot rather than
          // in whichever file configured it — and `disabled` is worth a word
          // because it is the answer people are surprised by.
          devtools: app._devtools.status === 'on'      ? app._devtools.url
                  : app._devtools.status === 'refused' ? `refused — ${app._devtools.reason}`
                  : 'disabled',
          mode:     config.debug ? 'debug' : 'production',
        })

        // The banner covered API and UI-facing surface and said nothing about
        // the Data realm, so "is the schema even loaded?" had no answer short
        // of issuing a request. It gets its own line rather than more fields on
        // the one above: this is the other realm, not more detail about this one.
        //
        // The DB path here is the RESOLVED one. That matters more than it looks
        // — a schema declaring `database main { path … }` overrides createClient's
        // `db:` option silently, so the file you are actually writing to is not
        // always the file you think you passed. Printing it makes that visible
        // at boot instead of three confusing test runs later.
        const _data = describeDataRealm(db)
        if (_data) logger.info(`🗄  litestone`, _data)

        // One line each rather than fields on the banner, for the reason the
        // line above gets its own: these are separate processes, not more
        // detail about this one. They print AFTER the app's own line because
        // that is the order they matter in — what is this, then what else is
        // up beside it.
        for (const svc of app._devServices.values()) {
          logger.info(`🔌 ${svc.name}`, { url: svc.url, note: svc.note })
        }
      }},
    ]

    for (const phase of startPhases) {
      if (phase.needsHost && !bindHost) continue
      await phase.run()
    }
  }

  return app
}

// ─── Auto service routing ─────────────────────────────────────────────────
/**
 * Install the CORS middleware declared in config, if any.
 *
 * `config.http.cors` has always existed — it is typed in config/index.ts, has a
 * documented default (`origins: []`, "must be set explicitly — '*' never
 * applied by default"), and loadConfig even merges `junction.config.js`'s
 * `middleware.cors` into it. Nothing ever read it back out, so setting it did
 * exactly nothing: preflights 404'd and no Access-Control header was ever sent.
 * Every app had to know to call `app.configure(cors({...}))` by hand, and the
 * failure mode in a browser is an opaque "TypeError: Failed to fetch".
 *
 * The secure default is preserved: an empty (or absent) origins list installs
 * nothing at all, exactly as before.
 */
function applyConfiguredCors(app: App, config: AppConfig): void {
  const c = (config.http as Record<string, unknown>)?.cors as
    Partial<import('../transport/middleware.ts').CorsOptions> | undefined

  const origins = c?.origins
  const isEmpty = !origins || (Array.isArray(origins) && origins.length === 0)
  if (isEmpty) return

  const callHeaders = (config.http as Record<string, unknown>)?.callHeaders as string[] | undefined

  app.configure(cors({
    origins,
    ...(c.methods     ? { methods:     c.methods }     : {}),
    ...(c.headers     ? { headers:     c.headers }     : {}),
    // Declared once under http.callHeaders and read by both halves — see the
    // note on the field. Without this an app's own header is allowed on the
    // socket and refused at a cross-origin preflight.
    ...(callHeaders   ? { callHeaders }                : {}),
    ...(c.credentials ? { credentials: c.credentials } : {}),
    ...(c.maxAge      ? { maxAge:      c.maxAge }      : {}),
  }))
}

/**
 * `apiPrefix` → a path segment: strip surrounding slashes, re-add the leading
 * one. '' stays ''. The browser client applies the identical transform to the
 * prefix it is given; the two must agree or nothing meets.
 */
export function normalizePrefix(prefix: string | undefined): string {
  const stripped = (prefix ?? '').replace(/^\/|\/$/g, '')
  return stripped ? `/${stripped}` : ''
}

// Maps {prefix}/users → services.users (CRUD)
// Maps {prefix}/users/123 → services.users (with id=123)
// Maps {prefix}/servers/123/reboot → servers.reboot (custom method)
//
// The prefix is NOT applied here: app.get/post/... apply it to every route
// alike, so adding it here too would mount the services at /api/api/users.

export function registerServiceRoutes(app: App): void {

  // ── CRUD handler ──────────────────────────────────────────────────
  const crudHandler: RouteHandler = async (ctx) => {
    const service = app.services.get(ctx.route.service)

    if (!service)
      return ctx.json({ name: 'NotFound', message: `Service '${ctx.route.service}' not found`, code: 404 }, 404)

    // The CANONICAL name, not the one in the URL. A service reached through an
    // older spelling of its name (`FJS-570`) must still announce, resolve its
    // model and appear in telemetry under the one name it has — otherwise the
    // alias is a second service wearing the same code.
    const serviceName = service.name

    const model  = (service as unknown as { model?: string }).model ?? serviceName
    // $wrap is a three-state request, not a boolean:
    //   absent      → the default rule (list keeps its envelope, single unwraps)
    //   'true'      → envelope the single too
    //   'false'     → unwrap the list to a bare array (Feathers' paginate:false)
    // It used to be read as `=== 'true'`, so $wrap=false on a list was silently
    // ignored — the only way to get a bare array out of find() was not to ask.
    //
    // Both spellings of false: the transport parses types now (`FJS-D125`) so
    // `?$wrap=false` arrives as the boolean, and a hand-built context still
    // passes the string. Reading only one of them is how this was broken the
    // first time.
    const rawWrapParam = (ctx.query as Record<string, unknown>)?.['$wrap']
    const wrap: boolean | undefined =
      rawWrapParam === undefined
        ? undefined
        : rawWrapParam !== false && rawWrapParam !== 'false'
    const svcCtx = bridge.toContext(ctx, serviceName, model, 'http', app)

    // Open the request scope once, around the whole pipeline run, so
    // requestMeta() works at any depth — including across internal
    // app.service() calls — without threading it. The three header-derived
    // fields are read by enterRequest(), which owns which headers they are.
    try {
      return await enterRequest({
        origin:  'http',
        headers: ctx.headers,
        // The transport's own id where the header is absent; `x-request-id`
        // itself is enterRequest's to read, and stated beats derived there.
        correlationId: ctx.headers['x-request-id']
          ?? (ctx as unknown as { requestId?: string }).requestId,
        // WHO, request-wide. This is what makes `ctx.auth` propagate: an
        // internal call naming no principal reads it back out of the store.
        user:   svcCtx.auth.user,
        client: svcCtx.client,
      }, async () => {
        await callService(service, svcCtx, app._appHooks, app.events, app.telemetry)
        return bridge.toResponse(svcCtx, wrap)
      })
    } catch (err) {
      // Through `errorResponse` with the service context, so a 500 is graded by
      // the same rule the other exit is: a generic sentence plus the
      // correlation id in production, and every protected column in the
      // payload replaced (`FJS-686`). Building the body here instead was the
      // second answer, and it was the one every service failure took.
      return errorResponse(err, svcCtx)
    }
  }

  // ── Restore handler ───────────────────────────────────────────────
  // PUT /{service}/{id} + X-Service-Method: restore
  // POST /{service}/{id} + X-Service-Method: {method} — custom methods
  // All dispatched via crudHandler — bridge reads the header and sets ctx.method.

  // ── Route registration ────────────────────────────────────────────

  // Collection — find, create, bulk patch/delete, upsert
  app.get(`/{service}`,        crudHandler)
  app.post(`/{service}`,       crudHandler)
  app.patch(`/{service}`,      crudHandler)
  app.delete(`/{service}`,     crudHandler)
  app.put(`/{service}`,        crudHandler)   // bulk restore

  // Resource — get, patch, delete, restore, custom methods (via X-Service-Method)
  app.get(`/{service}/{id}`,    crudHandler)
  app.post(`/{service}/{id}`,   crudHandler)  // custom methods
  app.patch(`/{service}/{id}`,  crudHandler)
  app.put(`/{service}/{id}`,    crudHandler)  // restore via header
  app.delete(`/{service}/{id}`, crudHandler)
}
