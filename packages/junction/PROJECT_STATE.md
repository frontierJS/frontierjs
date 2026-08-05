# Junction — project state

Last verified by running: **2026-08-03**.

## Snapshot

| | |
| --- | --- |
| Version | 0.1.0 — working, self-styled pre-alpha |
| Tests | **781 pass / 0 fail**, 25 files, 1,392 assertions (`bun run test`, 2.2s) |
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

## Open

- **No `apiPrefix` on plugin routes.** `registerServiceRoutes` applies it;
  plugins calling `app.post()` directly do not. `@frontierjs/auth` defaults to
  `/auth` while Junction's own browser client hardcodes `/api/auth/login`, so
  with defaults on both sides they never meet — apps must set
  `prefix: '/api/auth'` explicitly.
- **Litestone `onEvent` has zero Junction subscribers.** Needs a
  post-construction subscribe in litestone, mirroring `$tapQuery`. Mutations
  announced *through* `callService` do fan out to both the bus and channels;
  writes that bypass it are invisible.
- **`createLitestoneService` conflates the accessor with the model name** —
  `scopedDb[model]` wants `lead`, `generateJsonSchema` keys `$defs` by `Lead`.
  The `$defs` miss warns rather than throwing, so a service can silently accept
  unvalidated input. Probably wants two fields.
- **`createService({ model })` has no way to say "read only".** The model brings
  the full CRUD set with it, and a service that declares only `find()` still
  answers `POST`/`PATCH`/`DELETE` through the base — with schema validation, so
  a well-formed payload is *written*. Found in Basecamp: `/audit` is an
  append-only trail and an admin could forge a row into it, verified, until the
  service declared `create`/`patch`/`update`/`remove` that throw
  `MethodNotAllowed` (`basecamp/api/src/services/audit/audit.service.ts`).
  Refusing by hand works but is opt-OUT: every append-only or read-only resource
  is writable until someone remembers four stubs, and nothing warns. Candidates:
  a `methods: ['find', 'get']` allow-list, or `readOnly: true`. The allow-list
  generalises further — it also covers "no bulk delete" without a hook.
- **A custom method's return shape is load-bearing and nothing says so.** Four
  methods across Basecamp answered a partial row — `setVariable` → `{id,
  variables}`, the deployment engine's 5-field projection, `heartbeat` →
  `{ok, server_id, status}`, `jobs.trigger` → `{id, queued}` — and each broke a
  client that did the obvious thing with the result. The payload is also what
  the channel publishes, so a projection with no `id` cannot even be matched to
  the row it describes. Worth stating in the docs, and possibly worth having
  `createService` warn when a method on a model service returns an object with
  no id field.
- **Custom service methods are still called `actions`** and the name is under
  review; dispatch via the `X-Service-Method` header is decided (`DECISIONS.md`).
- **Hook context shape differs across realms.** Junction's split
  (`auth`/`client`/`route`/`locals`, plus `query`/`directives`) is the candidate
  standard, not yet the settled one.

## Layout

`README.md` (users) · `PROJECT_STATE.md` (this) · `CHANGES.md` (history,
newest first) · `docs/ARCHITECTURE.md` (depth). Per the root convention, nothing
else belongs at this package root.
