# conduit — package map

**The third parties an app integrates with, declared in one place.** A
counterparty is named once — with what credential, under what policy — and
`app.conduit.send()` is how a call to it leaves the process. v0.1.2, deliberately
narrow. `bun run test` (bun).

**Outbound is what ships; the relationship is the noun.** *Talk to* is a
relationship rather than a dialing direction — a vendor holds two of our secrets
and dials us about as often as we dial it — so the receiving end is conduit's too
and is **not built** (`IDEAS/inbound-integrations.md`). What is NOT conduit's is a
counterparty signing with FrontierJS's *own* scheme, which is junction's, and a
machine caller becoming a principal, which is junction's auth door (`FJS-371`).
The test is *whose scheme is it*.

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
and the far side must implement it, which in practice means an
`@frontierjs/outpost`. So `kind: 'outpost' | 'local'` and `protocol: 'websocket'`
are one feature, not three, and **a third-party WebSocket API is not reachable
through this package**. Streaming is that half's alone — `stream()` over `http`
and `unix` answers `not_implemented`.

---

## Layout

```
src/
  conduit.ts        the core — declare targets, send, apply policy
  router.ts         target resolution
  plugin.ts         the Junction plugin (app.conduit)
  credentials.ts    credential resolvers — a target names one, never inlines it
  resilience.ts     per-target load shedding
  trace.ts          trace-context propagation
  types.ts          the target/message types
  testing.ts        test factory
  transports/       http · websocket · unix · stub · not_implemented · base
    encode.ts       json | form — the ONE place a body becomes bytes
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
  `trace: () => null` turns it off. An upstream `traceparent` is continued; with
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
  own, and `collect-invoice` wrote an invoice off on each of them
  (`FJS-739`, `FJS-D194`). A 404 stays permanent under the rule, which is what
  says it is not *transient means retryable*.
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
  it is off by default for the same reason.
- **Every refusal belongs in `put()`, not in `register()`.** `init()` writes
  `opts.targets` straight through `put()`, so a rule that lives in `register()`
  is one a STATIC target — the way a provider is actually declared — never
  meets. `assertDescriptor` is the door.
- **Policy is per TARGET first and per conduit second.** All seven numbers live
  on `TargetDescriptor.policy` and fall back field by field to the conduit-wide
  option of the same name, so one conduit really can carry a card processor, a
  mail sink and a health probe. Two owners apply it and both are needed: the
  router merges the transport half when it builds a transport, and
  `Resilience.setPolicy` takes the breaker half — fed by `put()` for what this
  process registers AND by the router for a descriptor it read out of the store,
  since admission is graded before any descriptor is resolved. An unknown field
  under `policy` is refused at `register()` **by name**, which is the finding
  rather than tidiness: `timeout_ms` written beside `policy` instead of inside it
  was accepted and ignored, and TypeScript cannot see it — a descriptor read out
  of a store is a `TargetDescriptor` by assertion (`FJS-728`). Adding a field
  means `POLICY_FIELDS`, the router's merge or `Resilience`, **and**
  `EXTRA_KEYS`; a value that JSON cannot carry means the store too.
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
- **A target is declared, not constructed at the call site.** That is the whole
  point of the package: one place lists what this process may talk to, with what
  credential, under what policy.
- **`stub` and `not_implemented` are different answers.** A stub transport
  succeeds with a canned response; NotImplemented refuses. Do not use the first
  as a placeholder for a transport you meant to write.
- **`observers:` and `management.hooks` are two words for two tiers.** Everything
  under `observers:` receives and cannot act — a throw is caught, a promise is
  never awaited — so nothing there can change a request or suppress an error.
  `management.hooks` is Junction's own pipeline and does refuse calls. A new
  `on*` states which tier it is (`FJS-D06` §1).
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
- **The credential must really resolve.** `example`'s drive posts to a dev mail
  sink on :8111 precisely so the request leaves the process carrying a resolved
  credential and can really answer 500 — an outbound path that is only ever
  mocked is the easiest thing in a framework to believe in and never check.

## Proving a change

`bun run test`, then `example`:

- `bun run verify:notify` — the mail path runs over conduit to a real server.
- `bun run verify:stripe` — the TRANSPORT, against a real vendor's dialect. The
  only drive whose sink refuses a wrong content-type rather than parsing whatever
  arrives, so it can fail when the encoding is wrong; its negative control is the
  same connector against a target with `encoding` removed. Starts and stops its
  own API and its own Stripe, on the test port row.
