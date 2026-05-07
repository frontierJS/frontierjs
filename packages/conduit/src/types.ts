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

export type TargetAuth =
  | { type: 'bearer';  token: string }
  | { type: 'api_key'; key: string; header: string }
  | { type: 'hmac';    secret: string }
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

// ─── Store ──────────────────────────────────────────────────
// Implement this to provide a custom registry backend.
// Default is in-memory. Pass createSQLiteStore(db) for
// persistence across restarts.

export interface ConduitStore {
  init():   void
  get(id: string): TargetDescriptor | null
  set(descriptor: TargetDescriptor): void
  delete(id: string): void
  list(): TargetDescriptor[]
  touch(id: string): void   // update last_seen_at — heartbeats
}

// ─── Request / Response ─────────────────────────────────────

export interface ConduitRequest {
  target:      string
  method:      string
  path?:       string
  body?:       unknown
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

  // Targets to register immediately on init.
  // Use for provider integrations known at startup time.
  targets?:     TargetDescriptor[]

  timeout_ms?:  number    // default: 10_000
  retry_limit?: number    // default: 3

  hooks?:       ConduitHooks

  // Expose management routes as a Junction service.
  // Disabled by default. Requires auth.
  // TODO: review auth + path config before enabling in prod.
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

  /** Synchronous snapshot for metrics — avoids async in the metrics provider. */
  stats(): ConduitStats

  /** Close all open transport connections (WebSocket etc.) and release resources. */
  destroy(): Promise<void>
}

export interface ConduitStats {
  targets: {
    total:    number
    byKind:   Record<string, number>
    byProtocol: Record<string, number>
  }
}
