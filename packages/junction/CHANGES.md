# Changes — @frontierjs/junction

## 2026-08-04 — the client's transport rule, actually applied

803 tests (was 796).

The documented rule is in this package's README: *"CRUD methods prefer WebSocket
when connected, fall back to HTTP automatically. File uploads always use HTTP."*
WebSockets are the default when one is available; HTTP is the fallback. Two
methods did not follow it, and the fallback had a hole with no bottom.

**`action()` and `restore()` were unconditionally HTTP.** `find`, `get`,
`create`, `patch` and `remove` all check `_wsReady` first; those two never did,
which made a custom action the only service call that ignored a live connection.
The WS handler dispatches any method name generically — it passes `method`
straight to `bridge.internal` — so there was never a reason for the exception.
Both now prefer the socket. `action()` also honours the file exception, because
multipart cannot travel over it.

**The HTTP fallback recursed forever.** `_httpFallback`'s `default` branch
called `svc.call()`, which is `_wsCall()`, which routes back to `_httpFallback`
when the socket is down. A custom action with no connection bounced between the
two indefinitely — asynchronously, so no stack overflow ever pointed at it and
the call simply never settled. The default branch now calls `action()`, the HTTP
form of a custom action, and `restore` gained its own case.

Seven tests in `tests/client-transport.test.ts`, half of them on the no-socket
path. Verified in `example/` over CDP as well: clicking a transition button with
the socket up sends `orders.pay` as a WS frame and makes **zero** HTTP POSTs.

The README's dispatch-by-header section said what the HTTP form looks like
without saying it was the fallback; it now says both.

## 2026-08-04 — autoValidate says the sentence the schema declared

796 tests (was 787).

`FieldDef` gains `label` and `messages`, read from JSON Schema `title` and
`x-messages`. Every generated message in `core/schema.ts` now consults the
authored wording for the keyword that failed, and builds its fallback from the
label rather than the column name.

The point is that Sierra's `field-rules.js` does exactly the same thing from
exactly the same document. If these two disagreed the user would get one
message before the request and a different one after it — worse than either
alone. `tests/field-messages.test.ts` and
`packages/sierra/tests/field-messages.test.js` are deliberately the same
fixtures and the same expectations.

Presentation is read off the FIELD's own schema, never a `$ref` target:
Litestone titles every enum `$def` with the type name, so following the ref
would make `status OrderStatus` report itself as "OrderStatus". `mapProp` is
now a thin wrapper that attaches label/messages from the raw property around
the existing resolver.

## 2026-08-04 — the startup banner reports the Data realm

787 tests (was 781). Additive; no behaviour change to any request path.

`createApp()`'s banner covered routes, services, health and docs, and said
nothing about the database. "Is Litestone actually loaded, and against which
file?" had no answer short of issuing a request and seeing what came back.

It now prints a second line in the same startup phase:

```
INFO 🚀 shop v1.0.0     {"url":"…","routes":22,"services":3,"prefix":"/api",…}
INFO 🗄  litestone       {"models":8,"enums":1,"gated":"7/8",
                         "databases":"main → ./db/shop.db (sqlite), audit → ./db/audit (logger)"}
```

Four fields, each earning its place:

- **models / enums** — the shortest honest answer to "did the seed parse".
- **gated** as `n/total` — a schema reading `0/24` is one whose access control
  is not declared. Worth seeing daily rather than discovering in an audit.
- **databases** — name → **resolved** path and driver. This is the one that
  pays for the line: a schema declaring `database main { path … }` silently
  overrides `createClient`'s `db:` option, so the file being written is not
  always the file that was passed. Printing the resolved path makes that
  visible at boot instead of three confusing test runs later. (Verified in both
  directions — `example/` declares a path and shows it; `sierra/example` passes
  `db: ':memory:'` with no declaration and shows `:memory:`.)

`describeDataRealm()` lives in `core/litestone.ts`, beside the rest of the
Data↔API seam. It is entirely duck-typed and returns `null` — no line — for
anything that is not a Litestone client, including a raw `bun:sqlite` handle.
It also catches: `createApp({ db })` accepts Proxy-based clients that *throw*
on unknown property access (Litestone's own scoped proxy does exactly that),
and a banner helper that throws would take the app down at the last startup
phase, after the port is already open. Six tests in
`tests/describe-data-realm.test.ts`, four of them on that failure path.

Newest first. Everything below the 2026-08-02 block was applied during the
2026-07-25/26 FrontierJS pass, against the archive dated 2026-07-26
(`_built: 2026-05-27`).

## 2026-08-02 — the error boundary is extensible

`src/core/errors.ts`. `toFrameworkError()` is the single point where a thrown
value becomes an HTTP status, and it used to recognise a **closed** world:
Junction's own `FrameworkError` subclasses plus two Litestone error names by
string. Every other package's errors fell through to `GeneralError` — a 500 for
what the thrower had modelled as a 401 or a 404.

That bit `@frontierjs/auth` and `@frontierjs/caravan` independently, and each
worked around it differently: auth wrapped every one of its own routes in a
per-route try/catch that re-mapped statuses, caravan just shipped 500s.

Recognition order is now:

1. `instanceof FrameworkError`
2. a mapper registered with **`registerErrorMapper(fn)`**
3. a numeric **`status` / `statusCode` / `code` in 400–599** on the error
4. `err.name` matching a known class name (`NotFound`, `ValidationError`,
   `AccessDeniedError`, …)
5. `GeneralError` (500)

**Rule that follows from step 3: if you own the error class, give it a
`status`.** No registration, no import of Junction — which is how auth and
caravan now map statuses while depending on nothing here. Use
`registerErrorMapper` only for errors you cannot modify, e.g. a third-party
library's.

Consequence elsewhere: auth's per-route wrapper is **gone**, and its errors map
correctly everywhere rather than only on `/auth/*`. Raw routes (`app.get` /
`app.post`) can now simply throw.

---

## 2026-08-02 — plugin contract reworked

`src/core/app.ts`. Four changes, each closing a silent failure:

- **`register` is `=> void`, not `=> Promise<void>`.** `configure()` runs it
  synchronously and never awaited it, so an async `register` had its body run
  after the app was already assembled — with nothing to say so. Async setup
  belongs in `boot()`. Returning a promise from `register` now warns at runtime,
  and its rejection still aborts `start()` rather than becoming an unhandled
  rejection.
- **`requires: ['mailer']`** declares ordering. Checked once at startup, before
  any `boot()`, against both presence *and* `configure()` order.
- **`app.provide(name, value)`** is the guarded namespace claim. It assigns the
  real property — so the `AppConduit` / `AppJobs` / `AppNotify` interface
  augmentations keep resolving — but **throws if the name is taken**, replacing
  silent last-write-wins.
- **Startup is ONE named phase list**, `runStartPhases(bindHost)`. There were
  two hand-maintained sequences numbered 0, 0a, 0b, 0c, 1, 3, 4, 4.5, 4.6, 5, 6,
  7, with the test path documented as mirroring "phases 1, 4.5, 4.6" — a subset
  that could drift from the real one without any test noticing. `start()` and
  `_startForTest()` now run the same list; phases flagged `needsHost`
  (load-config, autoload-services, listen, ready-hooks, signal-handlers,
  announce) are skipped by the test path. **Add a phase to the list, never to
  one caller.**

The plugin protocol is `{ name, register, boot, ready, shutdown, requires }`.

---

## 2026-08-02 — webhook audit: four bugs, one of them a payload leak

`src/plugins/webhooks/index.ts`.

### `findForEvent` pattern-matched on the event name

```sql
events LIKE ('%"' || ? || '"%')     -- ← the parameter is a caller-supplied event name
```

SQL `LIKE` metacharacters in the **event name** therefore matched other
subscriptions. An event named `user_created` was delivered to a hook subscribed
only to `userXcreated` (`_` matches any character), and an event named `%`
fanned out to **every registration in the table**.

That is a payload leak: a partner receives correctly-signed data for an event
they never subscribed to, and the delivery looks entirely normal at both ends.

Matching is now `json_each()` equality. **Don't reintroduce pattern matching on
a caller-supplied name.**

### `updateDelivery` used `??`, so nullable columns could never be cleared

`updates.error ?? current.error` makes an explicit `null` mean "leave it alone".
A delivery that failed once and then **succeeded on retry** kept reporting the
`HTTP 500` it had recovered from, and kept a stale `next_retry_at` — so the
delivery log said a working webhook was broken.

Use `key in updates ? updates[key] : current`. This is a shape, not a one-off:
any patch helper written with `??` has the same hole.

---

## 2026-08-02 — router: fixed and dynamic routes no longer share a keyspace

`src/transport/router.ts`. The method cache was one object, with dynamic routes
stashed under the key `'D'`. A route registered at **`/D`** normalises to
exactly `'D'` and collided: `build()` threw
`methodCache.D.push is not a function`, and `lookup()` would have returned the
bucket array as if it were a route.

The cache is now `{ fixed, dynamic }` — separate fields, no shared keyspace.
Found by a test probing `hasExactRoute`.

---

## 2026-08-02 — the startup banner advertised a `/health` that might not exist

The endpoint was always fine; the **advertisement** was fiction. The banner
asked `router.hasRoute('GET', '/health')` — which is a *matching* question:
"would a request for this path match something". Every app registers
`GET /{service}`, which matches `/health`. So every app printed a health URL
whether or not `healthPlugin()` was configured.

**`hasRoute()` is a matching question, not an existence one.** Use
`hasExactRoute(method, path)` when you mean "is this endpoint mounted", and
`routePaths(method)` to list where routes actually landed. The banner uses
`routePaths`, so `healthPlugin({ path: '/internal' })` is advertised at
`/internal` instead of being claimed at `/health`.

Fixed in the same place: `hasRoute(a) ?? hasRoute(b)` never evaluated `b` — `??`
only falls through on null/undefined and `hasRoute` returns a boolean.

---

## 2026-08-02 — `/metrics` read service keys that don't exist

`svc.actions` is not a key on a service — custom methods are ordinary
function-valued properties, and three other places already had a predicate for
that. `/metrics` reported every service as having zero custom methods, and
misreported `svc.allowBulk` the same way.

Both now go through `customMethodNames()`, the same predicate manifest and
OpenAPI use.

---

## 2026-08-02 — `app.conduit` was declared twice, and conduit always lost

Junction typed `conduit?: SomeShape` on `App` while `@frontierjs/conduit`
declared the same property in a module augmentation. **Declaration merging
requires identical types**, so the augmentation silently lost and `app.conduit`
resolved to `{}` at every call site — in the editor and in `tsc`, with the code
working perfectly at runtime.

Junction now exports an empty `interface AppConduit` and types the field
`conduit?: AppConduit` (`src/core/app.ts`); conduit augments **that interface**.

**If you add another `app.<thing>` from a plugin package, use this pattern — an
empty interface exported here, augmented there — not a property redeclaration.**
Junction's typecheck baseline dropped to **212** as a result; that is the current
number, not the 214/216/224/226 in older notes.

---

## 2026-08-02 — the dialect trap took 7 "test drift" failures with it

Junction carried 7 long-standing test failures filed as drift. They were not
drift: Junction was resolving a *registry* Litestone that still spoke
`Integer/Text/Real/Blob` while the fixtures were written in the current
`Int/String/Float/Bytes` dialect.

Junction (and auth) now take litestone as a `workspace:*` dev-dependency with a
`^1.1.0` peer, so in-repo code gets the workspace parser. All 7 pass. See
`packages/litestone/CHANGES.md` for the registry half.

---

## createBaseService now carries `name`, `hooks` and custom methods

`src/core/service.ts`.

It destructured only `{ model, db, paginate, allowBulk }` and returned the seven
CRUD methods, dropping everything else. That made the documented service shape
silently wrong:

```ts
export default createBaseService({
  name:  'leads',
  model: 'lead',
  hooks: { before: { create: [authenticate] } },   // ← discarded
})
```

It type-checked. The autoloader registered it, deriving the name from the
filename, and it served requests — with no hooks. For `authenticate` that is an
authorization hole producing no error, no warning, and a service that reads
correctly in review.

Only the spread form worked, because the loader reads hooks off the object you
export via `createService({ name: deriveName(filename), ...service })`:

```ts
export default { ...createBaseService({ model: 'lead' }), hooks: { … } }
```

Both forms work now. `name` and `hooks` are carried onto the return value, and
extra function-valued options become custom service methods — mirroring
`createLitestoneService`, which already supported all three.

Guarded against leakage: reserved keys (`model`, `name`, `hooks`, `db`,
`paginate`, `allowBulk`) are never exposed as methods. `db` in particular is a
function, so without that check it would have become callable over HTTP. And
when `name` or `hooks` are omitted, no key is added at all — an explicit
`name: undefined` would override the loader's filename-derived name with
nothing.

**New:** `tests/base-service-options.test.ts` — 10 tests. Verified against both
the old and new implementations: 3 fail before the change (`name`, `hooks`,
custom methods), all 10 pass after.

## WebSocket service calls dropped the id

`src/client/index.ts`, `src/transport/channels.ts`.

Reported from a running app, once the `channels()` plugin was registered and WS
calls actually started flowing:

```
leads.patch   websocket  ✗  Bulk patch is disabled on this service (set allowBulk: true)
leads.remove  websocket  ✗  Bulk remove is disabled on this service
leads.find    websocket  ✓
```

`find` worked; anything carrying an id did not.

The browser client wrote call extras under `params`:

```ts
const params = {}
if (id != null) params.id = id
send(JSON.stringify({ type: 'service_call', …, params, data }))
```

The server read them from `meta`:

```ts
const extraParams = (parsed.meta ?? {}) as Record<string, unknown>
const paramId     = extra?.id ?? data?.id
```

Nothing matched, so `svcCtx.id` stayed null. A CRUD method with no id is a bulk
operation by definition, so the service correctly refused it — the error was
accurate and the cause was three layers away.

`WSMessage` declares `meta` and has no `params` field, so the client was the side
in the wrong. It now sends `meta`; the server accepts either, so a client that
has not been updated keeps working.

**Why it hid for so long:** with `channels()` unregistered there is no `/ws`
route, so `_wsCall()` fell back to HTTP on every call — and over HTTP the id
travels in the URL path, which is a different code path entirely. The protocol
mismatch could only surface once the WebSocket transport was genuinely in use.
The `?? data?.id` fallback also masked it for `create`-shaped payloads that
happen to carry an id.

**New:** `tools/check-ws-protocol.mjs` — asserts both ends agree on the frame.

## createApp({ db }) — the database client is now an app option

`src/core/app.ts`, `src/core/litestone.ts`, `src/core/service.ts`.

Wiring a Litestone client used to take three steps in two files:

```ts
export const withDb = withLitestoneDb(db)        // core/hooks.ts
app.hooks({ around: { all: [withDb] } })         // app.ts
```

An option with exactly one correct answer is not an option. `createApp({ db })`
now takes the client, exposes it on `app.db`, and installs the scoping itself
when the client has `$setAuth`. Plain table-shaped clients — the ones
`createBaseService` adapts — are accepted and simply get no scoping.

`config.database.url` still works and still produces a raw bun:sqlite handle;
`opts.db` takes precedence.

### The bug this exposed: only one service factory scoped

`withLitestoneDb` seeded `ctx.locals.db` with the **root** client and left
`$setAuth` to `createLitestoneService`. `createBaseService` never called it at
all. So a service written with `createBaseService` ran unscoped, and a schema
declaring

```prisma
@@allow('read', ownerId == auth().id)
```

compared against a null `auth()` and matched nothing. The service returned empty
results and looked broken; the policy was correct. **Which factory you picked
silently decided whether your row policies worked.**

`withLitestoneDb` now does the scoping itself, so both factories get a
caller-scoped client. `createLitestoneService`'s own `$setAuth` is redundant but
harmless, and is kept for apps that seed `ctx.locals.db` by hand.

### The unscoped fallback is now an error

`createBaseService` fell back to `ctx.app.db` and wrapped it with
`adaptPlainClient()`. For a Litestone client that meant running unscoped with no
warning. It fails closed — policies match nothing rather than leaking — but it
looks like broken code rather than misconfiguration. It now throws and names the
fix.

**New:** `tools/check-app-db.mjs` — 10 checks over the option's behaviour,
including anonymous requests, plain clients, and composition with later
`app.hooks()` calls.

## createLitestoneService removed

`index.ts`, `src/core/litestone.ts`, `src/core/service.ts`.

Its last remaining reason to exist was the `schema` option, which is now on
`createBaseService`. There is one service factory.

```ts
createBaseService({ name: 'leads', model: 'lead' })                    // derived
createBaseService({ name: 'leads', model: 'lead', schema: explicit })  // explicit
```

An explicit schema **replaces** the derived validator rather than stacking with
it, and a schema with no usable definition warns and falls back rather than
throwing:

```
✓ explicit schema compiles / enforced / REPLACES derived
✓ gate auth still applies
✓ unusable schema warns, falls back to derived
```

`resolveDefsKey` is exported from `litestone.ts` so the accessor → `$defs` key
mapping has one implementation rather than the guess-at-plurals chain the old
factory used.

**New:** `tools/check-explicit-schema.mjs` (8), replacing the alias checker.

### The old split, for the record

`createBaseService` and `createLitestoneService` were parallel implementations
over the same `createLitestoneBase`. The difference was invisible at the call
site and decided real behaviour — only one scoped with `$setAuth`, only one
validated. None of the three options that seemed to justify the split were
Litestone-specific:

| option | why it was not a blocker |
|---|---|
| `idField` | plain string, already understood by the shared base |
| `softDelete` | documented as *"a Junction-side override… default: trust the schema"* |
| `cache` | `CacheDeclaration` is defined in Junction core, backed by a per-app cache |

No stubs were needed — `createBaseService` simply wasn't passing them through.

**New:** `tools/check-service-options.mjs` (13).

`src/core/service.ts`, `src/core/litestone.ts`.

`createBaseService` and `createLitestoneService` were parallel implementations
over the same `createLitestoneBase`. The difference was invisible at the call
site and decided real behaviour — only one scoped with `$setAuth`, only one
validated. Both are derived from the client now, which left the split with
nothing to justify it except three options.

None of those three were Litestone-specific:

| option | why it was not a blocker |
|---|---|
| `idField` | plain string, already understood by the shared base |
| `softDelete` | documented as *"a Junction-side override… default: trust the schema"* |
| `cache` | `CacheDeclaration` is defined in Junction core, backed by a per-app cache |

So no stubs were needed — `createBaseService` simply wasn't passing them
through. It now accepts all three and carries `_meta` for the manifest and
devtools plugins.

`createLitestoneService` is a 50-line alias. The one asymmetry kept: an explicit
`schema` replaces the derived validator rather than stacking with it, for a
service whose validation should differ from its table definition.

```
✓ softDelete / cache / idField honoured
✓ gate auth still derived
✓ validation still derived
✓ explicit schema enforced — name: name is required
```

## Authentication is derived from @@gate

`src/core/litestone.ts`, `src/core/service.ts`.

A model's `@@gate` already states the minimum level per operation:

```prisma
@@gate("4")        read/create/update/delete all require USER
@@gate("0.4")      read is public; writes require USER
@@gate("2.4.4.5")  read 2, create 4, update 4, delete 5
```

Restating that as `before: { find: [authenticate], get: [authenticate], … }` on
every service is five lines saying what one line already said. Worse, the
per-operation form **cannot** be expressed that way — a public-read model had to
either drop the hooks entirely or reject anonymous reads.

`createBaseService` now installs `gateAuth(model, op)` per method, resolved at
call time:

```
✓ gate 4:       anonymous find rejected, authenticated find passes
✓ gate 0.4:     anonymous find ALLOWED, anonymous create rejected
✓ gate 0.4.4.5: read public, delete needs auth
✓ no gate:      unrestricted
✓ plain client: no-op
```

That is "authenticate by default with public exceptions", declared once in the
schema, per operation.

### Scope: only the anonymous case is derivable

Junction's contribution is the **status code**. The Gate plugin enforces the
level at the data layer, but an anonymous request reaching that far fails as a
policy error, not a 401. This rejects it at the API boundary instead.

Whether an *authenticated* user clears level 4 depends on the app's own
`getLevel()`, which Junction cannot see — so that check stays in the data layer
where it belongs. `gateAuth` only asks "does this operation require a level
above STRANGER, and is anyone logged in?"

### Ordering

Auth runs before validation — rejecting an anonymous request costs less than
parsing its body, and it produces the more useful error:

```
anonymous + invalid data     → 401 Authentication required
authenticated + invalid data → 400 email: email must be a valid email address
```

App hooks still run first, so a service can add its own checks ahead of both.

**New:** `tools/check-gate-auth.mjs` — 11 checks across gate shapes.

## Field validation is derived from the schema, not declared

`src/core/litestone.ts`, `src/core/service.ts`.

`createLitestoneService` accepted a `schema` option and compiled it into
`before.create` / `before.patch` validation hooks. `createBaseService` had no
schema option at all — so which factory you chose silently decided whether your
field rules were enforced, the same trap as the scoping bug above.

Nothing needed to be declared. A Litestone client carries its own parsed schema
on `$schema`, so `@length(1, 200)`, `@email` and `@gte(0)` were already known.
Passing `schema: generateJsonSchema(db.$schema)` to every service was
boilerplate whose only failure mode was forgetting it.

`createBaseService` now installs `autoValidate(model, mode)` hooks that resolve
everything at call time — the client is not known when a service module is
imported. Against the real smoke-test schema:

```
✓ valid data passes
✓ rejects a bad email        — email: email must be a valid email address
✓ rejects a negative value   — value: value must be at least 0
✓ rejects an over-long name  — name: name must be at most 200 characters
✓ plain client: validation no-ops
```

`@frontierjs/litestone` is a peer dependency, so the import is dynamic and its
absence tolerated — the same approach `plugins/manifest` already uses. User
hooks run first, so a `before/create` hook can still shape `ctx.data` before it
is validated.

### The accessor / model-name mismatch is fixed properly

`generateJsonSchema` keys `$defs` by model NAME (`Lead`); services address tables
by accessor (`lead`). `createLitestoneService` used one value for both lookups
and tried `name`, `model`, `name + 's'` — so `{ name: 'leads', model: 'lead' }`
matched none of them, fell through to a `try/catch`, warned, and ran with **no
validation**. Resolution now goes through the schema's own model list, so it
holds for any naming convention rather than guessing at plurals.

### A silent-failure path I introduced, then closed

The dynamic import was originally wrapped in a bare `catch { return null }`.
That is correct when the client is not a Litestone client — but when the client
*does* carry `$schema`, validation was expected, and swallowing the error would
disable field validation app-wide with no signal. It now warns once, naming the
cause.

**New:** `tools/check-auto-validation.mjs` — 6 checks against the real
smoke-test schema.

## Types imported as values broke type-stripping runtimes

`src/transport/http.ts`.

```ts
import { serveStatic, StaticOptions } from './static.ts'
import { createStats, TransportStats } from './types.ts'
```

Both second names are interfaces. Bun transpiles TypeScript fully so it erases
them silently; a runtime that *strips* types instead leaves the import in place,
the target has no such runtime export, and the module fails to instantiate:

```
SyntaxError: The requested module './types.ts' does not provide an export
named 'TransportStats'
```

That is Node's `--experimental-strip-types`, and it is the same rule
TypeScript's own `verbatimModuleSyntax` and `isolatedModules` enforce. Any
consumer outside Bun hits it on import.

Both split into `import type`. **New:** `tools/check-type-imports.mjs` — walks
`src/`, resolves each relative import, and reports names declared only as
`interface` or `type`. Currently clean across 50 files.

## Not changed, but worth knowing

Found while wiring a fullstack app against Litestone and `@frontierjs/auth`.
Neither is Junction's bug alone, but both surface here first:

- **`createLitestoneService` conflates the Litestone accessor with the model
  name.** It derives one value and uses it for two lookups: `createLitestoneBase`
  does `scopedDb[model]`, which needs the accessor (`lead`), while
  `generateJsonSchema` keys `$defs` by `model.name` (`Lead`). Neither value
  satisfies both, and the `$defs` miss doesn't throw — it `console.warn`s and
  drops auto-validation, so a service can silently accept unvalidated input.
  `LitestoneServiceConfig` probably wants the two as separate fields.

- **Auth plugin routes don't inherit `apiPrefix`.** `registerServiceRoutes`
  applies it; plugins calling `app.post()` directly do not. `@frontierjs/auth`
  defaults to prefix `/auth`, but Junction's own browser client hardcodes
  `/api/auth/login` in `authenticate()` — so with defaults on both sides they
  never meet. Apps have to set `prefix: '/api/auth'` explicitly.
