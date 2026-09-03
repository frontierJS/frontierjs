# Changes — @frontierjs/conduit

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
value is `v2-sha256=…`; an old signer against a new verifier is refused by name.

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
