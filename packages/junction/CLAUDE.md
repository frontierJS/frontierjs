# Junction — package map

**The API realm.** Services, the hook pipeline, HTTP + WebSocket transport,
channels, the browser client, and the batteries (mail, cache, scheduler,
webhooks, AI, OpenAPI, manifest). Sits **above** Litestone and **below** Sierra;
never import Sierra from here (Invariant 1).

`bun run test` (bun). `bun run test:all` adds the example. `bun run typecheck`
must be **clean** — junction is absent from `scripts/typecheck-baselines.json`
now, and absent means 0 (`FJS-034`).

---

## Layout

```
src/
  core/
    app.ts          createApp() — wires every subsystem. Plugin protocol lives here.
                    Lifecycle: configure → start → ready → running → shutdown
    service.ts      the heart — createBaseService (5 CRUD) + createService (compose)
    context.ts      ServiceContext, OWNED BY CORE. auth / client / route / locals
    directives.ts   QueryDirectives — the `$` fields, and nothing else.
                    Imports NOTHING, so the browser client can name them without
                    dragging node:async_hooks into a bundle. context.ts re-exports
    hooks.ts        Feathers-style pipeline + `around`
    hooks-builtin.ts, hooks-resilience.ts
    litestone.ts    the Data adapter — withLitestoneDb, withTenantDb, gateAuth,
                    sessionGateLevel, toDataPrincipal, accessorCandidates
    envelope.ts     the result envelope — one module, one owner
    outbox.ts       the transactional outbox — ctx.enqueue + the relay pass
    errors.ts       named HTTP error classes + `retryable`
    schema.ts       request validation from the generated JSON Schema
    loader.ts       auto-discovers *.service.ts (factory must be create*Service)
    config.ts, env.ts, logger.ts

  transport/
    bridge.ts       the formal transport↔service handoff. Nothing above it touches
                    req/res; nothing below it touches the service layer
    http.ts         Bun.serve — routing, body, auth resolution, static, gzip
    router.ts       two-tier route cache (fixed map → pattern)
    channels.ts     real-time channels; publish()
    middleware.ts, body.ts, health.ts, presence.ts, static.ts, types.ts

  client/index.ts   the browser client — WS first, HTTP fallback. `client.auth`
                    is the auth surface: the routes that establish a session and
                    the services for what the caller does to their own
                    credentials, both, because to the person signing in that is
                    one subject
  ../tools/surface.ts  `junction surface` — the committed surface.snapshot.md,
                    read off a BUILT app (describe() + buildRoutes()), --check in CI
  ../tools/errors-snapshot.ts  `junction errors` — the committed errors.snapshot.md,
                    every row a value actually thrown through toFrameworkError()
  auth/             IAuth types (implemented by @frontierjs/auth) + providers
  plugins/          manifest, openapi, webhooks, email, devtools, outbox, shims
  ../db/outbox.lite the OutboxMessage model, shipped for an app to import
  mail/  cache/  scheduler/  events/  storage/  workers/  ai/  testing/
```

---

## What bites here

- **There is no `ctx.params`, on either context.** Deleted rather than renamed
  (`FJS-D03`): in Feathers `params` is the whole context bag, and that idiom kept
  arriving here — `ctx.params.user`, `ctx.params.headers`,
  `app.service(x).get(id, ctx.params)` — where a field of that name holding
  something *else* is how a role check reads `undefined` and passes for everyone.
  Path captures are **`ctx.route`** on both contexts. Sierra says `page.params`;
  one word per realm, and the crossing is stated in both docs.

  See **§ The two contexts** below for which one you are holding and when.
- **Raw routes use `{id}`, not `:id`.** A `:id` registers as a literal segment
  and 404s silently forever.
- **`app.get`/`app.post`/… apply `apiPrefix`; `app.http.router.get` does not.**
  One owner, in `core/app.ts` — so a plugin registers `/webhooks` and an app
  under `/api` serves `/api/webhooks`, auth's `/auth/login` included. Never
  hand-resolve `app.config.apiPrefix` beside a registration: four plugins did,
  the one outside this package did not, and that asymmetry was `FJS-012`. The
  router is the escape for a path that must not move.
- **An `Idempotency-Key` on a mutating request means it runs once.** Claimed in
  `callService`, keyed by `(service, method, principal, key)`; a repeat replays
  the stored result and runs **no hooks**, so anything an app does in a hook does
  not happen on the replay. A failed call releases the key; an in-flight
  duplicate is a retryable 409. `config.idempotency.enabled: false` turns it off.
- **`transactional: true` wraps the WHOLE pipeline in one transaction** — before
  hooks, the method, and the after hooks — so a later `after` hook throwing rolls
  the write back instead of leaving a committed row behind a rejected response.
  `around` is the only phase that reaches the after hooks, which is what makes it
  a commit scope rather than a longer before hook. `true`, `false`, or a list of
  method names; `find`/`get` are never wrapped whatever is declared, the same way
  the announcement excludes them by name. Declaring it without a Litestone client
  on `ctx.locals.db` **throws naming the service** rather than quietly doing
  nothing. It reports through `describe()`.
  - **It does not make side effects atomic.** A transaction rolls back rows, not
    SMTP — an email an earlier `after` hook already sent stays sent. Queue the
    effect with `ctx.afterCommit(fn)` and it runs after the commit instead.
  - **It holds SQLite's single write lock for the whole pipeline**, `after` hooks
    included, so an `after` hook doing network I/O serialises every write in the
    app behind it. Off by default for that reason, and the same reason
    irreversible work belongs in Caravan.
  - Two orderings carry it and both already held: `withLitestoneDb` is an
    APP-level around hook so it runs OUTSIDE this one (the transaction opens on
    the caller-scoped client, so row policies and `auth()` survive), and the
    announcement happens after `runPipeline`, so the lock is released before
    anything fans out to a socket.
- **One rate limiter, and it takes one set of option names** —
  `max`/`window`/`key`/`message`/`skip`, `window` accepting a TTL string or ms.
  `core/rate-limit.ts` owns counting, the window, the sweep and the teardown; the
  transport middleware and the pipeline hook are adapters differing only in how
  they read a key and whether they can set `x-ratelimit-*` headers. The old
  transport names (`limit`/`keyFn`/`skipFn`) **throw**: silently ignoring `limit`
  would leave `max` undefined and `count > undefined` is never true, so the
  limiter would accept everything and say nothing.
- **`rateLimitHook` returns a `BridgeHook`, not a `Hook`** —
  `(ctx: ServiceContext | TransportContext) => void`. It runs in a pipeline and
  on a raw route, and the parameter is WIDER than `Hook`'s, which is what keeps
  it assignable into a `before:` map. It ran on both long before it said so; the
  signature claimed `ServiceContext` and auth's `any`-typed handlers were the
  only reason its routes compiled (`FJS-063`).
- **`clientIp(ctx)` reads either context shape.** A TransportContext carries `ip`
  at the top level; a ServiceContext splits client facts into `ctx.client`. That
  one-line gap is what grew a third limiter inside `@frontierjs/auth`, whose
  comment blamed `ctx.params.ip` — a field a ServiceContext does not have. The
  hook reaches `auth` optionally for the same reason: a sign-in route has no
  principal, because signing in is what produces one.
- **A route can be registered once. A second registration throws, naming it.**
  Keyed on the route's SHAPE, so `/a/{id}` and `/a/{name}` are the same route —
  the param name is read by the handler and by nothing that matches. It used to
  be silent, and which copy survived depended on the path: a FIXED path is
  overwritten in `build()` so the LAST won, a DYNAMIC one is scanned in order so
  the FIRST won and the later handler never ran. Doubled CORS is what surfaced it
  (`FJS-225`); the refusal covers any plugin claiming a path another owns.
- **A service broadcasts through `channel:` OR the `publish()` hook, never both.**
  `svc.pipelines()` refuses the pair, naming the method — it is the one place the
  full effective chain is known, so an app-level `after: { all: [publish(…)] }` is
  caught as well as a service-level hook. The check matches **marked** hooks, not
  names: an app may call its own hook `publish`, and suppressing a real one on a
  name collision would silently stop broadcasting (`FJS-045`).
- **The app-level catch-all is `app.channels.publishDefault(fn)`, and it is a
  DEFAULT rather than a second broadcaster.** Feathers' `app.publish(fn)` had no
  equal here, and the shape everyone reaches for —
  `after: { all: [publish(fn)] }` — is refused by the rule above for every
  service that also declares `channel:`, which is most of them (`FJS-334`). The
  default is consulted only where a service declares nothing, so it composes
  with `channel:` instead of racing it and cannot send one record twice;
  `channel: false` opts out of it too. **Function only, no string form** — one
  channel name for a whole app is exactly the shape that hands a subscriber rows
  no `@@allow` would have let them read. When one is registered, `boot()` names
  the services that fall through to it, and declaring `channel: false` on the
  ones you meant makes the report go quiet.
- **A filtered bulk PATCH/REMOVE writes one row at a time, and that is what
  enforces the schema.** Litestone skips `@@transitions` on `updateMany` by
  design (a power tool, caller takes responsibility) and bumps `@version`
  without requiring it — so calling `updateMany` from the bulk branch meant
  `PATCH /orders/1` was refused by the state machine and
  `PATCH /orders?status=draft` was not, for the identical move (`FJS-044`).
  Both are properties of `update()`. Selecting the targets and calling it per
  row brings them back and produces the `{ data, errors }` envelope bulk create
  already answered. Three things follow:
  - **`bulkMax`, default 1000** — one statement per row means an unbounded
    filter is unbounded work under SQLite's single write lock. Over it, refused
    naming the count, before any write.
  - **Only rows the caller can READ are touched** — the target select applies
    the read policy, the write applies the update/delete one.
  - **A caller-supplied `@version` is refused by name.** One value cannot be
    right for N rows; each row is written against the version selected with it,
    so a row that moved is a `VersionConflictError` in `errors`.
  Gate and row policy always applied on the bulk path, and `removeMany`
  cascaded correctly — neither changed. **`restore` is not looped**: nothing
  per-row to enforce, and `restore({ where })` already answers the rows. It
  called a `restoreMany` a Litestone table does not have, so every filtered
  restore was a 500 (`FJS-245`) — declared on `LitestoneTable`, which is why
  nothing typed it.
- **The API surface is committed, and nothing in a source file can answer it.**
  `junction surface --app <module> [--services <dir>]` writes `surface.snapshot.md`
  off a built app — methods after the policy, custom methods as
  `collectCustomMethods` resolved them, the hook chain in RUN order with the
  derived hooks leading it, every mounted path with `apiPrefix` applied, plugins
  in configure order. `--check` is
  the CI half (`snapshots` phase). Two constraints on the app it is pointed at:
  it must expose the app **without listening** (a built `App` or a factory — the
  same contract `@frontierjs/testing` takes as `api:`; guard an entry's
  `app.start()` with `import.meta.main`), and autoloaded services need
  `--services`, because that phase is `needsHost` and resolves against `Bun.main`.
  The snapshot lives at the APP ROOT: an app is built with the cwd its own scripts
  use, and CI reruns the command from the snapshot's directory.
- **`hasRoute()` is a matching question, not an existence one** — every app
  registers `GET /{service}`, which matches almost anything. Use
  `hasExactRoute(method, path)` / `routePaths(method)`. For the whole surface at
  once, `buildRoutes(app)` (plugins/manifest) — it rides `/manifest`, and
  `fli api:routes` is the CLI caller.
- **An auth provider is what Junction CALLS, and that is `verifySession`.**
  `createApp({ auth })` and `setAuth()` take `SessionVerifier`, not `IAuth` —
  the full interface declares six required methods and this package invokes two
  (`verifySession` on both inbound paths, `sessionFor` behind `runAs`, whose
  absence throws by name). The other four are `/auth/*`'s. The type is DERIVED
  (`Pick<IAuth,'verifySession'> & Partial<IAuth>`) so it cannot drift from
  `IAuth`, and the `Partial` half is load-bearing: without it TypeScript's
  excess-property check refuses an object literal carrying `login`, which is the
  provider it exists to accept. `FJS-D10`.
- **`register` is sync** — `configure()` never awaits it. Async setup goes in
  `boot()`. `requires: ['mailer']` is checked at startup against presence *and*
  configure order.
- **One owner per translation** (Invariant 4): errors → `toFrameworkError`,
  envelope → `envelope.ts`, `$`-params → the bridge, announcement → `callService`,
  custom methods → `_customMethods` (built by `collectCustomMethods`),
  pipelines → `svc.pipelines()`, "what is this service" → `svc.describe()`. Add to the owner, never beside it.
- **`methods:` DECLARES the custom methods; the scan is the fallback.** With a
  list, every non-CRUD name in it is a custom method resolved off the definition
  — which is the only way to name one after an option key (`cache`, `schema`,
  `channel` are otherwise eaten by the deny-list with no error). Without one,
  function keys are scanned for, exactly as before. A name in the list with no
  function throws at construction, naming what IS available.
- **`svc.pipelines(appHooks)` is memoised on BOTH inputs** — the app map by
  identity, the service's own by a version `hooks()` bumps. That is what makes
  staleness unreachable. `app.hooks()` reassigns `app._appHooks` rather than
  mutating it, and anything that starts mutating it in place defeats the memo
  silently.
- **A built service is marked** with `Symbol.for('junction.service')`,
  non-enumerable. `createService` on a marked object returns it unchanged, and
  the autoloader tests the marker rather than sniffing one field's type. A spread
  copy is correctly NOT built.
- **`client.auth` is the browser half of `@frontierjs/auth`, and it lives here
  because the token does.** This client holds the token, opens the socket and
  knows both prefixes; an app writing its own sign-in had to reproduce all three,
  and both dogfood apps did, differently (`FJS-D20`). Two properties to keep:
  **signing out tells the server** (dropping the token locally leaves the session
  row valid until it expires — nothing in this repo called `POST /auth/logout`
  before this), and **`tokenStorage` is the token's one owner**, so `setToken`
  persists, clears and emits `token` for anything cached per identity.
- **A worker's SETUP arrives by `workerData`, its WORK by `postMessage`, and the
  first one is invisible to three of the four places you would look for it.** On
  Bun 1.3.11 `new Worker(path, { workerData })` delivers — but only to
  `node:worker_threads`; inside the worker `globalThis.workerData`,
  `self.workerData` and `Bun.workerData` are all `undefined`, which is what made
  a delivered value read as a dropped parameter (`FJS-271`). `workerData()` is
  the read half and lives beside `spawn()`, the one place a `Worker` is
  constructed — a pool RESPAWNS after an error, and a respawned worker built
  without the setup data serves a different configuration than its siblings.
- **`ServiceTypes` is how the schema's types cross the wire, and it is an
  interface an app AUGMENTS** (`client/index.ts`). `litestone types --augment
  junction` emits the augmentation beside the rows, and `service('posts')` /
  `resource('posts')` infer from it; empty, `keyof ServiceTypes` is `never`, so
  the inferring overload matches nothing and every call falls to the open one.
  Two things to keep: the overload order (inferring first — an explicit
  `service<Foo>('x')` fails its constraint and falls THROUGH rather than
  erroring), and `ServiceRow`'s member mapping. An interface has no implicit
  index signature, so handing one straight to a proxy generic over
  `Record<string, unknown>` fails the constraint and silently widens back — the
  whole feature compiles and types nothing. `tests/client-types.test.ts`
  compiles a fixture with `tsc` because no runtime assertion can see any of this.
- **A 401 keeps the server's own sentence.** `_request` used to throw
  `Unauthorized` before reading the body, so `Invalid credentials` never reached
  a caller — which is most of what a hand-written sign-in page was doing when it
  re-mapped the status itself.
- **`createApp({ tenants })` replaces `createApp({ db })`, it does not join it.**
  A schema declaring `tenancy { strategy database }` has one SQLite file per
  tenant, so the CLIENT is per request: `withTenantDb` resolves the tenant and
  assigns `ctx.locals.db`. That is the same slot `withLitestoneDb` assigns, and
  installing both would leave which one wins to hook order. **Which tenant a
  request is for is asked, never re-derived** — `registry.tenantFor({ host,
  headers, principal })` applies the `resolve` the schema declares, and this
  side contributes only what a transport has and what the refusal's status code
  is. Work with no request behind it (a job, a sweep) carries
  `{ locals: { tenantId } }`, which is the one thing `locals` being
  hand-down-able is for.
- **Row tenancy needs no hook and fails the other way round.** One database, a
  tenant column, and the schema's own policies scope every query — so a
  **signed-in** principal carrying no claim matches no row and every screen is
  an empty list with a 200, which is indistinguishable from a tenant with no
  data. `tenantClaimGuard` refuses that by name on a scoped service. Anonymous
  is deliberately not its business: nobody is not a caller missing a claim, and
  refusing there breaks every public read the app's `@@gate` exists to grade.
- **`sessionGateLevel()` is a hand copy** of the same function in Litestone
  (which cannot import Junction). Change one, change both. `toDataPrincipal()` is
  the other half of that boundary — `userId` → `id`, without which every
  `@@allow(... auth().id)` matches nothing, silently.
- **`before: { all: [...] }` applies to every method**, machine-facing endpoints included.
  A comment claiming exemption is not one.
- **`after` means after the METHOD, not after the call succeeded — and
  `ctx.afterCommit(fn)` is the phase that does.** Queued from any phase, drained
  once in `callService` on `!ctx.error && !pipelineError`, after the
  announcement and before `idem.settle`. Under `transactional:` that is after
  the commit for free: the transaction is an `around` hook, so `runPipeline` has
  already returned by the time the drain runs — there is no transaction state to
  read and nothing to keep in step. **Observer tier**: a throw is logged and
  emitted as `junction.aftercommit.error`, never reported as the call failing,
  because the write is committed and the broadcast is out. **It is not
  durability** — a crash between commit and callback loses the effect and
  nothing is recorded. `ctx.enqueue` is the verb that survives that; see below.
  The queue lives on the CONTEXT, not on `locals.db`, which the transaction hook
  reassigns mid-pipeline.
- **`ctx.enqueue(job, payload)` is durability, and it is a second VERB rather
  than a flag on `afterCommit` because a closure cannot be written to a table.**
  It writes a row into the app's own database inside the call's own transaction,
  so the intent commits with the write or rolls back with it; the relay
  (`app.configure(outbox())`) hands it to `app.jobs` and marks it delivered
  (`FJS-D35`). **The row can be in no other database**: litestone opens one
  connection per declared `database` block and holds one transaction manager,
  over main's — measured, a row in a second block survives the rollback that was
  supposed to take it. It **refuses by name** outside a transaction, on a schema
  with no `OutboxMessage`, and with no relay installed, because a row nothing
  delivers is worse than a refusal; the transaction test asks
  `db.$inTransaction` and not the `transactional:` declaration, since a hook can
  run against a method the declaration does not name. **Delivery is
  at-least-once** — the queue is a different file, so the insert there and the
  mark here cannot be one transaction — and the relay dispatches under the
  OUTBOX ROW's id so a replay is a no-op rather than a second email.
- **Never call `ws.send()` directly — `wsSend()` in `transport/send-queue.ts` is the
  one owner.** Bun's return value is load-bearing: `-1` means buffered, **`0`
  means the frame was DROPPED**, and ignoring it left callers waiting on replies
  that were never coming (`FJS-145`). The outbox holds a dropped frame, flushes
  it on `drain`, and closes the socket with 1013 past `http.wsMaxQueued`.
- **The METHOD decides list vs single** — `wrapResult(raw, service, method)`.
  `find` must answer a list or it throws `ResultShapeError`; an array is a list;
  `{ data, errors }` is a list on any method (the bulk protocol); everything else
  is a single and travels whole. It used to guess from shape alone, which dropped
  an action's extra keys (`FJS-140`) and turned a non-list `find` into an empty
  list in the browser (`FJS-144`). The browser client calls this same function
  rather than copying the rule — that copy is how the two ends drifted.
- **A stream is not a result and `wrapResult` refuses one by name** (`FJS-D13`).
  `Response`, `ReadableStream`, anything with `getReader`, an async iterable. It
  used to wrap them, and both a Response and a ReadableStream have no enumerable
  own properties — so a method returning one answered `{"kind":"single","data":
  {}}`, an empty object with a 200 and the stream destroyed. **`kind` stays
  two-valued**: a third value is branched on at ten sites and lands in every one
  as *not a list*. Each FRAME is a result and the stream is not — which is why
  `publish()` is an after-hook (a pushed frame IS `ctx.result`, already through
  `protect()`) and why `ctx.sse()` on a raw route has no hooks, no `gateAuth` and
  no field protection: right for a heartbeat, wrong for records.
- **A `resource()` store is scoped to the query its last `load()` ran with**, and
  only if the caller passed a `match` — this package holds no schema, so it
  cannot decide; Sierra's `matchesQuery` is what it is given. `true` upserts,
  `false` REMOVES (a patch is how a row leaves a list, and nothing else announces
  that), `null` means *undecidable from this record* and reloads instead of
  guessing, once per burst. With no `match` every event applies, which is the old
  behaviour and the one every non-Sierra caller still gets.
- **A push is also PLACED, and a page past the first refuses one.** `orderBy`
  decides where the row goes (`core/sort.ts`, which is `parseSort` — one reading
  of `-createdAt`), and on the first page the row pushed past `limit` belongs to
  page 2. Past page 1 nothing here can know whether a new row belongs on an
  earlier one, so it is refused and counted on `stale`, which a view renders as
  *3 new — refresh* and `load()` clears. The limit and offset come off the
  ENVELOPE, not the params — the effective limit is the server's.
- **`resource().load()` writes the store only if it is still the newest load.**
  Stamped when issued (`FJS-082`); an overtaken load still RETURNS its rows to
  the caller that awaited them, and its request is not cancelled. Code reading
  the return value of a load it may have superseded is reading stale rows on
  purpose — the store is what is current.
- **A custom method announces under its own name** (`orders pay`) since
  2026-08-06. Only `find`/`get` are excluded; a read-shaped one opts out with
  `ctx.dispatch = false`.
- **`changed` is the announcement for a write that cannot name its row.**
  `announceDataWrites` used to drop every event whose `result` was null, which is
  a bulk statement answering `{count}` and a `select: false` write, both — so a
  job doing `createMany` left every tab stale (`FJS-307`). One event name for all
  three operations, since the receiving store's only honest answer is the same
  for each; the operation is in the payload. **The caller's `where` goes on the
  bus and never on a channel** — the bus is in-process, a channel is every
  subscribed browser, and a filter is made of the caller's own values. The
  browser store reloads on it and the `*` catch-all skips the name, or the count
  object lands in the store as a row.
- **Boot-time console output splits into two kinds and only one is loud.**
  `core/diagnostics.ts` owns the question, reading `DEBUG=1`. A DIAGNOSTIC
  describes what happened — the loader's per-service registration line, the
  anonymous-hook style note — and is silent unless asked for; `/manifest`
  answers the first on demand and the second is one line per SERVICE naming
  every position, not one per phase per method. A WARNING describes a probable
  defect — a duplicate service, a file with no factory, a hook map on a method
  the service does not have — and is unchanged. The old gate was
  `NODE_ENV !== 'production'`, which is every developer all of the time.
- **`ctx.data` is a row OR an array of rows, and a hook that forgets the second
  is silent.** Bulk create sends the array. `timestamps()` set `created_at` and
  `updated_at` as properties OF THE ARRAY — so every row of every bulk create
  went in with no timestamps — and `allow()` filtered nothing on the same shape.
  Narrow with `Array.isArray` and map; both now do.
- **A `__`-prefixed field on a context is a CONTRACT, so declare it.** A
  middleware runs before the response exists, so it leaves headers on
  `TransportContext` and `_finalizeWithHeaders` applies every bucket at the end:
  `__cors`, `__securityHeaders`, `__rateLimit`, `__correlationHeaders`,
  `__pendingCookies`, `__status`. All six were reached through
  `(ctx as Record<string, unknown>)` on both sides, which means a middleware
  writing a misspelled bucket compiled, ran, and dropped its headers with nothing
  said. Same for `Connection.__joinMeta` and `Channel.__presenceWrapped`.
  **An assertion to `Record<string, unknown>` is the smell**: nine of the
  twenty-five here were reaching a field the type already had.
- **The whole package must stay at zero, `tests/` and `example/` included.**
  `index.ts` + `src/**` is what an app compiles (the `exports` map points at
  `.ts` and nothing emits `.d.ts`, so junction's own errors land in every app's
  `tsc` and editor — `FJS-268`), and there is no baseline left to hide behind:
  junction is absent from `scripts/typecheck-baselines.json`, which means 0.
  **The reason `tests/` counts is not tidiness.** They are the only code here
  that uses junction the way an app does, so an error in one is an error a user
  gets — driving the last 138 to zero found eleven defects in the shipped types,
  including a custom method's `ctx` being an implicit `any` and
  `app.events.on('x', () => arr.push(n))` refusing to compile (`FJS-034`).
- **A cast in a test is a claim about the shipped type; read it before adding
  one.** The two that are legitimate here have one owner each in
  `tests/helpers.ts` — `stubbable` (Bun's `typeof fetch` carries `preconnect`,
  so no plain stub is assignable) and `asRecord` (a key the type does not
  declare, which is Invariant 5 working). Anything else is usually the type
  being wrong.
- **Fake clients hide real bugs.** Cross-package behaviour goes in
  `tests/real-litestone-client.test.ts`, against a real client.
- **`tests/email.test.ts` calls `mock.module()` on the smtp shim, and bun does
  not undo that.** The replacement is process-wide for the rest of the run, so
  any later test importing `src/mail/smtp.ts` grades the mock — one passed alone
  and failed inside the suite, which is the good outcome; the bad one is passing
  in both. `tests/smtp-starttls.test.ts` drives a subprocess for that reason.
- **`ctx.result` must be `null`, not absent**, when hand-building a context in a
  test — `runPipeline` reads non-null as "a before hook already answered".
- **The HTTP and WS paths build their context separately** — `bridge.toContext()`
  vs `bridge.internal()` — so anything one derives from a request the other must
  lift out of the frame by hand, and a difference is silent because the browser
  client falls back to HTTP whenever no socket is up. `ctx.id` is normalised to a
  string on both (FJS-197) because a path segment cannot be anything else, and
  request metadata (`requestMeta()` — correlation id, idempotency key) is
  established on both, which it was not: the WS path wrapped nothing in
  `runWithMeta`, so anything reading it applied to half the transports.
- **`fromStatusCode` maps fourteen codes to classes; the rest keep the status and
  lose the class.** Give an error you own a `status` and it arrives intact.
- **What a thrown value becomes is committed, and it is EXECUTED.**
  `junction errors` writes `errors.snapshot.md` at this package root: every class
  with its status, one row per branch `toFrameworkError` can take, the status →
  class table, and **Litestone's real error classes constructed and run through
  the boundary**. Nothing above `toFrameworkError` reads anything but the result,
  so a class that gains a `status` silently stops being a 500 and one that never
  had one silently is a 500 — neither breaks a test, because nothing asserts on a
  category nobody named. The cross-package rows are the ones that drift, and they
  are where `FJS-255` was found: the three lock errors declare `retryable` and no
  `status`, so each reaches a caller as a 500. `--check` in CI (`snapshots`).

## The two contexts

Junction hands out two, and which one you have is decided by **where your code is
mounted**, not by what you asked for.

| | `TransportContext` | `ServiceContext` |
| --- | --- | --- |
| You get one by | `app.get` / `app.post` / a middleware / a WS handler | a service method, any hook, `app.service(x).method()` |
| Created per | **request** | **call** — one request may make several |
| Ends when | the response is returned | the pipeline finishes |
| The principal | `ctx.user` — flat, may be `null` | `ctx.auth.user` — frozen, propagates |
| Caller environment | `ctx.ip`, `ctx.headers` — flat | `ctx.client.{ip,userAgent,headers}` |
| Path captures | `ctx.route` | `ctx.route` — `{}` on an internal call |
| The URL's search | `ctx.query` — **raw, `$` keys present** | `ctx.query` (filters) + `ctx.directives` (shape) |
| Scratch | — | `ctx.locals`, fresh every call |
| Wire-only payload keys | — | `ctx.transients` — what `@transient` declared, lifted off `ctx.data` |
| Wire-only query keys | — | `ctx.reserved` — what `reservedQuery` declared, lifted off `ctx.query` |
| Responding | `ctx.json` / `text` / `html` / `file` / `sse` / `paginate` | return a value; the envelope is built for you |
| Reaching the other | — | `ctx.$raw` — the transport ctx, or `null` |

**Where they must agree.** `route` is the same word for the same thing and the
bridge copies it across; `client.headers` is the transport's `headers`, same
bytes; the principal is the same object, resolved once by the transport, frozen,
and handed on.

**Where they deliberately differ, and why.**

- **`query`.** On the transport it is the search string as it arrived, `$limit`
  and all. On a service the bridge has split it into `query` (filters — becomes
  the WHERE) and `directives` (`{limit, offset, orderBy, select}` — shape).
  Nothing past the bridge reads a `$` (Invariant 10). Conflating the two is what
  once made `?limit=1` a filter on a column named `limit` — zero rows, no error.
- **The principal's spelling.** `ctx.user` is flat because a raw route has no
  pipeline and nothing to propagate. `ctx.auth.user` is nested because `auth` is
  one of four fields with four different lifetimes, and grouping them is what
  makes the contract statable at all.
- **`locals` exists on one side only.** A raw route has no phases, so there is
  nothing for scratch to live *between*.
- **`transients` exists on one side only, for the opposite reason.** It is filled
  by a derived hook off the model's schema, and a raw route has no model and no
  hooks. A raw route's body is whatever arrived.
- **`reserved` is the query-side mirror of it**, and it exists because there were
  only two readings of a search key and a service needed a third: `$`-names are
  directives and everything else is graded against the model's columns, so a
  documented `?workspace_id=` fallback was refused with a 400 naming it, before
  the hook that reads it could run — and the app could not fix it from its own
  side either (`FJS-337`). A raw route has no service and therefore no
  declaration to read.

### The six fields, and their rules

The substance of a `ServiceContext` is not its field list, it is that each of
these behaves differently. `tests/context-contract.test.ts` asserts all six by
running them, because none of it is expressible as a type — and one of them was
documented here for months while being false.

| Field | Rule |
| --- | --- |
| `auth` | WHO. **Frozen** — a hook mutating it throws rather than leaking into a sibling call. **Propagates**: a call naming no principal inherits the one in scope, at any depth. An explicit `{ user: null }` means *as nobody* and is kept — **absent is not null** |
| `client` | WHERE FROM. Read-only, propagates. `{ headers: {} }` when there is no request. **Information, never authority** — nothing here grades a caller by it |
| `route` | Path captures. Router-only, `{}` on an internal call |
| `locals` | Per-call scratch. **Fresh `{}` every call, and it does NOT propagate** — a sub-service physically cannot reach its caller by writing to it. It CAN be handed down deliberately (`{ locals: … }`), which is the whole difference between passing and inheriting |
| `transients` | The `@transient` keys of this call's payload — accepted on the wire, stored nowhere. `autoValidate` validates them with the model's own rules and then MOVES them here, so the write never carries one. Fresh `{}` every call, does not propagate, and there is no seed option: this is input the caller sent, not scratch a hook keeps. A model declaring none leaves it `{}` |
| `reserved` | The query keys the SERVICE declared as its own — `reservedQuery: ['workspace_id']`. Same freshness, same non-propagation, same reason as `transients`. Lifted in **`callService`, before the pipeline** rather than in a hook, so `ctx.query` is columns alone for the app's own leading hook as much as for the derived `autoFilter` behind it, and a custom method — which runs neither — is covered on the same terms as `find`. A `$`-name is refused at construction (the directive table owns those); a name that is also a column is refused on first use, because the client is not known when a service module is imported |

Propagation rides the `AsyncLocalStorage` store the transport already wraps a
request in, so nothing is threaded and no caller is rebuilt. A call whose
principal *differs* re-scopes — which is what makes a sub-call issued as somebody
else pass **that** principal to its own children rather than the request's.

### One object, three boundaries

`QueryDirectives` is declared in `core/directives.ts` and read by the bridge
(off a request), the browser client (writing `$` names out) and — through
`page.directives` — Sierra's router and resource. So `resource.load(page.query,
page.directives)` is the same object all the way down with nothing to translate,
which is Invariant 10's point.

**Filters are always the first argument.** The client's second argument used to
be a `FindParams` that also held `query`, which made the container both halves
of the split; and it named five of them, so `$search`, `$withDeleted` and
`$onlyDeleted` could not be asked for at all (`FJS-290`). `$first` and `$wrap`
stay out of the type — transport-only, no structured form on the other side,
which is the same line `DIRECTIVE_PARAMS` / `TRANSPORT_PARAMS` already draws.

### Work that outlives the request

A job, a retry, a scheduled sweep runs after the store is gone, so it has no
principal at all — and no principal is STRANGER(0), refused by the model's own
`@@gate`. Two members answer it, and neither is Caravan-specific:

- **`app.principal()`** — who is in scope, asked from somewhere holding no `ctx`.
  Read when work is *enqueued*, to record who asked.
- **`app.runAs(userId, fn)`** — opens a scope for a principal **re-resolved now**,
  through `IAuth.sessionFor(userId)`. Inside it, `auth` propagates as it does
  anywhere else, so `fn` makes ordinary service calls that name no principal.
  `null` means the app's own `createApp({ system })`; an app declaring none gets
  `null` rather than an invented identity.

**Re-resolved, never replayed.** Storing the session would be shorter and would
let a caller demoted between asking and running keep the authority they had when
they asked — a captured privilege that outlives its own revocation, for as long
as the retry schedule runs. So an id is what travels. A provider with no
`sessionFor`, or a user who no longer exists, **throws by name**: downgrading to
STRANGER(0) is the bug being removed and upgrading to the system principal would
be worse.

---

## Proving a change

`bun run test`, then `example`: `verify` + `verify:jobs`, and `basecamp`:
`verify`. Anything touching channels or publish needs `example`: `verify:live` —
it is the only drive that watches a SECOND tab, and nothing else can tell a real
broadcast from a tab seeing its own echo. Anything touching either transport's
context also wants `@frontierjs/testing`'s `bun run test`, whose parity runner
puts one call down both and compares.

`docs/ARCHITECTURE.md` is the depth doc.
