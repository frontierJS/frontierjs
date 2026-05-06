// index.ts
// Framework public API — everything an app needs, from one import.
//
//   import { createApp, createService, authenticate } from 'framework'

// ─── App ──────────────────────────────────────────────────────────────────
export { createApp }                              from './src/core/app.ts'
export type { App, Plugin, PluginFn, AppOptions, ServiceCaller } from './src/core/app.ts'

// ─── Config ───────────────────────────────────────────────────────────────
export { loadConfig, deepMerge, parseTtl, defaultConfig } from './src/config/index.ts'
export type { AppConfig, JunctionConfig, JunctionMiddlewareConfig,
              JunctionPluginsConfig, JunctionServicesConfig,
              JunctionCaravanConfig, JunctionConduitConfig }  from './src/config/index.ts'

// ─── Errors ───────────────────────────────────────────────────────────────
export {
  FrameworkError,
  BadRequest, Unauthorized, PaymentRequired, Forbidden,
  NotFound, MethodNotAllowed, Conflict, Gone, Unprocessable,
  TooManyRequests, GeneralError, NotImplemented, BadGateway,
  Unavailable, Timeout,
  toFrameworkError, fromStatusCode
} from './src/core/errors.ts'

// ─── Services ─────────────────────────────────────────────────────────────
export { createService, createBaseService, ServiceRegistry, callService, setServiceCache } from './src/core/service.ts'
export type { Service, ServiceDefinition, BaseServiceOptions, CacheDeclaration, TelemetryEvent, CallStartEvent, HookTelemetryEvent } from './src/core/service.ts'

// ─── Hooks ────────────────────────────────────────────────────────────────
export {
  resolvePipelines, mergeHookMaps, runPipeline,
  // Built-in hooks
  authenticate, requireRole, paginate, protect, allow, timestamps, logTiming,
  circuitBreaker,
  // Pipeline-level rate limiter — operates inside the hook pipeline on ServiceContext.
  // Named rateLimitHook to distinguish from the transport-level rateLimit middleware plugin.
  rateLimit as rateLimitHook
} from './src/core/hooks.ts'
export type { Hook, AroundHook, HookMap, ResolvedPipeline, CircuitBreakerOptions, RateLimitHookOptions } from './src/core/hooks.ts'

// ─── Bridge ───────────────────────────────────────────────────────────────
export { bridge, jsonResponse, errorResponse, redirectResponse } from './src/transport/bridge.ts'
export type { ServiceContext, ServiceMethod, AnyMethod }          from './src/transport/bridge.ts'

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
export type { IAuth, SessionContext, CreateUserInput, ApiKeyOptions, RateLimitHookOptions } from './src/auth/types.ts'

// ─── Events ───────────────────────────────────────────────────────────────
export { createScheduler }                                        from './src/plugins/scheduler/index.ts'
export type { JobFn, JobHandle, SchedulerStats }                  from './src/plugins/scheduler/index.ts'

export { createEventBus }                                         from './src/events/index.ts'
export type { IEventBus, EventHandler }                           from './src/events/index.ts'

// ─── Cache ────────────────────────────────────────────────────────────────
export { createMemoryCache, createSqliteCache }                   from './src/cache/index.ts'
export type { ICache, CacheStats, MemoryCacheOptions }            from './src/cache/index.ts'

// ─── Scheduler ────────────────────────────────────────────────────────────

// ─── Workers ──────────────────────────────────────────────────────────────
export { createThread, createPool, workerHandler }                from './src/workers/index.ts'
export type { WorkerHandle, WorkerPoolHandle, PoolStats }         from './src/workers/index.ts'

// ─── File Storage ─────────────────────────────────────────────────────────
export { createFileStorage }                                      from './src/storage/filestorage/index.ts'
export type { IFileStorage, StorageFile, StorageSaveOptions }     from './src/storage/filestorage/index.ts'

// ─── Mail ─────────────────────────────────────────────────────────────────
export { createResendMailer, createSmtpMailer, mailerPlugin, createMessage, MailBuilder } from './src/mail/index.ts'
export type { IMail, MailMessage, MailAttachment, SendResult, SmtpMailerOptions, ResendOptions } from './src/mail/index.ts'

// ─── AI ───────────────────────────────────────────────────────────────────
export { AIRegistry, AIBuilder, createOpenAIModel, createAnthropicModel } from './src/plugins/ai/index.ts'
export type { IAIModel, AIRequest, AIResponse, AIMessage }               from './src/plugins/ai/index.ts'

// ─── Schema ───────────────────────────────────────────────────────────────
export { createSchema, v }                                        from './src/core/schema.ts'
export type { Schema, FieldDef, SchemaOptions, CompiledSchema, ValidationResult, ValidationError } from './src/core/schema.ts'

// ─── Litestone ───────────────────────────────────────────────────────────
export { createLitestoneBase, parseQuery as parseLitestoneQuery, parseWhere,
         deriveModelName, withLitestoneDb,
         createLitestoneService, jsonSchemaToJunctionSchema }       from './src/core/litestone.ts'
export type { LitestoneServiceOptions, ParsedQuery,
              LitestoneServiceConfig, LitestoneJsonSchema,
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
