# conduit — package map

**The third parties an app integrates with, declared in one place.** A
counterparty is named once — with what credential, under what limits —
`app.conduit.send()` is how a call to it leaves the process and
`app.conduit.receive()` is how its deliveries arrive. Deliberately narrow.
`bun run test` (bun).

**Conduit is two-way** (`FJS-D177`). *Talk to* is a relationship rather than a
dialing direction — a vendor holds two of our secrets and dials us about as often
as we dial it — so a Provider has a Target (where we send) and a Receiver (the
route it calls us on), and the two share a credential store and no code. Write
*outbound* for the sending end, never for the package. What is NOT conduit's is a
counterparty signing with FrontierJS's *own* scheme: becoming a caller is
junction's door (`createApp({ credentials })`, `FJS-D475`), and a far app's
webhook deliveries are a webhooks SUBSCRIPTION (`FJS-D1087`), which restates
`accept()`'s applied-not-seen order over one fixed dialect — a change to that
order here is owed there too. The test is *whose scheme is it*.

**It is not a wall.** Nothing enforces the declaration — there is no check for a
raw `fetch`, and junction's `ai` and `mail` batteries each dial out directly on
purpose, because a contract with a working default is what keeps this package
optional (`IMail` + `createResendMailer`; basecamp's `core/mailer.ts` is the same
contract backed by conduit, and junction's email CAMPAIGN tier requires conduit by
name). Conduit is where an outbound call belongs, not a boundary around the
process.

**Two jobs, and they are not the same job.** A `provider` target over `http` or
`unix` is a third party — Stripe, an object store, a vendor's REST API — and the
transport is generic. A `websocket` target is an **FJS-to-FJS control-plane
link**: the transport speaks conduit's own frame envelope
(`{ id, type: 'request' | 'response' | 'stream_chunk' | …, method, path, body, seq }`)
and the far side must implement it. **A third-party WebSocket API is not
reachable through this package**, and `@frontierjs/outpost` does not use this
half either: basecamp registers an outpost as an `http` target with `hmac` auth. A
vendor's event stream is the `http` half's: `stream()` yields one chunk per SSE
event, or the bytes of any other body (`FJS-D934`).

---

## Layout

```
src/
  conduit.ts        the core — declare targets and receivers, send, accept, apply resilience
  receive.ts        the receiving end — Delivery, Dialect, Receiver, and the ONE order a delivery runs
  router.ts         target resolution
  observe.ts        the one place an observer is called
  plugin.ts         the Junction plugin (app.conduit)
  credentials.ts    credential resolvers — a target names one, never inlines it
  signers.ts        the signers always installed — HTTP Basic
  resilience.ts     per-target load shedding
  trace.ts          trace-context propagation
  types.ts          the target/message types
  testing.ts        test factory
  transports/       http · websocket · unix · broker · stub · not_implemented · base
    encode.ts       json | form | binary — the ONE place a body becomes bytes
  stores/           sqlite · memory
```

---

## What bites here

- **`kind` says who is at fault, and `server_error` means 5xx and nothing
  else.** Three consumers branch on it and they disagree: the retry decision,
  the `retryable` flag a caravan job acts on, and the breaker's failure count.
  Under one word for every non-2xx, five 404s opened the circuit on a target
  that answered all five, after which correct requests were shed as
  `circuit_open` (`FJS-684`). `client_error` is the target refusing (`raw`
  carries the body, which on a 4xx is the actionable half), `invalid_response`
  is an answer that is unusable — HTML where a payload was expected, a body that
  did not parse, a failed `validate`. Neither reaches `TARGET_FAULTS`, which is
  unchanged and is still the three that mean the target is unwell. **Adding a
  kind means deciding all three columns**: retryable, breaker, and what a caller
  can do with it — the four carve-outs here (`rate_limited`, `redirected`,
  `client_error`, `invalid_response`) each exist because one of the three
  disagreed with the word they were under. **`CONDUIT_ERROR_KINDS` is the array
  the union derives from**, so the suite can walk it: a kind added with no
  `retryable` answer beside it reads exactly like a decided one, which is how
  three of them came to be wrong at once.
- **The junction plugin wires `trace` by default, and everything it needed was
  already here.** `createTraceContext` existed with no caller, junction holds
  the correlation id on `requestMeta()`, and the default header is already
  `X-Request-Id` — so nothing this app sent carried either, and a target's logs
  could not be joined to the request that caused them (`FJS-742`). It is spread
  UNDER the caller's opts, so an app's own tracer replaces it and
  `trace: () => null` turns it off. **It reaches only a target that declares
  `trace: true`** — absent means a third party, which would otherwise hold the join from its
  log of a query to our audit row naming who typed it (`FJS-1413`, `FJS-D507`). An upstream `traceparent` is continued; with
  none, the trace id is DERIVED from the correlation id, because a random one
  per call makes six calls from one request six unrelated traces. A uuid needs
  no derivation — dashes out, it is already a trace id.
- **`retryable` is a statement about THIS request, and `indeterminate` decides
  it.** False only where the request may already have been applied — which is
  what `indeterminate` means: the request went out and nobody knows. Never set
  where nothing left the process — Bun says `ConnectionRefused` for a refused
  port AND an unresolvable name, and `CERT_*` is a prefix — because a flag that
  fires on every network fault is one nobody reads; everything else is on the
  over-reporting side deliberately. **A replay conduit refuses is one case of
  the rule, not a rule beside it**: the ladder returns a non-idempotent request
  with no idempotency key rather than replaying it, and the layer above acts on
  the flag — `example`'s mailer copies it onto a thrown Error and a caravan job
  retries on it, so the charge conduit declined to repeat was repeated one layer
  up (`FJS-733`). `declineReplay` owns that judgement and applies it to the
  indeterminate faults alone; squashing every declined replay answered
  `retryable: false` to a 429 and to a refused connection, and load shed at
  admission said the same of `circuit_open` and `overloaded` — three answers
  about requests that were certainly never applied, two of which clear on their
  own, and `invoice-collect` wrote an invoice off on each of them
  (`FJS-739`, `FJS-D194`). A 404 stays permanent under the rule, which is what
  says it is not *transient means retryable*.
- **A caller's patience is never the target's fault.** `signal` is joined to
  the transport's `AbortController`, and what it ends is `aborted`, outside
  `TARGET_FAULTS`. It is also the only per-send deadline
  (`AbortSignal.timeout`): a `deadline_ms` on the request would expire as
  `timeout` and open a healthy target's breaker for every caller. `req.timeout_ms`
  was that trap until `send()` stopped counting a `timeout` from a request
  timeout shorter than the target's own (`outwaited`, `FJS-1409`). A transport that ignores the signal
  looks like it honors it until a provider's own log shows the loser ran on, so
  the suite asserts the close from the SERVER's `req.signal` (`FJS-1408`).
- **`replayable` and `idempotency_key` are two different claims.** A key asserts
  the TARGET collapses duplicates; `replayable: true` asserts that repeating the
  request is harmless. Minting a payment intent is the case for the second and
  against the first — it moves no money, and after a decline the next attempt
  must be a new intent rather than the refused one handed back. Conduit sees a
  method and a path, so only the caller can make either claim; with neither, a
  failed POST is returned rather than replayed.
- **The idempotency header name belongs to the target.** `Idempotency-Key` is
  the convention, not the rule — PayPal reads `PayPal-Request-Id` — and a wrong
  name is silent in the worst way: the key is sent, ignored, and a retry
  believed collapsed is a second charge. `idempotency.auto` mints one **per
  `send()`, never per attempt**, or every replay is a fresh request under a
  fresh key. It is on the target because it asserts what the far end does, and
  it is off by default for the same reason. **A key the target reads from the
  JSON body is `idempotency.field`** (Telnyx's `command_id`), http and unix only
  and refused beside `header`: without it the caller sent the key as a body
  field and claimed `replayable`, which is false for a dial (`FJS-1877`). A body
  the key cannot be written into is refused, not sent bare. `meta.replays` says
  how many times the ladder sent the request again, so a collapsed duplicate's
  refusal is not read as the first attempt failing.
- **Every refusal belongs in `put()`, not in `register()`.** `init()` writes
  `opts.targets` straight through `put()`, so a rule that lives in `register()`
  is one a STATIC target — the way a provider is actually declared — never
  meets. `assertDescriptor` is the door.
- **Resilience is per TARGET first and per conduit second.** All seven numbers live
  on `TargetDescriptor.resilience` and fall back field by field to the conduit-wide
  option of the same name, so one conduit really can carry a card processor, a
  mail sink and a health probe. Two owners apply it and both are needed: the
  router merges the transport half when it builds a transport, and
  `Resilience.setResilience` takes the breaker half — fed by `put()` for what this
  process registers AND by the router for a descriptor it read out of the store,
  since admission is graded before any descriptor is resolved. An unknown field
  under `resilience` is refused at `register()` **by name**, which is the finding
  rather than tidiness: `timeout_ms` written beside `resilience` instead of inside it
  was accepted and ignored, and TypeScript cannot see it — a descriptor read out
  of a store is a `TargetDescriptor` by assertion (`FJS-728`). The descriptor's own
  keys are refused the same way (`FJS-1951`): `DESCRIPTOR_FIELDS` is a `Record`
  over the interface, so a field added without a line there fails the typecheck.
  Adding a field means `DESCRIPTOR_FIELDS`, `RESILIENCE_FIELDS`, the router's merge or `Resilience`, **and**
  `EXTRA_KEYS`; a value that JSON cannot carry means the store too.
- **A `websocket` target honors the same descriptor as http, field by field**
  (`FJS-D586`): `timeout_ms`, `max_response_bytes` (one inbound frame), and the
  request frame's `headers` (target constant, then caller, plus the idempotency
  key under the target's header name) and `query`. Credentials stay on the
  upgrade, never in a frame. A new descriptor field reaches `WebSocketTransport`
  through the router's `opts`, or it stops at this transport in silence.
  `send()` runs http's ladder minus remint and `Retry-After`: `retry_limit`,
  `deadline_ms`, and `declineReplay` imported from `http.ts`, so a silent reply to
  an unkeyed POST is `indeterminate` here too. `stream()` is never retried.
  **A socket that stays silent through a whole 30s ping interval is terminated**
  (any inbound frame counts, not only a pong), failing pending sends as
  `connection_failed` at once; a `stream_chunk` whose `seq` is not the last plus
  one ends that stream as `invalid_response` (`FJS-2852`).
- **`max_concurrent` defaults to 64 and unlimited was never unbounded.** A burst
  past the pool queues INSIDE it with the per-attempt timer already running, so
  the wait is charged to the target as a timeout and opens its breaker: 5000
  concurrent against a healthy target measured 10s, 136 timeouts, 533 file
  descriptors and an open circuit (`FJS-685`). Shedding as `overloaded` is the
  honest answer and it is instant. `Infinity` restores the old behavior.
- **A truncated response RAISES on this Bun, in all three shapes** — graceful
  FIN, shutdown and RST — so the existing catch already answers a retryable
  `connection_failed` and a length check on `content-length` would be
  unreachable code. `FJS-710`'s `conduit-5` said otherwise; what it measured is
  a `Bun.serve` recorder REWRITING a fabricated `content-length` to the real
  body length, so the client saw a consistent short response and correctly
  reported success. A raw `Bun.listen` is the only way to send a mismatched one.
- **A 3xx is an answer here, not a hop.** Every fetch is `redirect: 'manual'`
  and a redirect comes back as its own kind, `redirected` — non-retryable, not a
  breaker fault, with the resolved `location` and the status on `meta`. The
  default was the runtime's, and the runtime re-sends every header but
  `Authorization`: an `api_key` target handed its key to whatever host the 3xx
  named, an `hmac` target handed over a valid signature, and a 302 on a POST
  arrived at the new host as a GET still carrying the `Idempotency-Key` — so a
  bearer target was the one shape that was safe, by accident (`FJS-679`).
  `follow_redirects: 'same-origin'` opts back in for the cases that need it: at
  most 5 hops, GET/HEAD only unless the status is 307/308, never across an
  origin, and **refused at `register()` beside `hmac` or `api_key`**, because a
  followed hop rebuilds its headers for an address the descriptor never named. A
  descriptor field is also invisible to the SQLite registry unless it is in
  `EXTRA_KEYS` — it round-trips in memory, survives no restart, and says nothing
  (`FJS-657`).
- **An `api_key` under `query` is on the fetched URL and nowhere else**
  (`FJS-D940`). `dispatch` fetches `wire` but answers and judges redirects from
  the keyless URL, and `scrubber` takes the key out of a connection failure,
  which Bun builds from the URL, and out of an echoed `Location`. A new place
  that turns the request URL into a string a caller sees goes through `scrub`.
- **The HMAC signs the query, and the version is in the signature value.** The
  canonical string is six lines and the third is the query: pairs sorted, RFC
  3986 encoded, empty when there is none. It signed the pathname alone until
  `FJS-678`, so a captured `GET /transfer?to=alice` verified unchanged against
  `?to=mallory` and a receiver could not include the query even if it wanted to.
  The value is `v1-sha256=…`; a signature carrying another version is refused
  **by name** rather than as a mismatch, because *signature does not match* is
  the same sentence a wrong secret produces. A verifier must
  recompute from the RAW request URL — a path the router already stripped is a
  different request.
- **`pinned_cert` is `ca`, and a fingerprint callback alone is fail-open.** Under
  `rejectUnauthorized: false` Bun never calls `checkServerIdentity`, so the obvious pin
  accepts every certificate. `ca: <pem>` replaces the public roots and is the refusal. The
  callback beside it only stands in for the hostname check, which an IP-only machine's
  certificate cannot pass (`FJS-D557`). The control in the suite is the same server with
  no pin, refused.
- **A `broker` target is subscribed to, and the ack follows the handler**
  (`FJS-D235`). The handler is where the app dispatches under `message.id`
  (caravan's `dispatch({ id })`); an ack sent before it is a lost message. Every
  subscription registers `conduit:<target>` through `registerReadiness` — *connected*,
  not *recent message*, since a quiet broker is not an outage — and a new broker
  path that cannot say so does not ship.
- **An `http` stream is opened by its first read, through `send()`'s ladder.**
  `stream()` calls the same `attempt()` with `open`, so a refusal before the
  first byte is the kind `send()` answers, thrown as a `ConduitStreamError`
  whose `meta.status` a vendor's `translate()` reads. The per-attempt timer
  covers headers only, and an answer that streams for minutes is not a
  `timeout`. `conduit.stream()` admits through `resilience` like `send()` and
  holds the slot until the stream ends, so a stream never `return()`ed holds
  its `max_concurrent` slot for good. `content-type` decides the chunk:
  `text/event-stream` gives events, anything else gives bytes with no
  `max_response_bytes` cap, except an unfinished SSE event, which is capped,
  because one with no blank line would grow without bound. `stream.test.ts`.
- **A target is declared, not constructed at the call site.** That is the whole
  point of the package: one place lists what this process may talk to, with what
  credential, under what limits. **A counterparty on several hosts is one target
  with `origins`** (`FJS-D939`): a send names an absolute `address`, admitted on
  the target's own origin or a declared one and refused by name otherwise. The
  credential goes to every declared origin, so the list is never a send's to
  widen. Breaker and concurrency are keyed per origin whenever a send names an
  address.
- **A request-addressed target reaches public https, and the only credential
  it carries is the row's own** (`FJS-D1089`). `destinations.allowPrivate`
  opens the whole target to every row, so it is a test receiver's switch: a
  counterparty on a LAN is a fixed-address target the operator declares, or an
  Outpost vantage (`FJS-D1018`), never a row's to name. A self-hosted instance
  behind a public name is one `address_from` target with `per_caller` auth, the
  send naming the row with `grant` — refused by name without it, because
  `withCache` keyed on the tenant alone sends the first row's token to the
  second row's address (`FJS-2232` per row). What conduit cannot see is a
  `getFor` that ignores `grant` and answers a tenant-wide token for every row;
  nothing grades that. Registering one fixed-address target per row is never
  graded and is the hole, not the workaround.
- **A Receiver is three parties and one order** (`FJS-D899`). A connector exports
  the `Dialect` — `verify · parse · dedupeKey`, pure, the clock passed in as
  `ctx.now` in seconds; `parse` may be a promise, because a raw-MIME vendor's
  parse is a MIME parser's (conduit-mailgun, `FJS-D784`) — the app declares
  the `Receiver` around it, and
  `accept()` runs credential → verify → parse → owner → receipt → apply → mark.
  `credential` is a ref through the installed resolver, or a function choosing
  the key for one delivery BEFORE the body is believed (Quo's key is the
  subscription's row). **Dedupe means APPLIED, not SEEN** (`FJS-1805`): the
  receipt is written unapplied, only `markApplied` makes a redelivery a
  duplicate, and an `apply` that throws answers 500 and leaves the receipt so the
  sender's retry gets a clean run — so applying twice must be safe, which the
  subject's own unique key inside the apply is for. `parked` leaves the receipt
  unapplied on purpose. A refusal is one 401 sentence, `not verified`; the reason
  reaches `onReceived` and the junction plugin's log, never the body. A nonce
  memory is per receiver, `toolbelt/signature`'s `nonceMemory`, kept for what
  the dialect states (twice its tolerance). A dialect that needs a step the
  order lacks — a handshake, a batch — is the second asker `FJS-D899` waits for;
  do not grow the record for one.
- **`stub` and `not_implemented` are different answers.** A stub transport
  succeeds with a canned response; NotImplemented refuses. Do not use the first
  as a placeholder for a transport you meant to write.
- **`observers:` and `management.hooks` are two words for two tiers.** Everything
  under `observers:` receives and cannot act — a throw is caught, a promise is
  never awaited — so nothing there can change a request or suppress an error.
  `management.hooks` is Junction's own pipeline and does refuse calls. A new
  `on*` states which tier it is (`FJS-D06` §1). What an observer is handed is `observedRequest`'s
  doing: origin-only address, and body, headers and query run through the
  logger's credential-name walk. Any new observer call site goes through it.
- **A body becomes bytes in `transports/encode.ts` and nowhere else.** `rawBody`
  is the same string handed to `buildAuthHeaders`, which hashes it — so an
  encoder anywhere else signs bytes the transport did not send, and every signed
  request fails as an invalid credential. `encoding: 'form'` on a target is
  `application/x-www-form-urlencoded`; it defaults to `json`. It is on the TARGET
  because it is a fact about who is on the other end. The trap it replaced:
  `Content-Type` was already overridable through `req.headers` while the body was
  not, so a caller could say `form` and still send JSON (`FJS-556`).
- **`@frontierjs/toolbelt/query` is NOT the form encoder, and reusing it is the
  obvious wrong move.** It also emits brackets, but it is Invariant 10's grammar
  — built to round-trip back through `parseValue` — so it quotes a numeric-looking
  string (`"5"`), writes `null` as four letters, and marks an array `k[]`. A
  provider reads all three literally. Same punctuation, different language.
- **A connector to a named vendor does not live here** (`FJS-D153`). Conduit owns
  the mechanism — encoding, auth types, error mapping, idempotency. A connector
  owns the vendor's paths, payload shapes and webhook signature scheme, and gets
  its own package once a second one exists to design the interface against. The
  first is `example/api/src/providers/stripe/index.ts`.
- **A refused credential replays once, POST included, when the resolver can
  `invalidate`.** The target refused before acting, so the replay is safe where
  a retry of a POST is not; it sits outside `retry_limit` and `declineReplay`.
  *Refused* is a 401 or a shape `auth.refusal` declares (`'markup'`,
  `'redirect'`) — a login-page system never says 401, and undeclared its 200
  HTML is `invalid_response`, so the dead session is cached forever
  (`FJS-1906`), or an answer a signer's `refused` names (`FJS-D941`: APNs's
  403 `ExpiredProviderToken`). `refusedCredential()` in `http.ts` is the one
  test; a 403 is in it only through a signer. `withCache`'s `invalidate` is a compare-and-set on the refused
  value — an unconditional forget turns twenty sends racing one expired session
  into twenty logins.
  A minted session is `withCache({ get: login }, { ttl_ms: Infinity })`;
  `meta.headers['set-cookie']` is newline-joined, since `Expires` holds a comma.
- **A vendor's scheme is a `signed` target, and the function is the connector's**
  (`FJS-D891`). `auth: { type: 'signed', signer, ref }` names an entry of
  `ConduitOptions.signers`, because a descriptor is JSON in the registry and a
  function is not. The four older types did not move onto it. **HTTP Basic is
  the one built-in signer** (`src/signers.ts`, always installed, its name
  refused to a connector): four connectors wrote it four ways (`FJS-2233`). The signer gets the
  bytes `serialize()` produced and may return a replacement body — an http
  transport sends `authorize().body`, never its own `rawBody`, or the signed bytes
  were not the ones sent. A minted JWT or OAuth token is the RESOLVER's:
  its `get` answers `{ value, expires_at }` and `withCache({ get: mint }, { ttl_ms:
  Infinity })` holds it exactly that long (`FJS-D1075`) — a fixed `ttl_ms` beside a
  minted token is a copy of the provider's number, and 3CX ships `expires_in` as
  3600 or 60 by build. `valueOf()` is the one place an answer becomes the string
  a transport sends; a non-finite `expires_at` is `auth_failed` by name. `put()` refuses an unknown signer by name, and a signed
  target beside `follow_redirects`, or beside `address_from` unless it is
  `per_caller` (`FJS-D1089`). A per-target fact the
  scheme signs under (SigV4's region) is `auth.params`, strings only, never a
  secret — not a signer registered per value (`FJS-2725`). **A resolver or signer
  that throws has sent nothing**, so `beforeDispatch` makes any throw a
  `CredentialError` — `auth_failed`, never `indeterminate`, never a remint
  (`FJS-2723`, `FJS-2726`). **A mint that calls a third party is a send through
  its own `auth: 'none'` target**, and a failed one is thrown as `MintError`:
  still `auth_failed`, but `retryable` and `retry_after_ms` are the mint's, so a
  token endpoint's 503 does not tell a job to drop the work. The ladder never
  replays an `auth_failed`, or every mint retry is multiplied by this target's
  (`FJS-2722`, `mint.test.ts`). Credentials with different lifetimes are
  `byRef({ ref: resolver })`, one `withCache` each (`FJS-2724`).
- **A credential that belongs to the caller is `per_caller`, and it never goes
  through `get(ref)`** (`FJS-D848`). One target and one ref, a login per
  tenant: the transport asks `getFor(ref, who)` with
  `who = { tenant, principal, grant }`, a 401 calls `invalidateFor` for that
  caller alone, and `withCache` keys on the ref plus all three. The junction
  plugin writes `who` from the call in progress and refuses a send that states
  one; the caller names only `grant`. Reading a tenant off ambient state inside
  `get(ref)` instead is `FJS-2232`: cached by ref, the first tenant's login
  went out on the next tenant's calls. `put()` refuses a per-caller target
  when the resolver has no `getFor`, and on a websocket or broker, whose one
  connection serves every caller. `per-caller.test.ts`.
- **The credential must really resolve.** `example`'s drive posts to a dev mail
  sink on :8111 precisely so the request leaves the process carrying a resolved
  credential and can really answer 500 — an outbound path that is only ever
  mocked is the easiest thing in a framework to believe in and never check.

## Proving a change

`bun run test`, then `example`:

- `bun run verify:notify` — the mail path runs over conduit to a real server.
- `bun run verify:pay` — the RECEIVING end against a provider speaking this
  project's own scheme: four refusals (forged, tampered, stale, replayed nonce)
  and a redelivered event, over a real socket. Needs `bun run api` up on the dev
  row; `verify:stripe` also posts Stripe's dialect at the app's receiver.
- `bun run verify:stripe` — the TRANSPORT, against a real vendor's dialect. The
  only drive whose sink refuses a wrong content-type rather than parsing whatever
  arrives, so it can fail when the encoding is wrong; its negative control is the
  same connector against a target with `encoding` removed. Starts and stops its
  own API and its own Stripe, on the test port row.
