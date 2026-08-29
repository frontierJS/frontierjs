// ============================================================
// Conduit — Types
// ============================================================

export type Protocol =
  | 'http'
  | 'websocket'
  | 'unix'
  | 'ssh'    // defined, not implemented in V1
  | 'nats'   // defined, not implemented in V1

export type TargetKind =
  | 'provider'  // external REST API — Hetzner, GitHub, NetBird
  | 'outpost'     // remote server outpost
  | 'local'     // local unix process

import type { BodyEncoding } from './transports/encode.ts'
export type { BodyEncoding }

// ─── Target ─────────────────────────────────────────────────

// Targets carry a *reference* to a credential, never the credential
// itself. The material is fetched at send time by the CredentialResolver
// (see below) and is never persisted in the registry, returned from
// resolve()/list(), passed to hooks, or exposed on the management routes.
//
// `ref` is resolver-defined: an env var name for the default env resolver,
// a secret path for a vault-backed one, a key for createStaticResolver().
export type TargetAuth =
  | { type: 'bearer';  ref: string }
  | { type: 'api_key'; ref: string; header: string }   // header name is not secret
  // Signs a canonical string over method, path, timestamp, nonce and a
  // hash of the body. `header_prefix` names the three headers this emits
  // (default 'X-Hub' → X-Hub-Signature, X-Hub-Timestamp, X-Hub-Nonce).
  | { type: 'hmac';    ref: string; header_prefix?: string }
  | { type: 'none' }

export interface TargetDescriptor {
  id:              string
  kind:            TargetKind
  protocol:        Protocol
  address:         string
  auth:            TargetAuth

  // How this target's request bodies go on the wire. Defaults to 'json'.
  //
  // 'form' is `application/x-www-form-urlencoded` — Stripe, PayPal, Twilio and
  // every OAuth token endpoint. A property of the TARGET rather than of a call,
  // because it is a fact about who is on the other end; a provider that wanted
  // both would be a second target, which is also how its credentials differ.
  //
  // It is here and not in the caller because the encoded body is the same string
  // the HMAC signer hashes — encoding anywhere else signs bytes that were never
  // sent (`FJS-D153`). Response decoding is unaffected and stays content-type
  // driven: a form-encoded API almost always answers JSON.
  encoding?:       BodyEncoding

  registered_at:   number        // unix ms
  last_seen_at:    number | null
}

// ─── Credentials ────────────────────────────────────────────
// Resolves a TargetAuth.ref to its secret material at send time.
//
// Implementations should cache: a transport calls get() once per attempt,
// so a retried request resolves up to retry_limit + 1 times.
//
// Returning null (or an empty string) is a hard failure — the transport
// returns auth_failed rather than sending unauthenticated traffic.

export interface CredentialResolver {
  get(ref: string): Promise<string | null>
}

// Thrown internally when a target's credential cannot be resolved.
// Transports translate this into an `auth_failed` ConduitError; it never
// escapes send(). The offending value is never included in the message.
export class CredentialError extends Error {
  readonly target: string
  readonly ref:    string

  constructor(target: string, ref: string) {
    super(`Credential '${ref}' for target '${target}' could not be resolved`)
    this.name   = 'CredentialError'
    this.target = target
    this.ref    = ref
  }
}

// ─── Store ──────────────────────────────────────────────────
// Implement this to provide a custom registry backend.
// Default is in-memory. Pass createSQLiteStore(db) for
// persistence across restarts.
//
// Every method is async so a networked registry (Redis, Postgres, an
// HTTP service) is implementable — required for running more than one
// replica against a shared set of dynamically registered outposts.
// Implementations must return copies, not live references, from
// get() and list().

export interface ConduitStore {
  init():   Promise<void>
  get(id: string): Promise<TargetDescriptor | null>
  set(descriptor: TargetDescriptor): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<TargetDescriptor[]>
  touch(id: string): Promise<void>   // update last_seen_at — heartbeats
}

// ─── Request / Response ─────────────────────────────────────

export type QueryValue = string | number | boolean

export interface ConduitRequest {
  target:      string
  method:      string
  path?:       string

  // Query parameters. Array values produce repeated keys (`?tag=a&tag=b`).
  // Merged with any query string already present on `path`, and — for GET —
  // with the flattened `body`. Values set here win.
  query?:      Record<string, QueryValue | QueryValue[] | null | undefined>

  body?:       unknown

  // Merged with the auth headers built from the target's `auth`.
  // Auth headers take precedence: a caller cannot override or strip them.
  headers?:    Record<string, string>

  // Opts a non-idempotent request (POST, PATCH) into the retry policy, and
  // is forwarded as an `Idempotency-Key` header so the target can collapse
  // duplicates. Without it, POST and PATCH are never retried — a timed-out
  // `POST /servers` that actually committed must not create four servers.
  idempotency_key?: string

  // Checks the decoded response before it is handed back. Without one,
  // `data` is an unchecked cast: a provider returning {"error": …} under
  // HTTP 200 types and behaves as a success.
  validate?: ResponseValidator

  timeout_ms?: number
}

// Deliberately structural rather than tied to a schema library — Junction's
// `createSchema`, zod, valibot or a hand-written predicate all satisfy it
// with a small adapter, and Conduit's core stays dependency-free.
export interface ResponseValidator<T = unknown> {
  validate(data: unknown): { ok: true; value: T } | { ok: false; errors: string[] }
}

export interface ConduitResponse<T = unknown> {
  data:  T
  error: null
  meta:  ResponseMeta
}

export interface ConduitErrorResponse {
  data:  null
  error: ConduitError
  meta:  ResponseMeta
}

export type ConduitResult<T> = ConduitResponse<T> | ConduitErrorResponse

export interface ResponseMeta {
  protocol:    Protocol | null  // null when target not found before transport dispatch
  target:      string
  status?:     number
  duration_ms: number
}

// ─── Streaming ──────────────────────────────────────────────

export interface ConduitChunk {
  data:      unknown
  sequence:  number
  timestamp: number
}

// Thrown by conduit.stream() when the stream cannot be
// established (target not found, connection failed before
// first chunk). Check err.conduit for structured details.
export class ConduitStreamError extends Error {
  readonly conduit: ConduitError

  constructor(err: ConduitError) {
    super(err.message)
    this.name    = 'ConduitStreamError'
    this.conduit = err
  }
}

// ─── Errors ─────────────────────────────────────────────────

export type ConduitErrorKind =
  | 'target_not_found'
  | 'connection_failed'
  | 'timeout'
  | 'auth_failed'
  | 'not_implemented'
  | 'server_error'
  | 'stream_error'
  // The request itself is unusable — a body that will not serialise, a
  // response larger than the configured cap. The caller is at fault, not
  // the network or the target, so these are never retryable.
  | 'invalid_request'
  // The breaker for this target is open: it failed repeatedly and Conduit
  // is refusing to send until the reset window elapses. Nothing left the
  // process — this is load shed on the way out.
  | 'circuit_open'
  // The per-target concurrency cap is full. Also shed before dispatch.
  | 'overloaded'

export interface ConduitError {
  kind:      ConduitErrorKind
  target:    string
  protocol:  Protocol | null
  message:   string
  retryable: boolean
  raw?:      unknown
}

// ─── Observers ──────────────────────────────────────────────

// Every callback here is an Observer in the FJS-D06 sense: it receives and
// cannot act. None of them can change a request, suppress an error or halt a
// send — a Hook is the tier that may, and conduit has none.
//
// Observers may be async. They are invoked fire-and-forget — never awaited, so
// exporting a span or writing a log cannot slow a request — and a throw or
// rejection is caught and logged rather than failing the caller.
//
// Declared `void` rather than `void | Promise<void>` deliberately. TypeScript
// only ignores a returned value when the expected return type is exactly
// `void`; widening it to a union means the most natural way to write one —
// `(req) => seen.push(req)` — becomes a type error. `void` still accepts an
// async observer, since `Promise<void>` is assignable in a void return position.
export type ObserverResult = void

export interface ConduitObservers {
  onRequest?:      (req: ConduitRequest) => ObserverResult
  onResponse?:     (req: ConduitRequest, res: ConduitResult<unknown>) => ObserverResult
  onError?:        (req: ConduitRequest, err: ConduitError) => ObserverResult

  // Fires once per retried attempt, before the backoff sleep. `attempt` is
  // 1-based: the first retry reports 1. Without this, retries were invisible
  // to any observability the caller wired up.
  onRetry?:        (req: ConduitRequest, err: ConduitError, attempt: number) => ObserverResult

  // Stream lifecycle. onStreamEnd reports how many chunks were yielded;
  // a stream that fails to establish or drops mid-flight reports through
  // onError instead.
  onStreamStart?:  (req: ConduitRequest) => ObserverResult
  onStreamEnd?:    (req: ConduitRequest, chunks: number) => ObserverResult

  onReconnect?:    (target: string) => ObserverResult
  onRegistered?:   (descriptor: TargetDescriptor) => ObserverResult
  onDeregistered?: (target: string) => ObserverResult
}

// ─── Options ────────────────────────────────────────────────

export interface ConduitOptions {
  // Registry backend. Defaults to in-memory if omitted.
  // Pass createSQLiteStore(db) for persistence.
  store?:       ConduitStore

  // Resolves TargetAuth.ref to secret material at send time.
  // Defaults to createEnvResolver() — refs are read from process.env.
  credentials?: CredentialResolver

  // Targets to register immediately on init.
  // Use for provider integrations known at startup time.
  targets?:     TargetDescriptor[]

  timeout_ms?:  number    // default: 10_000
  retry_limit?: number    // default: 3

  // Total wall-clock budget for one send(), across every attempt and every
  // backoff sleep. Default: 45_000. Without it, four attempts at 10s plus
  // backoff can occupy a request handler for ~43.5s.
  deadline_ms?: number

  // Hard cap on a response body, in bytes. Default: 10 MiB.
  // Reading stops and the request fails with `invalid_request` rather than
  // buffering an unbounded response from a misbehaving provider.
  max_response_bytes?: number

  // Lifecycle observers. They receive and cannot act — nothing here can
  // change a request or suppress an error. `management.hooks` below is the
  // other word and means the other thing: Junction's own hook pipeline.
  observers?:   ConduitObservers

  // Per-target load shedding. Without it, a provider outage produces
  // retry_limit+1 amplification against the failing dependency while
  // pinning your own request handlers.
  resilience?:  ResilienceOptions

  // Returns headers to attach to every outbound request — a traceparent,
  // a correlation id. Caller-supplied `req.headers` override these, and
  // auth headers override everything.
  // See createTraceContext() for a W3C-traceparent implementation.
  trace?:       (req: ConduitRequest) => Record<string, string> | null | undefined

  // Expose management routes as a Junction service. Disabled by default.
  //
  // Descriptors returned by these routes carry credential *refs* only —
  // no secret material. But the routes still enumerate your infrastructure
  // and can deregister targets, so access has to be a decision, not an
  // oversight: enabling management requires either `hooks` or an explicit
  // `public: true`. Enabling it with neither throws at configure().
  //
  // `hooks` is Junction's HookMap; it is typed loosely here so the core
  // stays free of a Junction import.
  management?:  {
    path?:   string
    hooks?:  unknown
    public?: true
  }
}

// ─── Resilience ─────────────────────────────────────────────

export interface ResilienceOptions {
  /**
   * Consecutive failures before a target's breaker opens.
   * Default 5. Set to 0 to disable the breaker.
   *
   * Only failures that implicate the target count — connection_failed,
   * timeout, server_error. A misconfigured credential or an unserialisable
   * body is your bug, not the target's, and must not shed load.
   */
  failure_threshold?: number

  /** How long a breaker stays open before admitting one trial request. Default 30_000. */
  reset_ms?: number

  /**
   * Max in-flight requests per target. Default: unlimited.
   * Excess requests fail fast with `overloaded` rather than queueing —
   * a bounded queue just moves the pile-up somewhere less visible.
   */
  max_concurrent?: number
}

export type BreakerState = 'closed' | 'open' | 'half_open'

// ─── The Interface ──────────────────────────────────────────

export interface IConduit {
  init(): Promise<void>

  send<T>(req: ConduitRequest): Promise<ConduitResult<T>>
  stream(req: ConduitRequest): AsyncIterable<ConduitChunk>

  register(descriptor: TargetDescriptor): Promise<void>
  deregister(target: string): Promise<void>
  resolve(target: string): Promise<TargetDescriptor | null>
  list(): Promise<TargetDescriptor[]>

  /**
   * Refresh a target's `last_seen_at` — the heartbeat path.
   * Cheaper than re-`register()`ing a whole descriptor, and it does not
   * evict the pooled connection.
   */
  touch(target: string): Promise<void>

  /** Synchronous snapshot for metrics — reads maintained counters, never the store. */
  stats(): ConduitStats

  /** Close all open transport connections (WebSocket etc.) and release resources. */
  destroy(): Promise<void>
}

export interface ConduitStats {
  targets: {
    total:      number
    byKind:     Record<string, number>
    byProtocol: Record<string, number>
  }

  // Counted at the conduit layer, so latency covers the whole call
  // including every retry — not just the last attempt.
  // Per-attempt retry counts need the onRetry transport hook (not built yet).
  requests: {
    total:      number
    success:    number
    error:      number
    in_flight:  number
    latency_ms: { total: number; avg: number; max: number }
  }

  streams: {
    opened: number
    failed: number   // failed to establish
  }

  errors: Record<string, number>   // keyed by ConduitErrorKind

  // Only targets that are not closed-and-idle appear here, so an empty
  // object means everything is healthy — the shape you want to eyeball
  // at 3am without reading past it.
  breakers: Record<string, {
    state:      BreakerState
    failures:   number
    opened_at:  number | null
    in_flight:  number
  }>
}
