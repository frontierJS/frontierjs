# Junction — project state

Last verified by running: **2026-08-03**.

## Snapshot

| | |
| --- | --- |
| Version | 0.1.0 — **published to npm 2026-08-10**, tag `latest`, public. Bun-only by construction: Node will not strip types inside `node_modules`, and compiling would only move the failure later (`Bun.serve`, `Bun.file`, `bun:sqlite`) |
| Tests | **866 pass / 0 fail**, 33 files, 1,551 assertions (`bun run test`, 2.0s) |
| Typecheck | **exactly 212** — the baseline. `bun run typecheck` exits 0 |
| Realm | API / D8 |

## What works

Services + hook pipeline, HTTP and WebSocket transport, channels, the browser
client, and the batteries (mail, cache, scheduler, workers, file storage,
webhooks, AI, OpenAPI, manifest, devtools, health).

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
- **`app.provide(name, value)`** is the guarded namespace claim — it throws on a
  taken name instead of silently overwriting.
- **Raw-route path params are `{id}`, not `:id`** (`PARAM_PATTERN` in
  `src/transport/router.ts`). `:id` registers as a literal static segment and
  404s forever, silently. On a raw route `ctx` is a `TransportContext`: `params`
  is path params only, and headers are on `ctx.headers`.
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

Open items for this package are in the repo-wide register, not here:
**`FJS-010`** litestone `onEvent` has no subscriber ·
**`FJS-016`** service definition vs runtime ·
**`FJS-017`** middleware vs hooks ·
**`FJS-018`** types stop at the server ·
**`FJS-019`** dialect trap ·
**`FJS-034`** typecheck baseline ·
**`FJS-043`** `/metrics` `actions: []` ·
**`FJS-044`** bulk patch/remove ·
**`FJS-045`** double broadcast ·
**`FJS-046`** export tiering ·
**`FJS-047`** sibling ownership.
Decisions waiting: **`FJS-D01`**, **`FJS-D02`**,
**`FJS-D10`**, **`FJS-D11`**, **`FJS-D13`**.

Add a new one to `../../ISSUES.md`, not to this file.

## Layout

`README.md` (users) · `PROJECT_STATE.md` (this) · `CHANGES.md` (history,
newest first) · `docs/ARCHITECTURE.md` (depth). Per the root convention, nothing
else belongs at this package root.
