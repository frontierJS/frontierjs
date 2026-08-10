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
- **`hasRoute()` is a matching question, not an existence one** — every app
  registers `GET /{service}`, which matches almost anything. Use
  `hasExactRoute(method, path)` / `routePaths(method)`.
- **`register` is sync** — `configure()` never awaits it. Async setup goes in
  `boot()`. `requires: ['mailer']` is checked at startup against presence *and*
  configure order.
- **One owner per translation** (Invariant 4): errors → `toFrameworkError`,
  envelope → `envelope.ts`, `$`-params → the bridge, announcement → `callService`.
  Add to the owner, never beside it.
- **`sessionGateLevel()` is a hand copy** of the same function in Litestone
  (which cannot import Junction). Change one, change both. `toDataPrincipal()` is
  the other half of that boundary — `userId` → `id`, without which every
  `@@allow(... auth().id)` matches nothing, silently.
- **`before: { all: [...] }` applies to every method**, including agent endpoints.
  A comment claiming exemption is not one.
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

## Proving a change

`bun run test`, then `example`: `verify` + `verify:jobs`, and `basecamp`:
`verify`. Anything touching channels or publish needs `example`: `verify:live` —
it is the only drive that watches a SECOND tab, and nothing else can tell a real
broadcast from a tab seeing its own echo.

`docs/ARCHITECTURE.md` is the depth doc.
