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
  | 'agent'     // remote server agent
  | 'local'     // local unix process

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
  | { type: 'hmac';    ref: string }
  | { type: 'none' }

export interface TargetDescriptor {
  id:              string
  kind:            TargetKind
  protocol:        Protocol
  address:         string
  auth:            TargetAuth
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
// replica against a shared set of dynamically registered agents.
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

  timeout_ms?: number
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

export interface ConduitError {
  kind:      ConduitErrorKind
  target:    string
  protocol:  Protocol | null
  message:   string
  retryable: boolean
  raw?:      unknown
}

// ─── Hooks ──────────────────────────────────────────────────

export interface ConduitHooks {
  onRequest?:      (req: ConduitRequest) => void
  onResponse?:     (req: ConduitRequest, res: ConduitResult<unknown>) => void
  onError?:        (req: ConduitRequest, err: ConduitError) => void
  onReconnect?:    (target: string) => void
  onRegistered?:   (descriptor: TargetDescriptor) => void
  onDeregistered?: (target: string) => void
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

  // Hard cap on a response body, in bytes. Default: 10 MiB.
  // Reading stops and the request fails with `invalid_request` rather than
  // buffering an unbounded response from a misbehaving provider.
  max_response_bytes?: number

  hooks?:       ConduitHooks

  // Expose management routes as a Junction service.
  // Disabled by default. Descriptors returned by these routes carry
  // credential *refs* only — no secret material. The routes are still
  // unauthenticated unless the app installs auth, either app-wide via
  // app.hooks({ before: { all: [authenticate] } }) or per-service.
  management?:  boolean | { path?: string }
}

// ─── The Interface ──────────────────────────────────────────

export interface IConduit {
  init(): Promise<void>

  send<T>(req: ConduitRequest): Promise<ConduitResult<T>>
  stream(req: ConduitRequest): AsyncIterable<ConduitChunk>

  register(descriptor: TargetDescriptor): Promise<void>
  deregister(target: string): Promise<void>
  resolve(target: string): Promise<TargetDescriptor | null>
  list(): Promise<TargetDescriptor[]>

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
}
