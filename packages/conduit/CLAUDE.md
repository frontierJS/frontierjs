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
  The value is `v2-sha256=…`; a v1 signature is refused **by name** rather than
  as a mismatch, because *signature does not match* is the same sentence a wrong
  secret produces and every already-deployed Outpost signs v1. A verifier must
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
