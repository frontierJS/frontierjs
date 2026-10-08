# Junction internals — why the code is shaped this way

The trap write-ups behind `CLAUDE.md`, grouped by the path each one guards, moved
verbatim. A trap the `api-hazards` or `bridge-index` skill already carries is there
and not here. Read the section for a path before changing code under it.

## `src/client/` — the browser client

- **A reconnect is a GAP, by construction, and it was a silent one.** The server
  queues nothing for an absent socket, so every write between a drop and the
  next `connected` frame reached this client and nobody else's copy of it — and
  `resource.stale`, which exists to count exactly this, read 0 with nothing on
  screen saying anything was missing (`FJS-701`). The client emits `reconnected` on
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
  whole feature compiles and types nothing. `test/client-types.test.ts`
  compiles a fixture with `tsc` because no runtime assertion can see any of this.
- **A 401 keeps the server's own sentence.** `_request` used to throw
  `Unauthorized` before reading the body, so `Invalid credentials` never reached
  a caller — which is most of what a hand-written sign-in page was doing when it
  re-mapped the status itself.
- **A push is also PLACED, and a page past the first refuses one.** `orderBy`
  decides where the row goes (`core/query-values.ts`, which is `parseSort` — one reading
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

## `src/transport/channels.ts` · `presence.ts` — sockets, presence and the broadcast

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
- **A WS token that is PRESENT and does not verify closes the socket 4001; no
  token stays anonymous** (`FJS-702`). `_wsOpen` swallowed the throw, so a
  revoked, expired or forged session held a socket for its whole life, the
  browser client's `4001` no-reconnect branch was dead code, and the plugin's own
  doc comment promised an `auth_failed` message nothing ever sent. The close is
  before `open` runs, so nothing joins a channel and no `connected` frame goes
  out. A caller who claimed nothing is a different answer from one whose claim
  was rejected — do not collapse the two.
- **A broadcast is GRADED per recipient** — the cohort, the measurements and
  `toDataPrincipal` are the `bridge-index` skill's entry; what follows it does not carry.
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
- **A service broadcasts through `channel:` OR the `announce()` hook, never both.**
  `svc.pipelines()` refuses the pair, naming the method — it is the one place the
  full effective chain is known, so an app-level `after: { all: [announce(…)] }` is
  caught as well as a service-level hook. The check matches **marked** hooks, not
  names: an app may call its own hook `announce`, and suppressing a real one on a
  name collision would silently stop broadcasting (`FJS-045`).
- **`channel:` takes three shapes.** A string names the channel, `false` is the
  declared opt-out (from `announceDefault` too), and a function `(data, ctx) =>
  app.channel(…)` picks the target per write — the shape for a workspace or a
  room, where the name is on the row.
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

## `src/transport/http.ts` · `router.ts` · `body.ts` · `static.ts` · `middleware.ts` · `bridge.ts` — HTTP

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
- **A route can be registered once. A second registration throws, naming it.**
  Keyed on the route's SHAPE, so `/a/{id}` and `/a/{name}` are the same route —
  the param name is read by the handler and by nothing that matches. Silence
  there makes which copy survives depend on the path: a FIXED path is
  overwritten in `build()` so the LAST won, a DYNAMIC one is scanned in order so
  the FIRST won and the later handler never ran. Doubled CORS is what surfaced it
  (`FJS-225`); the refusal covers any plugin claiming a path another owns.
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
  at the top level; a ServiceContext splits caller facts into `ctx.caller`. That
  one-line gap is what grew a third limiter inside `@frontierjs/auth`, whose
  comment blamed `ctx.params.ip` — a field a ServiceContext does not have. The
  hook reaches `auth` optionally for the same reason: a sign-in route has no
  principal, because signing in is what produces one.
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
- **The HTTP and WS paths build their context separately** — `bridge.toContext()`
  vs `bridge.internal()` — so anything one derives from a request the other must
  lift out of the frame by hand, and a difference is silent because the browser
  client falls back to HTTP whenever no socket is up. `ctx.id` is normalized to a
  string on both (FJS-197) because a path segment cannot be anything else, and
  request metadata (`requestMeta()` — correlation id, idempotency key) is
  established on both, which it was not: the WS path wrapped nothing in
  `runWithMeta`, so anything reading it applied to half the transports.
- **A query string is PARSED, and a WS frame is not** — the rule is the `api-hazards`
  skill's; two consequences it does not state:
  - **A raw route reads the parsed query too**, so a value that looks numeric
    arrives as a number. An id is text whatever it looks like — `String()` it.
  - `$` keys are still present on a transport context; splitting those off is
    the service boundary's job (`splitParams`), not the transport's.
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
- **Security is opt-out and CORS is the exception.** `cors.origins` defaults to
  `[]` and `'*'` is never applied for you. Helmet headers are on unless
  `http: { helmet: false }`, and the DDoS gate and the rate limiter are off
  until configured.

## `src/core/app.ts` · `config/index.ts` · `diagnostics.ts` — lifecycle, config, plugins

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
  `_readinessApp`'s argument (`FJS-414`) applied to a second fact. It is
  false for the whole life of a running app, which is what keeps
  `_finalizeWithHeaders`'s no-op fast path intact.
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
- **A top-level key in `junction.config.js` reaches the app only if `loadConfig`
  MAPS it.** `app`, every `middleware` key and `plugins` map onto `AppConfig`;
  everything else is stashed under `config._junction` for whichever subsystem
  owns it. So a block nobody looks up is read by nothing, silently — an app
  writes it, the app boots, and the feature is simply off (`FJS-431`).
  `attachments` is mapped straight through; anything new needs the same line, and
  reading a fallback in the consumer instead is a second answer to where the
  block lives. **Eleven keys were in that state at once** (`FJS-1066`), which is
  why `test/config-surface.test.ts` now reads both interfaces off their source
  and fails a key added without a behavioral row.
- **`junction.config.js` DECLARES, `app.configure()` CONSTRUCTS, and what the
  option TAKES decides which** (`FJS-D256`). Data is declared — `middleware:`
  normalizes onto `config.http` and installs in the `config-middleware` phase,
  `plugins:` onto `config.plugins` in `config-plugins`. Code is constructed:
  `channels(cb)`, `authPlugin`, `backfills(defs)`, and any plugin whose options
  hold a function — `health.checks`, `health.authFn`, `manifest.db` are the three
  that exist. **A plugin declared in config AND configured by hand is refused by
  name at `start()`**, so an app needing one of those three declares it nowhere.
  `manifest.db` is not a gap where there is one client, since a config-installed
  manifest is handed `app.db`; under `tenancy { strategy database }` there is no
  single client and manifest goes back to being code, which is what `example`
  does.
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

## `src/core/service.ts` · `hooks.ts` · `idempotency.ts` — the call and its pipeline

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
    included, so an `after` hook doing network I/O serializes every write in the
    app behind it. Off by default for that reason, and the same reason
    irreversible work belongs in Caravan.
  - Two orderings carry it and both already held: `withLitestoneDb` is an
    APP-level around hook so it runs OUTSIDE this one (the transaction opens on
    the caller-scoped client, so row policies and `auth()` survive), and the
    announcement happens after `runPipeline`, so the lock is released before
    anything fans out to a socket.
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
- **An `Idempotency-Key` runs a mutating call once** — the claim and the replay are the
  `api-hazards` skill's; the two refusals are here.
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
- **A `gate:` on a CRUD verb is graded only over no model** (`FJS-D408`). There
  it is the only grade the verb can have, and `gateAuthAround` enforces it as a
  custom method's; over a model it is refused, since `@@gate` owns that verb —
  at construction where `model:` is stated, at the first call where the model is
  reached through the service's NAME, which only a client in hand can tell.
- **`ctx.data` is a row OR an array of rows, and a hook that forgets the second
  is silent.** Bulk create sends the array. `timestamps()` set `created_at` and
  `updated_at` as properties OF THE ARRAY — so every row of every bulk create
  went in with no timestamps — and `allow()` filtered nothing on the same shape.
  Narrow with `Array.isArray` and map; both now do.
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

## `src/core/envelope.ts` · `errors.ts` — the result and the error

- **A stream is not a result and `wrapResult` refuses one by name** (`FJS-D13`).
  `Response`, `ReadableStream`, anything with `getReader`, an async iterable. It
  used to wrap them, and both a Response and a ReadableStream have no enumerable
  own properties — so a method returning one answered `{"kind":"single","data":
  {}}`, an empty object with a 200 and the stream destroyed. **`kind` stays
  two-valued**: a third value is branched on at ten sites and lands in every one
  as *not a list*. Each FRAME is a result and the stream is not — which is why
  `announce()` is an after-hook (a pushed frame IS `ctx.result`, already through
  `protect()`) and why `ctx.sse()` on a raw route has no hooks, no `gateAuth` and
  no field protection: right for a heartbeat, wrong for records.
- **`kind` is the envelope's one discriminant.** `object` names the SERVICE in
  both kinds (`'posts'`, never `'list'`), so `object === 'list'` is never true
  and `'object' in value` is true of any record with a column called `object`.
  Branch on `kind`. On the wire `$wrap=true` opts a single into the envelope and
  `$wrap=false` unwraps everything, lists included.
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

## `src/core/litestone.ts` — the Data adapter, the principal, tenancy

- **Litestone is an optional peer reached by dynamic `import()`, and junction
  runs without it.** A static import anywhere under `src/` makes every
  modelless app fail at load — the adapter and the manifest plugin import it
  inside the function that needs it.
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
- **`sessionGateLevel` does not read `role`, and a test written against one
  grades 4.** A standing is `isAdmin`/`isOwner`/`isSystemAdmin` plus the two
  lifecycle fields; an app's own `role` column is not consulted whatever it
  says. `StubUser` carries all five now, written onto the session **only when
  stated** — absent means *this app does not model that stage* and only `null`
  grades down, so defaulting them would move the standing of every test that
  never mentioned one.
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
  and deferred work reaches a tenant through `app.runAs(userId, { tenant })`
  instead, where `membershipClaim` re-reads the membership (`FJS-384`).
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

## `src/core/context.ts` — the two contexts, the two stores, `$`

### Where the two contexts deliberately differ

The table is `CLAUDE.md` § The two contexts; `ctx.system` is the `bridge-index` skill's.

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
these behaves differently. `test/context-contract.test.ts` asserts all six by
running them, because none of it is expressible as a type — and one of them was
documented here for months while being false.

| Field | Rule |
| --- | --- |
| `auth` | WHO. **Frozen** — a hook mutating it throws rather than leaking into a sibling call. **Propagates**: a call naming no principal inherits the one in scope, at any depth. An explicit `{ user: null }` means *as nobody* and is kept — **absent is not null** |
| `caller` | WHERE FROM. Read-only, propagates. `{ headers: {} }` when there is no request. **Information, never authority** — nothing here grades a caller by it |
| `route` | Path captures. Router-only, `{}` on an internal call |
| `locals` | Per-call scratch. **Fresh `{}` every call, and it does NOT propagate** — a sub-service physically cannot reach its caller by writing to it. It CAN be handed down deliberately (`{ locals: … }`), which is the whole difference between passing and inheriting |
| `transients` | The `@transient` keys of this call's payload — accepted on the wire, stored nowhere. `autoValidate` validates them with the model's own rules and then MOVES them here, so the write never carries one. Fresh `{}` every call, does not propagate, and there is no seed option: this is input the caller sent, not scratch a hook keeps. A model declaring none leaves it `{}` |
| `reserved` | The query keys the SERVICE declared as its own — `reservedQuery: ['workspace_id']`. Same freshness, same non-propagation, same reason as `transients`. Lifted in **`callService`, before the pipeline** rather than in a hook, so `ctx.query` is columns alone for the app's own leading hook as much as for the derived `autoFilter` behind it, and a custom method — which runs neither — is covered on the same terms as `find`. A `$`-name is refused at construction (the directive table owns those); a name that is also a column is refused on first use, because the client is not known when a service module is imported |

Propagation rides an `AsyncLocalStorage` store, so nothing is threaded and no
caller is rebuilt. A call whose principal *differs* re-scopes — which is what
makes a sub-call issued as somebody else pass **that** principal to its own
children rather than the request's.

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

What `$` is, the assignable keys and `enterCall` are the `bridge-index` skill's entry.

It exists because every service reached its caller-scoped client by digging it
out of the context, and every helper took a `ctx` parameter to carry it —
basecamp wrote `dbOf(ctx)`/`wsOf(ctx)`/`actorOf(ctx)` 251 times, with a comment
on the module saying it existed so the fact was stated once. The cost is not
verbosity: reaching for a module-level client instead writes as the system, with
the gate and every row policy gone, and nothing says so.

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

**The span is the whole of `_callService`** — method policy, idempotency claim,
pipeline, announcement, `afterCommit` drain, outbox handoff. Everything that
semantically belongs to the invocation, which is why an effect queued with
`ctx.afterCommit` can still read `$`. A nested call runs it again with its own
context. A replayed idempotent call returns before any of it and runs no user
code, so it is owed nothing.

**It is a second store on purpose, not a widening of `runInServiceCall`.** That
one holds the service NAME and is read by litestone's write tap to suppress a
double announcement, so widening it to this span would stop a write inside an
`afterCommit` effect from being announced at all. `test/call-scope.test.ts`
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

`test/call-scope.test.ts` runs all of it, including the leaks: 25 concurrent
calls each seeing only their own, a nested call not overwriting its parent's
`locals`, and a throw leaving no scope standing.

### Work that outlives the request

A job, a retry, a scheduled sweep runs after the store is gone, so it has no
principal at all — and no principal is STRANGER(0), refused by the model's own
`@@gate`. Two members answer it, and neither is Caravan-specific:

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

## `src/plugins/` · `src/mail/` — devtools, webhooks, mail, files

- **The devtools console binds LOOPBACK, and off it `auth` is required whatever
  `NODE_ENV` says** (`FJS-691`). `Bun.serve({ port })` with no `hostname` is
  every interface, and the only guard was `NODE_ENV === 'production'` — unset in
  dev, unset in `staging`, unset in `test`, and unset is the common case. Every
  POST and the WS upgrade also check `Sec-Fetch-Site` then `Origin`: a
  `text/plain` POST needs no preflight, so a page on any origin could run a job
  by name (measured: `POST /api/jobs/run/send-invoices` from `Origin:
  https://evil` answered `{"ok":true}`). A request carrying NEITHER header is not
  a browser and is left alone, which is what keeps `curl` and the drives working.
- **A webhook registration is a destination somebody else chose, and every bound
  on it was missing** (`FJS-681`). Measured: a `role: 'user'` shopper POSTed a
  `*` subscription and got 201 with the signing secret; `169.254.169.254`,
  `localhost:8503` (the devtools job runner), `file:///etc/passwd` and the
  literal string `not-a-url` were all accepted as destinations; a 307 was
  followed with the signature re-sent; and a subscriber whose deliveries all
  died stayed active. **`manage` (default 5) is the standing**, graded with
  `sessionGateLevel` — 403 for a caller who is merely too junior and 401 for a
  stranger, which a client acts on differently. **`assertPublicUrl` (`core/public-url.ts`) is
  the destination**, an ALLOW-list of schemes plus a public-address check over
  every address a name answers with, run at registration AND before every
  attempt — a name that resolved publicly an hour ago can resolve to loopback
  now. A rebind BETWEEN the check and the connect is not closed and `public-url.ts`
  says so: it needs the socket pinned to the graded address, and `fetch` has no
  way to do that. `targets: { allowHttp, allowPrivate }` is the opt-out and the
  only thing in this repo that turns it off is the delivery suite, whose
  receiver is a real server on localhost.
- **A webhook subscriber is a principal, and it is read rather than stated**
  (`FJS-D193`). A delivery carried whatever the bus emitted — measured,
  `deliver('users:created', { …, password: 'hunter2' })` arrived in full
  (`FJS-724`). `FJS-631` one layer over, and `$readAs` does not carry across
  unchanged because a URL is not a principal. What makes it carry is that a
  REGISTRATION had one: the subscriber is READ from the principal in scope at
  registration, stored as an ID and re-resolved at every delivery — caravan's
  answer for a job, on a longer fuse. **Read and not stated is the security
  property**: `sessionFor` must never be wired to anything a request can name,
  and `manage` (5) is the bar for creating a registration, so a subscriber the
  registrant chose would make 5 the bar for receiving anything.
  **Three answers, and the line between the last two is the design**: *graded*;
  *ungraded* where grading was never APPLICABLE (no Data boundary, an event
  naming no model, a payload that is not a row), delivered with the floor and
  said once; *refused* where it was applicable and unanswerable — nothing sent
  and **no pending row**, because a payload nobody may read must not sit in a
  retry table for a day. `$protectedFields` is the floor on the ungraded path
  alone, by name at any depth; under grading it would be a second reading of a
  rule the boundary already applied. **ABSENT is not `null`** — a custom store
  that cannot record a subscriber answers `undefined`, which is *cannot say* and
  not *nobody*, and its deliveries go out ungraded saying so.
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
- **Junction owns no file store, and adding one back is the mistake to catch.**
  Litestone's `FileStorage` plugin is the single owner — the `File` column, the
  provider seam (local, r2, s3, b2, minio), `@accept`, `keyPattern`, cleanup —
  and junction's half is the CROSSING, in three places that are easy to mistake
  for a store: `transport/body.ts` parses multipart, `transport/bridge.ts` merges
  the files into `ctx.data`, and the client turns a `File` value into multipart.
  Serving the local provider's bytes is `http.static`, not a route. `FJS-D260`
  retired a second `createFileStorage` that lived here; it was a keyed blob store
  over local disk with no provider seam, nothing in the workspace called it, and
  the shared word made the two indistinguishable from a package header. What
  grows next belongs below: a PUT presign is `presignUrl` in litestone, and the
  junction-shaped half of it is a route that grades the caller and redirects.

## `test/` and the typecheck

- **The whole package must stay at zero, `test/` and `example/` included.**
  `index.ts` + `src/**` is what an app compiles (the `exports` map points at
  `.ts` and nothing emits `.d.ts`, so junction's own errors land in every app's
  `tsc` and editor — `FJS-268`), and there is no baseline left to hide behind:
  junction is absent from `scripts/typecheck-baselines.json`, which means 0.
  **The reason `test/` counts is not tidiness.** They are the only code here
  that uses junction the way an app does, so an error in one is an error a user
  gets — driving the last 138 to zero found eleven defects in the shipped types,
  including a custom method's `ctx` being an implicit `any` and
  `app.events.on('x', () => arr.push(n))` refusing to compile (`FJS-034`).
- **A cast in a test is a claim about the shipped type; read it before adding
  one.** The two that are legitimate here have one owner each in
  `test/helpers.ts` — `stubbable` (Bun's `typeof fetch` carries `preconnect`,
  so no plain stub is assignable) and `asRecord` (a key the type does not
  declare, which is Invariant 5 working). Anything else is usually the type
  being wrong.
- **Fake clients hide real bugs.** Cross-package behavior goes in
  `test/real-litestone-client.test.ts`, against a real client.
- **`ctx.result` must be `null`, not absent**, when hand-building a context in a
  test — `runPipeline` reads non-null as "a before hook already answered".
