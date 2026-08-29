# conduit — package map

**The outbound boundary.** Every call that leaves the process goes through a
*declared target* — `app.conduit.send()`. v0.1.0, deliberately narrow.
`bun run test` (bun).

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
  first is `example/api/src/core/stripe.ts`.
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
