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
  | 'broker'    // a broker somebody else runs — subscribed to, never sent to (FJS-D235)

import type { BodyEncoding } from './transports/encode.ts'
export type { BodyEncoding }
import type { Receiver, ReceivedEvent, Delivery, Received, ReceiveResult } from './receive.ts'

// ─── Target ─────────────────────────────────────────────────

// Targets carry a *reference* to a credential, never the credential
// itself. The material is fetched at send time by the CredentialResolver
// (see below) and is never persisted in the registry, returned from
// resolve()/list(), passed to hooks, or exposed on the management routes.
//
// `ref` is resolver-defined: an env var name for the default env resolver,
// a secret path for a vault-backed one, a key for createStaticResolver().
//
// `refusal` names what this target answers a refused credential with besides
// a 401, and each one is then `auth_failed` and forgotten and replayed exactly
// as a 401 is. A system that only has a login page usually never says 401:
// Service Autopilot answers an expired session with its login page as a 200,
// and a 302 to it is the other common spelling. Without the declaration the
// first is `invalid_response`, the cached session is never forgotten, and
// every send fails until the process restarts (`FJS-1906`). Declared rather
// than assumed, because a captive portal answers 200 markup too and is not a
// credential problem.
//
//   'markup'   — a 2xx whose body is HTML where a payload was expected
//   'redirect' — any 3xx this target does not follow
export const CREDENTIAL_REFUSALS = ['markup', 'redirect'] as const
export type CredentialRefusal = typeof CREDENTIAL_REFUSALS[number]

//
// `per_caller: true` says the material belongs to WHOEVER the send is for — a
// tenant's own login to a vendor, one of a person's connected accounts — and
// not to the process. One declared target, one ref, a credential per caller:
// the resolver is asked `getFor(ref, who)` and never `get(ref)`, and a target
// declaring it is refused at `put()` unless the installed resolver has
// `getFor` (`FJS-D848`). Without the flag a per-tenant login read off ambient
// state inside `get(ref)` is cached by ref alone, and the first tenant's is
// sent for the next (`FJS-2232`).
export type TargetAuth =
  | { type: 'bearer';  ref: string; refusal?: CredentialRefusal[]; per_caller?: true }
  // The key travels as `header`, or as the URL parameter `query` for a vendor
  // that reads it nowhere else (Google's legacy Geocoding: `?key=`). Neither
  // name is secret. Under `query` the transport puts the key on the URL it
  // fetches and nowhere a caller or observer is handed, and scrubs it from a
  // failure Bun builds out of that URL (`FJS-2727`).
  | { type: 'api_key'; ref: string; header: string; query?: never; refusal?: CredentialRefusal[]; per_caller?: true }
  | { type: 'api_key'; ref: string; query: string; header?: never; refusal?: CredentialRefusal[]; per_caller?: true }
  // Signs a canonical string over method, path, timestamp, nonce and a
  // hash of the body. `header_prefix` names the three headers this emits
  // (default 'X-Fjs' → X-Fjs-Signature, X-Fjs-Timestamp, X-Fjs-Nonce).
  | { type: 'hmac';    ref: string; header_prefix?: string; refusal?: CredentialRefusal[]; per_caller?: true }
  // A vendor's own scheme (a secret in the body, a minted JWT, SigV4),
  // supplied as a function by the connector: `signer` names one of
  // `ConduitOptions.signers`, `ref` is the secret handed to it (`FJS-D891`).
  // HTTP Basic is the built-in `signer: 'basic'`.
  // A name and not the function, because a descriptor round-trips through the
  // registry as JSON. `params` is the per-target fact a scheme signs under —
  // SigV4's region and service — handed to the signer as `SignInput.params`.
  // Without it the app registered one signer per value under a name like
  // `s3:<region>`, which a conduit rebuilt from the store could not read back
  // (`FJS-2725`). Stored in plaintext: never a secret.
  | { type: 'signed';  ref: string; signer: string; params?: Record<string, string>; refusal?: CredentialRefusal[]; per_caller?: true }
  | { type: 'none' }

// What a signer is handed: the resolved secret and the request as it will go on
// the wire. `body` is what `serialize()` produced, because the bytes signed must
// be the bytes sent (`FJS-D153`). `url` is the full address with its query, and
// `headers` every header already set, lowercased, auth excluded.
export interface SignInput {
  secret:  string
  // The target's `auth.params`, `{}` when it states none.
  params:  Readonly<Record<string, string>>
  method:  string
  url:     string
  path:    string
  query:   string
  body:    string | Uint8Array | undefined
  headers: Record<string, string>
}

// What goes on the wire in addition. `headers` replace any of the same name; a
// `body` replaces the serialized one, for a vendor that wants the secret inside
// it. A signer that returns a body is the one that signs it.
//
// A credential the signer mints (an ES256 JWT, an OAuth access token) is minted
// by the CredentialResolver, whose `get()` is that mint: its expiry is the
// resolver's TTL (`withCache`'s `ttl_ms`), and a 401 forgets it through
// `invalidate` like any other. Conduit never holds a credential's lifetime.
export interface SignOutput {
  headers?: Record<string, string>
  body?:    string | Uint8Array
}

// A non-2xx answer as a signer's `refused` reads it.
export interface RefusedAnswer {
  status:  number
  headers: Record<string, string>
  body:    string
}

// `refused` says which answers are this scheme's own credential refusal beyond
// a 401, so they are forgotten and replayed once as a 401 is. APNs refuses an
// expired provider token with a 403 whose body names it, while a 403 is
// otherwise the credential accepted and the answer no, which reminting does
// not change (`FJS-2721`). On the signer and not the descriptor, because only
// the scheme can read its body and a function is not JSON. A throw is a no.
export type Signer = ((input: SignInput) => SignOutput | Promise<SignOutput>) & {
  refused?: (answer: RefusedAnswer) => boolean
}

export type FollowRedirects = 'never' | 'same-origin'

// Per-target overrides for the conduit's own resilience numbers. Each is the same
// value, with the same meaning and the same default, as the ConduitOptions /
// ResilienceOptions field it shadows — see those for what each one buys.
//
// An absent field is not zero: it defers to the conduit. `0` and `Infinity`
// keep the meanings they have conduit-wide (`failure_threshold: 0` disables the
// breaker, `max_concurrent: Infinity` removes the cap), so a target can opt out
// of a limit the rest of the conduit runs under.
export interface TargetResilience {
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

  // This target is one of our own services, so the conduit-wide `trace` may
  // hand it the inbound request's correlation id and `traceparent`.
  //
  // Absent means a third party, and it gets neither: junction writes that id
  // on every audit row of the request, so a provider holding a user's query
  // and the id holds the join to the person who typed it (`FJS-1413`,
  // `FJS-D507`). A forgotten flag therefore fails closed.
  trace?:          boolean

  // The one certificate this target may present, as PEM.
  //
  // For a counterparty no public CA will vouch for: an outpost reached by a
  // bare IP, serving a certificate it made itself and handed over at
  // enrollment. The connection trusts this certificate and nothing else —
  // neither the public roots nor the hostname, which an IP-only machine has no
  // certificate for. Without it the only way to reach such a machine is plain
  // HTTP, which put every deploy's decrypted env on the wire (`FJS-1603`).
  //
  // Refused at register() anywhere it would be accepted and not applied: a
  // protocol other than 'http', or an address that is not https.
  pinned_cert?:    string

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

  // The address comes with each send, as `ConduitRequest.address`, and
  // `address` here is ''. For a destination an app holds in a row and conduit
  // must never keep: a Slack or webhook URL somebody pasted, which is its own
  // credential (`FJS-1667`). Registering one target per row put the URL in
  // the registry in plaintext and in every observer's hands.
  //
  // A URL somebody else chose is graded by junction's `assertPublicUrl` before
  // EVERY attempt, a retry included, since what a name resolves to is not
  // fixed: no private or loopback address and no http unless `destinations`
  // says so. Refused at register() with a stored `bearer`, `api_key` or
  // `signed` credential (the process's would go wherever the row says), with a
  // followed redirect, a pinned certificate or `trace`. `hmac` is allowed: it
  // signs the body, as a webhook delivery does, and names nothing secret. So
  // is any credential that is `per_caller` (`FJS-D1089`): a self-hosted
  // instance a row names takes that row's own token, and the send states
  // `grant` or is refused, because the grant is what ties the token to the
  // address — keyed on the tenant alone, two rows share one cached token. The
  // breaker and the concurrency cap are kept per origin, so one dead
  // subscriber URL does not close the target for the rest, and observers see
  // the origin only.
  address_from?:   'request'

  // What a request-addressed target may reach beyond public https. A test or
  // a dev receiver on localhost turns both on and says so. `allowPrivate`
  // opens the target to every row, so a counterparty on a LAN is never a
  // row's to name: it is a fixed-address target the operator declares, or an
  // Outpost vantage (`FJS-D1018`, `FJS-D1089`).
  destinations?:   { allowHttp?: boolean; allowPrivate?: boolean }

  // Further origins this counterparty answers on, each a bare origin
  // (`https://www.googleapis.com`). A send reaches one by naming
  // `ConduitRequest.address` — as it may an absolute URL on `address`'s own
  // origin — and an address on any other origin is refused. One provider is often several hosts — OIDC
  // discovery names absolute endpoints, and Google's sit on three origins — and
  // one target per origin made an app register targets for hosts it learned at
  // runtime (`FJS-2730`). The credential goes to every origin listed, so the
  // list is a declaration and never what a send says. Refused beside
  // `address_from`, which is the per-row address, and beside `pinned_cert`,
  // which names one certificate.
  origins?:        string[]

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
  //
  // `field` is where a target that reads its key from the JSON body (Telnyx's
  // `command_id`) names it, in place of `header`: the key is written into the
  // request body under that name. Naming the location is what lets the claim
  // made be the true one, *this target collapses duplicates* — without it the
  // caller claims `replayable` and sends the key as an ordinary body field,
  // which asserts a harmlessness a dial does not have. Beside `header` it is
  // refused: the target reads one place. Only an http or unix target has a body
  // to write into.
  idempotency?:    { header?: string; field?: string; auto?: boolean }

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
  resilience?:     TargetResilience

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

// What a resolver answers. A string is material with no lifetime of its own —
// an env var, a static key. Material a provider minted for a while says when,
// `expires_at` in epoch ms, and `withCache` holds it exactly that long
// whatever its `ttl_ms`: a fixed TTL beside a minted token is a hand copy of
// the provider's number, and one PBX ships `expires_in` as 3600 on one build
// and 60 on another (`FJS-D1075`, `FJS-2245`). `valueOf()` in credentials.ts
// is the one place either shape becomes the string a transport sends.
export type Material = string | { value: string; expires_at?: number }

export interface CredentialResolver {
  get(ref: string): Promise<Material | null>

  // The target refused `value` — a 401, or a shape the target's
  // `auth.refusal` declares: forget it, so the next get() mints
  // or fetches a fresh one, and the send is replayed once on that. A credential
  // a login mints is the case — a session that expired answers 401 and nothing
  // else. Forgets only when `value` is still what get() would return: twenty
  // sends refused on one stale session each call this, and every one after the
  // first arrives when the fresh session is already in place.
  //
  // Optional. A resolver without it answers a 401 as auth_failed, unreplayed.
  invalidate?(ref: string, value: string): void

  // The material for `ref` as `who` holds it, for a target whose auth is
  // `per_caller` (`FJS-D848`). A second method rather than a second argument
  // to get(): a process-scoped resolver that ignored an optional argument
  // would hand every caller the machine's credential with nothing saying so,
  // and a target that needs this is refused at put() when it is missing.
  // Null fails the send closed, as get() does.
  getFor?(ref: string, who: CredentialCaller): Promise<Material | null>

  // invalidate(), for the value getFor(ref, who) answered. Forgets that
  // caller's and nobody else's: one tenant's revoked login is not another's.
  invalidateFor?(ref: string, value: string, who: CredentialCaller): void
}

// Whose credential a per-caller send spends. All three are ids, never
// material. Under junction the plugin reads `tenant` and `principal` off the
// call in progress and the caller states only `grant` — the one fact no
// ambient state carries, since an account can connect several logins to one
// vendor and only the send knows which it means.
export interface CredentialCaller {
  tenant:    string | null
  principal: string | null
  grant:     string | null
}

// Thrown internally when a target's credential cannot be resolved.
// Transports translate this into an `auth_failed` ConduitError; it never
// escapes send(). The offending value is never included in the message.
export class CredentialError extends Error {
  readonly target: string
  readonly ref:    string
  // The mint's own failure, when the resolver threw a MintError: what the
  // `auth_failed` answer takes its `retryable` and `retry_after_ms` from.
  readonly mint?:  ConduitError

  constructor(target: string, ref: string, why?: string, mint?: ConduitError) {
    super(`Credential '${ref}' for target '${target}' could not be resolved${why ? ` — ${why}` : ''}`)
    this.name   = 'CredentialError'
    this.target = target
    this.ref    = ref
    if (mint) this.mint = mint
  }
}

// What a resolver throws when its mint — a token exchange sent through a
// second target (`FJS-D933`) — came back an error. Thrown as anything else it
// is `auth_failed, retryable: false`, so a token endpoint's 503 tells a job
// the credential is wrong and the job drops the work for good (`FJS-2722`).
// Carried, the send is still `auth_failed` — this target was never reached,
// so its breaker is untouched — with the mint's `retryable`, its
// `retry_after_ms`, and the mint's error as `raw`, which names the target that
// failed.
//
//   const r = await conduit.send(tokenTarget, { method: 'POST', path: '/token', body, replayable: true })
//   if (r.error) throw new MintError(r.error)
export class MintError extends Error {
  readonly error: ConduitError

  constructor(error: ConduitError) {
    super(`mint through '${error.target}' failed: ${error.kind} — ${error.message}`)
    this.name  = 'MintError'
    this.error = error
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

  // ─── Receipts — one per inbound delivery a Receiver accepted ───
  //
  // Dedupe means APPLIED, not SEEN (`FJS-1805`): `record` writes the receipt
  // unapplied, `markApplied` is the only thing that makes a later delivery of
  // the same key a duplicate, and a receipt left unapplied by a throw is
  // applied again by the sender's retry. `record` of a key that already exists
  // is a no-op, since two deliveries of one key may race the lookup.
  receipt(provider: string, key: string): Promise<Receipt | null>
  record(receipt: Receipt): Promise<void>
  markApplied(provider: string, key: string, at: number): Promise<void>
}

/** What a Receiver remembers of one delivery. Times are unix ms. */
export interface Receipt {
  provider:    string
  key:         string
  event_type:  string
  owner:       string | null
  received_at: number
  applied_at:  number | null
}

// ─── Request / Response ─────────────────────────────────────

export type QueryValue = string | number | boolean

export interface ConduitRequest {
  target:      string

  // The URL this one request goes to: any URL for a target declared
  // `address_from: 'request'`, otherwise one on the target's own origin or on
  // one it declares in `origins`, and refused for any other. `path` and `query` are applied to it as to a
  // registered address.
  address?:    string
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

  // Whose credential a `per_caller` target spends. Standalone, the caller
  // states it; under junction the plugin writes it from the call in progress
  // and a stated one is refused, so a tenant is never an argument. A
  // per-caller send with none fails closed as `auth_failed`. Ignored by a
  // target that is not per-caller.
  who?:        CredentialCaller

  // Which of the caller's logins to this vendor a per-caller send spends,
  // where it holds more than one. Copied onto `who.grant` by the plugin.
  grant?:      string

  // Opts a non-idempotent request (POST, PATCH) into retries, and
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

  // Per attempt. Shorter than the target's own `timeout_ms`, a miss answers
  // `timeout` and the breaker does not count it: the caller's patience, not the
  // target's health (`FJS-1409`).
  timeout_ms?: number

  // Ends the call: the attempt in flight is cut at the socket, no further
  // attempt starts, and a backoff sleep wakes early. Answered as `aborted`,
  // which the breaker does not count — the caller left, the target did not
  // fail. Without it a fan-out that answered early left every loser running at
  // the provider, and with retries on, conduit began NEW attempts after the
  // answer had gone back (`FJS-1408`).
  //
  // It is also the whole-call deadline: `AbortSignal.timeout(ms)`, or
  // `AbortSignal.any([...])` beside a cancel. There is no per-send
  // `deadline_ms` because it would be the same budget spelled twice, and its
  // expiry, answered as `timeout`, would open a healthy target's breaker for
  // one impatient caller (`FJS-1409`).
  signal?: AbortSignal
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

  // The WHOLE call: every attempt the transport made, and the waits between
  // them. It is the same measurement `stats().latency` is built from, so an
  // app logging off the result and a `/metrics` scrape cannot disagree — they
  // did, by three orders of magnitude, for as long as a transport measured its
  // own attempt (`FJS-660`). Per-attempt latency is not carried: the `onRetry`
  // observer already sees each one, with its error and its attempt number.
  //
  // 0 where nothing was sent — an unknown target, a shed request, a breaker
  // refusal — which is what those calls cost.
  duration_ms: number

  // How many times the ladder sent this request again after the first attempt.
  // A target that collapses duplicates answers a replay with what it did for
  // the first, or refuses it as a duplicate; a result that does not say it was
  // a replay reads that refusal as the first attempt failing. Per send, which
  // `onRetry` is not: it is conduit-wide. The same number a call's `onRetry`
  // was called with last; a remint is not an attempt and is not counted.
  // Stamped by the http and unix transports.
  replays?:    number

  // The response's headers, lowercased. Absent when nothing was sent — a
  // breaker refusal, an unknown target, a body that would not serialize.
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

// Over http, `data` is one `{ event, data, id }` per event of a
// `text/event-stream` body and a `Uint8Array` per read of any other body
// (`FJS-D934`). `meta` is the response the chunk is part of — a `Content-Type`
// to pass a recording on with is answered nowhere else. A websocket stream has
// no response and carries none.
export interface ConduitChunk {
  data:      unknown
  sequence:  number
  timestamp: number
  meta?:     ResponseMeta
}

// Thrown by conduit.stream() when the stream cannot be established, and when
// it ends in a failure. `conduit` is the ConduitError send() would have
// answered; `meta` carries the status, which a vendor's translation of a
// refusal reads beside the kind.
export class ConduitStreamError extends Error {
  readonly conduit: ConduitError
  readonly meta?:   ResponseMeta

  constructor(err: ConduitError, meta?: ResponseMeta) {
    super(err.message)
    this.name    = 'ConduitStreamError'
    this.conduit = err
    if (meta) this.meta = meta
  }
}

// ─── Errors ─────────────────────────────────────────────────

/**
 * Every fault conduit can answer with.
 *
 * An ARRAY the type derives from, and not the other way round: `retryable` and
 * the breaker's fault set are both one answer per kind, and a union cannot be
 * walked at runtime, so a kind added here with no answer beside it read as
 * decided (`FJS-739`). The suite walks this list.
 */
export const CONDUIT_ERROR_KINDS = [
  'target_not_found',
  'connection_failed',
  'timeout',
  'auth_failed',
  'not_implemented',
  // 5xx ONLY. The target is broken, this is retryable, and it is the one
  // response-shaped kind the breaker counts. It used to be every non-2xx and
  // every unusable body as well, which put three unrelated things behind one
  // word that three consumers branch on (`FJS-684`).
  'server_error',
  'stream_error',
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
  'client_error',
  // The target answered and the answer is unusable: HTML where a payload was
  // expected, a body that did not parse as the JSON its own content-type
  // claimed, a body past `max_response_bytes`. Not retryable — the same request renders the same error page —
  // and not a target fault, because a captive portal, a proxy interstitial or
  // a wrong content-type is a misconfiguration and a breaker cannot heal one.
  // A body that arrived SHORT is not this: that is a `connection_failed`,
  // because the bytes stopped rather than being wrong.
  'invalid_response',
  // The target asked us to slow down — HTTP 429, or 503 carrying `Retry-After`.
  // Its own kind rather than a `server_error`, because the two disagree on both
  // counts that matter: this one is always retryable, and it says nothing about
  // the target's health, so it must not count toward the circuit breaker. Under
  // `server_error` a provider's rate limit tripped the breaker and every send
  // after it failed `circuit_open` — load shed by the one status that means
  // *slow down* rather than *I am broken* (`FJS-650`).
  'rate_limited',
  // The request itself is unusable — a body that will not serialize, a method
  // that is not an HTTP verb. The caller is at fault, not the network or the
  // target, so these are never retryable.
  'invalid_request',
  // The breaker for this target is open: it failed repeatedly and Conduit
  // is refusing to send until the reset window elapses. Nothing left the
  // process — this is load shed on the way out.
  'circuit_open',
  // The per-target concurrency cap is full. Also shed before dispatch.
  'overloaded',
  // The target answered a 3xx and this target does not follow redirects (or
  // could not follow this one). Its own kind rather than a `server_error`,
  // because the three things that word decides all disagree here: it is not
  // retryable — the same request gets the same 3xx — it says nothing about the
  // target's health, so it must not count toward the breaker, and the caller
  // has something to act on, which `meta.headers.location` and `meta.status`
  // carry (`FJS-679`).
  'redirected',
  // The caller's `signal` ended the call. Not a target fault — patience is per
  // caller and the breaker is per target. Retryable on the same terms as a
  // `timeout`: a request conduit would replay may be sent again, and one it
  // would not comes back `indeterminate`, since the bytes may have left.
  'aborted',
] as const

export type ConduitErrorKind = typeof CONDUIT_ERROR_KINDS[number]

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
  // loop honors it in place of its own backoff, capped by the deadline; a
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

  // One per inbound delivery a receiver answered, refusals included. An
  // observer: it receives and cannot act. `reason` is the sentence the body
  // never carries — why a 401 was a 401 — and the junction plugin logs it.
  onReceived?:     (path: string, received: Received) => ObserverResult
}

// ─── Options ────────────────────────────────────────────────

export interface ConduitOptions {
  // Registry backend. Defaults to in-memory if omitted.
  // Pass createSQLiteStore(db) for persistence.
  store?:       ConduitStore

  // Resolves TargetAuth.ref to secret material at send time.
  // Defaults to createEnvResolver() — refs are read from process.env.
  credentials?: CredentialResolver

  // The functions a `{ type: 'signed', signer }` target names, by name. A
  // connector exports its own to spread in here (`FJS-D891`). A target naming
  // one that is not here is refused at put(). `basic` (RFC 7617, the ref
  // resolving to `user:password`) is always installed, and a name it holds is
  // refused here (`src/signers.ts`).
  signers?:     Record<string, Signer>

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

  // Told of each broker subscription's liveness so a host can report it. The
  // junction plugin passes `app.registerReadiness`; a subscription that
  // cannot say whether it is still consuming does not ship (`FJS-D235`).
  // `check()` is false while the connection is down.
  registerReadiness?: (name: string, check: () => boolean) => void

  // Expose management routes as a Junction service. Disabled by default.
  //
  // Descriptors returned by these routes carry credential *refs* only —
  // no secret material. But the routes still enumerate your infrastructure
  // and can deregister targets, so access has to be a decision, not an
  // oversight: enabling management requires `gate`, `hooks` or an explicit
  // `public: true`. Enabling it with none throws at configure().
  //
  // `gate` is the level on the app's own ladder every route needs. The service
  // is over no model, so a number here is the only thing that can grade it —
  // Junction enforces it, and a surface listing the service (an MCP tool list)
  // reads it, where a hook is invisible to both (`FJS-D408`).
  //
  // `hooks` is Junction's HookMap; it is typed loosely here so the core
  // stays free of a Junction import.
  management?:  {
    path?:   string
    gate?:   number
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
   * timeout, server_error. A misconfigured credential or an unserializable
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
   * `Infinity` restores the old behavior.
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

  /**
   * Receive from a `broker` target. The handler is the handoff: hand the
   * message to whatever does the work once, under `message.id` (caravan's
   * `dispatch({ id })`), and the ack goes out only after it resolves. A throw
   * leaves the message unacknowledged for the broker to redeliver.
   */
  subscribe(target: string, handler: BrokerHandler): Promise<void>

  /**
   * Declare the receiving end of a Provider (`FJS-D899`). Refused by name
   * when a field is unknown or a path is already taken. Under junction the
   * plugin also mounts the route; here it only registers, and `accept()` is
   * what a transport hands a delivery to.
   */
  receive<Cred, Ev extends ReceivedEvent, Owner>(receiver: Receiver<Cred, Ev, Owner>): void

  /** Run one delivery through the receiver declared at `path`. `now` is seconds. */
  accept(path: string, delivery: Delivery, now: number): Promise<Received>

  /** Synchronous snapshot for metrics — reads maintained counters, never the store. */
  stats(): ConduitStats

  /** Close all open transport connections (WebSocket etc.) and release resources. */
  destroy(): Promise<void>
}

// A message the broker delivered. `id` is the broker's own and is the id the
// work is dispatched under, so a redelivery is the same dispatch.
export interface BrokerMessage {
  id:   string
  body: unknown
}

export type BrokerHandler = (message: BrokerMessage) => void | Promise<void>

export interface BrokerHealth {
  connected:        boolean
  last_received_at: number | null   // unix ms
  received:         number
}

export interface ConduitStats {
  // One entry per live broker subscription, keyed by target id.
  subscriptions: Record<string, BrokerHealth>

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

  // Inbound, per result. A receiver declared and never delivered to is a
  // zero row here, which is how a vendor pointed at the wrong URL shows up.
  received: Record<string, Record<ReceiveResult, number>>   // keyed by receiver path

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
