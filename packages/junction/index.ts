// index.ts
// The four axes — admission, call, carriage, announcement — and the host that
// holds them (`FJS-D639`). A battery is its own subpath and is not here.
//
//   import { createApp, createService, authenticate } from '@frontierjs/junction'
//   import { mailerPlugin }                           from '@frontierjs/junction/mail'

// ─── App ──────────────────────────────────────────────────────────────────
export { createApp }                              from './src/core/app.ts'
export type { App, AppConduit, AppDb, AppJobs, AppNotify, DevService, Plugin, PluginFn, AppOptions, ServiceCaller } from './src/core/app.ts'
// The battery slots (`FJS-D640`): each battery augments its own from its subpath.
export type { AppCache, AppScheduler, AppMail, AppAI, AppOutbox, AppCommitments, AppWebhooks } from './src/core/app.ts'
export { CALL_OPTIONS_AT } from './src/core/app.ts'

// ─── Config ───────────────────────────────────────────────────────────────
export { loadConfig, deepMerge, parseTtl, defaultConfig } from './src/config/index.ts'
export type { AppConfig, DeepPartial, JunctionConfig, JunctionMiddlewareConfig,
              JunctionPluginsConfig, JunctionServicesConfig,
              JunctionCaravanConfig, JunctionConduitConfig }  from './src/config/index.ts'

// ─── Errors ───────────────────────────────────────────────────────────────
export {
  FrameworkError,
  BadRequest, Unauthorized, PaymentRequired, Forbidden,
  NotFound, MethodNotAllowed, Conflict, Gone, Unprocessable,
  TooManyRequests, GeneralError, NotImplemented, BadGateway,
  Unavailable, Timeout,
  toFrameworkError, fromStatusCode, registerErrorMapper
} from './src/core/errors.ts'
export type { ErrorMapper } from './src/core/errors.ts'

// Per-field errors an app's OWN rules can raise — the writer for the shape
// sierra's toFieldErrors already reads, so a hand-written business rule
// reports like a declared one.
export { fieldErrors, validateFields, fieldError } from './src/core/field-errors.ts'
export type { FieldError, FieldErrorBuilder }      from './src/core/field-errors.ts'

// ─── Services ─────────────────────────────────────────────────────────────
export { createService, createBaseService, ServiceRegistry, callService, setServiceCache,
         SERVICE_OPTION_KEYS, SERVICE_RUNTIME_KEYS, isCustomMethod, customMethodNames,
         READ_ONLY_METHODS, resolveMethodPolicy, serviceMethodNames,
         methodEntryName, collectMethodInputs,
         isMethodAllowed, allowedMethodNames } from './src/core/service.ts'
export type { Service, ServiceDefinition, ServiceDefinitionValue, BaseServiceOptions, BaseServiceDefinition, CacheDeclaration, MethodPolicy, MethodEntry, MethodDeclaration, TelemetryEvent, CallStartEvent, HookTelemetryEvent } from './src/core/service.ts'

// ─── Sorting ──────────────────────────────────────────────────────────────
// The one reading of `orderBy` (Bridge index). `autoSort` VALIDATES a request's
// `$orderBy` and leaves it raw on `ctx.directives`, so a service that wants to
// honor it has to parse the same three spellings — and doing that by hand in
// a service is how the grammar ends up with a second definition.
export { normalizeOrderBy, normalizeSelect, comparatorFor, compareValues } from './src/core/query-values.ts'
export type { SortParam, SelectParam, OrderBy } from './src/core/query-values.ts'

// ─── Hooks ────────────────────────────────────────────────────────────────
export {
  resolvePipelines, mergeHookMaps, runPipeline,
  // Built-in hooks
  authenticate, requireRole, paginate, protect, allow, timestamps, logTiming,
  circuitBreaker,
  // The rate limiter both a service pipeline and a raw route can use — it answers
  // for either context (BridgeHook). Named rateLimitHook to distinguish it from
  // the transport-level rateLimit middleware plugin.
  rateLimit as rateLimitHook
} from './src/core/hooks.ts'
// RateLimitHookOptions is NOT re-exported here even though `hooks.ts` forwards
// it: it is declared in `src/auth/types.ts` and exported from there below, and
// naming it on both lines is a duplicate identifier rather than two types.
export type { Hook, AroundHook, BridgeHook, HookMap, ResolvedPipeline, CircuitBreakerOptions } from './src/core/hooks.ts'

// ─── Bridge ───────────────────────────────────────────────────────────────
export { bridge, jsonResponse, errorResponse, redirectResponse, withholdProtected } from './src/transport/bridge.ts'
export type { ServiceContext, ServiceMethod, AnyMethod, ServiceContextLocals, CallOptions, RequestMeta } from './src/transport/bridge.ts'
export type { QueryDirectives } from './src/core/context.ts'
export { requestMeta } from './src/transport/bridge.ts'
// `enterCall` is the escape hatch for calling a service method DIRECTLY —
// a unit test holding a hand-built context, or an app invoking a method
// outside the pipeline. `callService` opens the scope for every ordinary
// path; without this, a method that reads `$` cannot be called any other way.
export { $, currentCall, enterCall, inAfterCommitDrain, warnEffectInDrain } from './src/core/context.ts'
export type { CallContext } from './src/core/context.ts'

// ─── Transport ────────────────────────────────────────────────────────────
export { HttpTransport }                                          from './src/transport/http.ts'
export { Router }                                                 from './src/transport/router.ts'
export { parseBody, parseQuery, parseCookies, extractIP }         from './src/transport/body.ts'
export { serveStatic }                                            from './src/transport/static.ts'
export { createStats }                                            from './src/transport/types.ts'
export type {
  TransportContext, RawRequest, RouteDefinition,
  RouteHandler, MiddlewareFn, HttpMethod, TransportStats,
  WsContext, WsHandlerSet, WsData,
  PaginateResponse, SseEvent, SseSendFn
} from './src/transport/types.ts'

// ─── Auth ─────────────────────────────────────────────────────────────────
export type { IAuth, LoginResult, SessionVerifier, SessionContext, CreateUserInput, ApiKeyOptions, AuthSessionInfo, ApiKeyInfo, RateLimitHookOptions } from './src/auth/types.ts'

// ─── Events ───────────────────────────────────────────────────────────────
export { createEventBus }                                         from './src/events/index.ts'
export type { IEventBus, EventHandler }                           from './src/events/index.ts'

// ─── Result envelope ──────────────────────────────────────────────────────
// One module owns wrap/unwrap/inspect. Import these instead of reaching into
// `.data` — that habit is what let the same find() answer three different ways.
export { wrapResult, unwrapResult, resultData,
         isServiceResult, isListResult,
         single, list, toBulkFailure }                            from './src/core/envelope.ts'
export type { ResultKind, ListResult, SingleResult,
              UnwrapOptions, BulkFailure }                        from './src/core/envelope.ts'

// ─── Schema ───────────────────────────────────────────────────────────────
export { createSchema, v }                                        from './src/core/schema.ts'
export type { Schema, FieldDef, SchemaOptions, CompiledSchema, ValidationResult, ValidationError } from './src/core/schema.ts'

// ─── Litestone ───────────────────────────────────────────────────────────
export { createLitestoneBase, parseQuery as parseLitestoneQuery, parseWhere,
         findWindow,
         deriveModelName, accessorCandidates, withLitestoneDb,
         sessionGateLevel, callerGateLevel, principalGateLevel, toDataPrincipal, LEVELS,
         applyClaims, membershipClaim, MEMBERSHIP, tenantOf,
         bearerClaim, BEARER, bearerOf, header, authorization, cookie,
         jsonSchemaToJunctionSchema }                              from './src/core/litestone.ts'
export type { GradableUser } from './src/core/litestone.ts'
export type { PrincipalResolver, PrincipalSetting, PrincipalClaims, PrincipalDescription, DescribedResolver,
              MembershipClaimOptions, NoClaim } from './src/core/litestone.ts'
export type { BearerClaimOptions, BearerSource, BearerResolver, ResolvedBearer, MintedGrant,
              RedeemOptions, RedeemContext } from './src/core/litestone.ts'
export type { WindowResult } from './src/core/litestone.ts'
export type { LitestoneServiceOptions, ParsedQuery,
              LitestoneJsonSchema,
              LitestoneQueryEvent }                                   from './src/core/litestone.ts'

// ─── Channels ─────────────────────────────────────────────────────────────
export { createChannelManager, Channel, channels, announce } from './src/transport/channels.ts'
export type { Connection, AnnounceFn, WSMessage, PresenceMember }                          from './src/transport/channels.ts'

// ─── Middleware plugins ───────────────────────────────────────────────────
export { cors, helmet, rateLimit, requestLogger, bodyLimit, correlationId, csrf, combineOrigins } from './src/transport/middleware.ts'
export type { CorsOptions, HelmetOptions, RateLimitOptions, CorrelationIdOptions, CsrfOptions, OriginList, CombinedOrigins } from './src/transport/middleware.ts'

// ─── Health + metrics ─────────────────────────────────────────────────────
// `registerMetricsSource` was a registrar with no reader: every source wrote
// into `app._metricsSources` and the only way back out was an HTTP request to
// this process's own port, or a reach into the private map. A scraper that has
// the app in hand is the ordinary case (`FJS-956`), so the collector is part of
// the seam rather than half of it.
export { healthPlugin, collectMetrics, renderPrometheus }          from './src/transport/health.ts'
// Reading what the store kept, as opposed to collecting what is true now.
// Beside `db/metrics.lite`, because an app that imports those models cannot
// read a counter out of them without the reset rule and would write its own.
export { counterIncrease, counterRate, isStale, seriesKey }        from './src/core/metrics.ts'
export type { Reading }                                            from './src/core/metrics.ts'
export type { HealthPluginOptions, HealthResponse, MetricsResponse, CheckResult } from './src/transport/health.ts'

// ─── Logger ───────────────────────────────────────────────────────────────
export { createLogger, consoleWriter, fileWriter, multiWriter, noopLogger } from './src/core/logger.ts'
export type { ILogger, LogLevel, LogEntry, LogWriter, LoggerOptions }       from './src/core/logger.ts'

export { defineEnv, generateEnvExample, printEnvExample }   from './src/core/env.ts'
export type { EnvSpec, EnvFieldSpec, EnvOutput }            from './src/core/env.ts'

// ─── Auth credentials ─────────────────────────────────────────────────────
export { signedRequest, REFUSE }                                  from './src/auth/credentials.ts'
export type { CredentialVerifier, CredentialAnswer, InboundRequest, SignedRequestOptions } from './src/auth/credentials.ts'

// ─── Loader ───────────────────────────────────────────────────────────────
export { autoloadServices, loadServiceFile }                      from './src/core/loader.ts'

// ─── Testing ──────────────────────────────────────────────────────────────
export { createTestApp, createStubAuth, request, testCtx }        from './src/testing/index.ts'
export type { TestApp, TestAppOptions, TestRequest, TestResponse, StubUser } from './src/testing/index.ts'

// ─── The app model ────────────────────────────────────────────────────────
// What is mounted and what runs, read off a built app — core, because the
// registers and the manifest battery both render it.
export { buildRoutes, serializeHookMap }                           from './src/core/app-model.ts'
export type { RouteManifest, HookManifest }                        from './src/core/app-model.ts'

// ─── Batteries ────────────────────────────────────────────────────────────
// Not re-exported here (`FJS-D639`). Each is its own subpath — `/mail`, `/ai`,
// `/cache`, `/scheduler`, `/email`, `/webhooks`, `/openapi`, `/outbox`,
// `/backfill`, `/commitments`, `/manifest`, `/devtools`, `/export`, `/metrics`.
