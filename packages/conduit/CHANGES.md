# Changes — @frontierjs/conduit

## 2026-09-04 — `retryable` says only whether THIS request may be sent again

`FJS-739`, ruled `FJS-D194`. 290 tests, 0 fail. Typecheck clean.

`FJS-733` found the dangerous direction and fixed it: a request conduit will not
replay came back `retryable: true`, a job acted on the flag, and a charge was
repeated. The squash it added went wider than its own argument, which is *the
request went out and nobody knows whether it was applied* — the fact
`declineReplay` computes under the name `indeterminate`, and correctly withholds
from a 429 and from a refused connection before squashing both anyway. Two more
sites never went through that function: load shed at admission wrote
`retryable: false` as a literal, for `circuit_open` — whose own message names the
seconds to wait — and for `overloaded`.

Measured, four of five rows wrong. The three that never left the process are the
sharpest: they cannot have been applied, and two of them clear on their own.

`indeterminate` decides the flag now. Where nothing was applied a fault keeps
whatever its own kind said, which leaves a 404 permanent — the control that says
the rule is not *transient means retryable*. `FJS-733`'s 500 and timeout rows are
asserted beside every flip, because wrong toward `true` is a double charge and is
much worse than wrong toward `false`.

**The consumer this was costing.** `example`'s `collect-invoice` throws on
`retryable` and logs-and-returns otherwise, so five failures opened the breaker
and every send for the next thirty seconds was an outage reported as permanent:
the invoice written off in a `console.error`, the job green.

**`CONDUIT_ERROR_KINDS` is new and the type derives from it.** Three kinds were
wrong at once because a kind with no stated answer reads exactly like a decided
one; the suite walks the array, so a kind added without one fails.


## 2026-09-03 — an outbound call carries the request that caused it

`FJS-742`. 290 tests, 0 fail. Typecheck clean.

**Every ingredient was already built and none of them had been introduced.**
`createTraceContext` shipped with nobody wiring it, junction holds the
correlation id on `requestMeta()`, and the default correlation header here is
already `X-Request-Id`. Measured against a listening recorder: an inbound
request stating both `x-request-id` and `traceparent` produced an outbound call
carrying **neither**, so nothing could join a target's logs to the request that
caused them.

**The plugin defaults `trace` now**, and it does it under the caller's own
(`{ trace: junctionTrace(), ...opts }`) — so an app with its own tracer replaces
this whole thing rather than fighting it, and `trace: () => null` turns it off.
An upstream trace wins over a derived one, which is the difference between
hanging off the caller's span and making this process the root of a trace it is
already in the middle of. Junction is the other half: it carries `traceparent`
and `tracestate` on `RequestMeta` now, verbatim.

**Where nobody sent a trace, the id is DERIVED from the correlation id.** A
random trace per call would make six calls from one request six unrelated
traces, which is the thing this exists to prevent — and the case that matters
needs no derivation at all: junction mints correlation ids with
`crypto.randomUUID()`, and a uuid with its dashes out IS a 32-hex trace id.
Anything else folds through FNV-1a twice; not a cryptographic hash and it does
not need to be, since the input is already the request's own identity and the
output is only ever compared for equality with itself. Outside a request — a
job, a script, boot — a fresh trace is the right answer rather than a missing
one.

`parseTraceparent` takes version `00` and nothing else: a future version may
append fields, and forwarding ids out of a format nobody here understands is
worse than starting fresh. Both readers are exported, because an app replacing
the default needs them rather than a second copy of the W3C format.

## 2026-09-03 — a replay conduit refused is a replay nobody else should make

`FJS-733`. 278 tests, 0 fail. Typecheck clean.

**The flag now says what the loop decided.** A non-idempotent method with no
idempotency key was never replayed — that part was right — and the error was then
handed back untouched, still carrying the transient fault's `retryable: true`.
That flag is what the layer above acts on: `example`'s own mailer copies it onto
the Error it throws and a caravan job retries on it, so *we will not send this
again* traveled outwards as *send this again*, on the one class of request where
a duplicate takes money. `declineReplay` is the one place the judgement is made.

**`indeterminate` is what that flag was standing in for.** The request went out
and nobody knows whether it was applied — a different question from whether
sending it again is safe, and the one a payment caller actually needs. Set for a
`timeout`, a `server_error` and a `connection_failed` that got past the
handshake; never where nothing left the process, since a flag that fires on every
network fault is one nobody reads. Bun answers `ConnectionRefused` for a refused
port and an unresolvable name alike, and `CERT_*` is matched as a prefix because
a failed handshake wrote no request. Where the two cannot be told apart the
answer is *indeterminate*: reporting it wrongly costs a caller one check, and the
other way round costs a duplicate charge.

**`idempotency` on the target.** `header` names what the key travels under —
`Idempotency-Key` is the convention and PayPal reads `PayPal-Request-Id`, and a
wrong name fails in the worst way: the key is sent, ignored, and a retry the
caller believed was collapsed is a second charge. `auto` mints one for any
non-idempotent request that carries none, **once per `send()` and not per
attempt**, or each replay would be a fresh request under a fresh key, which is
the duplicate the key exists to prevent. On the target because it asserts
something about the far end that conduit cannot discover; off by default,
because minting a key for a target that ignores it turns one refused retry into
four charges.

**`ConduitRequest.replayable` is the assertion that was missing.** A key says
*the target collapses duplicates*; this says *repeating this is harmless*, and
they are not the same claim. Minting a payment intent is the case that forced it
— it moves no money and the shop writes no row until it succeeds, so a second
one costs nothing, while a key would be actively wrong: after a decline the next
attempt must be a NEW intent rather than the refused one handed back. Conduit
sees a method and a path and can know neither, so only the caller can say so.
`example`'s PSP connector declares it, which is what makes a provider blip heal
instead of surfacing to a shopper.

**Every refusal is `put()`'s now.** `register()` held the `follow_redirects:
'same-origin'` refusal and `init()` writes `opts.targets` straight through
`put()` — so a STATIC target, which is how a provider integration is actually
declared, skipped it entirely. One `assertDescriptor` for redirects, idempotency
and policy alike.

11 tests, each with the control that separates the fix from a blanket
suppression — a GET on the same target, at the same timeout, keeps
`retryable: true`. Stubbed one at a time they fail 2 / 1 / 1 / 6.

## 2026-09-03 — policy belongs to a target

`FJS-728`. 269 tests, 0 fail. Typecheck clean.

**A target declares what it costs when it misbehaves.** `TargetDescriptor.policy`
carries the seven numbers policy was made of — `timeout_ms`, `retry_limit`,
`deadline_ms`, `max_response_bytes`, `failure_threshold`, `reset_ms`,
`max_concurrent` — each falling back field by field to the conduit-wide option of
the same name, so a descriptor that states one keeps the conduit's answer for the
rest and a descriptor that states nothing behaves exactly as it did. They were
conduit-wide, and one conduit carries a card processor, a mail sink and an
outpost: 10s with three retries is generous for the mail sink, thin for a card
capture, absurd for a health probe. The only way to say so was a SECOND conduit,
which also means a second registry and a second set of breakers.

**The field was already being written and dropped in silence.** A descriptor
declaring `timeout_ms: 1` answered a 300ms request as a success, and TypeScript
cannot see it — a descriptor read out of a store is a `TargetDescriptor` by
assertion, and excess-property checking only fires on an object literal. So an
unknown field under `policy` is refused **by name** at `register()`, and so is a
value that cannot mean anything: the author is telling you about a typo, not
asking for the default they wrote the field to override.

**Two owners, and the second is the one that is not obvious.** The router merges
the transport half when it builds the transport; the breaker and the concurrency
gate are consulted BEFORE any descriptor is resolved, so `Resilience.setPolicy`
is fed twice — by `put()` for what this process registers, and by the router for
a descriptor it read out of the store, which is the only way a target another
replica registered is ever graded by its own numbers. `setPolicy` deliberately
does not reset the counts: a policy change says nothing about a target's health,
and clearing the trip count on re-register would make a heartbeat a way to keep a
broken target admitted.

**Two persistence traps, both the same shape one level apart.** The SQLite
registry drops any descriptor field absent from `EXTRA_KEYS`, so a policy would
have survived no restart (`FJS-657`). And `JSON.stringify` writes `Infinity` as
`null`, which reads back as *field absent* — silently restoring the cap
`max_concurrent: Infinity` was written to remove — so it is carried as a string
and revived on read.

Every one of the 8 tests is a pair: the target that declared a policy beside an
otherwise identical target on the same conduit that did not, because a change
that applied the number to everything looks identical from the declaring side.
7 of 8 fail with the merge stubbed, and the eighth fails against either half of
the persistence fix stubbed on its own.

## 2026-09-03 — the kind says who is at fault, and a burst sheds

`FJS-684`, `FJS-685`. 261 tests, 0 fail. Typecheck clean.

**`server_error` is 5xx and nothing else** (`FJS-684`). It was every non-2xx and
every unusable body as well, and that one word feeds three consumers that
disagree about it: whether to retry, the `retryable` flag a caravan job acts on,
and the circuit breaker's failure count. Measured: five 404s in a row opened the
breaker on a target that had answered all five, after which correct requests
were shed locally as `circuit_open`. Two kinds carved out beside the three that
were already there — **`client_error`** for a 4xx the target understood and
refused, carrying `raw` because a validation report or a decline code is the
half a caller can act on; **`invalid_response`** for an answer that is unusable,
which is HTML where a payload was expected, a body that did not parse as the
JSON it claimed, and a response that failed the caller's own `validate`.
`TARGET_FAULTS` is unchanged — the fix is the label, not the set, which is what
makes it small.

**`max_concurrent` defaults to 64** (`FJS-685`). Unlimited was not unbounded: a
burst queues inside the connection pool with the per-attempt timer already
running, so the wait comes back as the TARGET's timeout and opens its breaker.
5000 concurrent against a target that answered every request measured 10s, 136
timeouts, 533 file descriptors and an open circuit; the same burst against a cap
answers instantly, sheds the excess as `overloaded`, and leaves the breaker
closed. `Infinity` restores the old behavior. The finding's other half — moving
the per-attempt timer to socket dispatch — is not needed and is not done: a cap
below the pool means the queue that produced those timeouts does not form, and
`fetch` exposes no dispatch hook to move the timer to.

**A connection failure names itself.** DNS, refused, TLS and a mid-body reset
are one kind and all retryable, which is right — and four different things to
whoever is reading the log. Bun's `code` is the only thing that separates them
and it was not surfaced; it is now in the message.

**`conduit-5` did not reproduce and the row is corrected.** A body shorter than
its declared `content-length` does not arrive as a success: the reader raises,
in all three shapes a server can end early in, and the existing catch already
answers a retryable `connection_failed`. What the original measurement caught is
a `Bun.serve` recorder rewriting a fabricated `content-length` to the real body
length — the declared length never left the test. Pinned with a raw `Bun.listen`,
which is the only way to send a mismatched one; no guard was added, because it
would be unreachable code carrying a comment about a bug that is not there.

## 2026-09-02 — a redirect is an answer, not a hop; and the HMAC signs the query

`FJS-679`, `FJS-678`. 252 tests, 0 fail. Typecheck clean.

**Every fetch is `redirect: 'manual'` now.** It never was, and the default
belonged to the runtime: `fetch` follows a 3xx and re-sends every header it was
given except `Authorization`. Measured against two hosts — host A answers 302 to
host B — an `api_key` target handed B its key, an `hmac` target handed B a valid
signature, and a 302 on a POST arrived at B as a GET still carrying the
`Idempotency-Key`, which is the token that makes a retry safe going to an
address the descriptor never named. A bearer target was the one shape that was
safe, by accident, because that is the header the runtime happens to strip.

A 3xx is its own result kind, `redirected`, carrying `meta.status` and the
resolved `meta.headers.location`. Its own kind rather than a `server_error`,
because the three things that word decides all disagree here: it is not
retryable — the same request gets the same 3xx — it says nothing about the
target's health, so it must not count toward the breaker (five of them under
`server_error` opened it and every later send shed as `circuit_open` against a
target answering correctly), and the caller has something to act on.

`follow_redirects: 'never' | 'same-origin'` on the descriptor, default `never`.
`same-origin` follows at most 5 hops, on GET/HEAD only unless the status is
307/308 — 301/302/303 permit a method rewrite and this transport rewrites
nothing — and never across an origin, which is where the credential leaks. It is
**refused at `register()` beside `hmac` or `api_key`**: a followed hop rebuilds
its headers for the new address, and that is either a signature bound to a path
and query that are no longer the ones being requested, or a key sent somewhere
the descriptor never named. Neither is something a per-request decision can make
safe, so it is a construction-time refusal rather than a runtime branch.

`follow_redirects` is in the SQLite store's `EXTRA_KEYS`, and there is a test for
the round trip. A descriptor field absent from that list is dropped on write with
nothing said (`FJS-657`): the target keeps working and quietly stops following
after the first restart.

**The HMAC signs the query** (`FJS-678`). `buildAuthHeaders` takes a `query`
beside its `path` and the http transport passes `url.search`, so a captured
signed GET can no longer be replayed against different parameters. The websocket
transport signs its upgrade URL's query for the same reason — a verifier
recomputing from the raw URL would otherwise build a different string than this
side did and refuse every connection to an address carrying one. The signature
value carries its version (`v1-sha256=…`); any other version is refused by name
rather than as a mismatch.

## 2026-08-27 — a target declares how its bodies are encoded

`FJS-556`. 204 tests, 0 fail. Typecheck clean.

Every outbound body was `JSON.stringify`d and there was no way past it, so
conduit could not speak to a form-encoded API at all — Stripe, PayPal, Twilio,
every OAuth token endpoint. Not one vendor being unusual: it is most of the
payment world.

The shape it replaced is worse than a plain gap. `Content-Type` was already
overridable, because `...req.headers` is spread after the `application/json`
default — so a caller could set `application/x-www-form-urlencoded` and have the
bytes still be JSON. The request looked configured and was not. Passing a
pre-encoded string did not help either: `JSON.stringify('amount=500')` is
`"amount=500"`, quotes included.

`encoding: 'json' | 'form'` on the **target**, defaulting to `json`. On the
target rather than the call because it is a fact about who is on the other end;
a provider wanting both would be a second target, which is also how its
credentials differ.

**In the transport and nowhere else.** `rawBody` is the same string handed to
`buildAuthHeaders`, which hashes it — so an encoder living in a caller or in a
connector package would sign bytes the transport did not send, and every signed
form request would fail as an invalid credential. There is a test for exactly
that, with the JSON the body would have been as its negative control.

**`transports/encode.ts` is the owner**, and it does not reuse
`@frontierjs/toolbelt/query`, which also emits bracket notation. That module is
Invariant 10's grammar — a wire format designed to round-trip back through
`parseValue` — so it quotes a string that looks like a number (`"5"`), writes
`null` as four letters, and marks an array `k[]`. A provider reads all three
literally. Same punctuation, different language.

Arrays are INDEXED (`items[0][price]`) rather than `items[]`, because `items[]`
cannot express two fields of one item: two `items[][price]` pairs are
indistinguishable from one item with two prices, and a list of objects is the
ordinary shape here. `undefined` is dropped and `null` is sent as an empty
value, since form encoding has no null and empty is what a provider reads as
*clear this* — dropping it would silently turn a clear into a leave-alone.

Six tests over the encoder and five over a real socket, including the signature
one above and a body that will not encode, which is reported as
`invalid_request` with nothing sent.

**What is NOT here is a connector to any named vendor** (`FJS-D153`). Conduit
owns the mechanism; a connector owns the vendor's paths, payload shapes and
webhook signature scheme. The first one — Stripe — lives in
`example/api/src/core/stripe.ts` and moves to `@frontierjs/conduit-stripe` when a
second exists to argue with it.

## 2026-08-19 — the HMAC scheme has one owner (`FJS-349`)

193 tests, 0 fail.

`buildAuthHeaders`'s `hmac` branch built the canonical string, hashed the body
and named the three headers itself. It now calls `signRequest` from
`@frontierjs/toolbelt/signature`; the string on the wire is byte-identical, and
a spec in toolbelt pins that.

The reason is the other end. **Signing with no verifier reads as a scheme being
enforced**: basecamp's three Outpost endpoints took no credential at all while
every outbound call to an Outpost was signed. A receiver has to recompute this
exact string, and two implementations of one string is how it ends up not
being the same string.


## 2026-08-16 — `hooks:` is `observers:` (`FJS-287`, `FJS-D06` §1)

193/193 tests pass, junction integration included; `example`: `verify:notify`
green, so the rename was proven over a real outbound send and not only in types.

Nothing in this option could ever change a request, suppress an error or halt a
send — `safe()` catches a throw and drops a rejection precisely so a failed
metrics export is not a failed deployment. That is the **Observer** tier, and it
was wearing the Hook name. `ConduitHooks` → `ConduitObservers`, `HookResult` →
`ObserverResult`, `createTestConduit({ hooks })` → `{ observers }`.

Breaking for anyone who set it, with no alias: pre-alpha, and the two callers
are basecamp and this package's own suite. Basecamp is where the change proved
itself — its typecheck went red on the now-excess `hooks` property and green
again on the rename, which is what says an app cannot miss this silently.

**`management.hooks` keeps the word on purpose.** That one IS Junction's hook
pipeline: it runs before the management routes and can refuse the call. Two
options, two tiers, two words — where before one word covered both.

## 2026-08-16 — the metrics reach-in is a declared seam (`FJS-D06`)

193/193 tests pass, junction integration included.

`register()` used to write into `app._metricsProviders` behind an
`instanceof Map` guard — the private-field reach-in this package's own
`docs/AUDIT.md` flagged, with the exact failure named: *if Junction renames the
field, metrics silently disappear with no error*. It is now
`app.registerMetricsSource('conduit', …)`, and it is called **unguarded on
purpose**. This plugin imports Junction's `App` type, so a seam that is not
there is a compile error rather than a number that quietly stops being reported.

`app.provide('conduit', …)` is `app.claim('conduit', …)` for the same ruling:
a Provider is now a third party the app speaks to, which conduit already
believed — `'provider'` has been one of its target kinds all along.


## 2026-08-13 — `TargetKind`'s `'agent'` member is now `'outpost'`

`FJS-D29` retires *agent* for infrastructure across the repo, because the word
already meant two things here and one of them is going to be an AI. Conduit is
affected beyond prose: **`testing.ts` derives a target's kind from its id prefix**
(`agent:` → `'agent'`), so a caller that renamed its ids without renaming the union
would have had every target graded as the wrong kind, silently.

Breaking for anything constructing `kind: 'agent'` — which is Basecamp, renamed the
same day. 193/193 tests pass, junction integration included.

## 2026-08-08 — a non-JSON response is not a broken target

The HTTP transport refused every content type that was not JSON. The check was
written for one real case — a 200 carrying HTML is a captive portal, a proxy
interstitial or a provider error page — but spelled as "not JSON", which is a
far wider net: **a Slack incoming webhook answers `200 text/plain: ok`**, so
`app.conduit.send()` reported a `server_error` for a notification that had
already been delivered.

Now only markup fails — `text/html`, `application/xhtml+xml`. Anything else
non-JSON comes back as the text it is. A response with no content-type at all
and a body that does not parse is still a failure: nothing said what it was.

Found wiring basecamp's notification channels through the outbound boundary,
where the test delivery arrived at the sink and was reported as an error.
1 test; 193 pass.

## Unreleased

**The header merge was case-sensitive and header names are not** (`FJS-656`). A
caller spelling `authorization` where `buildAuthHeaders` writes `Authorization`
produced two object keys and `fetch` joined them — `Bearer FORGED, Bearer REAL`
on the wire, across bearer, api_key and hmac alike, and `content-type` with it.
`mergeHeaders` in `base.ts` is the one owner now and lowercases every key.

**A response's headers reach the caller** (`FJS-648`). `meta.headers`, on success
and on failure. `Link`, `ETag` and `X-Total-Count` were read and discarded, so a
target that paginates by header could not be walked past page one.

**A 304 is a success** (`FJS-649`) — `data: null`, `meta.status: 304`. It was a
`server_error`, so a conditional request failed in the only way it can succeed.

**`rate_limited` is its own error kind** (`FJS-650`), carrying a parsed
`retry_after_ms` that the retry ladder waits instead of its own backoff, and out
of the circuit breaker's fault set — a 429 says the target is healthy.

**`encoding: 'binary'`** (`FJS-651`). Bytes pass through untouched; bytes under
`json`/`form` and a structure under `binary` are both refused by name.
`@frontierjs/toolbelt/signature` hashes bytes now, so a signed binary request
signs what was sent.

**`headers` on a target** (`FJS-652`) — a pinned API version, a required
`User-Agent`. Below the caller's, below auth.

**The SQLite registry keeps the optional fields** (`FJS-657`). It had never
stored `encoding`, so a restart turned a `form` target back into a JSON one.

**The default signature prefix is `X-Fjs`, was `X-Hub`** — a leftover from when
this package was one app's fleet arm. Every in-tree user took the default, so the
rename is atomic; `@frontierjs/toolbelt/signature` owns it.
