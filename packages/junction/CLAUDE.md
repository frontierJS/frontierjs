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

## Proving a change

`bun run test`, then `example`: `verify` + `verify:jobs`, and `basecamp`:
`verify`. Anything touching channels or publish needs `example`: `verify:live` —
it is the only drive that watches a SECOND tab, and nothing else can tell a real
broadcast from a tab seeing its own echo. Anything touching either transport's
context also wants `@frontierjs/testing`'s `bun run test`, whose parity runner
puts one call down both and compares.

`docs/ARCHITECTURE.md` is the depth doc.
