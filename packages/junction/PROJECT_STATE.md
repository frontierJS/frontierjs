# Junction — project state

Last verified by running: **2026-08-17**.

## Snapshot

| | |
| --- | --- |
| Version | 0.1.0 — **published to npm 2026-08-10**, tag `latest`, public. Bun-only by construction: Node will not strip types inside `node_modules`, and compiling would only move the failure later (`Bun.serve`, `Bun.file`, `bun:sqlite`) |
| Tests | **1193 pass / 0 fail**, 56 files, 2,285 assertions (`bun run test`, 12s) |
| Typecheck | **clean — 0 errors**, and junction is absent from `scripts/typecheck-baselines.json`, where absent means 0 (`FJS-034`). It was 212, then 138, then gone; clearing the last of it found eleven defects in the shipped types, because `tests/` and `example/` are the only code here that uses junction the way an app does |
| Realm | API / D8 |

## What works

Services + hook pipeline, HTTP and WebSocket transport, channels, the browser
client, and the batteries (mail, cache, scheduler, workers, file storage,
webhooks, AI, OpenAPI, manifest, devtools, health, the transactional outbox).

Two verbs decide when an effect runs. `ctx.afterCommit(fn)` is ordering — it
runs only if the call succeeded and, under `transactional:`, only after the
commit. `ctx.enqueue(job, payload)` is durability: it writes an `OutboxMessage`
row inside the call's own transaction and `app.configure(outbox())` relays it to
`app.jobs` (`FJS-D35`). They are two verbs because a closure cannot be written
to a table.

Schema-derived behaviour is the load-bearing part: `createService({ model })`
merges `gateAuth()` and `autoValidate()` through `createBaseService`, so a model
service gets 401s and 400s from `db/schema.lite` without declaring them.

Runnable examples are verified over HTTP — `example/README.md` has the ladder
(`minimal/` → `elegant.ts` → `fullstack/` → `single-file.ts`). A broken example
is a bug, not a sketch.

## Invariants worth knowing before you change anything

These are the ones that have already cost a debugging session each. The full
accounts are in `CHANGES.md`.

- **`toFrameworkError()` is THE error boundary** (`src/core/errors.ts`) — one
  point where a thrown value becomes a status. If you own an error class, give
  it a numeric `status`; that needs no registration and no dependency on
  Junction. `registerErrorMapper(fn)` is for errors you cannot modify.
- **Startup is ONE named phase list** — `runStartPhases(bindHost)` in
  `src/core/app.ts`. Add a phase to the list, never to one caller.
- **`register` is `=> void`, not `=> Promise<void>`.** `configure()` runs it
  synchronously. Async setup goes in `boot()`.
- **`app.claim(name, value)`** is the guarded namespace claim — it throws on a
  taken name instead of silently overwriting. Named `claim` and not `provide`
  because a Provider is a third party the app speaks to (`FJS-D06`).
- **`app.registerMetricsSource(name, fn)`** is the blessed way into `/metrics`.
  The store behind it is `_metricsSources`; a plugin reaching for that field
  directly is guessing, and the guess fails silently.
- **Raw-route path params are `{id}`, not `:id`** (`PARAM_PATTERN` in
  `src/transport/router.ts`). `:id` registers as a literal static segment and
  404s forever, silently. On a raw route `ctx` is a `TransportContext`: path
  captures are `ctx.route` (never `ctx.params`, which does not exist on either
  context — `FJS-D03`) and headers are on `ctx.headers`.
- **`app.principal()` / `app.runAs(userId, fn)`** are the seam deferred work runs
  through. `runAs` re-resolves the id via `IAuth.sessionFor` and opens the ALS
  scope, so a service call inside names no `auth` and inherits one; `null` means
  `createApp({ system })`.
- **`hasRoute()` is a matching question, not an existence one.** Use
  `hasExactRoute(method, path)` for "is this endpoint mounted", and
  `routePaths(method)` to list where things actually landed.
- **Patch helpers must test key presence, not `??`.** `updates[k] ?? current`
  makes an explicit `null` mean "leave it alone", so a nullable column can never
  be cleared. Use `key in updates ? updates[key] : current`.
- **Never pattern-match on a caller-supplied name in SQL.** Webhook event
  matching is `json_each()` equality; a `LIKE` built from an event name leaked
  payloads across subscriptions.
- **`ctx.query` is filters, `ctx.directives` is result shaping.** `$` is
  transport syntax only, parsed by the bridge and by nothing else — nothing past
  `src/transport/bridge.ts` sees a `$`.

## Typecheck — why the runner exists, and the rule

Packages in this monorepo import each other's raw `.ts` source, so a bare
`tsc --noEmit` reports the *dependency's* diagnostics alongside your own —
conduit saw 78 of Junction's. `scripts/typecheck.mjs` reports only the package's
own diagnostics and takes a `--baseline N` ratchet.

**Lower a baseline when you improve it; never raise one.** The runner tells you
when to: it prints `below the baseline of N. Lower the baseline in package.json
to lock the improvement in.`

Junction's 212 is the highest in the repo and it is almost entirely in `tests/`
(implicit `any` in test callbacks, `App` cast to `Record<string, unknown>`, a
few genuinely wrong service-definition literals). It dropped to this number when
`app.conduit` stopped being redeclared — older notes quoting 214/216/224/226
predate that.

## Open — see `ISSUES.md`

Open items for this package are in the repo-wide register, not here, and **no
defect is currently open against junction**. What is:

**`FJS-D30`** — should login work over the WebSocket? Today it cannot: `/auth/*`
deliberately is not a service and the socket dispatches one frame type. The
recorded rationale for the split is that auth must be UNGATED, which is not the
same as HTTP-only. The hard part is not the frame: channels key off
`ctx.auth.user`, so a socket that logs in mid-life keeps its anonymous
subscription set and silently misses its own events.

Two rows owned elsewhere are half junction's: **`FJS-268`** (an app compiles the
whole framework on every `tsc` run because the `exports` map points at `.ts` and
nothing emits `.d.ts` — a cost question now that the output is clean) and
**`FJS-279`** (nothing in jetty can talk to a real Junction; the browser client
exposes no channel-subscription API, so a conforming adapter cannot be written
against it as it stands).

The ten issues and four decisions this section used to list are all closed. An
id that is no longer here resolves in `ISSUES.md` § Closed, in
`ISSUES_ARCHIVE.md`, or as a ruling in `DECISIONS.md`.

Add a new one to `../../ISSUES.md`, not to this file.

## Layout

`README.md` (users) · `PROJECT_STATE.md` (this) · `CHANGES.md` (history,
newest first) · `docs/ARCHITECTURE.md` (depth). Per the root convention, nothing
else belongs at this package root.
