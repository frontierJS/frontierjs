# Conduit — Project State

_Verified 2026-09-03 by running the code. Everything below marked **verified** was
reproduced; anything else is labelled as unconfirmed._

> Drop this file into a fresh session to pick up Conduit cold.
> Read `../../CLAUDE.md` for repo-wide vocabulary, then this package's own
> `CLAUDE.md` for the layout and what bites — neither is restated here.

---

## What it is

`@frontierjs/conduit` v0.1.2 — the outbound half of an app's third-party
integrations. A counterparty is declared once, with what credential and under
what policy, and `app.conduit.send()` is how a call to it leaves the process.

Realm: **D4**. Two jobs that share a package and not a mechanism — a generic
`provider` over http or unix, and an FJS-to-FJS control-plane link over
`websocket` that reaches an Outpost. Deliberately narrow; `README.md` § *What
Conduit is not* is the boundary as shipped.

## Verified state

| | |
|---|---|
| Tests | **290 pass, 0 fail**, 595 expect() calls, 2 files, 13.2s (`bun run test`) — verified. Stack traces in the output are two observers throwing on purpose |
| Typecheck | **clean, no baseline** (`bun run typecheck`) — verified |
| Test files | `conduit.test.ts` (261 cases) and `junction-integration.test.ts` (26) — the second is the one that boots a real Junction app, which is where this package's plugin bugs have always been |
| Published | 0.1.2 on npm per the root `CLAUDE.md`; **not re-checked against the registry here** |

Reproduce: `cd packages/conduit && bun run test && bun run typecheck`.

Three things landed in the three days before this file and each has its
`CHANGES.md` entry: per-target policy (`FJS-728`), a refused replay no longer
travelling outward as `retryable: true` (`FJS-733`), and an outbound call
carrying the request that caused it (`FJS-742`).

The suite proves the mechanism against stubs and a recorder. What proves it
against a real vendor is `example`: `verify:stripe` and `verify:notify` — see
`CLAUDE.md` § Proving a change. **Neither was run for this file.**

---

## What is NOT built

- **No receiver.** Conduit dials and does not listen, though the relationship is
  the noun and the receiving end is this package's to own. Verifying a webhook is
  app code today. `IDEAS/inbound-integrations.md`.
- **`FJS-710` is the standing audit register for this package**, open, and it is
  where the honest gap list lives — fourteen numbered findings covering
  credentials (no expiry, refresh or rotation, no tenant seam, no single-flight),
  response decoding (text-only, binary destroyed, no charset), the WebSocket
  transport ignoring every knob http honours, and the batteries conduit does not
  yet have. Promote one to its own id when it is worked; do not open a second
  register.
- **`FJS-659`** — junction's `ai` and `mail` batteries hand-roll the ring this
  package exists to own, and its webhooks plugin is a third. Open, and it is a
  question about where the boundary goes rather than a defect here.
- **`FJS-660`** — `result.meta.duration_ms` reports the last attempt where
  `stats()` reports the whole call, so a retried request under-reports on the
  public result. Open, small, and self-contained.
- **`FJS-739`** — a provider outage answers `retryable: false` on `example`'s
  payment path. Open, filed against `example · conduit`, and it may be one fix
  with the fault taxonomy in `FJS-710`.

## Picking it up next

`FJS-660` is the one to take first: it is a single number with a stated correct
answer, and fixing it settles which of two clocks the public result reports.
`FJS-739` is the one that matters most, because it is the only entry here found
by a drive rather than by reading, and the answer to it decides whether the fault
taxonomy under `FJS-710` gets promoted to its own id.

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
