// index.ts
// Framework public API — everything an app needs, from one import.
//
//   import { createApp, createService, authenticate } from 'framework'

// ─── App ──────────────────────────────────────────────────────────────────
export { createApp }                              from './src/core/app.ts'
export type { App, AppConduit, AppDb, AppJobs, AppNotify, DevService, Plugin, PluginFn, AppOptions, ServiceCaller } from './src/core/app.ts'

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
export { normalizeOrderBy, comparatorFor, compareValues } from './src/core/sort.ts'
export type { SortParam, OrderBy } from './src/core/sort.ts'

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
export { bridge, jsonResponse, errorResponse, redirectResponse } from './src/transport/bridge.ts'
export type { ServiceContext, ServiceMethod, AnyMethod, ServiceContextLocals, CallOptions, RequestMeta } from './src/transport/bridge.ts'
export type { QueryDirectives } from './src/core/context.ts'
export { requestMeta } from './src/transport/bridge.ts'
// `enterCall` is the escape hatch for calling a service method DIRECTLY —
// a unit test holding a hand-built context, or an app invoking a method
// outside the pipeline. `callService` opens the scope for every ordinary
// path; without this, a method that reads `$` cannot be called any other way.
export { $, currentCall, enterCall } from './src/core/context.ts'
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
export type { IAuth, SessionVerifier, SessionContext, CreateUserInput, ApiKeyOptions, AuthSessionInfo, ApiKeyInfo, RateLimitHookOptions } from './src/auth/types.ts'

// ─── Events ───────────────────────────────────────────────────────────────
export { createScheduler }                                        from './src/scheduler/index.ts'
export type { JobFn, JobHandle, SchedulerStats }                  from './src/scheduler/index.ts'

export { createEventBus }                                         from './src/events/index.ts'
export type { IEventBus, EventHandler }                           from './src/events/index.ts'

// ─── Cache ────────────────────────────────────────────────────────────────
export { createMemoryCache, createSqliteCache }                   from './src/cache/index.ts'
export type { ICache, CacheStats, MemoryCacheOptions }            from './src/cache/index.ts'

// ─── Scheduler ────────────────────────────────────────────────────────────

// ─── Workers ──────────────────────────────────────────────────────────────
export { createThread, createPool, workerHandler, workerData }    from './src/workers/index.ts'
export type { WorkerHandle, WorkerPoolHandle, PoolStats }         from './src/workers/index.ts'

// ─── File Storage ─────────────────────────────────────────────────────────
export { createFileStorage }                                      from './src/storage/filestorage/index.ts'
export type { IFileStorage, StorageFile, StorageSaveOptions }     from './src/storage/filestorage/index.ts'

// ─── Mail ─────────────────────────────────────────────────────────────────
export { createResendMailer, createSmtpMailer, mailerPlugin, createMessage, MailBuilder } from './src/mail/index.ts'
export type { IMail, MailMessage, MailAttachment, SendResult, SmtpMailerOptions, ResendOptions } from './src/mail/index.ts'

// ─── AI ───────────────────────────────────────────────────────────────────
export { AIRegistry, AIBuilder, createOpenAIModel, createAnthropicModel } from './src/ai/index.ts'
export type { IAIModel, AIRequest, AIResponse, AIMessage }               from './src/ai/index.ts'

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
         sessionGateLevel, toDataPrincipal, LEVELS,
         applyClaims, membershipClaim, MEMBERSHIP, tenantOf,
         jsonSchemaToJunctionSchema }                              from './src/core/litestone.ts'
export type { GradableUser } from './src/core/litestone.ts'
export type { PrincipalResolver, PrincipalClaims, MembershipClaimOptions, NoClaim } from './src/core/litestone.ts'
export type { WindowResult } from './src/core/litestone.ts'
export type { LitestoneServiceOptions, ParsedQuery,
              LitestoneJsonSchema,
              LitestoneQueryEvent }                                   from './src/core/litestone.ts'

// ─── Channels ─────────────────────────────────────────────────────────────
export { createChannelManager, Channel, channels, publish, publish as publishToChannels } from './src/transport/channels.ts'
export type { Connection, PublishFn, WSMessage, PresenceMember }                          from './src/transport/channels.ts'

// ─── Middleware plugins ───────────────────────────────────────────────────
export { cors, helmet, rateLimit, requestLogger, bodyLimit, correlationId, csrf, combineOrigins } from './src/transport/middleware.ts'
export type { CorsOptions, HelmetOptions, RateLimitOptions, CorrelationIdOptions, CsrfOptions, OriginList, CombinedOrigins } from './src/transport/middleware.ts'

// ─── Health + metrics ─────────────────────────────────────────────────────
export { healthPlugin }                                            from './src/transport/health.ts'
export type { HealthPluginOptions, HealthResponse, MetricsResponse, CheckResult } from './src/transport/health.ts'

// ─── Logger ───────────────────────────────────────────────────────────────
export { createLogger, consoleWriter, fileWriter, multiWriter, noopLogger } from './src/core/logger.ts'
export type { ILogger, LogLevel, LogEntry, LogWriter, LoggerOptions }       from './src/core/logger.ts'

export { defineEnv, generateEnvExample, printEnvExample }   from './src/core/env.ts'
export type { EnvSpec, EnvFieldSpec, EnvOutput }            from './src/core/env.ts'

// ─── Auth providers ───────────────────────────────────────────────────────
export { createBetterAuthAdapter, createBetterAuthPlugin }        from './src/auth/providers/better-auth.ts'
export type { BetterAuthAdapterOptions }                          from './src/auth/providers/better-auth.ts'

// ─── Loader ───────────────────────────────────────────────────────────────
export { autoloadServices, loadServiceFile }                      from './src/core/loader.ts'

// ─── Database ─────────────────────────────────────────────────────────────
export { createDatabase, createInMemoryDatabase }                 from './src/storage/database/index.ts'
export type { DatabaseClient, DatabaseOptions, MigrationResult }  from './src/storage/database/index.ts'

// ─── Testing ──────────────────────────────────────────────────────────────
export { createTestApp, createStubAuth, request, testCtx }        from './src/testing/index.ts'
export type { TestApp, TestAppOptions, TestRequest, TestResponse, StubUser } from './src/testing/index.ts'

// ─── Webhooks ─────────────────────────────────────────────────────────────
export { webhooks, createSqliteWebhookStore }                              from './src/plugins/webhooks/index.ts'
export type { WebhookOptions, WebhookManager, WebhookRegistration,
              WebhookDelivery, DeliveryStatus, IWebhookStore }             from './src/plugins/webhooks/index.ts'

// ─── OpenAPI ──────────────────────────────────────────────────────────────
export { openapi, generateOpenAPI }                                from './src/plugins/openapi/index.ts'
export type { OpenAPIOptions, ServiceSchemas, ScalarOptions }      from './src/plugins/openapi/index.ts'

export { outbox }                                                  from './src/plugins/outbox/index.ts'
export type { OutboxPluginOptions }                                from './src/plugins/outbox/index.ts'
export { outboxSchemaFragment }                                    from './src/core/outbox.ts'
export type { OutboxApi, OutboxRow, EnqueueOptions, EnqueueRef,
              DeliverOptions, DeliverResult }                      from './src/core/outbox.ts'

export { backfills }                                               from './src/plugins/backfill/index.ts'
export type { BackfillPluginOptions, BackfillApi }                 from './src/plugins/backfill/index.ts'
export { defineBackfill, backfillSchemaFragment, nextDelayMs,
         assertField as assertBackfillField }                      from './src/core/backfill.ts'
export type { BackfillDefinition, BackfillOptions, BackfillRow,
              ChunkResult }                                        from './src/core/backfill.ts'

export { manifestPlugin }                                          from './src/plugins/manifest/index.ts'
export type { ManifestPluginOptions, AppManifest, ServiceManifest,
              ChannelManifest, HookManifest, AppMeta }              from './src/plugins/manifest/index.ts'

// ─── Devtools ────────────────────────────────────────────────────────────────
export { devtools }                                           from './src/plugins/devtools/index.ts'
export type { DevtoolsOptions, RequestEntry, ConnectionEntry } from './src/plugins/devtools/index.ts'

// ─── Email ───────────────────────────────────────────────────────────────────
export { email, sendSystemEmail, sendCampaignEmail,
         SmtpError, SystemEmailError }                from './src/plugins/email/index.ts'
export type { EmailOptions, EmailMessage, EmailResult,
              SystemEmailConfig, CampaignEmailConfig,
              IEmail, ISystemEmail, ICampaignEmail,
              SmtpConfig, SmtpMessage,
              SendEmailHookOptions }                  from './src/plugins/email/index.ts'
