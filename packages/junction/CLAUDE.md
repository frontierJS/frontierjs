# Junction — Project Context

`@frontierjs/junction` is the API realm: services, the hook pipeline, HTTP and
WebSocket transport, channels, the browser client, and the batteries. TypeScript,
Bun-only. It sits above Litestone and below Sierra, and never imports Sierra
(Invariant 1). Litestone is an optional peer reached by dynamic `import()`, so
junction runs without it and a static import of it under `src/` breaks every
modelless app at load.

## Rules a change must keep

Each names its pin. The failure behind each is `docs/internals.md`, by path.

- **A broadcast is graded per recipient**, on the service path and on the
  background tap alike, with the DECLARED `model:` as the accessor (`FJS-D175`,
  `FJS-672`, `FJS-700`) — `test/realtime-grading.test.ts`. A connection's claims
  are the app's to state, per channel (`FJS-749`, `test/channel-claims.test.ts`).
- **A service broadcasts through `channel:` or the `announce()` hook, never
  both**, matched on the hook's mark rather than its name (`FJS-045`,
  `test/double-broadcast.test.ts`).
- **A write is done when the OUTERMOST transaction commits.** The commit scope in
  `core/context.ts` drains `afterCommit` and the announcement on commit and
  discards both on rollback (`FJS-682`, `FJS-688`, `test/commit-scope.test.ts`).
- **The gate wraps every hook an app wrote** —
  `around(gateAuth) → before → validated → method → after` (`FJS-403`,
  `test/hook-ordering.test.ts`).
- **A custom method takes the model's read gate as a floor**, and a `gate:` on a
  CRUD verb is graded only over no model (`FJS-826`, `FJS-D408`,
  `test/custom-method-gate.test.ts`). **An omitted `model:` resolves from the
  service's NAME**, so a model-less service named like a model is graded by that
  model; `model: null` says there is none, and `serviceAccessor()` is the one
  reader — never write `model ?? name` (`FJS-D628`).
- **A filtered bulk PATCH/REMOVE writes one row at a time through `update()`**,
  under `bulkMax` (`FJS-044`, `test/bulk-partial-success.test.ts`).
- **An `Idempotency-Key` needs a principal and names ONE request** — a stranger's
  key is ignored, a changed payload is 422 (`FJS-680`, `test/idempotency.test.ts`).
- **The METHOD decides list vs single, and a stream is refused by name**, from
  a method or a hook (`FJS-140`, `FJS-D13`, `FJS-1693`, `test/envelope.test.ts`).
- **What a thrown value becomes is committed and executed** — `errors.snapshot.md`
  at this root, `junction errors` (`FJS-255`, `test/errors-snapshot.test.ts`).
- **Every socket bound is the socket's own**, since every HTTP bound stops at the
  upgrade (`FJS-705`, `FJS-704`, `test/ws-limits.test.ts`). Presence is opt-in and
  batched on a timer (`FJS-703`, `test/presence-scale.test.ts`).
- **A reconnect is a gap**: the client emits `reconnected` and a live list refetches,
  jittered (`FJS-701`, `test/reconnected.test.ts`). A present WS token that does not
  verify closes 4001; no token stays anonymous (`FJS-702`,
  `test/realtime-grading.test.ts`).
- **A shutdown that does not finish exits 1** (`FJS-693`, `test/shutdown.test.ts`).
- **A `junction.config.js` key reaches the app only where `loadConfig` maps it**
  (`FJS-1066`, `FJS-D256`) — `test/config-surface.test.ts` fails a key added
  without a behavioral row.
- **A route registers once**, keyed on its shape (`FJS-225`,
  `test/duplicate-routes.test.ts`).
- **A webhook destination is graded at registration and before every attempt, and
  its subscriber is read from the registrant** (`FJS-681`, `FJS-D193`,
  `test/webhook-targets.test.ts`, `test/webhook-payload.test.ts`).
- **A CRLF in a mail address or header is refused at the builder AND at
  `sendMessage()`** (`FJS-677`, `test/mail-injection.test.ts`).
- **The static server serves a file inside its root**, symlinks resolved, 404 on
  the way out (`FJS-746`, `test/static-root.test.ts`). Its cases are shared with
  sierra's origins: one found by either goes in
  `test/fixtures/served-path-vectors.json` (`FJS-D653`).
- **`$` throws outside a call, and a call that has ended is outside it**
  (`FJS-687`, `test/call-scope.test.ts`).
- **A claim resolver runs inside the data hook, for a guest as well as a
  session, and a guest's claims never become `ctx.auth.user`** (`FJS-D113`,
  `test/principal-claims.test.ts`).
- **`principal` may be a list, run in order and merged; a claim name two
  elements emit is refused by name, and every element's `describe()` is read**
  (`FJS-D522`, `FJS-D694`, `test/principal-list.test.ts`). **A grant is minted by
  the caller's own create and a link redeemed for a cookie through `bearerClaim`'s
  `mint`/`redeem`**, never a second write below the boundary (`FJS-D819`,
  `test/bearer-claim.test.ts`). **A session beside a grant is a 400 before the
  grant is read, unless the grant states `session: 'merge'`** (`FJS-D832`, same
  file § a session beside a grant).
- **A test names no port** — `port: 0`, then read `app.http.port` (`FJS-900`,
  `test/test-ports.test.ts`).
- **The whole package typechecks to zero, `test/` included** — junction has no
  baseline, and absent means 0 (`FJS-034`, Invariant 14).

## Proving a change

```bash
bun run test            # test:all adds the example
bun run typecheck       # must be clean
bun run test:browser    # the devtools console, in Chrome
```

Then `example` `bun run verify` and `verify:jobs`, and `basecamp` `bun run verify`.
A change to channels or `announce` also needs `example` `verify:live`, the only
drive that watches a SECOND tab and so tells a broadcast from a tab's own echo.
A change to either transport's context also needs `@frontierjs/testing`'s
`bun run test`, whose parity runner puts one call down both.

| A change that adds… | …joins |
| --- | --- |
| a `junction.config.js` key | a behavioral row in `test/config-surface.test.ts`, naming its axis |
| a `ServiceContext` field | `test/context-contract.test.ts`, which runs each field's rule and names its axis |
| a `src/` directory, or a core import of a battery | `test/edge.test.ts` — classified, or an allow-list row that is a ruling |
| an error class or a status | `errors.snapshot.md`, regenerated by `junction errors` |
| a broadcast path | `test/realtime-grading.test.ts` — one recipient admitted and one refused |
| a cache behavior | `test/cache-conformance.test.ts` — one body, both drivers |
| a documented OpenAPI operation | `test/openapi-round-trip.test.ts`, which calls it |
| a cross-package behavior | `test/real-litestone-client.test.ts`, against a real client |
| a type on the far side of the wire | `test/client-types.test.ts`, which compiles a fixture with `tsc` |

## What the default gets wrong

- **Path captures are `ctx.route`**; there is no `ctx.params` on either context
  (`FJS-D03`).
- **A raw route writes `{id}`**; a `:id` is a literal segment.
- **`app.get`/`app.post` apply `apiPrefix`**; `app.http.router` is the escape for
  a path that must not move.
- **`update` is `patch` with an id required, and it MERGES** (`FJS-D179`).
- **`after` is after the METHOD.** An effect that must not run early goes in
  `ctx.afterCommit(fn)`, and one that must not be lost in `ctx.enqueue(job, payload)`.
- **`register` is sync.** Async setup and reading `junction.config.js` go in
  `boot()`; only a throw in `ready` lets the app start.
- **A timer in `boot()` ticks in every one-shot process.** `junction call` and
  the snapshot tools boot with `_startOnce()`, which runs `boot()` and skips
  `work()`; a worker, poller or `setInterval` goes in `work()`, and
  `app.scheduler` holds its jobs until then (`FJS-D551`,
  `test/start-work.test.ts`).
- **An internal caller's directives ride `{ directives }`** in the options, and
  filters are the first argument.
- **`_find`/`_get`/`_create` skip junction's hooks and keep Litestone's gate.**
- **A frame goes out through `wsSend()`** in `transport/send-queue.ts`, which
  holds what Bun drops.
- **`ctx.data` is a row or an ARRAY of rows**; a hook narrows with `Array.isArray`.
- **A `__`-prefixed context field is a declared contract.** A cast to
  `Record<string, unknown>` to reach one is the smell.
- **A Litestone client is probed with `'x' in db`**, since `typeof db.x` throws, and
  `$tapQuery`/`$tapEvents`/`$logContext` are on the ROOT client only (`FJS-673`).
- **Junction's edge is four axes and a host** (`FJS-D639`): admission, the call,
  carriage, announcement, and `createApp`. Everything else is a battery behind a
  subpath — nothing under `src/core/` or `src/transport/` imports one outside
  the allow-list in `test/edge.test.ts`, and the main entry re-exports none. A
  battery types its `app.<slot>` by augmenting an empty `App*` interface, never
  by an import in `app.ts` (`FJS-D640`). A schema-declared thing that needs a
  process and a queue is a battery over `app.jobs`, shipped with its `.lite`
  fragment (`FJS-D643`). Junction opens no database: `createApp({ db })` is the
  one way in (`FJS-D641`).
- **Junction owns no file store** (`FJS-D260`). Litestone's `FileStorage` is the one;
  junction owns the crossing — `transport/body.ts` parses multipart,
  `transport/bridge.ts` merges it into `ctx.data`, the client encodes a `File`.
- **A standing is the app's mapping**: `callerGateLevel` asks `db.$levelOf`, and
  `sessionGateLevel` is the fallback that never reads a `role` column (`FJS-D308`).
- **`createApp({ tenants })` replaces `createApp({ db })`** rather than joining it.
- **Helmet headers are on until `http: { helmet: false }`; CORS, the DDoS gate and
  the rate limiter are off until configured**, and `'*'` is never applied for you.
- **A test injects a transport rather than mocking a module**; `mock.module()` is
  process-wide in bun (`FJS-908`). A hand-built context sets `ctx.result = null`.

## The two contexts

Which one you hold is decided by where the code is mounted.

| | `TransportContext` | `ServiceContext` |
| --- | --- | --- |
| You get one by | `app.get` / `app.post` / a middleware / a WS handler | a service method, any hook, `app.service(x).method()` |
| Created per | **request** | **call** — one request may make several |
| The principal | `ctx.user` — flat, may be `null` | `ctx.auth.user` — frozen, propagates |
| Caller environment | `ctx.ip`, `ctx.headers` | `ctx.caller.{ip,userAgent,headers}` |
| Path captures | `ctx.route` | `ctx.route` — `{}` on an internal call |
| The URL's search | `ctx.query` — **raw, `$` keys present** | `ctx.query` (filters) + `ctx.directives` (shape) |
| Scratch | — | `ctx.locals`, fresh every call |
| Wire-only keys | — | `ctx.transients` (payload), `ctx.reserved` (query) |
| Columns the app supplies | — | `ctx.system`, a Set a hook adds to |
| Responding | `ctx.json` / `text` / `html` / `file` / `sse` / `paginate` | return a value; the envelope is built for you |
| Reaching the other | — | `ctx.$raw` — the transport ctx, or `null` |

The bridge copies `route` and the principal across unchanged. The HTTP and WS
paths build a context separately — `bridge.toContext()` and `bridge.internal()` —
so a fact one derives, the other must lift out of the frame by hand.

**Two stores.** The request store holds `RequestMeta` and its one owner is
`enterRequest(src, fn)` / `reenterAs(user, fn)`. The call store is `$`, the
`ServiceContext` of the call in progress, opened around the whole of
`_callService`; `enterCall(ctx, fn)` opens it for a hand-built context.

## Seams this package owns

- **`transport/bridge.ts`** is the transport↔service handoff: nothing above it
  touches `req`/`res`, nothing below touches a service.
- **`callService`** is the one announcement point, for the bus and the channels.
- **`core/litestone.ts`** is the Data adapter — `withLitestoneDb`/`withTenantDb`,
  `gateAuth`, `autoValidate`/`validateInput`, `toDataPrincipal`.
- **`core/directives.ts` and `core/events.ts` import nothing**, so the browser
  client names them without pulling `node:async_hooks` into a bundle (`FJS-1181`).
- **`core/app-model.ts` is one walk over a built app**; the snapshot tools under
  `tools/` render it and hold no walk of their own.

## Where to look

| Question | Answer |
| --- | --- |
| How a feature is used | `README.md`, one section per feature |
| How to write an app against junction | `AGENTS.md` |
| Why the code is shaped this way | `docs/internals.md`, by path |
| Correct-but-surprising behavior in the API realm | the `api-hazards` skill |
| Who owns a cross-package seam | the `bridge-index` skill |
| Open defects, rulings, state | `ISSUES.md` · `DECISIONS.md` · `PROJECT_STATE.md` |

<!--
The layout below is for `fli done`'s layout-named check, which reads this file raw.
Claude Code strips a block-level HTML comment before injecting the file, so an
agent pays nothing for it. It must stay outside a code fence, since a comment
inside one is kept.

index.ts — the four axes and the host; no battery (FJS-D639, test/edge.test.ts)
src/
  core/
    app.ts — createApp; the plugin protocol; configure, start, ready, running, shutdown
    service.ts — createBaseService (five CRUD verbs), createService, callService
    context.ts — ServiceContext; the request store (enterRequest, reenterAs) and the call store ($, enterCall)
    directives.ts — QueryDirectives, the $-prefixed key fields; imports nothing
    hooks.ts · hooks-builtin.ts · hooks-resilience.ts — the pipeline and around; the built-in hooks; circuitBreaker, rateLimit
    litestone.ts — the Data adapter: withLitestoneDb, withTenantDb, gateAuth, autoValidate, validateInput, toDataPrincipal
    envelope.ts — the result envelope, one owner
    events.ts — AUTO_EVENT_MAP and the publish-hook mark; imports nothing (FJS-1181)
    app-model.ts — one walk over a built app, for every register that renders one; buildRoutes, serializeHookMap
    build-id.ts — which build this is, and which one the browser is on (FJS-D160)
    attachments.ts — the attached service, declared here and bound per environment (FJS-D158)
    errors.ts — named HTTP error classes and retryable
    schema.ts — request validation from the generated JSON Schema
    loader.ts — auto-discovers *.service.ts
    services-dir.ts — where an app's services are, one answer
    rate-limit.ts — the one rate limiter
    public-url.ts — assertPublicUrl: whether a URL a stranger chose may be fetched; @frontierjs/junction/public-url (FJS-1579)
    idempotency.ts — claimIdempotency
    metrics.ts — reading a counter, beside db/metrics.lite
    query-values.ts — what a directive's value means: parseSort, parseSelect, comparatorFor
    diagnostics.ts — whether to print developer diagnostics
    field-errors.ts — a thrown value carrying one message per field
    config-scope.ts — configuration read at call scope, per tenant
    env.ts — defineEnv
    logger.ts — the leveled logger
  config/index.ts — loadConfig, junction.config.js onto AppConfig
  transport/
    bridge.ts — the transport and service handoff
    http.ts — Bun.serve: routing, body, auth resolution, static, gzip
    router.ts — two-tier route cache
    channels.ts — channels, publish, gradeRecipients
    presence.ts — presence tracking
    send-queue.ts — wsSend, the one owner of a frame
    forwarded.ts — which client address to believe (http.trustProxy)
    middleware.ts · body.ts · health.ts · static.ts · types.ts
  client/
    index.ts — the browser client: WS first, HTTP fallback, client.auth, resource()
    nodes.ts — one node per row, keyed by model (FJS-D138)
  auth/ — types.ts (IAuth, SessionVerifier) · credentials.ts (signedRequest)
  plugins/
    manifest/index.ts · openapi/index.ts · devtools/index.ts · devtools/admin.html
    webhooks/ — index.ts · payload.ts (what a subscriber may receive)
    declared.ts — the plugins junction.config.js may declare; the one plugins/ module core names (FJS-D256)
    outbox/ — index.ts · engine.ts (ctx.enqueue's row and the relay pass)
    backfill/ — index.ts · engine.ts (the middle step of expand, backfill, contract, FJS-D157)
    export/index.ts (the governed extract, FJS-D228) ·
    metrics/index.ts (keeping what /metrics said) · commitments/index.ts (the sweep under @@commitment, FJS-D368)
  mail/ — index.ts · smtp.ts
  cache/index.ts · events/index.ts · scheduler/index.ts · ai/index.ts
  testing/index.ts — createTestApp, request, withTestMeta
tools/
  cli.ts — the package bin; respawns the named tool as its own process
  surface.ts · jobs-snapshot.ts · notifications-snapshot.ts · principal-snapshot.ts — the four app snapshots
  errors-snapshot.ts — errors.snapshot.md, this package's own; takes no app
  atlas.ts — describeAppModel as JSON on stdout
  call.ts — one service method, once, as a person, the answer as JSON on stdout
  app-module.ts — reading a built app off a module
  repl.ts — a REPL against a running app
  check-app-db.mjs · check-auto-validation.mjs · check-explicit-schema.mjs · check-gate-auth.mjs ·
  check-service-options.mjs · check-type-imports.mjs · check-ws-protocol.mjs — standalone checks over an app
db/ — outbox.lite · backfill.lite · metrics.lite, shipped for an app to import
test/ — one file per concern
-->
