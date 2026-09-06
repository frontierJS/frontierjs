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
    context.ts      ServiceContext, OWNED BY CORE. auth / client / route / locals.
                    Also the two ALS stores and their one owner each —
                    enterRequest/reenterAs (the request) and enterCall + `$`
                    (the call in progress)
    directives.ts   QueryDirectives — the `$`-PREFIXED KEY fields, and nothing
                    else. Unrelated to `$` above.
                    Imports NOTHING, so the browser client can name them without
                    dragging node:async_hooks into a bundle. context.ts re-exports
    hooks.ts        Feathers-style pipeline + `around`
    hooks-builtin.ts, hooks-resilience.ts
    litestone.ts    the Data adapter — withLitestoneDb, withTenantDb, gateAuth,
                    sessionGateLevel, toDataPrincipal, accessorCandidates.
                    autoValidate (a MODEL, create/patch) and validateInput (a
                    `type` in the seed, any method) both compile through
                    jsonSchemaToJunctionSchema → createSchema
    envelope.ts     the result envelope — one module, one owner
    outbox.ts       the transactional outbox — ctx.enqueue + the relay pass
    build-id.ts     which build this is, and which one the browser is on
                    (`FJS-D160`). The server STATES (`x-fjs-build` on a response,
                    a field on the socket's `connected` frame) and the CLIENT
                    compares — nothing here reads a build off a request. It is
                    the BUILD and not the Release: a browser holds the web
                    bundle, and two Releases share one on every API-only deploy.
                    Reaches `process` through `globalThis`, because the browser
                    client imports the wire names and compiles under the app's
                    own tsconfig
    attachments.ts  the attached service — a third-party dependency this app
                    needs and does not own, DECLARED here and BOUND per
                    environment (`FJS-D158`). Not a second `defineEnv`:
                    `checkEnvField` is extracted from it and called by both. What
                    it adds is that these keys are ONE SERVICE, that half-bound
                    always refuses (`optional` forgives a service nobody bound,
                    never one bound halfway), and that a DEFAULTED key is not
                    evidence anybody bound anything
    backfill.ts     the middle step of expand → backfill → contract. A CURSOR
                    OVER ONE TABLE and not a durable workflow (`FJS-D157`).
                    Idempotence is the PREDICATE, not the cursor — a chunk
                    re-reads `field IS NULL`, so an interrupted one skips what
                    it already wrote. Every write is silent, including the run
                    row's own: `announce` is a bulk option and `asSystem()` does
                    NOT suppress a tap, so a per-row update would broadcast
                    every row
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
  ../tools/principal-snapshot.ts  `junction principal` — the committed principal.snapshot.md:
                       who a caller ARRIVES as and who they BECOME. The access snapshot's
                       input, which nothing else commits (`FJS-514`).
  ../tools/surface.ts  `junction surface` — the committed surface.snapshot.md,
                    read off a BUILT app (describe() + buildRoutes()), --check in CI
  ../tools/errors-snapshot.ts  `junction errors` — the committed errors.snapshot.md,
                    every row a value actually thrown through toFrameworkError()
  ../tools/notifications-snapshot.ts  `junction notifications` — the committed
                    notifications.snapshot.md: what this app can TELL somebody.
                    `app.notifications` is duck-typed exactly as `app.jobs` is —
                    @frontierjs/notifications is not a dependency here and must
                    not become one. A notification that stops being registered
                    THROWS when somebody was owed a message, where a schedule
                    that stops being registered is silence
  auth/             IAuth types (implemented by @frontierjs/auth) + providers
  plugins/          manifest, openapi, webhooks, email, devtools, outbox, backfill, shims
                    webhooks is OUTBOUND ONLY — register(url, events) registers a
                    SUBSCRIBER and the engine delivers to them. Nothing here receives;
                    the mirror half is IDEAS/inbound-integrations.md § A.
  ../db/outbox.lite the OutboxMessage model, shipped for an app to import
  ../db/backfill.lite the BackfillRun row — how far a backfill got. No @@tenant:
                    `@@tenant(none)` is a PARSE ERROR with no `tenancy` block, so
                    a shipped fragment cannot carry one. `extend model` is the
                    way in for a tenanted app
  mail/  cache/  scheduler/  events/  storage/  workers/  ai/  testing/
```

---

## What bites here

- **A reconnect is a GAP, by construction, and it was a silent one.** The server
  queues nothing for an absent socket, so every write between a drop and the
  next `connected` frame reached this client and nobody else's copy of it — and
  `resource.stale`, which exists to count exactly this, read 0 with nothing on
  screen saying anything was missing (`FJS-701`). The client emits `resync` on
  a `connected` frame that is not the FIRST one, and a live list answers it with
  the `refetch` it already gives `changed`: *some unknown rows moved*, which is
  the only sound answer, since nothing in a browser knows what it did not
  receive. **The reload is jittered up to 2s and that is not politeness** — a
  deploy drops every socket at once, so this fires fleet-wide together and an
  unjittered reload is `FJS-703`'s shape one layer up.
  **There is deliberately NO sequence number.** A seq would let a client that
  missed nothing skip the reload, and the case where that matters most is a
  deploy — where the server restarted and every counter reset, so everybody
  reloads anyway. What it costs is a stamp on six encode paths including the
  per-cohort graded one, where getting it wrong is a gap reported as no gap.
  `_noteConnected`/`_noteDisconnected` are extracted from the socket's own
  closures so the logic can be driven without a server; the branch they came
  from is unreachable in a test, which is why the silent half went unnoticed.

- **Presence is OPT-IN now, and it was the default for a feature most apps do
  not use.** Every channel was wrapped unconditionally with no way off, and a
  join sends the roster to the joiner AND a frame to every existing member — so
  N connections cost N x (N-1) frames: 500 signed-in connections over two
  channels produced 251 500 frames, 89.5MB out and 172MB of heap, which makes an
  ordinary post-deploy reconnect fatal (`FJS-703`). `channels(setup, {
  presence })` takes `false` (default), `true`, or a list of names and `pre:*`
  patterns — a list is the shape to reach for, since presence belongs on the one
  channel a room is and never on the ten a data-sync app announces model writes
  over. **The two fixes answer different halves**: opt-in removes the cost from
  apps that do not use it, and batching changes the exponent for the apps that
  do. Join and leave are coalesced per channel over `presenceFlushMs` (50) into
  one `presence:diff`; a **timer and not a microtask**, because every socket
  opens in its own tick and a storm is N ticks, so a microtask batch coalesces
  nothing. A connection that joins and leaves inside one window cancels out
  entirely — which is what a flapping socket is. `presenceFlushMs: 0` restores a
  frame per event and is a supported mode, so `presence:join`/`presence:leave`
  are not legacy. **Sierra had to learn `presence:diff`** or presence silently
  stops updating there, and it applies leaves BEFORE joins: a connection that
  left and rejoined inside one window is in both lists.

- **Every HTTP bound stops at the upgrade, so the socket needed its own.** The
  body cap, the DDoS gate and the rate limiter all cover `fetch` and none of
  them covers a frame — which made the transport junction PREFERS the cheapest
  way to exhaust an app: 20 000 `find` frames answered in 1.1s took a victim's
  latency from 9.2ms to 1093ms with the offending socket still open, and 3000
  anonymous sockets were accepted in 2.2s (`FJS-705`). `http.ws` is the five
  bounds. **Two of them are one number written twice on purpose**:
  `maxFrameBytes` is what the APP accepts and is refused by name with a 1009,
  `maxPayloadLength` is what the PROCESS will buffer and is the runtime's,
  which closes with a bare 1006 and no reason — measured, and indistinguishable
  from the network dropping, which is why the app's own limit sits below it and
  answers first. `maxFrameBytes` follows `maxBodySize`, because a socket must
  not be a wider door than a POST. **The rate and the in-flight cap are also
  not one thing**: 100 frames a second against a service call taking a second
  each is 100 concurrent calls. The connection cap is checked at the UPGRADE, so
  a refusal is an HTTP status rather than a close code on a socket the client
  believes it established — and the per-IP map deletes at zero, since a row per
  address that ever connected is itself unbounded.
- **Two timers bound a request and the runtime's is the coarse one.**
  `http.idleTimeout` is Bun's, in seconds, and it was reachable from nowhere —
  its 10-second default reset every slower request with no status and no log
  line here. It closes at roughly TWICE the configured value with a floor near
  four seconds (measured: `1` and `2` both cut a 10 s handler at 4.0 s, `5` cut
  a 20 s one at 8.0 s), so do not read it as a deadline. `http.requestTimeout`
  is the app's own, in ms, absent by default, and setting it raises the
  runtime's per-request timer above it so the app's 503 wins the race. Neither
  stops a handler; one that finishes after its deadline is announced through
  `onError`.
- **`HEAD`, `OPTIONS` and `405` are the transport's, and none of them is a
  route.** A HEAD falls back to the GET route after the lookup misses — Bun
  drops the body itself, so only the routing was missing — and a registered
  `head()` still wins. A method that missed on a path something else answers is
  405 with `Allow`, listing HEAD wherever GET appears; a path nothing answers
  stays 404, because *look for another URL* and *look at your verb* are
  different instructions. An unclaimed OPTIONS is 204 with `Allow`, and
  `cors()`'s own `OPTIONS /*` wins the lookup before any of this runs. The scan
  behind `Allow` (`router.allowedMethods`) is only ever reached once the
  caller's own method has already missed.
- **A body that declares no length is bounded by this package and by nothing
  else.** `Content-Length` is optional, so the pre-read check has nothing to
  look at on a chunked request; `req.arrayBuffer()` then buffers whatever
  arrives, and Bun's `maxRequestBodySize` does not help — measured, it compares
  the DECLARED length and a chunked body passes it untouched. `readBounded`
  walks the stream and cancels at the limit. **Cancelling spends the
  connection**: on Bun 1.3.11 the abandoned bytes stay on a kept-alive socket
  and are read as the start of the next request, so the sender's own next
  request is answered 400 by Bun before this app sees it. That is refused as
  malformed rather than parsed, so nothing is smuggled, and draining instead
  would mean accepting every byte of a flood already refused. Only
  `BodyTooLargeError` answers 413 — the catch used to say it for any parse
  failure, which is a lie about a limit the caller is nowhere near.
- **A presence meta was whatever the client sent, and it went to every member.**
  One 200KB frame produced 39.8MB of egress to 199 members in 114ms, and the
  amplification factor is the channel's membership, so it grows with the
  application's success and needs no privilege beyond being in the channel
  (`FJS-704`). Three bounds, cheapest first: a token bucket per connection, a
  byte cap on the serialized meta, then the app's own `presenceMeta(meta)` —
  which is the only one that can know meta is `{ typing: boolean }`. **The two
  refusals answer differently and that is deliberate**: an oversize meta is a
  fixed property of the client's code, so it is told; a rate refusal is
  transient, so it is dropped in silence — an error frame per refused update is
  the same egress the cap exists to remove.

- **A shutdown that does not finish used to exit 0.** With every remaining
  timer unref'd the loop empties and node leaves *successfully*, so a plugin
  whose `shutdown()` never settles ended in 54ms with the caravan pool, the
  outbox relay and the litestone close all skipped and *Shutdown complete*
  never printed — and zero is what an orchestrator reads as a clean stop, so
  nothing anywhere reported it (`FJS-693`). Three bounds now, and the ref'd
  timer is the load-bearing part of all three: `shutdown.pluginTimeout` per
  plugin, `shutdown.timeout` for the whole thing then `exit(1)`, and crash
  handlers that stop and exit 1 — installed only where
  `process.listenerCount` says the app has not stated its own policy.
- **`app.draining` is read by three surfaces and is why it is on the APP.**
  `/health` answers 503 `draining`, the devtools console answers readiness on
  its own port, and the transport puts `Connection: close` on every response so
  a client holding a keep-alive socket does not send its next request into a
  process that is closing. A flag in one closure makes the three disagree —
  `_healthChecksApp`'s argument (`FJS-414`) applied to a second fact. It is
  false for the whole life of a running app, which is what keeps
  `_finalizeWithHeaders`'s no-op fast path intact.

- **The AI battery is a shape, not a provider** (`FJS-D215`). `IAIModel`,
  `AIBuilder` and `AIRegistry` stay; `createOpenAIModel` and
  `createAnthropicModel` are gone, with the hardcoded hosts, the 2023
  `anthropic-beta` and the two `fetch` calls that had no deadline. An app's
  adapter reaches its vendor through `app.conduit`, where the deadline and the
  auth header are declared per target rather than restated per provider.

- **A custom method is documented as a HEADER, not as a path, and the spec is
  graded by calling it.** `/{service}/{id}/{method}` answered 404 for its whole
  life — the wire dispatches `POST /{service}/{id}` on `X-Service-Method` — and
  CRUD verbs were documented whatever `methods:` allowed, so six documented
  operations were three 405s and a 404 (`FJS-902`). What a service answers now
  comes from `describe().methods`. **The header is the only address and that is
  ruled** (`FJS-D218`): a second path form would be a second place for the gate,
  the idempotency claim and the allow-list to be applied, and the collapsed
  operation is a fact about OpenAPI rather than about the design. `tests/openapi-round-trip.test.ts` calls every
  documented operation against the app that produced the spec, which is the only
  shape that catches drift nobody predicted. The docs page is hand-written HTML
  with two caller-supplied values in it and its CDN reference is PINNED.

- **`/health` is readiness, `/health/live` is liveness, and they disagree during a
  drain.** A failed liveness probe restarts the process and a failed readiness
  probe stops traffic, so one endpoint answering both restarted every replica when
  a third party went down (`FJS-901`). Liveness consults nothing — a draining
  process is still alive, or the orchestrator kills the drain. Checks are
  concurrent and bounded (`checkTimeout`, 2000ms); one that never settled meant no
  answer at all. `/metrics` renders Prometheus exposition when `Accept` asks and
  JSON otherwise; only NUMBERS become metrics, which is what bounds cardinality.

- **A cache value is JSON, and both drivers are held to it by ONE test body.**
  The memory driver and the SQLite one disagreed eleven measured ways —
  reference semantics against value semantics, a `Date` back as a `Date` or as a
  string, `clear()` answering a count or 0, `clear(prefix)` a substring or a
  prefix, FIFO eviction — so swapping the driver, which is the only reason there
  is an interface, changed answers (`FJS-898`). One codec now decides what a
  value may be, and it decides by JSON, because a Litestone row already IS JSON
  and so is every response and every frame. Anything JSON would silently lose
  throws at `set()` naming the key and the way out; the memory driver stores the
  ENCODED value, which is what makes `get()` hand back something a caller cannot
  mutate the cache through. `getOrSet` is the read-through and is single-flight.
  Do not hand-clone around it — `buildCacheHooks` did, and a hook's clone cannot
  be true of a driver it has never heard of. `tests/cache-conformance.test.ts`
  runs one body against both; a test per driver cannot see a divergence at all.

- **A payload key that names no field of the model is a 400; a field the caller
  may not WRITE is still dropped in silence** (`FJS-889`). The strip is
  mass-assignment protection and is right about the second kind — `id` on a
  create, `createdAt`, a `@guarded` column, every one of which a client PUTting
  back a row it fetched sends on every write. It was wrong about the first:
  `{ title, titel: 'typo' }` answered 201 with the typo gone, which is a write
  the caller believed had happened. The field set is read off `$schema.models`
  and **not** off the generated documents — `createdAt` and `updatedAt` are in
  no mode `create`/`update`/`read` emits, so a document-derived set would refuse
  exactly the legitimate echo above. Checked per ROW, so a bulk write still
  partitions; a declared `input:` type is the same rule against its own
  properties. The escape is `@transient` and the refusal names it. There is no
  *did you mean*: litestone owns the typo hint and exports neither of its two
  `editDistance` copies, and a third would be a new origin for it.

- **`update` is `patch` with an id REQUIRED, and it MERGES** (`FJS-D179`).
  Feathers' word for the verb is a full replace and this is not one: the write is
  litestone's `table.update`, so a `PUT` stating only `title` leaves every column
  it did not name where it was. What the id buys is that a REST client's `PUT` can
  never reach patch's query path, which is a bulk write. It was validated against
  the CREATE-mode schema until `FJS-663`, which omits `@version` — so the version
  a `PUT` carried was stripped and the Data boundary refused the write for not
  carrying one, making every `PUT` to a versioned model a 400 naming the field the
  request had just sent. The other three layers already agreed: the write merges,
  sierra's `field-rules.js` grades a form for `update` exactly as for `patch`, and
  a sierra resource never issues `update` at all.

- **There is no `ctx.params`, on either context.** Deleted rather than renamed
  (`FJS-D03`): in Feathers `params` is the whole context bag, and that idiom kept
  arriving here — `ctx.params.user`, `ctx.params.headers`,
  `app.service(x).get(id, ctx.params)` — where a field of that name holding
  something *else* is how a role check reads `undefined` and passes for everyone.
  Path captures are **`ctx.route`** on both contexts. Sierra says `page.params`;
  one word per realm, and the crossing is stated in both docs.

  See **§ The two contexts** below for which one you are holding and when.

- **The build a client compares against is stated, never diffed.** A response
  carries `x-fjs-build` and the socket's `connected` frame carries `build`; the
  client holds its own (Sierra stamps `VITE_FJS_BUILD` at build time) and decides.
  Both halves are inert unless both sides know one, and the response header is
  GATED — `_finalizeWithHeaders` has a no-op fast path that hands an untouched
  `Response` back, and setting a header unconditionally would defeat it for every
  request in every app that never deployed. `stale` fires once.

- **A top-level key in `junction.config.js` reaches the app only if `loadConfig`
  MAPS it.** `app` and two `middleware` keys map onto `AppConfig`; everything
  else is stashed under `config._junction` for whichever subsystem owns it. So a
  block nobody looks up is read by nothing, silently — an app writes it, the app
  boots, and the feature is simply off (`FJS-431`). `attachments` is mapped
  straight through; anything new needs the same line, and reading a fallback in
  the consumer instead is a second answer to where the block lives.

- **An attached service that is BOUND HALFWAY refuses, `optional` included.**
  `optional: true` says the app can run without the service, never that it can
  run against half of one — and half-bound is the shape that reaches production,
  because somebody binds the URL and forgets the key. A key carrying a `default`
  is not evidence either way, so it never counts toward *is this bound here*.
  The refusal is at STARTUP and the operator sees it because a failed health
  check now tails the container (`fli`'s `showContainerTail`); before that the
  app's own sentence died in `docker logs`.

- **A `methods:` list that names one method narrows the service to it.** The
  entry form that carries an `input:` is the same declaration as a bare name, so
  a service written without `methods:` — which answers every verb — starts
  answering 405 to all but the ones now listed. `surface.snapshot.md` is where
  you see it: it carries the policy-applied list, and CI fails a stale one.

- **`$` is the call you are inside, and it throws outside one.** Not Invariant
  10's `$`-prefixed keys — a different thing sharing a character. It is the whole
  `ServiceContext` (`$.db`, `$.data`, `$.id`, `$.locals`), read-only except for
  junction's own contract keys, and dead the moment the call ends. Reading it at
  module scope runs at import, before any call exists, and says so. In a
  `*.job.ts` handler it throws too: a job's `ctx` is Caravan's, and deferred work
  reaches the database through a service.

  See **§ `$` — the call you are inside** below.
- **A query string is PARSED, and a WS frame is not.** `ctx.query` on a
  `TransportContext` is `?qty=5&live=true&qty[gte]=3` as numbers, booleans and
  structure — `@frontierjs/toolbelt/query`, which Sierra's router and this
  package's own client also read (`FJS-D125`). The socket was always the correct
  half: `buildWsQuery` spreads filters into a JSON frame, while
  `buildQueryString` used to `String()` every scalar, `JSON.stringify` every
  operator object and drop `null` outright — so an app worked until its socket
  dropped and then silently filtered on text, three of the five kinds answering
  an empty list with a 200 (`FJS-450`). A frame is JSON and already carries its
  types, so the parser must never run over one: it would turn a filter that
  genuinely says the string `'5'` into 5.
  - **A raw route reads the parsed query too**, so a value that looks numeric
    arrives as a number. An id is text whatever it looks like — `String()` it.
  - `$` keys are still present on a transport context; splitting those off is
    the service boundary's job (`splitParams`), not the transport's.
  - **A string is a number only if `String(Number(v)) === v`.** `'007'`, `'+1'`,
    `'1.50'`, `'1e5'` and a snowflake id stay text. `?code="5"` is the escape.
- **Raw routes use `{id}`, not `:id`.** A `:id` registers as a literal segment
  and 404s silently forever.
- **`app.get`/`app.post`/… apply `apiPrefix`; `app.http.router.get` does not.**
  One owner, in `core/app.ts` — so a plugin registers `/webhooks` and an app
  under `/api` serves `/api/webhooks`, auth's `/auth/login` included. Never
  hand-resolve `app.config.apiPrefix` beside a registration: four plugins did,
  the one outside this package did not, and that asymmetry was `FJS-012`. The
  router is the escape for a path that must not move.
- **An `Idempotency-Key` on a mutating request means it runs once, and only for
  a caller who HAS a principal.** Claimed in `callService`, keyed by
  `(service, method, principal, key)`; a repeat replays the stored result and
  runs **no hooks**, so anything an app does in a hook does not happen on the
  replay. A failed call releases the key; an in-flight duplicate is a retryable
  409. `config.idempotency.enabled: false` turns it off.
  - **A key from a caller with no principal is IGNORED** (`FJS-680`), with one
    `console.warn` naming why. Anonymous callers used to share the literal
    string `anonymous`, which made one namespace out of every stranger: the
    second to send a key the first had used was replayed the first one's row —
    somebody else's created record — or refused a 409 about a request they
    never made. There is nothing to key on instead: a guest's claims
    deliberately never become `ctx.auth.user` (`applyClaims` scopes the Data
    client and stops), so two anonymous POSTs with one key are two calls.
  - **The key names ONE request.** The claim stores a hash of method + path +
    query + body, and the same key with a different payload is a **422** rather
    than a silent replay of the first answer — the same thing Stripe does, and
    the only way a client finds out it reused a key.
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
  the param name is read by the handler and by nothing that matches. Silence
  there makes which copy survives depend on the path: a FIXED path is
  overwritten in `build()` so the LAST won, a DYNAMIC one is scanned in order so
  the FIRST won and the later handler never ran. Doubled CORS is what surfaced it
  (`FJS-225`); the refusal covers any plugin claiming a path another owns.
- **A broadcast is GRADED per recipient and joining a channel is no longer a
  permission** (`FJS-D175`). A channel is a named set of connections and joining
  one used to be an ungraded GRANT: `@@allow` compiles into a SELECT's WHERE and
  a broadcast is not a SELECT, so an anonymous socket received whole `Order`
  rows the same caller was answered 401 for (`FJS-631`). `gradeRecipients` asks
  `db.$readAs(accessor, row, principal)` at the Data boundary — the rule is
  declared there and a second implementation of it is a second answer to who may
  read — and this owns the fan-out and nothing else.
  **The unit is a COHORT**, keyed on the principal's VALUE — a canonical
  serialization of the session, memoised on the object `verifySession`
  answered — because the term that multiplies is the ENCODING and not the
  verdict: Phoenix says so about `handle_out` ("encoded N times instead of a
  single shared encoding") and measured here it is 288 ns against 684 ns. Two
  tabs of one person are one verdict and one frame; a hashed key would collide
  two people, and OBJECT identity collapsed nothing at all, because
  `verifySession` runs per socket and answers a fresh object every time
  (`FJS-764`). Over 100 connections — 14.9 µs where the model needs no grading,
  49.8 µs for one cohort, 445.6 µs for 100 distinct principals; against a real
  Data boundary, 100 sockets of ONE person went 606.7 µs → 75.5 µs when the key
  stopped being the object. Serialization REFUSES anything with a prototype of
  its own — a class instance, a Map, a function — and falls back to the object,
  because collapsing two principals that are not the same is the one mistake
  here that delivers a row to somebody who may not read it.
  **Three things are deliberately NOT graded and none is a hole**: a model
  `$readGrading` calls `open` (gate 0, no read policy, no field policy — a
  catalogue), a LIST payload (a bulk write announces a COUNT, which names no
  row), and a call with no Data boundary on its context (a raw route, a test
  harness) — which is a different thing from a boundary that was asked and
  threw, and that one refuses.
  **`toDataPrincipal` on the way in, or the grading is worse than none**: a
  `SessionContext` puts the id at `userId` and litestone's `auth()` reads `.id`,
  so `userId == auth().id` is false for the recipient's OWN row and TRUE for a
  guest row whose `userId` is null. The first working version refused the
  anonymous socket correctly and delivered the one row the recipient may not
  read — caught only because every assertion is a pair.
  **A CLAIM cannot be resolved for a connection, so the app states it per
  channel** (`FJS-D191`). A claim is per REQUEST — `createApp({ principal })`,
  off a header — and a broadcast has no request: the principal on a connection
  was built at the upgrade, where there is no workspace and no header to read
  one from. Under `strategy row` the tenancy rule desugars into an `@@deny` and
  an `@@deny` fires on UNKNOWN, so an ABSENT claim refuses every subscriber on
  every tenanted model, permanently — basecamp's eighteen live services, with
  only a once-per-service warning that reads as *the model is genuinely
  private* (`FJS-749`). `channels(setup, { claims })` is the missing input,
  merged onto the principal before grading; the app answers because the app
  named the channel. **Per channel and not per connection** — one person in two
  workspaces is one principal on one socket and holds a different tenant in
  each — so a cohort is keyed on the principal AND the claim set. **An empty
  answer is not a claim**: `{}` would turn a `null` principal into an object,
  which every `getLevel` grades a rung above a stranger.
  **The BACKGROUND path is graded by the same function** (`FJS-672`).
  `announceDataWrites` sent raw for as long as it existed, so every write that
  went through no service call — a job, a webhook, a cron, a bulk write,
  `asSystem()` anywhere — put whole rows on every subscribed socket: measured,
  the service path reached 0 of 100 anonymous sockets and `asSystem().create`
  reached 100 of 100. `gradeRecipients` takes the client and the accessor rather
  than a `ServiceContext`, and the tap reaches it through
  `manager.sendGraded()`, duck-typed like every other reach into the manager
  from there.
  **A count-only `changed` is graded by the GATE alone, and the mode is STATED.**
  A bulk write announces a count, which names no row, so `$readAs` has nothing to
  grade and would refuse everybody for a reason unrelated to who may read — while
  *something you may not read changed* is still an existence oracle over a gated
  model. The payload cannot say which of the two it is, so the caller does.
  **The accessor is the DECLARED `model:` and the service name only as a
  fallback** (`FJS-700`). Resolved from the name alone, a service whose name maps
  to no model — `orders2` over `Order`, a modelless service, any Invariant-19
  irregular — graded to nobody, silently. A channel that grades to nobody warns
  once per service, because a correct refusal and a misresolved accessor look
  identical from the send side.
  **The index is model → a SET of services, and a DECLARED `model:` is the only
  spelling that service claims** (`FJS-765`). Holding one name per model, the
  suppression compared against the winner and every OTHER service over that
  model was told nothing — measured on two services over one `Order`, a write
  through the loser announced only the winner and an `asSystem()` write announced
  only the winner, with registration order deciding which. The declared-only
  claim is the second half: the old build made the name-derived claim first and
  let the declared one override the key it named, so a service called `orders`
  over `model: 'Invoice'` went on receiving `Order` writes.
- **`typeof db.x` on a Litestone client is a THROWING expression, and a
  `$setAuth` proxy carries fewer `$`-members than the root** (`FJS-673`). The
  probe is `'x' in db`, and answering it is only half the job: `$tapQuery`,
  `$tapEvents` and `$logContext` are ROOT-client members, so `in` answers FALSE
  on a scoped one and a feature that "works" now installs for nobody. The query
  tap used to be installed per request off `ctx.locals.db` — which is a scoped
  proxy for a signed-in caller — so ONE `app.telemetry.on(…)` listener turned
  every AUTHENTICATED call into a 500 while anonymous ones, holding the root
  client, kept working. The devtools console registers four. It is
  `installQueryTelemetry` on the root client once, with attribution read off
  `currentCall()`, because the ALS store is the only thing that knows which of
  several concurrent calls a query belongs to.
- **A WS token that is PRESENT and does not verify closes the socket 4001; no
  token stays anonymous** (`FJS-702`). `_wsOpen` swallowed the throw, so a
  revoked, expired or forged session held a socket for its whole life, the
  browser client's `4001` no-reconnect branch was dead code, and the plugin's own
  doc comment promised an `auth_failed` message nothing ever sent. The close is
  before `open` runs, so nothing joins a channel and no `connected` frame goes
  out. A caller who claimed nothing is a different answer from one whose claim
  was rejected — do not collapse the two.
- **The devtools console binds LOOPBACK, and off it `auth` is required whatever
  `NODE_ENV` says** (`FJS-691`). `Bun.serve({ port })` with no `hostname` is
  every interface, and the only guard was `NODE_ENV === 'production'` — unset in
  dev, unset in `staging`, unset in `test`, and unset is the common case. Every
  POST and the WS upgrade also check `Sec-Fetch-Site` then `Origin`: a
  `text/plain` POST needs no preflight, so a page on any origin could run a job
  by name (measured: `POST /api/jobs/run/send-invoices` from `Origin:
  https://evil` answered `{"ok":true}`). A request carrying NEITHER header is not
  a browser and is left alone, which is what keeps `curl` and the drives working.
- **A write is DONE at two different moments and `callService` used to know
  neither.** With `transactional:` the rows belong to the OUTERMOST transaction,
  so a nested call settled early — on the rollback path it ran an `afterCommit`
  effect and broadcast a create for a row that had just been removed
  (`FJS-682`). Without one they are durable the moment the METHOD returned, so a
  later hook throwing leaves the row committed while the caller is told 500 and
  nothing announces (`FJS-688`). The commit scope (`core/context.ts`) is the
  owner now: opened by the transaction hook, REUSED where one is already open,
  drained on commit and discarded on rollback.
  **Three edges, and each is a way to get it wrong again.** The scope is
  captured INSIDE the pipeline — the announcement point runs after it, where the
  ALS scope has already closed. The call that OPENED the scope drains it itself
  and does not defer into a queue it has emptied. And that call is the only one
  that has to be told the transaction rolled back, because `methodSucceeded` is
  true either way.
  **The tap asks the scope, not the span**: litestone buffers a transaction's
  write events to the COMMIT, so `announcingService()` sees the outermost call
  and misses for every inner one — measured, three events for one nested create.
  **`afterCommit` deliberately keeps the opposite answer to the announcement.**
  It follows the CALL's verdict (`FJS-089`), so a client told the call failed
  does not also get the email, while a subscriber is still told the row moved.
- **A webhook registration is a destination somebody else chose, and every bound
  on it was missing** (`FJS-681`). Measured: a `role: 'user'` shopper POSTed a
  `*` subscription and got 201 with the signing secret; `169.254.169.254`,
  `localhost:8503` (the devtools job runner), `file:///etc/passwd` and the
  literal string `not-a-url` were all accepted as destinations; a 307 was
  followed with the signature re-sent; and a subscriber whose deliveries all
  died stayed active. **`manage` (default 5) is the standing**, graded with
  `sessionGateLevel` — 403 for a caller who is merely too junior and 401 for a
  stranger, which a client acts on differently. **`assertDeliverableTarget` is
  the destination**, an ALLOW-list of schemes plus a public-address check over
  every address a name answers with, run at registration AND before every
  attempt — a name that resolved publicly an hour ago can resolve to loopback
  now. A rebind BETWEEN the check and the connect is not closed and `url.ts`
  says so: it needs the socket pinned to the graded address, and `fetch` has no
  way to do that. `targets: { allowHttp, allowPrivate }` is the opt-out and the
  only thing in this repo that turns it off is the delivery suite, whose
  receiver is a real server on localhost.
- **A webhook subscriber is an AUDIENCE, and it is read rather than stated**
  (`FJS-D193`). A delivery carried whatever the bus emitted — measured,
  `deliver('users:created', { …, password: 'hunter2' })` arrived in full
  (`FJS-724`). `FJS-631` one layer over, and `$readAs` does not carry across
  unchanged because a URL is not a principal. What makes it carry is that a
  REGISTRATION had one: the audience is READ from the principal in scope at
  registration, stored as an ID and re-resolved at every delivery — caravan's
  answer for a job, on a longer fuse. **Read and not stated is the security
  property**: `sessionFor` must never be wired to anything a request can name,
  and `manage` (5) is the bar for creating a registration, so an audience the
  registrant chose would make 5 the bar for receiving anything.
  **Three answers, and the line between the last two is the design**: *graded*;
  *ungraded* where grading was never APPLICABLE (no Data boundary, an event
  naming no model, a payload that is not a row), delivered with the floor and
  said once; *refused* where it was applicable and unanswerable — nothing sent
  and **no pending row**, because a payload nobody may read must not sit in a
  retry table for a day. `$protectedFields` is the floor on the ungraded path
  alone, by name at any depth; under grading it would be a second reading of a
  rule the boundary already applied. **ABSENT is not `null`** — a custom store
  that cannot record an audience answers `undefined`, which is *cannot say* and
  not *nobody*, and its deliveries go out ungraded saying so.
- **`sessionGateLevel` does not read `role`, and a test written against one
  grades 4.** A standing is `isAdmin`/`isOwner`/`isSystemAdmin` plus the two
  lifecycle fields; an app's own `role` column is not consulted whatever it
  says. `StubUser` carries all five now, written onto the session **only when
  stated** — absent means *this app does not model that stage* and only `null`
  grades down, so defaulting them would move the standing of every test that
  never mentioned one.
- **`createFileStorage` is a SECOND owner of file storage and is hardened rather
  than trusted** (`FJS-692`). Litestone already ships the real `FileStorage`
  (local + S3, `@accept`, cleanup), so retiring this one is a ruling and not a
  refactor. Until then: `assertSafeId` sits on both path builders rather than on
  the entry points, so nothing in that module reaches the filesystem without
  having passed it — an id is a path segment, and `../../../../outside/p2` wrote
  two directories above the root; the type comes off a CALLER-SUPPLIED filename,
  so every response carries `nosniff` and anything outside a small image
  allow-list that EXCLUDES svg is an attachment; and an unsatisfiable range is
  416 with `bytes */N`, where `bytes=50-10` used to answer 206 with
  `content-length: -39`.
- **Every address and every header value on a mail message is refused at BOTH
  ends** (`FJS-677`). SMTP is line-oriented, so a CRLF in a `to` is not a bad
  address but a second transaction — a fake MTA queued TWO messages from one
  `sendMail`, the second composed by whoever typed the address into a form. The
  builder is where a mistake is cheapest to attribute and `sendMessage()` is the
  last thing before a socket write and is reachable directly through the exported
  `sendMail`; one of the two alone is a validator somebody routes around. The
  header encoder REFUSES a CRLF rather than encoding it — the subject survived
  only because `encodeMimeHeader` base64-encodes non-printables, which is a rule
  that exists for emoji.
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
  `app.start()` with `import.meta.main`). Autoloaded services are found without
  `--services` now — the tool asks `resolveServicesDir` the same question the
  app asks, naming the app MODULE as the entry, because the app's own phase
  resolves against `Bun.main`, which here is the tool. `--services` is an
  override, and one that is checked: a directory named and absent is fatal.
  **The snapshot is written beside the CWD, and CI reruns it from the snapshot's
  own directory** — which decides where it may live. All four of these
  (`surface`, `jobs`, `principal`, `notifications`) belong in the surface they
  describe, `api/`, the same rule `db/` and `web/` already follow; that only
  works for an app that BOOTS from `api/`. `configPath` defaults to
  `./api/config` against the CWD, so an app that does not state it looks for
  `api/api/config` and describes an app running on junction's defaults — a
  silent wrong answer, not an error. An app moving them states `configPath`
  anchored to its own module and anchors any relative path its config carries
  (`example/api/src/app.ts`). An app whose isolation is BY cwd keeps them at the
  app root instead (`packages/basecamp`), and `fli`'s reader looks in `api/`
  first and the app root second.
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
- **A `methods:` entry may be `{ method, input }`, and `input` names a `type` in
  the seed.** `autoValidate` derives from a MODEL and covers create/patch on a
  model service; every other method a service answers — `pay`, `ship`, `prune` —
  took `ctx.data` on trust, which is the largest surface here with no declared
  shape at all, because the interesting operations in an app are exactly the ones
  that are not CRUD. `type PayOrder { … }` in `db/schema.lite` reaches `$defs`
  beside the models, and `validateInput` compiles it with the same
  `jsonSchemaToJunctionSchema` → `createSchema` pair `autoValidate` uses — so
  nothing new decides what a shape is, and the 400 renders in `<Form>` like a
  CRUD one. A CRUD name may carry one too, and it REPLACES the model-derived
  validator: the only way a create accepts a payload the model does not describe.
  **A named type that is not there THROWS**, where a missing model warns — a
  missing model definition is a config that used to work, and an `input:` is a
  statement the author made this morning, so failing open on it hands back the
  assurance it was written to provide.
- **Declaring an input is also declaring the SURFACE, and that is the sharp
  edge.** `{ method: 'pay', input: … }` narrows exactly as `'pay'` does, so a
  service that declared no `methods:` and gains one to turn validation on answers
  405 to every verb it did not name. Name the whole surface. It is not left to
  production: `surface.snapshot.md` carries the policy-applied method list AND
  the declared inputs, and the `snapshots` CI phase fails a stale one — a verb
  that stopped being answered is a diff before it is a bug.
- **What a declared input does NOT buy is a transform.** `@trim`/`@lower`/
  `@upper`/`@slug` are enforced at the Data boundary and are not emitted into
  JSON Schema at all, and a custom method's payload never becomes a model write —
  so it never meets them. Worse than absent, the two boundaries would disagree
  about what is VALID if they were wired naively: litestone transforms BEFORE
  validating, junction's `def.transform` runs AFTER, so `@trim @length(3,12)` on
  `'  ab  '` fails at one and passes at the other. `FJS-401`.
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
- **`withTenantDb` holds the pool's LEASE for the length of the request, and
  that is the only reason an eviction can free anything.** litestone's pool
  never closes a client it lent out (`FJS-D172`) — it cannot know who holds one
  — so without a lease the handles come back on a collection that
  file-descriptor pressure does not trigger. A request is the unit of work, so
  this is the one place the answer is already known: `registry.retain?.(id)`
  after the client is resolved, released in a `finally` that wraps `next()` and
  the error path. `retain` is optional on `TenantRegistryLike` because the
  registry is duck-typed across the dependency boundary.
- **Row tenancy needs no hook and fails the other way round.** One database, a
  tenant column, and the schema's own policies scope every query — so a
  **signed-in** principal carrying no claim matches no row and every screen is
  an empty list with a 200, which is indistinguishable from a tenant with no
  data. `tenantClaimGuard` refuses that by name on a scoped service. Anonymous
  is deliberately not its business: nobody is not a caller missing a claim, and
  refusing there breaks every public read the app's `@@gate` exists to grade.
  **It refuses in three sentences and never in a 401.** The caller proved who
  they are, and a 401 is what a client is built to answer by discarding the
  token — so naming a tenant you do not belong to would sign you out of the one
  you do. *Nothing here emits this claim* is a developer's problem; *this
  request names no tenant* is a **400**, an incomplete request rather than a
  refused one; *you do not belong to the one it names* is a 403. Only the
  resolver can tell the last two apart, so it says so.
- **`ctx.locals.tenantId` is WHICH TENANT, under both strategies, and it has two
  assignment points.** `withTenantDb` resolves it from the request
  (`strategy database`); `liftRowTenant` takes it off the principal
  (`strategy row`) — from `sessionFields` before a resolver runs, and off
  `applyClaims` after one has. **The claim is NAMED by the schema**
  (`tenancy { claim }`), so a cart token or an invitation claim is a claim and is
  not a tenant. `tenantOf(ctx)` is the accessor; `app.tenant()` is the same
  question from somewhere holding no ctx and reads the CALL before the request,
  because a service whose subject is the tenant may re-resolve mid-request.
  Before this, three subsystems with no request in hand each answered it
  themselves: the cache key, the outbox relay and a queued job (`FJS-386`,
  `FJS-365`, `FJS-384`).
- **A cached service is partitioned by tenant, and the segment lands outside
  `keyBy`.** The cache is on the APP and not on the client, so one process
  serving two tenants shares one cache under EITHER strategy — the `uid` segment
  is what hid it, since a cached list is keyed by the caller and the leak needs
  the same person in two workspaces. A custom key function says what makes two
  calls the same call within a tenant and was never asked about the tenant, so
  it cannot opt out; `cache: { shared: true }` is the declared opt-out, and it is
  the app's statement to make.
- **The outbox relay sweeps every database the request path can write to, COLD
  and once per tick.** One per tenant off the registry, and the dispatch names
  the tenant so the handler writes back to the file the row came from. An app
  built with both `createApp({ db })` and `createApp({ tenants })` holding the
  model in both is refused at BOOT — `assertOutboxShape`, not the pass, because
  `pass()` logs and continues and the failure is a queue that quietly never
  drains; it opens no tenant to answer that, since the question is decidable
  from `app.db` and the registry's presence.
  **The walk goes through `registry.query`**, litestone's own scan-resistant
  path, and everything here that needs the database set goes through
  `forEachOutboxDatabase` rather than a `list()` + `get()` loop. `get(id)` is the
  REQUEST path's verb and promotes into the pool, so a relay's timer using it
  made the walk the working set: measured against a real registry, one idle pass
  over 20 tenants evicted the tenant that had just been served, and it happened
  three times per tick because deliver, sweep and count each resolved the
  registry (`FJS-778`). `outboxPass` is one traversal, and **the post-commit
  kick names its own database** — the call knows the client it wrote the row
  through — which is what leaves the timer as pure crash recovery.
- **A row that keeps failing is given up on.** `maxAttempts` (default 10) with a
  doubling backoff on `nextAttemptAt`; past the cap the row is not deleted and
  not stamped — it stops matching the relay's query, counts as `dead` rather
  than `pending`, and fails the readiness check, which is the only thing in the
  process that says an effect is never going to happen. Dead is DERIVED from
  `attempts` against the cap, so raising the number revives every row it covers;
  `maxAttempts: 0` is the old behavior, retried on every tick forever.
- **`createApp({ principal })` is where a claim gets onto the principal, and the
  ordering is the feature.** It runs INSIDE `withLitestoneDb`/`withTenantDb` —
  after the client is scoped to the caller, before `next()` — because
  `getTable()` re-derives its own scoped client from `ctx.auth.user`, so a
  standing that lives only on `ctx.locals.db` is dropped the moment a service
  touches a model (`FJS-D113`). A tenant claim and a per-request standing are
  the same thing and resolve together; `applyClaims` is exported because a
  service whose SUBJECT is the tenant must re-resolve mid-call.
  Two refusals are built in: a resolver may not set `userId`/`id` — a claim says
  what a caller HOLDS, not who they are — and it does not run for an anonymous
  caller, because minting a principal out of claims turns *nobody* into
  *someone*, an object satisfying `auth() != null` while carrying no identity.
  **It does not run for work with no request behind it either**, which is ruled
  and is the reason `FJS-384` is open.
- **`membershipClaim()` is the battery, and its whole safety is one line: no row
  is no claim.** The hand-written version that forgets the membership check
  emits the claim anyway and every read answers 200 over somebody else's rows —
  so the read that DECIDES access goes through `asSystem()` (it cannot be
  scoped by the access it decides) and a caller naming a tenant they do not
  belong to comes out holding nothing. The row is parked at
  `ctx.locals.membership`, so the standing costs no second query. `namedBy:`
  is how the app's own actionable sentence — *pass X-Workspace-Id or
  ?workspace_id=* — reaches a framework refusal that could not otherwise know
  it; `tenantFrom` is the only thing that knows where a tenant is named.
- **`sessionGateLevel()` is a hand copy** of the same function in Litestone
  (which cannot import Junction). Change one, change both. `toDataPrincipal()` is
  the other half of that boundary — `userId` → `id`, without which every
  `@@allow(... auth().id)` matches nothing, silently.
- **`before: { all: [...] }` applies to every method**, machine-facing endpoints included.
  A comment claiming exemption is not one.
- **The gate runs before anything an app wrote, and `validated:` is the phase
  after the derived layer.** `gateAuth` is a service-level AROUND hook, so it
  wraps every before hook at either scope — it used to be appended to the
  per-method before list after the app's own, and an app rule that read the
  database therefore read it for strangers (`FJS-403`, ruled `FJS-D124`). Leading
  the per-method list would not have fixed it: `resolvePipelines` runs
  `before.all` ahead of `before.<method>`. The validators still trail the app's
  hooks, because a before hook shapes `ctx.data` and it is the shaped payload
  that must satisfy them. **The order is
  `around(gateAuth) → before → validated → method → after`**, and `validated:` is
  where a rule that reads the database off `ctx.data` belongs: it needs a caller
  the gate has graded and a payload the validator has coerced. It short-circuits
  like `before` and is skipped when a before hook has already answered the call.
  The one thing still ahead of the gate is an APP-level `around` hook, which must
  be: `withLitestoneDb` establishes the client the gate grades against.
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
- **Socket liveness is SERVER-driven and an app calls nothing.** The channels
  plugin pings an idle connection every 15s and evicts one that has sent nothing
  for 40s (`heartbeatInterval`/`heartbeatTimeout`); any frame answers it, and the
  client replies to the ping from its message handler. Do not reach for
  `client.startHeartbeat()` — a client-side TIMER is what does not work, because
  browsers throttle timers to ~1/min in a hidden tab, which is slower than any
  eviction window. Before this the eviction had a server half and no client half
  at all and every app flapped on a ~35s cycle (`FJS-366`).
- **The METHOD decides list vs single** — `wrapResult(raw, service, method)`.
  `find` must answer a list or it throws `ResultShapeError`; an array is a list;
  `{ data, errors }` is a list on any method (the bulk protocol); everything else
  is a single and travels whole. Guessing from shape alone drops
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
  behavior and the one every non-Sierra caller still gets.
- **A push is also PLACED, and a page past the first refuses one.** `orderBy`
  decides where the row goes (`core/sort.ts`, which is `parseSort` — one reading
  of `-createdAt`), and on the first page the row pushed past `limit` belongs to
  page 2. Past page 1 nothing here can know whether a new row belongs on an
  earlier one, so it is refused and counted on `stale`, which a view renders as
  *3 new — refresh* and `load()` clears. The limit and offset come off the
  ENVELOPE, not the params — the effective limit is the server's.
  **A list with a `limit` and NO `orderBy` is in the same position and takes the
  same answer** (`FJS-766`). Nothing can place the row, so at the page size it is
  counted rather than appended — appending unconditionally is what this did, and
  the list then grew without bound: 3000 pushes into a `limit: 20` load reached
  3003 rows and 221 MB of RSS. It bounds GROWTH alone: a row already on the page
  takes `apply`'s `present` branch and never reaches the bound, and a page that
  is not yet full still appends. Trimming instead would drop a server row chosen
  at random, which is worse than not showing it.
- **`resource().load()` writes the store only if it is still the newest load.**
  Stamped when issued (`FJS-082`); an overtaken load still RETURNS its rows to
  the caller that awaited them, and its request is not cancelled. Code reading
  the return value of a load it may have superseded is reading stale rows on
  purpose — the store is what is current.
- **A custom method announces under its own name** (`orders pay`).
  Only `find`/`get` are excluded; a read-shaped one opts out with
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
  every position, not one per phase per method. The old gate was
  `NODE_ENV !== 'production'`, which is every developer all of the time.
  **The third kind is a REFUSAL, and it took over what this line used to call a
  warning.** A duplicate service, a file with no factory, a hook map on a method
  the service does not answer: each one is a thing the author wrote that nothing
  reads, and each was a `console.warn` beside a `continue` — or, measured, not
  even that. They are `check-authoring` findings now (`FJS-D199`), collected and
  refused together at `start()`. What stays a warning is a probable defect the
  app can still run with.
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
- **Fake clients hide real bugs.** Cross-package behavior goes in
  `tests/real-litestone-client.test.ts`, against a real client.
- **No test file may name a port.** Bun runs every file in ONE process and an
  app's `stop()` does not finish before the next file's `start()` begins, so a
  shared port means a socket is answered by another file's app mid-shutdown —
  which reached the client as `Expected 101 status code` and was reported as the
  connection-cap assertion failing, one run in three and then every run
  (`FJS-900`). Three files bound 3396 and four bound 3397. Ask for `port: 0` and
  read `app.http.port` back after `start()`. `tests/test-ports.test.ts` refuses a
  second file naming the same port.

- **Nothing here mocks a module any more, and it must stay that way.**
  `mock.module()` is applied PROCESS-WIDE by bun and never undone, so
  `tests/email.test.ts`'s five calls on the smtp shim made every later file grade
  the mock — measured, five assertions green in isolation and failing in the full
  run — and three suites spawned a subprocess to escape it. The transport is
  INJECTED now: `createSystemSender(config, { transport })`, defaulting to the
  real client, which is Outpost's runner one package over (`FJS-908`).
  All three suites came home and stayed green, which is what proves the mock was
  the only cause. **Their assertions are real `expect`s now, not stdout
  matching** (`FJS-909`): an `ok <name>` line a parent greps for cannot fail when
  it is not reached, so a renamed row or a probe that exits early read as a pass
  — 2 greps became 42 assertions. For a double at the interface,
  `createTestMailer()` in `@frontierjs/testing` — it refuses exactly what the
  real mailer refuses.
- **`ctx.result` must be `null`, not absent**, when hand-building a context in a
  test — `runPipeline` reads non-null as "a before hook already answered".
- **The HTTP and WS paths build their context separately** — `bridge.toContext()`
  vs `bridge.internal()` — so anything one derives from a request the other must
  lift out of the frame by hand, and a difference is silent because the browser
  client falls back to HTTP whenever no socket is up. `ctx.id` is normalized to a
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
- **An internal caller's directives go under the `directives` key, and a flat
  one is ignored.** `app.service('posts').find({ status: 'open' }, { directives:
  { limit: 10 } })` — `CallOptions` is a closed type carrying `auth`,
  `transport`, `locals` and `directives` only, so a bare `{ limit: 10 }` in the
  second argument is not a directive and silently does nothing. Filters ride the
  first argument, never the options. `transport` defaults to `'internal'`, and a
  hook branching on it treats that as background work.
- **`_find`/`_get`/`_create`/… bypass junction's hooks only, never a Litestone
  gate.** They skip `autoValidate` and `autoFilter` with the rest of the
  pipeline, so what reaches the Data boundary is unshaped, and `ctx.telemetryId`
  is `undefined` on that path because `callService` never set one. They are not
  dispatchable by name over `X-Service-Method`: `_customMethods` is the whole
  allow-list, and a name absent from it is a 404 whatever the service object
  holds.
- **`kind` is the envelope's one discriminant.** `object` names the SERVICE in
  both kinds (`'posts'`, never `'list'`), so `object === 'list'` is never true
  and `'object' in value` is true of any record with a column called `object`.
  Branch on `kind`. On the wire `$wrap=true` opts a single into the envelope and
  `$wrap=false` unwraps everything, lists included.
- **Litestone is an optional peer reached by dynamic `import()`, and junction
  runs without it.** A static import anywhere under `src/` makes every
  modelless app fail at load — the adapter and the manifest plugin import it
  inside the function that needs it.
- **`channel:` takes three shapes.** A string names the channel, `false` is the
  declared opt-out (from `publishDefault` too), and a function `(data, ctx) =>
  app.channel(…)` picks the target per write — the shape for a workspace or a
  room, where the name is on the row.
- **Plugin phases run breadth-first, and only `ready` is forgiving.** `register`
  for every plugin, then `boot` for every plugin, then `ready` for every plugin,
  and `shutdown` in reverse configure order. A throw in `register` or `boot` fails
  `start()`. A throw in `ready` is logged and the app starts anyway, so anything
  that must succeed belongs in `boot()`. `app._plugins` is complete by `boot()`
  and holds only the plugins configured BEFORE yours during `register()`.
  Configuring one plugin twice registers it twice — nothing deduplicates by
  name.
- **`opts.config` wins at the leaf.** `createApp({ config })` is deep-merged over
  `defaultConfig`, and `junction.config.js` is merged under it at `start()`, so a
  nested block in code overrides one field of the file's block rather than
  replacing it — and the file cannot override a field the code stated.
- **Security is opt-out and CORS is the exception.** `cors.origins` defaults to
  `[]` and `'*'` is never applied for you. Helmet headers are on unless
  `http: { helmet: false }`, and the DDoS gate and the rate limiter are off
  until configured.

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
| Columns the APP supplies | — | `ctx.system` — a Set a hook adds to; passed to litestone as `system: [...]` |
| Responding | `ctx.json` / `text` / `html` / `file` / `sse` / `paginate` | return a value; the envelope is built for you |
| Reaching the other | — | `ctx.$raw` — the transport ctx, or `null` |

**Where they must agree.** `route` is the same word for the same thing and the
bridge copies it across; `client.headers` is the transport's `headers`, same
bytes; the principal is the same object, resolved once by the transport, frozen,
and handed on.

**Where they deliberately differ, and why.**

- **`system`.** A `@system` column is written by the application and refused when
  a caller's payload names it. A hook that DERIVES one had nowhere to stand: it
  shapes `ctx.data`, and the write happens downstream on the caller's own client,
  so the derived value reached the boundary indistinguishable from one the caller
  sent — every customer create over HTTP in `example` was a **403** (`FJS-644`).
  `ctx.system.add('col')` names it for THIS CALL; `systemFields(ctx)` in
  `core/litestone.ts` is the one reader, called at each of the five derived write
  args. A Set rather than a list one hook assigns, and `readonly`, because
  `before.all` and `validated.create` each legitimately derive their own column
  and an assignment from the second silently drops the first's. Naming a column
  widens one call and never the model; an empty set is not *all*; `@guarded` gets
  no equivalent by design (`FJS-D178`).

- **`query`.** On the transport it is the search string as it arrived, `$limit`
  and all. On a service the bridge has split it into `query` (filters — becomes
  the WHERE) and `directives` (`{limit, offset, orderBy, select}` — shape).
  No `$`-prefixed KEY survives the bridge (Invariant 10 — the rule is about the
  prefix on a parameter name, not about `$` the identifier). Conflating the two is what
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

Propagation rides an `AsyncLocalStorage` store, so nothing is threaded and no
caller is rebuilt. A call whose principal *differs* re-scopes — which is what
makes a sub-call issued as somebody else pass **that** principal to its own
children rather than the request's.

**The static server serves a FILE inside the root, not a path that looks like
one.** `sanitizePath` refuses `..` and a NUL byte — the whole of what a URL can
say — and a symlink inside the root said the rest, serving anything on the disk
with a 200 (`FJS-746`). The resolved path is compared against the root's, the
root resolved once and the file every request, since a link can be repointed
under a running server. It answers **404** rather than 403, because a 403
confirms the caller found a way out; the operator gets the warning instead, and
`allowOutside` is how a shared assets directory is published on purpose. An
EMPTY root is exempt — `ctx.file(path)` names a file the app chose and there is
nothing for it to be inside of.

**The client's address is DECLARED, not discovered.** `X-Forwarded-For` is a
list the caller can start and nginx appends to, so the leftmost entry is their
claim and the rightmost is what the nearest proxy observed —
`transport/forwarded.ts` reads the chain `[...x-forwarded-for, socket]` from the
RIGHT, and how far back to believe it is `http.trustProxy`: `false` (socket
alone), `true` (one hop, what the shipped nginx template is), `<n>` hops, or a
list of trusted proxies by address or CIDR. Both directions are a real failure
and neither is visible from the other — reading the leftmost hands the rate
limiter its key to the caller, and leaving it unset behind a proxy gives the
whole internet one bucket, which is what every deployed app had, because the
option existed on the transport and reached it from no config key at all
(`FJS-744`). A CIDR list only works if `::ffff:10.0.0.1` is read as the v4
address it is, which is what a dual-stack listener reports.

**A trace is CARRIED and never emitted.** `traceparent` and `tracestate` ride
`RequestMeta` verbatim and unparsed: junction traces nothing itself, and what to
do with the header belongs to whoever continues the trace — a parse here would be
a second reading of the spec beside theirs. It is there because without it an
outbound call has nothing to hang off and every one this process makes is the root
of an unrelated trace; conduit's plugin is the first reader (`FJS-742`).
`tracestate` is not decoration — a vendor's own position in the trace lives there,
so dropping it breaks the chain for that vendor alone.

**There are two stores and they are not interchangeable.** The REQUEST store
holds `RequestMeta` — who, where from, correlation id, idempotency key, and the
caller's `traceparent`/`tracestate` where they sent one — and is
opened by `enterRequest(src, fn)`, which is its one owner: five entry points
establish a request and each used to build the meta by hand, which is how the
socket path came to wrap nothing at all for its whole life and the test harness
came to drop `user` and `client`. `reenterAs(user, fn)` is the same request as
somebody else, carrying everything but the principal, and opening nothing when
the principal in scope is already the one asked for. The CALL store holds the
`ServiceContext` itself and is `$`, below.

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

### `$` — the call you are inside

`$` is the `ServiceContext` of the call in progress, read out of the call store
rather than taken as a parameter. `$.data`, `$.id`, `$.query`, `$.locals`,
`$.enqueue`, `$.afterCommit` — the whole context — plus `$.db` (`ctx.locals.db`)
and `$.me` (`ctx.auth.user`), which are the two an app reaches for most.

It exists because every service reached its caller-scoped client by digging it
out of the context, and every helper took a `ctx` parameter to carry it —
basecamp wrote `dbOf(ctx)`/`wsOf(ctx)`/`actorOf(ctx)` 251 times, with a comment
on the module saying it existed so the fact was stated once. The cost is not
verbosity: reaching for a module-level client instead writes as the system, with
the gate and every row policy gone, and nothing says so.

**Nothing shared with Invariant 10's `$`-prefixed keys but the character.**

Two rules make a surface this broad safe, and neither of them is smallness.

- **No invented keys.** Only junction's own contract properties can be assigned
  — `data · query · id · result · error · statusCode · dispatch`. So
  `$.dispatch = false` works and `$.myThing = 1` throws by name. What makes an
  ambient object dangerous is that anyone can keep state on it, not that it can
  be written at all; a fixed list cannot grow, so it is not a bag. Per-call state
  is `$.locals`, app state is `app.claim()`.
- **Call lifetime.** Outside a call it THROWS, naming the key and saying where
  `$` is legal. An ambient dependency is an undeclared one — `steps(id)` does not
  say in its signature that it needs a call — and the whole of what makes that
  acceptable is a failure that is loud, immediate and names itself. Answering
  `undefined` would trade a loud bug for a silent one, which is the trade this
  exists to reverse.
  **A call that has ENDED is outside it too**, and that half did not hold: an
  `AsyncLocalStorage` store propagates into every timer and microtask created
  inside a call, so a `setTimeout` scheduled from a hook found `$` answering the
  call it was scheduled from, thirty milliseconds after that call had resolved
  (`FJS-687`). `enterCall` marks the context over when it settles — on a
  `finally`, because a call that threw is just as over — and the refusal names
  the call and points at `afterCommit` and `enqueue`. **The marker is on the
  CONTEXT**, which is per call: on the store or the service it would make an app
  work exactly once. The span still covers the `afterCommit` drain, which runs
  inside `_callService` and is the control that keeps the marker from being set
  too early.

**A captured `$.db` is still the client, and litestone is not where that is
fixed.** `db.$transaction(fn)` hands the callback **the same object** — `tx ===
db`, measured — because every scoped proxy passes itself, which is what makes
`asSystem().$transaction(…)` keep its scope. So there is no settled proxy to
refuse writes on, and refusing them would refuse every write an app makes after
any transaction. What was actually wrong is that `transactionScopeHook` left
`ctx.locals.db = tx` assigned; it restores the request's own client in a
`finally` now, so anything reading it after the commit gets a working
non-transaction client rather than what a reader believes is the transaction.

**Resolved on every property read, never snapshotted.** `transactional:` assigns
`ctx.locals.db = tx` before running the method, so a captured value is the wrong
client and every write in the method would commit outside the transaction.

**The span is the whole of `_callService`** — method policy, idempotency claim,
pipeline, announcement, `afterCommit` drain, outbox handoff. Everything that
semantically belongs to the invocation, which is why an effect queued with
`ctx.afterCommit` can still read `$`. A nested call runs it again with its own
context. A replayed idempotent call returns before any of it and runs no user
code, so it is owed nothing.

**It is a second store on purpose, not a widening of `runInServiceCall`.** That
one holds the service NAME and is read by litestone's write tap to suppress a
double announcement, so widening it to this span would stop a write inside an
`afterCommit` effect from being announced at all. `tests/call-scope.test.ts`
asserts the narrow store is already closed by `afterCommit`, so a later merge
fails loudly.

**`$.db` is typed as junction's `LitestoneClient`**, which is a deliberate
minimal stand-in for the surface this adapter uses — it knows neither `exists()`
nor what a row of any particular model looks like. An app that owns a schema owns
that cast, in one place (basecamp's `db()`).

**`$` throws in a `*.job.ts` handler**, and that is correct rather than missing.
A job's `ctx` is Caravan's, not a `ServiceContext`, and a job wanting the
database should go through a service — which is where the gate, the policies and
the announcement are. `app.principal()` is what a job asks for the caller.

**`enterCall(ctx, fn)` is the escape hatch, and it is exported.** `callService`
opens the scope for every ordinary path — HTTP, a socket frame,
`app.service(x).find()`. What it does not cover is a hand-built context calling
a method as a plain function, which several suites here do
(`tests/populate.test.ts`, `tests/real-litestone-client.test.ts`); those pass
because `createBaseService`'s CRUD reads the ctx PARAMETER, and a method reading
`$` would have no way in at all. It nests and restores, so a direct call inside
a real one leaves the outer scope as it found it. Also on
`@frontierjs/junction/testing` beside `testCtx`, which is the thing that
produces the context it needs.

`tests/call-scope.test.ts` runs all of it, including the leaks: 25 concurrent
calls each seeing only their own, a nested call not overwriting its parent's
`locals`, and a throw leaving no scope standing.

### Work that outlives the request

A job, a retry, a scheduled sweep runs after the store is gone, so it has no
principal at all — and no principal is STRANGER(0), refused by the model's own
`@@gate`. Two members answer it, and neither is Caravan-specific:

- **`app.principal()`** — who is in scope, asked from somewhere holding no `ctx`.
  Read when work is *enqueued*, to record who asked.
- **`app.runAs(userId, [{ tenant }], fn)`** — opens a scope for a principal **re-resolved now**,
  through `IAuth.sessionFor(userId)`. Inside it, `auth` propagates as it does
  anywhere else, so `fn` makes ordinary service calls that name no principal.
  `null` means the app's own `createApp({ system })`; an app declaring none gets
  `null` rather than an invented identity.

**`{ tenant }` is the other half, and it is a second argument because it is a
second fact: WHO is re-resolved and WHERE is stated.** It rides `RequestMeta`, so
`withTenantDb` picks it up with no extra plumbing and `membershipClaim` falls
back to it when `tenantFrom` finds no header — the membership row is still READ
for that actor and that tenant. Storing a tenant is not the captured privilege
storing a session would be: an id names WHICH ROWS, and the standing that decides
what may be done with them is the re-resolved principal. Absent inherits the
tenant in scope; `{ tenant: null }` is work that belongs to none.

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
