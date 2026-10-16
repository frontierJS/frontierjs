# Conduit — Project State

_Verified 2026-10-15 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up Conduit cold.
> Read `../../CLAUDE.md` for repo-wide vocabulary, then this package's own
> `CLAUDE.md` for the layout and what bites — neither is restated here.

---

## What it is

`@frontierjs/conduit` — an app's third-party integrations, both ends of the
relationship (`FJS-D177`). A counterparty is declared once, with what credential
and under what limits; `app.conduit.send()` is how a call to it leaves the
process and `app.conduit.receive()` is how its deliveries arrive (`FJS-D899`).

Realm: **D4**. Two jobs that share a package and not a mechanism — a generic
`provider` over http or unix, and an FJS-to-FJS control-plane link over
`websocket` that reaches an Outpost; a `broker` target is subscribed to
(`FJS-D235`). Deliberately narrow; `README.md` § *What Conduit is not* is the
boundary as shipped.

## Verified state

| | |
|---|---|
| Tests | green (`bun run test`) — verified. Stack traces in the output are observers throwing on purpose |
| Typecheck | **clean, no baseline** (`bun run typecheck`) — verified |
| Test files | `conduit.test.ts`, `junction-integration.test.ts` (boots a real Junction app, which is where this package's plugin bugs have always been), `stream.test.ts`, `mint.test.ts`, `per-caller.test.ts`, `signers.test.ts`, `receive.test.ts` |
| Published | per the root `CLAUDE.md`; **not re-checked against the registry here** |

Reproduce: `cd packages/conduit && bun run test && bun run typecheck`.

The suite proves the mechanism against stubs and a recorder. What proves it
against a real vendor is `example`: `verify:stripe`, `verify:pay` and
`verify:notify` — see `CLAUDE.md` § Proving a change. **`verify:stripe` and
`verify:pay` were run for this file and passed; `verify:notify` was not run.**

---

## What is NOT built

Every open item is a row in `ISSUES.md`; this is the map of them.

- **The receiving end handles one delivery at a time.** A vendor's handshake
  (Graph's `validationToken`, Slack's `url_verification`), a batched delivery
  and a subscription's lifecycle events have no step in the order and wait for
  a second app to ask (`FJS-D899`, `FJS-2573`). `orion`'s webhook door and the
  stressor apps' hand-built receivers are not moved onto it yet.
- **Half A — a partner posting back under FrontierJS's own scheme without
  installing conduit** — is junction's and unbuilt (`IDEAS/inbound-integrations.md`
  § Order step 3). `receive.test.ts`'s dialect is the shape it would take.
- **The credential seam** (`FJS-2245`): no OAuth `TargetAuth`, no expiry on a
  resolver's answer, no cross-replica refresh lock. Both ends of a relationship
  need it, and `per_caller` (`FJS-D848`) is only the principal half.
- **A self-hosted counterparty on a private network has no spelling**
  (`FJS-2923`).
- **Transports reach HTTP-shaped vendors only.** `websocket` and `broker` speak
  conduit's own frame envelope; a third-party WebSocket API, a real broker
  (Kafka, NATS, AMQP) and `ssh` are not reachable. `IDEAS/conduit-batteries.md`.
- **Junction's own webhooks plugin delivers beside conduit** (`FJS-2924`), and
  its `ai` and `mail` batteries dial out directly on purpose (`FJS-659`, closed
  per `FJS-D219`).

## Picking it up next

Anything touching the transport, the encoder or a credential needs `verify:stripe`
run afterwards — the suite here cannot see a vendor's dialect, which is the whole
reason that drive exists.

## Unconfirmed

- The npm version, and whether the tarball's `files:` still covers every entry in
  `exports` — `fli ws:exports` is the check and was not run.
- Whether the WebSocket transport's frame envelope still matches what
  `@frontierjs/outpost` implements; nothing in this suite speaks to a real one.
- Retry, breaker and deadline behaviour under genuine load — the timings here are
  all against stubs.
