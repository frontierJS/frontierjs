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
and the far side must implement it. **A third-party socket is reachable only
as a `broker` to listen to**, its framing the connector's (`FJS-D1127`), and
`@frontierjs/outpost` does not use this half either: basecamp registers an outpost as an `http` target with `signed` auth and the built-in `ed25519` signer. A
vendor's event stream is the `http` half's: `stream()` yields one chunk per SSE
event, or the bytes of any other body (`FJS-D934`).

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `src/conduit.ts` is the core — declare targets and receivers, `send`, `accept`, resilience; `src/plugin.ts` is the Junction plugin (`app.conduit`), which writes `who` and wires `trace`.
- `src/receive.ts` is the receiving end — `Delivery`, `Dialect`, `Receiver`, `BrokerReceiver`, and the ONE order a delivery or a frame runs.
- `src/router.ts` resolves a target and merges the transport half of `resilience`; `src/resilience.ts` is the breaker half and per-target load shedding.
- `src/transports/http.ts` owns the retry ladder (`declineReplay`, `refusedCredential`), redirects and streams; `websocket`, `unix`, `broker`, `stub`, `not_implemented` sit beside it; `transports/encode.ts` is the ONE place a body becomes bytes.
- `src/credentials.ts` is the resolvers (`withCache`, `byRef`, `getFor`); `src/signers.ts` the built-in signers, HTTP Basic and `ed25519` (FrontierJS's own scheme under a key pair).
- `src/mirror.ts` is the mirror claim — a connector's models, verbs and parse; `src/observe.ts` the one place an observer is called; `src/trace.ts` trace-context propagation.
- `src/types.ts` holds `TargetDescriptor`, `DESCRIPTOR_FIELDS`, `RESILIENCE_FIELDS`, `EXTRA_KEYS`, `CONDUIT_ERROR_KINDS`; `src/stores/` is sqlite · memory; `src/testing.ts` the test factory.

## What bites here

The fifteen that bite most; the full catalog is `docs/hazards.md`, read it before
touching an error kind, the retry ladder, a credential, a signer, a receiver or
a transport.

- **`kind` says who is at fault, and `server_error` means 5xx and nothing else.** Retry, caravan's `retryable` and the breaker all branch on it; under one word for every non-2xx, five 404s opened a circuit (`FJS-684`). Adding a kind means deciding all three columns, and `CONDUIT_ERROR_KINDS` is the array the union derives from.
- **`retryable` is a statement about THIS request, and `indeterminate` decides it** — false only where the request may already have been applied; never set where nothing left the process. `declineReplay` owns the judgement (`FJS-733`, `FJS-739`, `FJS-D194`).
- **A caller's patience is never the target's fault.** `signal` ends as `aborted`, outside `TARGET_FAULTS`; a per-send deadline is `AbortSignal.timeout`, never `deadline_ms` (`FJS-1408`, `FJS-1409`).
- **`replayable` and `idempotency_key` are two different claims**, and the header name belongs to the target — a wrong name is a key sent, ignored, and a second charge. `idempotency.auto` mints per `send()`, never per attempt; a body-field key is `idempotency.field` (`FJS-1877`).
- **Every refusal belongs in `put()`, not in `register()`** — `init()` writes static targets straight through `put()`. An unknown `resilience` or descriptor field is refused by name (`FJS-728`, `FJS-1951`); adding a field means `DESCRIPTOR_FIELDS`, `RESILIENCE_FIELDS`, the router's merge or `Resilience`, **and** `EXTRA_KEYS`, or it survives no restart (`FJS-657`).
- **`max_concurrent` defaults to 64 and unlimited was never unbounded** — a burst queues inside the pool with the timer running and opens the breaker (`FJS-685`). Shedding as `overloaded` is instant; `Infinity` restores the old behavior.
- **A 3xx is an answer here, not a hop** — every fetch is `redirect: 'manual'` and answers `redirected`, because the runtime re-sends every header but `Authorization` to whatever host the 3xx named (`FJS-679`). `follow_redirects: 'same-origin'` is refused beside `hmac` or `api_key`.
- **The HMAC signs the query, and the version is in the signature value** (`FJS-678`); a verifier recomputes from the RAW request URL. **An `api_key` under `query` is on the fetched URL and nowhere else** — a new string a caller sees goes through `scrub` (`FJS-D940`).
- **`pinned_cert` is `ca`, and a fingerprint callback alone is fail-open** — under `rejectUnauthorized: false` Bun never calls `checkServerIdentity` (`FJS-D557`).
- **A `broker` target is subscribed to, and the ack follows the handler** (`FJS-D235`); readiness is opt-in (`FJS-D1244`). **A Provider's socket is a receiver that names a `target` and mounts no route** (`FJS-D1127`) — the dial was the verification; frames run through one promise chain per connection. A framing that `dial`s owns the address and the credential (`FJS-D1355`, `FJS-D1356`).
- **A mirror forward spends `self.send`, read at call time** (`FJS-D1125`) — the plugin replaces `send` after `createConduit` returns, and a forward holding the unwrapped one makes every human write `auth_failed`.
- **A counterparty on several hosts is one target with `origins`** (`FJS-D939`); **a request-addressed target reaches public https with the row's own credential only** (`FJS-D1089`) — `address_from` plus `per_caller`, the send naming `grant`, or `withCache` sends the first row's token to the second (`FJS-2232`).
- **A Receiver is three parties and one order** (`FJS-D899`): the connector's pure `Dialect`, the app's `Receiver`, and `accept()`'s credential → verify → parse → owner → receipt → apply → mark. **Dedupe means APPLIED, not SEEN** (`FJS-1805`), so applying twice must be safe. A refusal is one 401 sentence, `not verified`.
- **A body becomes bytes in `transports/encode.ts` and nowhere else** — `rawBody` is what `buildAuthHeaders` hashes (`FJS-556`), and `@frontierjs/toolbelt/query` is NOT the form encoder (Invariant 10's grammar quotes `"5"`). An http transport sends `authorize().body`, never its own `rawBody`.
- **A vendor's scheme is a `signed` target, and the function is the connector's** (`FJS-D891`); a minted token is the RESOLVER's, `withCache({ get: mint }, { ttl_ms: Infinity })` (`FJS-D1075`). A resolver or signer that throws has sent nothing — `auth_failed`, never `indeterminate`, never a remint (`FJS-2722`, `FJS-2723`, `FJS-2726`); a refused credential replays once when the resolver can `invalidate` (`FJS-1906`, `FJS-D941`). A caller's credential is `per_caller`, through `getFor(ref, who)`, never `get(ref)` (`FJS-D848`).

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

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
conduit.ts credentials.ts encode.ts http.ts index.ts junction-integration.test.ts mint.test.ts 
mirror.ts observe.ts per-caller.test.ts plugin.ts receive.ts resilience.ts router.ts signers.ts 
stream.test.ts testing.ts trace.ts types.ts 
-->
