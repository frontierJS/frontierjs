# Junction — package map

**The API realm.** Services, the hook pipeline, HTTP + WebSocket transport,
channels, the browser client, and the batteries (mail, cache, scheduler,
webhooks, AI, OpenAPI, manifest). Sits **above** Litestone and **below** Sierra;
never import Sierra from here (Invariant 1).

`bun run test` (bun). `bun run test:all` adds the example. `bun run typecheck`
runs against the repo's only non-zero baseline — see `scripts/typecheck-baselines.json`.

---

## Layout

```
src/
  core/
    app.ts          createApp() — wires every subsystem. Plugin protocol lives here.
                    Lifecycle: configure → start → ready → running → shutdown
    service.ts      the heart — createBaseService (5 CRUD) + createService (compose)
    context.ts      ServiceContext, OWNED BY CORE. auth / client / route / locals
    hooks.ts        Feathers-style pipeline + `around`
    hooks-builtin.ts, hooks-resilience.ts
    litestone.ts    the Data adapter — withLitestoneDb, gateAuth, sessionGateLevel,
                    toDataPrincipal, accessorCandidates
    envelope.ts     the result envelope — one module, one owner
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

  client/index.ts   the browser client — WS first, HTTP fallback
  ../tools/surface.ts  `junction surface` — the committed surface.snapshot.md,
                    read off a BUILT app (describe() + buildRoutes()), --check in CI
  ../tools/errors-snapshot.ts  `junction errors` — the committed errors.snapshot.md,
                    every row a value actually thrown through toFrameworkError()
  auth/             IAuth types (implemented by @frontierjs/auth) + providers
  plugins/          manifest, openapi, webhooks, email, devtools, shims
  mail/  cache/  scheduler/  events/  storage/  workers/  ai/  testing/
```

---

## What bites here

- **A SERVICE context has no `ctx.params`.** It splits into `auth` (the
  principal) / `client` (`ip`, `userAgent`, `headers`) / `route` (path captures) /
  `locals` (per-call scratch — `withLitestoneDb` puts `db` there). A **raw-route**
  `TransportContext` *does* have `params`, and that asymmetry is the trap. This
  package's own docs get it wrong in places (`core/app.ts` around the
  `app.service('users').get(id, ctx.params)` examples, `core/litestone.ts`'s
  "cached on `ctx.params`" comment) — fix them when you pass, they cost real time.
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
    SMTP — an email an earlier `after` hook already sent stays sent (`FJS-089`).
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
  off a built app — methods after the policy, actions as `collectActions` resolved
  them, the hook chain in RUN order with the derived hooks leading it, every
  mounted path with `apiPrefix` applied, plugins in configure order. `--check` is
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
- **`register` is sync** — `configure()` never awaits it. Async setup goes in
  `boot()`. `requires: ['mailer']` is checked at startup against presence *and*
  configure order.
- **One owner per translation** (Invariant 4): errors → `toFrameworkError`,
  envelope → `envelope.ts`, `$`-params → the bridge, announcement → `callService`,
  actions → `_actions` (built by `collectActions`), pipelines → `svc.pipelines()`,
  "what is this service" → `svc.describe()`. Add to the owner, never beside it.
- **`methods:` DECLARES the actions; the scan is the fallback.** With a list,
  every non-CRUD name in it is an action resolved off the definition — which is
  the only way to name an action after an option key (`cache`, `schema`,
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
- **`sessionGateLevel()` is a hand copy** of the same function in Litestone
  (which cannot import Junction). Change one, change both. `toDataPrincipal()` is
  the other half of that boundary — `userId` → `id`, without which every
  `@@allow(... auth().id)` matches nothing, silently.
- **`before: { all: [...] }` applies to every method**, machine-facing endpoints included.
  A comment claiming exemption is not one.
- **`after` means after the METHOD, not after the call succeeded.** A later
  `after` hook throwing makes the call report failure with the earlier hook's
  email already sent. There is no commit-scoped phase — the announcement point
  is the only thing that waits for `!ctx.error && !pipelineError`. Put an
  irreversible effect last in the chain, or hand it to Caravan. `FJS-089`
  (deferred 2026-08-13 — documented rather than fixed).
- **Never call `ws.send()` directly — `wsSend()` in `transport/outbox.ts` is the
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
- **`resource().load()` writes the store only if it is still the newest load.**
  Stamped when issued (`FJS-082`); an overtaken load still RETURNS its rows to
  the caller that awaited them, and its request is not cancelled. Code reading
  the return value of a load it may have superseded is reading stale rows on
  purpose — the store is what is current.
- **A custom action announces under its own name** (`orders pay`) since
  2026-08-06. Only `find`/`get` are excluded; a read-shaped action opts out with
  `ctx.dispatch = false`.
- **Fake clients hide real bugs.** Cross-package behaviour goes in
  `tests/real-litestone-client.test.ts`, against a real client.
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

## Proving a change

`bun run test`, then `example`: `verify` + `verify:jobs`, and `basecamp`:
`verify`. Anything touching channels or publish needs `example`: `verify:live` —
it is the only drive that watches a SECOND tab, and nothing else can tell a real
broadcast from a tab seeing its own echo. Anything touching either transport's
context also wants `@frontierjs/testing`'s `bun run test`, whose parity runner
puts one call down both and compares.

`docs/ARCHITECTURE.md` is the depth doc.
