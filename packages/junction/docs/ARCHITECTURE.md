# Junction — Architecture

_Junction-internal design notes. Verified against the tree on 2026-08-01._

Scope: how Junction is put together and why. It does **not** describe package
status, release state, or any other package's API — those rot fastest and are
owned elsewhere:

- `../../HANDOFF.md` — current state + the numbered issue ledger
- `../../CLAUDE.md` — the monorepo map and the cross-package bridge index
- `../../DECISIONS.md` — dated rulings; authoritative for semantics
- `README.md` — the user-facing guide, including the file tree
- `CHANGES.md` — what changed in the 2026-07 pass and why

Anything here that contradicts the code is a bug in here. `../../VERIFYING.md`
is the method: run it, don't trust it.

---

## The pipeline

```
Transport (HTTP / WS / internal)
  → bridge.toContext()          ← normalise to ServiceContext
  → callService(svc, ctx, appHooks)
      → around hooks
      → before hooks
      → method (Litestone-derived or custom)
      → after hooks
      → (error hooks on throw)
      → announce once: app.events + declared channels
  → ServiceResult envelope
  → bridge.toResponse()
```

`bridge.toContext()` / `toResponse()` are the transport↔service boundary.
Nothing above the bridge touches `req`/`res`; nothing below it knows what HTTP
is. `callService` is the single announcement point — a mutation is published to
the in-process bus and to declared channels from one place, not from two hook
chains that drifted.

---

## ServiceContext (v6 — canonical)

`ctx.params` — an open `{ user, headers, ip, [key]: unknown }` bag that
propagated wholesale into sub-calls — was **deleted** and split into four typed
fields with explicit propagation rules. This kills the FeathersJS
shared-mutation footgun (their issue #562, unfixable there due to ecosystem
lock-in). Junction is pre-alpha; it was done in one breaking pass.

Defined in `src/core/context.ts`. `src/transport/bridge.ts` re-exports the
types, so older `from '.../transport/bridge.ts'` imports keep working.

```typescript
interface ServiceContext {
  // routing / inputs
  service; method; type; transport; model; id; data

  query:      Record<string, unknown>  // FILTERS ONLY → the WHERE clause
  directives: QueryDirectives          // { limit, offset, orderBy, select, … }

  auth:   { user: SessionContext | null }   // identity ONLY. frozen.
                                            // PROPAGATES (deep-cloned)
  client: { ip?; userAgent?; headers; … }   // caller env. read-only.
                                            // propagates. {} internal
  route:  Record<string, string>            // path captures ({id}/{room})
                                            // router-only; {} internal
  locals: ServiceContextLocals              // per-call scratch. FRESH {}
                                            // every call. does NOT
                                            // propagate (kills the bug)

  // app / lifecycle / internals
  app; result; error; statusCode?; dispatch?; $raw; telemetryId?; _cleanups?
}

interface ServiceContextLocals {
  paginate?: { limit; offset; … }
  [key: string]: unknown   // plugins augment via `declare module`
}
```

Migration map (every old `ctx.params.X`):
`.user`→`ctx.auth.user`; `.headers`→`ctx.client.headers`;
`.ip`→`ctx.client.ip`; `.db`→`ctx.locals.db` (litestone augments the type);
`.paginate`→`ctx.locals.paginate`; path params→`ctx.route.X`;
`__channels`→`ctx.locals`; any ad-hoc hook stash→`ctx.locals.X`.

**A `TransportContext` says `ctx.route` too.** It was `params` for a while — the
router's path-param `Record<string,string>`, always a separate thing from the
killed bag — but keeping the WORD meant the Feathers idiom kept arriving and
finding a field of that name holding something else, which is how a role check
reads `undefined` and passes for everyone. One word per realm now
(`app.get('/x/{id}', ctx => ctx.route.id)`); Sierra says `page.params`. Ruled as
`FJS-D03`. Patterns are `{id}`; a `:id` segment is treated as a literal and
never matches.

### `query` vs `directives`

Settled 2026-08-02 (DECISIONS.md). `$` is **transport syntax only**.

- On the wire: `?status=open&$limit=10`
- `parseDirectives` in `src/transport/bridge.ts` splits them — and is the only
  place that reads a `$`
- Past the bridge: `ctx.query = { status: 'open' }`,
  `ctx.directives = { limit: 10 }`
- Internal callers set directives directly, under the `directives` key:
  `app.service('posts').find({ status: 'open' }, { directives: { limit: 10 } })`
  — a flat `{ limit: 10 }` is not a directive and is silently ignored

Conflating the two is what made `?limit=1` a filter on a column named "limit"
(zero rows, no error) while `?$limit=1` did nothing at all.

`RESERVED_PARAMS` (`src/core/context.ts`): `$limit` `$offset` `$orderBy`
`$select` `$populate` `$search` `$withDeleted` `$onlyDeleted` `$first` `$wrap`.

### Request-wide metadata (AsyncLocalStorage)

Correlation id / idempotency key / locale belong to the **whole request**, not
any single call. They ride an `AsyncLocalStorage` store the bridge wraps the
pipeline run in — NOT hand-threaded through `CallOptions`, which would be the
Feathers footgun reborn: one forgotten call site silently breaks the trace.

```typescript
import { requestMeta } from '@frontierjs/junction'
const meta = requestMeta()   // { correlationId, idempotencyKey?, locale?, origin }
                             // — readable at ANY call depth, never passed
```

The HTTP crud handler builds `RequestMeta` from headers (`x-request-id` →
correlationId, `idempotency-key`, `accept-language` → locale) and wraps the
pipeline in `runWithMeta(...)`. Test helper: `withTestMeta(partial, fn)` in
`@frontierjs/junction/testing`.

### Internal-call signature (`CallOptions`)

`app.service('x').<method>(...)`'s second arg is a closed, typed `CallOptions`
— only what you VARY per call. No open index signature, so nothing mutable
leaks unnamed.

```typescript
interface CallOptions {
  auth?:       { user: SessionContext | null }   // default: system (null)
  transport?:  'http' | 'websocket' | 'internal' // default: 'internal'
  locals?:     Partial<ServiceContextLocals>     // rare; e.g. shared tx
  directives?: QueryDirectives                   // limit/offset/orderBy/select
}

await app.service('orders').get(id, { auth: ctx.auth })   // propagate identity
await app.service('audit').create(data, { auth: ctx.auth })  // correlationId
                                                             // rides ALS
```

`patch`/`update`/`remove` reject a null id **and** null query. Query rides arg
1, never opts.

### Key invariants

- `ctx.result === null` in before hooks; populated in after hooks
- `ctx.type` must be preserved through the pipeline
- `_method()` bypasses Junction hooks only — **not** Litestone gates
- `db.asSystem()` grants Litestone level 8 — bypasses `@@gate`, all
  `@@allow`/`@@deny` row policies and field-level `@allow`, and reveals
  `@guarded`/`@encrypted`/`@secret`. Seeding, migrations, and any path with no
  user context

---

## The result envelope

One module, one owner: `src/core/envelope.ts`. `wrapResult()` /
`unwrapResult()` / `isServiceResult()`.

```typescript
interface ServiceResult<T> {
  kind:    'single' | 'list'   // ← THE discriminant. Branch on this.
  object:  string              // the service — 'posts', not 'Post', not 'list'
  data:    T
  errors:  unknown[]           // partial failures on bulk writes; [] otherwise
  total?; limit?; offset?      // list only, and only when the source paginated
}
```

`kind` exists because detection used to be `'object' in value`, which is true
of any record with a column called `object`. Do not reintroduce that check, and
do not treat `object === 'list'` as the discriminant — `object` names the
service in **both** kinds.

Rules, identical everywhere: **a list keeps its envelope; a single unwraps to
the record.** HTTP `$wrap=true` opts a single into the envelope; `$wrap=false`
unwraps everything, lists included. The browser client's `find()` returns the
list envelope (`findData()` for rows only) — it used to return a bare array,
which is why `total` was reachable from curl and from nowhere else.

The July password leak came from the same root: `protect()` stripped fields off
the wrapper instead of the record, because "the result" meant two different
things in two files.

---

## Litestone integration

`src/core/litestone.ts` is the whole Data-boundary seam.

- **`withLitestoneDb(db)`** — around hook; puts a caller-scoped (`$setAuth`)
  client on `ctx.locals.db`. Auto-installed by `createApp({ db })`. Scoping
  happens here, once, so both service factories get a scoped client —
  previously `createBaseService` ran unscoped and row policies silently matched
  nothing
- **`gateAuth()` + `autoValidate()`** — schema-derived 401s and 400s for
  model-backed services. Merged in via `createBaseService`;
  `createService({ model })` forwards hooks so the derived layer survives
- **`accessorCandidates()`** — resolves `model Post` ⇄ service `posts` ⇄
  accessor `db.post`. Used by the query, the gate, **and** validation, so a
  naming slip can't silently disable one of the three
- **`sessionGateLevel(user)`** — maps a `SessionContext` onto Litestone's 0–7
  scale; pass to `GatePlugin({ getLevel })`. Litestone's own default grades a
  shape Junction does not produce, so this must be wired explicitly:

  ```
  isSystemAdmin → 7   verifiedAt === null  → 1 (VISITOR)
  isOwner       → 6   activatedAt === null → 2 (READER)
  isAdmin       → 5   otherwise            → 4 (USER)
  no user       → 0
  ```

  `undefined` means the app doesn't model that stage (not an objection);
  `null` means it does and this user hasn't reached it
- Adapter details: `findManyAndCount` single-trip pagination; `offset`/`limit`
  (not skip/take); `restore()` → `table.restore()`, by id and by filter alike —
  it already takes a multi-row where;
  `$withDeleted`/`$onlyDeleted` honoured on `find` **and** `findFirst`;
  `$search` → `table.search()` for FTS5 models

Dependency direction is one-way: Litestone ← Junction. It is wired by an
optional peer dep (`^1.1.0`) plus dynamic import, not a hard dependency —
Junction runs without Litestone, and model-backed services are the part that
needs it.

---

## Real-time

Declared, not hand-wired. A service says where its mutations go:

```typescript
createService({
  name: 'posts',
  channel: 'posts',                                // a channel name
  // channel: (rows, ctx) => app.channel(`w:${…}`)    dynamic target
  // channel: false                                   declared opt-out
})
```

`callService` announces a write **once** and fans out to both the in-process
bus (`svc:created`) and the channel (`svc created`). Off unless declared — the
same split Feathers has between its core (publishes nothing) and its generator
(writes a publisher). `fli make:*` scaffolds declare it, so a generated app is
live out of the box.

**A custom method announces too, under its own name** — `orders pay`, not a
past tense invented for it. It is a write: `db.order.transition(id, 'pay')`
changes the row exactly as a patch does, and the browser client's `*` handler
has always upserted any non-CRUD event. Only `find` and `get` are excluded, by
name. A method that merely READS (search, stats, export) is
indistinguishable from one that writes at this layer, so it opts out with
`ctx.dispatch = false` — the same one switch that suppresses any other
broadcast, and it suppresses both consumers.

*Until 2026-08-06 only the five CRUD methods announced, so an action changed a
row and told nobody. Every app hid it by re-issuing `find()` afterwards, which
made the acting tab look right and left every other tab stale in silence. Found
by `example/web/test/verify-live.mjs` — a watcher tab that never acts.*

Channels and presence live in `src/transport/channels.ts` and
`src/transport/presence.ts`: server-controlled membership,
`presence:sync/join/leave/update`, `app.presence()` / `app.presenceOf()`, and
server-driven liveness — the server pings an idle socket every 15s and evicts
one that has sent nothing for 40s. Any frame answers it; the client replies to
the ping from its message handler, so an app calls nothing and a backgrounded
tab (whose timers are throttled to ~1/min) stays connected.

**Still open:** Litestone's `onEvent` has zero Junction subscribers — writes
made directly through the db client, not through a service, announce nothing.
Needs a post-construction subscribe mirroring `$tapQuery`.

---

## Subsystems

**Built-in hooks** — `src/core/hooks-builtin.ts`: `authenticate`,
`requireRole`, `paginate`, `protect`, `allow`, `timestamps`, `logTiming`.
`src/core/hooks-resilience.ts`: `circuitBreaker`, `rateLimit`.

**Custom methods** are defined directly alongside CRUD on the service object —
any extra function-valued option. Dispatch is via the `X-Service-Method`
header, whitelist-only: built-ins (`restore`, `upsert`) and custom methods
match, CRUD names are blocked from override, and case is preserved so a
camelCase method isn't a guaranteed 404. They are METHODS and there is no
second noun for them — `DECISIONS.md` § Naming & vocabulary, `FJS-D02`.

**Config** — `createApp()` with no args reads `api/config/junction.config.js`.
Sections: `app`, `middleware`, `plugins`, `services`, `conduit`, `caravan`.
`app.start()` deep-merges `loadConfig(...)` with `opts.config` so `opts` wins
at the leaf and nested blocks aren't clobbered. `apiPrefix` defaults to `''`.

**Env** — `defineEnv(spec)`, typed output, required vars throw at startup.
Types: `string`, `number`, `port`, `boolean`, `url`, `json`. Weak-secret
detection in production. `generateEnvExample` / `printEnvExample`.

**Telemetry** — `app.telemetry` emits `junction.call.start/end`,
`junction.hook`, `junction.ws.connect/disconnect/message`,
`junction.channel.publish`, `litestone.query`; all correlated by
`ctx.telemetryId`. Set by `callService`, undefined for bypass (`_find` etc.).

**manifestPlugin** — `src/plugins/manifest/index.ts`, mounts in `register()`
(early enough that routes and services added in `boot()` are still visible).
Reads `db.$schema` (the already-parsed AST, no file read) and Litestone
`status()` for migration state.

**Plugin protocol** — `{ name, register, boot, ready, shutdown }`. How
caravan / conduit / auth / notifications attach. Verified behaviour, 2026-08-02:

- **Phase order** is `register` for every plugin, then `boot` for every plugin,
  then `ready` for every plugin; `shutdown` runs in reverse registration order.
  Measured: `A:reg B:reg A:boot B:boot A:ready B:ready B:down A:down`.
- **`register()` runs synchronously inside `configure()`**, so it can add routes
  and middleware before the router is built. An async `register` that rejects is
  recorded and rethrown by `start()` — a half-registered plugin must not boot.
- **Which failures are fatal:** a throw in `register` or `boot` fails
  `start()`. A throw in `ready` is logged to `console.error` and the app starts
  anyway. **Put anything that must succeed in `boot()`, not `ready()`.**
- **Dependency checks belong in `boot()`.** `app._plugins` holds the configured
  plugin names, but during `register()` it only contains plugins configured
  *before* yours (register runs as each is configured); by `boot()` it is
  complete.
- **Duplicate names are not deduplicated** — configuring the same plugin twice
  registers it twice.

**Attaching to `App` — augment, never redeclare.** Each plugin surface is an
empty interface Junction exports, plus an optional field pointing at it:
`AppConduit`/`conduit`, `AppJobs`/`jobs`, `AppNotify`/`notify`. The plugin adds
its real shape by declaration merging:

```typescript
declare module '@frontierjs/junction' {
  interface AppNotify { (user: User, n: Notification): Promise<void> }
}
```

Junction keeps no dependency on the plugin, and an app that never installs it
sees an empty interface rather than a lie — calling an unaugmented `app.notify`
is a `TS2349`, not an `any` that swallows the mistake.

Redeclaring the property instead (`conduit?: IConduit` in the plugin) is a
`TS2717` and the augmentation silently loses. Declaring a *parallel* `App` type
inside the plugin is worse, because nothing errors at all: that is how
notifications' `MailMessage` (`{subject, lines}`) came to disagree with
Junction's `IMail` (`{subject, html, text}`) with no compiler comparing them,
and every notification email shipped with an empty body.

**Cookies** — `ctx.cookies` parsed from the request; `ctx.setCookie(name,
value, opts)` queues `Set-Cookie`, applied in `_finalizeWithHeaders`.

---

## Standing conventions

- **Opt-out security:** CORS defaults to `[]`, helmet auto-applied, rate
  limiting opt-in
- **Zero coupling between packages:** cross-package coordination happens at the
  app layer, via hooks and the plugin protocol
- **`$tapQuery` requires explicit `stop()`** — queue it on `ctx._cleanups`
- **`ctx.app` is read-only on the hook context** — enables calling other
  services from hooks
- **Litestone `DateTime` fields take ISO-8601 strings**, not `Date` objects
- **Bun-native:** `Bun.serve()`, `Bun.connect()`, `Bun.gzipSync()`,
  `bun:sqlite`, `node:async_hooks`
- **Model naming:** PascalCase singular in the schema; the accessor is that
  name camelCased **verbatim** (`model User` → `db.user`; not pluralized or
  singularized). `accessorCandidates()` does the resolution

---

## Known issues

- **Shutdown always waits the full drain window when a WebSocket is open.**
  `app.stop()` races `http.stop()` against `config.http.drainTimeout` (default
  5s). Bun's `stop()` without force never closes WebSockets and a long-lived
  socket never drains on its own, so the race always falls through to the
  timeout: measured 5004ms with one open socket, 0ms with none, and exactly
  250ms when `drainTimeout` is set to 250. Nothing is lost — it is a stall, not
  a hang — but every restart with live clients pays it, and clients get no
  close frame. The fix is to close WS connections explicitly before draining.
- **`config.http` is not `Partial`.** Overriding one field means restating the
  whole block, so `http: { drainTimeout: 250 }` is a type error; you need
  `http: { ...defaultConfig.http, drainTimeout: 250 }`.
- **Litestone `onEvent` has no Junction subscriber** (see Real-time above)
- **Hook context shape differs across realms.** Junction's split
  (`auth`/`client`/`route`/`locals` + `query`/`directives`) is the candidate
  standard, not yet adopted repo-wide
- **`bun run typecheck` reports 214 errors.** An accepted baseline, not a
  target — treat it as a ratchet. Mostly `Record<string, unknown>` cast noise,
  but it is not all noise: the presence bug below sat in here for its whole
  life as a `TS2552`. Sweep real identifier/property errors (`TS2552`,
  `TS2339`) before the casts. There is no repo-wide tsconfig, so cross-package
  type declarations are never checked (Junction and Conduit declare
  `app.conduit` with conflicting types, silently).

### Fixed 2026-08-02

- **Presence was entirely non-functional.** `channels.ts` referenced a bare
  `presence` identifier that does not exist in that module (the tracker is
  `_presence`; its Map is private to `presence.ts`), so `presenceOf()` and
  `_presenceGet()` threw `ReferenceError` on every call — and `_presenceGet()`
  is on the WS `subscribe` path, whose errors the transport swallows
  (`try { … } catch {}` in `transport/http.ts`), so the only symptom was
  `presence:update`/`presence:sync` never arriving. `presence.ts` now owns the
  lookups (`get`, `byUser`) and `channels.ts` delegates. Covered by
  `tests/presence.test.ts` (11 tests), which were confirmed to fail against the
  old code.
- **`/metrics` service detail was fabricated.** It read `svc.actions` (no such
  key — custom methods are copied straight onto the service) and `svc.allowBulk`
  (never carried onto the built service), so every service reported
  `actions: []` and `allowBulk: false`. Both plausible-looking values, which is
  why it survived. `/metrics` now uses `customMethodNames()` — the same
  predicate as manifest and OpenAPI — and `allowBulk` is carried on `Service`.
  Covered by `tests/metrics-service-details.test.ts`.
- **`tests/changes.test.ts` leaked a stubbed `global.fetch`.** It replaced it a
  dozen times and never restored it; Bun shares one process across files, so
  every later file doing a real `fetch()` silently got a canned response. Now
  snapshotted and restored in `afterAll`.

Current: `bun run test` → 703 pass / 0 fail across 21 files.
