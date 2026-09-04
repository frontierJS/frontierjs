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
  // (default 'X-Fjs' → X-Fjs-Signature, X-Fjs-Timestamp, X-Fjs-Nonce).
  | { type: 'hmac';    ref: string; header_prefix?: string }
  | { type: 'none' }

export type FollowRedirects = 'never' | 'same-origin'

// Per-target overrides for the conduit's own policy numbers. Each is the same
// value, with the same meaning and the same default, as the ConduitOptions /
// ResilienceOptions field it shadows — see those for what each one buys.
//
// An absent field is not zero: it defers to the conduit. `0` and `Infinity`
// keep the meanings they have conduit-wide (`failure_threshold: 0` disables the
// breaker, `max_concurrent: Infinity` removes the cap), so a target can opt out
// of a policy the rest of the conduit runs under.
export interface TargetPolicy {
  timeout_ms?:         number
  retry_limit?:        number
  deadline_ms?:        number
  max_response_bytes?: number
  failure_threshold?:  number
  reset_ms?:           number
  max_concurrent?:     number
}

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

  // Headers sent on every request to this target.
  //
  // Here for `encoding`'s reason: a pinned API version and a required
  // `User-Agent` are facts about who is on the other end, not about one call.
  // Spread at the call site instead, they are one omission away from a request
  // that runs against whatever the account defaults to — and some counterparties
  // make it worse than drift: Basecamp requires a `User-Agent` naming the
  // application and blocks traffic without one, so the first call written
  // without the spread is an outage rather than a difference.
  //
  // Precedence: below `req.headers`, so a caller can still override one, and
  // below the auth headers, which nothing may displace. A name here that
  // collides with an auth header is therefore ignored rather than merged.
  headers?:        Record<string, string>

  // What this target's 3xx answers mean.
  //
  // 'never' (the default) makes a redirect its own result: nothing is re-sent,
  // and `meta.headers.location` says where the target pointed. Until `FJS-679`
  // conduit inherited `fetch`'s redirect-following, which re-sent this target's
  // `api_key` header and its HMAC signature to whatever host the 3xx named —
  // `fetch` strips only `Authorization`, so a bearer target was the ONE shape
  // that was safe. A 302 on a POST also became a GET at the new host, carrying
  // the `Idempotency-Key`.
  //
  // 'same-origin' follows, up to 5 hops, on GET/HEAD only unless the status is
  // 307/308, and never across an origin. It is refused at register() for an
  // `hmac` or `api_key` target: the canonical string binds one path and one
  // query, so a followed hop either re-sends a signature that is no longer
  // valid for the request being made, or sends a key to an address the
  // descriptor never named.
  follow_redirects?: FollowRedirects

  // How this target collapses a duplicate request, if it does.
  //
  // `header` is the name the key travels under. `Idempotency-Key` is the
  // convention and the default, and it is not universal — PayPal reads
  // `PayPal-Request-Id`, and a target that names something else silently
  // received a header it ignores.
  //
  // `auto` mints a key for any non-idempotent request that carries none, once
  // per `send()`, so every attempt inside one send carries the same key. It is
  // declared on the TARGET because it is an assertion about the far end —
  // *this counterparty collapses duplicates under this header* — which conduit
  // cannot discover and a caller should not have to restate per call. Off by
  // default: minting a key for a target that ignores it turns *we did not
  // retry your charge* into four charges.
  idempotency?:    { header?: string; auto?: boolean }

  // What this target costs when it misbehaves. Every field falls back to the
  // conduit-wide option of the same name, so a descriptor that states nothing
  // behaves exactly as it did.
  //
  // It is per-target because the numbers are facts about one counterparty and
  // nothing else: one conduit carries a card processor, a mail sink and an
  // outpost, and 10s with three retries is generous for the mail sink, thin for
  // a card capture, and absurd for a health probe. Held conduit-wide, the only
  // way to say so was a second conduit, which also means a second registry and
  // a second set of breakers. A field here was already being written by hand and
  // dropped in silence — a descriptor carrying `timeout_ms: 1` let a 300ms
  // request succeed (`FJS-728`).
  policy?:         TargetPolicy

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

  // The caller asserting that repeating this request is harmless, for a
  // non-idempotent method conduit would otherwise not replay.
  //
  // A DIFFERENT claim from `idempotency_key`, which asserts the target collapses
  // duplicates. Minting a payment intent is the case: it moves no money and the
  // shop writes no row until it succeeds, so a second one costs nothing — while
  // a key would be wrong, since after a decline the next attempt must be a new
  // intent rather than the refused one handed back.
  //
  // Only the caller can know this: conduit sees a method and a path. Without
  // either assertion a failed POST is returned rather than replayed, and its
  // error says `retryable: false` and, where the outcome is open,
  // `indeterminate: true`.
  replayable?: boolean

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

  // The response's headers, lowercased. Absent when nothing was sent — a
  // breaker refusal, an unknown target, a body that would not serialise.
  //
  // Not a convenience. A large share of the field puts load-bearing answers
  // here and nowhere else: RFC 5988 `Link` is how GitHub, Basecamp and Shopify
  // paginate, so without this a caller cannot fetch page two at all; `ETag`
  // and `Last-Modified` are the input to the conditional request that makes a
  // 304 possible; `X-Total-Count` is the count. They were read and discarded
  // for the package's whole life (`FJS-648`).
  //
  // The whole map rather than an allow-list: a response header from a target
  // the app declared is not our secret, and a list would go stale against every
  // provider that invents one.
  headers?:    Record<string, string>
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
  // 5xx ONLY. The target is broken, this is retryable, and it is the one
  // response-shaped kind the breaker counts. It used to be every non-2xx and
  // every unusable body as well, which put three unrelated things behind one
  // word that three consumers branch on (`FJS-684`).
  | 'server_error'
  | 'stream_error'
  // The target understood the request and refused it — any 4xx that is not a
  // 401/403 (`auth_failed`), a 429 (`rate_limited`) or a 3xx (`redirected`).
  // Its own kind for the reason each carve-out beside it has one: it is never
  // retryable, since the same request gets the same 404, and it says nothing
  // about the target's health, so it must not reach the breaker. Under
  // `server_error` five 404s in a row opened the circuit on a target that had
  // answered every one of them, after which correct requests were refused
  // locally (`FJS-684`). `raw` carries the body, because a 4xx is the one
  // failure whose payload the caller can usually act on — a validation report,
  // a decline code.
  | 'client_error'
  // The target answered and the answer is unusable: HTML where a payload was
  // expected, a body that did not parse as the JSON its own content-type
  // claimed. Not retryable — the same request renders the same error page —
  // and not a target fault, because a captive portal, a proxy interstitial or
  // a wrong content-type is a misconfiguration and a breaker cannot heal one.
  // A body that arrived SHORT is not this: that is a `connection_failed`,
  // because the bytes stopped rather than being wrong.
  | 'invalid_response'
  // The target asked us to slow down — HTTP 429, or 503 carrying `Retry-After`.
  // Its own kind rather than a `server_error`, because the two disagree on both
  // counts that matter: this one is always retryable, and it says nothing about
  // the target's health, so it must not count toward the circuit breaker. Under
  // `server_error` a provider's rate limit tripped the breaker and every send
  // after it failed `circuit_open` — load shed by the one status that means
  // *slow down* rather than *I am broken* (`FJS-650`).
  | 'rate_limited'
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
  // The target answered a 3xx and this target does not follow redirects (or
  // could not follow this one). Its own kind rather than a `server_error`,
  // because the three things that word decides all disagree here: it is not
  // retryable — the same request gets the same 3xx — it says nothing about the
  // target's health, so it must not count toward the breaker, and the caller
  // has something to act on, which `meta.headers.location` and `meta.status`
  // carry (`FJS-679`).
  | 'redirected'

export interface ConduitError {
  kind:      ConduitErrorKind
  target:    string
  protocol:  Protocol | null
  message:   string
  retryable: boolean
  raw?:      unknown

  // The request was dispatched and its outcome is unknown — it may have been
  // applied at the target. Set where a transient fault ends a request conduit
  // will not replay: a POST that timed out carrying no idempotency key is the
  // case, and it is the difference between *this did not happen* and *this may
  // have taken the money*. Never set where nothing left the process (a refused
  // connection, a name that does not resolve) or where the target answered by
  // refusing.
  //
  // Separate from `retryable`, which is the narrower question of whether
  // sending it again is safe. Both are false here, and they are false for
  // different reasons.
  indeterminate?: boolean

  // How long the target asked us to wait, in milliseconds — parsed from
  // `Retry-After`, which is either a count of seconds or an HTTP-date. Set on
  // `rate_limited` and on any other response that carried the header. The retry
  // loop honours it in place of its own backoff, capped by the deadline; a
  // caller handling the error itself gets the same number rather than the
  // header's two possible spellings.
  retry_after_ms?: number
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
   * Max in-flight requests per target. Default: 64.
   * Excess requests fail fast with `overloaded` rather than queueing —
   * a bounded queue just moves the pile-up somewhere less visible, and
   * unlimited was not unbounded either: it queued inside the connection pool
   * with the attempt timer already running, so the wait came back as the
   * target's timeout and opened its breaker (`FJS-685`).
   * `Infinity` restores the old behaviour.
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
