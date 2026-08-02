# FrontierJS — Project State
_Last updated: 2026-04-28 (Junction V5)_

This document captures current design decisions, architecture, known issues, and standing conventions across all FrontierJS packages.

---

## Package inventory

| Package | File | Status |
|---|---|---|
| `@frontierjs/junction` | `junction-v5.zip` | ✅ Production ready |
| `@frontierjs/auth` | `auth-v1.1.1.zip` | ✅ v1.1.1 — OAuth + 57-test suite |
| `@frontierjs/litestone` | (external) | ✅ Schema-first SQLite ORM — see usage cheatsheet below |
| `@frontierjs/caravan` | `caravan.zip` | ✅ Production ready |
| `@frontierjs/conduit` | `conduit.zip` | ✅ Production ready |
| `@frontierjs/notifications` | `notifications.zip` | ✅ Production ready |
| Example: minimal-fjs | `minimal-fjs.zip` | ✅ Current |
| Example: auth-fjs | `auth-fjs.zip` | ✅ Current |
| Example: ela-api | `ela-api.zip` | 🔄 Working, Conduit fallback pending |

---

## Junction V5 — what changed since V4

V5 is a maintenance / consistency release. No new features, several real bug
fixes that surfaced during the V4 review:

1. **`package.json` exports map fully repaired** — every subpath
   (`./scheduler`, `./database`, `./email`, `./client`, `./openapi`,
   `./webhooks`, `./manifest`, `./ai`, `./mail`, `./events`, `./cache`,
   `./workers`, `./testing`, `./config`, `./errors`, `./hooks`, `./service`,
   `./schema`, `./env`, `./logger`, `./litestone`, `./filestorage`,
   `./channels`, `./middleware`, `./health`, `./auth`, `./devtools`,
   `./transport`) now points at the correct path under `src/`. Previously
   every subpath was broken — only the root `.` import worked.
2. **`defineEnv` type inference fix.** `EnvOutput<S>` now correctly types
   purely-optional vars (no `required`, no `default`) as `T | undefined`.
   The old conditional `F['default'] extends undefined` evaluated `unknown
   extends undefined` as false → typed everything as definitely-present.
   New form: `'default' extends keyof F` — checks key presence, not value.
3. **HTTP cache-control bug.** `_finalizeWithHeaders` checked `ctx.user?.id`
   but `SessionContext` uses `userId`. Authenticated reads were getting
   `cache-control: no-store` instead of the intended `private, no-cache` +
   `Vary: Authorization`. Fixed to read `ctx.user?.userId`.
4. **`manifestPlugin` import paths repaired.** Imports were `'./core/app.ts'`
   and `'./core/hooks.ts'`, which resolve to `src/plugins/manifest/core/...`
   and don't exist. Fixed to `'../../core/...'`. The file did not compile in
   V4. Stale JSDoc ("Mount in ready()") replaced — the plugin actually
   mounts in `boot()`.
5. **`protect()` fix for single-record envelopes.** When a `get` or `create`
   call's result was `{ object: 'user', data: { ...record... }, errors: [] }`,
   the old `protect('password')` deleted `password` from the envelope itself
   (no-op) instead of from `.data`. **Passwords leaked.** New branch detects
   the envelope and strips inside `.data`.
6. **`app.setAuth()` now mirrors onto `app.auth`.** Previously only patched
   the HTTP transport's internal opts. The `channels()` plugin reads
   `app.auth` at register time, so `setAuth` after `createApp({ auth:
   undefined })` left channels without an auth implementation.
7. **`App` interface declares `conduit?: unknown`.** Email plugin's campaign
   sender reads `app.conduit` directly — the App interface didn't declare it,
   so the file failed strict-mode TS compile.
8. **Email plugin re-exported from main `index.ts`.** `email`,
   `sendSystemEmail`, `sendCampaignEmail`, `EmailOptions`, etc. were only
   reachable via the subpath import. Now also from the root.
9. **`apiPrefix` JSDoc comment fixed.** Comment said default is `/api`; the
   code defaults to `''`. Comment now matches.
10. **Litestone `findFirst` honours `$withDeleted` / `$onlyDeleted`.** The
    id-branch of `get()` and the entire `find()` already passed these
    through; the no-id (findFirst) branch silently dropped them.
11. **Proper deep merge in `app.start()` config loading.** The previous
    implementation iterated top-level keys of `junctionCfg` and
    shallow-assigned only those missing from `opts.config`. This worked for
    scalars (`port`, `name`) but silently broke nested overrides — passing
    `opts.config = { http: { compress: false } }` clobbered the entire
    `http` block from `junction.config.js`, dropping `cors`, `powered`, etc.
    Now: `deepMerge(loadConfig(...), opts.config)` so `opts.config` wins at
    the leaf level and the rest is preserved.

No public API changed except (a) repaired subpath exports that should have
worked all along, and (b) new `email`/`conduit` symbols on the App interface.

---

## Junction — Architecture

### Directory structure
```
junction/
  index.ts          ← public API — all exports go through here
  src/
    core/           ← app, service, hooks, schema, errors, loader, logger, env, litestone
    transport/      ← http, ws, router, bridge, channels, health, middleware, body, static
    plugins/        ← ai, devtools, email, manifest, openapi, scheduler, webhooks
    storage/        ← database, filestorage
    auth/           ← IAuth, SessionContext (interface layer only)
    cache/          ← in-memory cache
    events/         ← event bus
    mail/           ← IMail interface + SMTP/Resend adapters
    config/         ← loadConfig, AppConfig, JunctionConfig, deepMerge
    client/         ← Sierra/browser client
    workers/        ← worker pool
    tools/          ← REPL, init, setup
    testing/        ← test harness
    tests/          ← tests across 5 files
    example/        ← example server
```

### The pipeline
```
Transport (HTTP / WS / internal)
  → bridge.toContext()          ← normalise to ServiceContext
  → callService(svc, ctx, appHooks)
      → around hooks
      → before hooks
      → method (Litestone or custom)
      → after hooks
      → (error hooks on throw)
  → ServiceResult envelope
```

### SessionContext (camelCase — final shape)
```typescript
interface SessionContext {
  userId:       string
  userType:     string      // 'user' | 'admin' | 'system'
  email?:       string
  name?:        string
  accountId?:   string
  workspaceId?: string
  role?:        string
  scopes?:      string[]
  authMethod:   'session' | 'apiKey' | 'oauth' | 'created' | 'verified'
}
```

Note: `authMethod` is **required** in V5 (downstream auth code can stamp
`'created'` / `'verified'` itself). Earlier project state notes it as
optional — the in-tree types and tests treat it as required.

### Key invariants
- `ctx.result === null` in before hooks; populated in after hooks
- `ctx.query` is top-level (not nested in ctx.params)
- **`ctx.params` is DELETED (v6 restructure).** Replaced by four typed
  fields — see "ServiceContext shape (v6)" below
- `context.type` must be preserved through the pipeline
- `_method()` bypasses Junction hooks only (not gates)
- `db.asSystem()` grants Litestone level 8 — bypasses `@@gate`, all
  `@@allow`/`@@deny` row policies, all field-level `@allow`, and reveals
  `@guarded` / `@encrypted` / `@secret` fields. Use for seeding,
  migrations, and any code path where there's no user context.

### ServiceContext shape (v6 — canonical)

`ctx.params` (the open `{ user, headers, ip, [key]: unknown }` bag) was
**deleted** and split into four typed fields with explicit propagation
semantics. This kills the FeathersJS shared-mutation footgun
(diagnosed in their issue #562, never fixable there due to ecosystem
lock-in). Junction is pre-alpha — done in one breaking pass.

```typescript
interface ServiceContext {
  // routing / inputs — unchanged
  service; method; type; transport; model; id; query; data

  auth:   { user: SessionContext | null }   // identity ONLY. frozen.
                                              // PROPAGATES (deep-cloned)
  client: { ip?; userAgent?; headers; … }    // caller env. read-only.
                                              // propagates. {} internal
  route:  Record<string, string>             // path captures (:id/:room)
                                              // router-only; {} internal
  locals: ServiceContextLocals               // per-call scratch. FRESH {}
                                              // every call. does NOT
                                              // propagate (kills the bug)
  // app / lifecycle / internals — unchanged
  app; result; error; statusCode?; dispatch?; $raw; telemetryId?; _cleanups?
}
interface ServiceContextLocals {
  paginate?: { limit; offset; … }
  [key: string]: unknown   // plugins augment via `declare module`
}
```

Migration map (every old `ctx.params.X`):
`.user`→`ctx.auth.user`; `.headers`→`ctx.client.headers`;
`.ip`→`ctx.client.ip`; `.db`→`ctx.locals.db` (litestone augments the
type); `.paginate`→`ctx.locals.paginate`; path params→`ctx.route.X`;
`__channels`→`ctx.locals`; any ad-hoc hook stash→`ctx.locals.X`.

**`TransportContext.params` is UNCHANGED** — that's the router's
path-param `Record<string,string>`, always a separate thing from the
killed bag. Route handlers (`app.get('/x/:id', ctx => ctx.params.id)`)
keep working exactly as before.

### Request-wide metadata (AsyncLocalStorage)

Correlation id / idempotency key / locale belong to the **whole
request**, not any single call. They ride an `AsyncLocalStorage` store
the bridge wraps the pipeline run in — NOT hand-threaded through
`CallOptions` (that would be the Feathers footgun reborn: one
forgotten call site silently breaks the trace). Bun-native.

```typescript
import { requestMeta } from '@frontierjs/junction'
const meta = requestMeta()   // { correlationId, idempotencyKey?, locale?, origin }
                             // — readable at ANY call depth, never passed
```

The HTTP crud handler builds `RequestMeta` from headers
(`x-request-id`→correlationId, `idempotency-key`,
`accept-language`→locale) and wraps the pipeline in `runWithMeta(...)`.
Test helper: `withTestMeta(partial, fn)` in `@frontierjs/junction/testing`.

### Internal-call signature (CallOptions, replaces ServiceParams)

`app.service('x').<method>(...)` second arg is now a closed, typed
`CallOptions` — only what you VARY per call. No open index signature →
nothing mutable leaks unnamed.

```typescript
interface CallOptions {
  auth?:      { user: SessionContext | null }   // default: system (null)
  transport?: 'http' | 'websocket' | 'internal' // default: 'internal'
  locals?:    Partial<ServiceContextLocals>     // rare; e.g. shared tx
}
// 7 signatures: find/get/create/patch/update/remove/restore + call().
// patch/update/remove reject null id+query. query rides arg 1, never opts.

await app.service('orders').get(id, { auth: ctx.auth })  // propagate identity
await app.service('audit').create(data, { auth: ctx.auth })  // correlationId
                                                              // rides ALS
```
- `apiPrefix` defaults to `''`
- Result envelope: lists → `{ object: 'list', data: [], errors, total, limit,
  offset }`, singles → `{ object: model, data: record, errors: [] }`. HTTP
  unwraps singles by default; `$wrap=true` opts into envelope. WS unwraps
  singles, keeps lists.

---

## Junction — Key features (all implemented)

**Config system:**
- `createApp()` with no args reads `api/config/junction.config.js` automatically
- `JunctionConfig` sections: `app`, `middleware`, `plugins`, `services`, `conduit`, `caravan`
- `loadConfig(dir)` resolves from CWD
- `autoloadServices` and Caravan `autoloadJobs` both resolve from CWD

**Logger (`src/core/logger.ts`):**
- `ILogger` with `debug`, `info`, `warn`, `error`, `child(ns)`
- `createLogger(opts)` — level filtering, pretty/json format, pluggable writers
- `app.logger` wired onto App interface — injectable via `createApp({ logger })`

**Env validation (`src/core/env.ts`):**
- `defineEnv(spec)` — typed output, required validation throws at startup
- Types: `string`, `number`, `port`, `boolean`, `url`, `json`
- Weak secret detection in production
- `generateEnvExample(spec)` / `printEnvExample(spec)`
- V5: `EnvOutput` correctly types optional fields as `T | undefined`

**Litestone adapter (`src/core/litestone.ts`):**
- `findManyAndCount` single-trip pagination
- `offset`/`limit` (not skip/take)
- `restore()` wired to `table.restore()` / `table.restoreMany()`
- `$withDeleted` / `$onlyDeleted` passthrough — V5 also through `findFirst`
- `$search` → `table.search()` for FTS5 models
- `$populate` trim fix
- Response shape (raw): `{ total, limit, offset, data }` — wrapped to envelope
  by service.ts

**Cookie support (`src/transport/http.ts`):**
- `ctx.cookies` — parsed from incoming `Cookie` header
- `ctx.setCookie(name, value, opts)` — queues `Set-Cookie` on response
- Applied in `_finalizeWithHeaders`

**Channels/Presence:** Server-controlled membership, `presence:sync/join/leave/update`
events, `app.presence()`, `app.presenceOf()`, heartbeat 30s

**Telemetry:** `app.telemetry` emitting `junction.call.start/end`, `junction.hook`,
`junction.ws.*`, `junction.channel.publish`, `litestone.query` — all correlated
by `telemetryId`

**manifestPlugin:** Mounts in `boot()`. Lives at `src/plugins/manifest/index.ts`.

**Built-in hooks:** `authenticate`, `requireRole`, `paginate`, `protect`,
`allow`, `timestamps`, `logTiming`, `circuitBreaker`, `rateLimitHook`.
V5: `protect()` correctly strips inside `.data` on single-record envelopes.

---

## @frontierjs/litestone — usage cheatsheet

External package, schema-first SQLite ORM for Bun. Junction integrates via
`createService({ model })` and `withLitestoneDb`. Auth, Caravan, and Conduit
all sit on top of it.

### `createClient` shape (single options object)

```ts
const db = await createClient({
  schema:        './schema.lite',         // path OR inline schema string
  db:            ':memory:' | './app.db', // omit if schema declares `database` blocks
  encryptionKey: process.env.ENCRYPTION_KEY,   // required if any @encrypted/@secret
  plugins:       [gate, FileStorage({...})],
  computed:      './computed.js',         // optional
  filters:       { posts: ctx => ({ tenantId: ctx.auth?.tenantId }) },
})
```

**No `apply()` needed for fresh DBs** — DDL runs automatically inside
`createClient` for `:memory:` and first-time files. `apply()` is the
file-migrations function (reads SQL files from a directory). Dev-mode
schema sync without files: `autoMigrate(db)`.

### Scopes

```ts
const userDb = db.$setAuth(req.user)   // ctx.auth = req.user — policies + plugins see it
const sysDb  = db.asSystem()           // grants level 8 — bypasses everything
```

`$setAuth` returns a *new client* sharing the connection. Don't reassign
`db`. Per-request scoped clients are the pattern; `withLitestoneDb` does
this automatically and stashes the scoped client on `ctx.locals.db`.

### Method surface (most-used)

Reads: `findMany` `findFirst` `findUnique` `findFirstOrThrow`
`findUniqueOrThrow` `count` `exists` `findManyCursor` `search` (FTS).

Writes: `create` `createMany` `update` `updateMany` `upsert` `upsertMany`
`remove` (soft-delete on `@@softDelete` models) `removeMany` `restore`
`delete` (always hard) `deleteMany`.

Aggregate: `aggregate` `groupBy`.

Where ops: `in` `notIn` `gte` `gt` `lte` `lt` `contains` `startsWith`
`endsWith` `not` `AND` `OR` `NOT`.

### Soft delete

`@@softDelete` auto-injects `deletedAt DateTime?`, filters by default.
Read flags: `withDeleted: true`, `onlyDeleted: true`. `remove()` stamps,
`delete()` always hard-deletes. `@@softDelete(cascade)` walks `hasMany`
edges. `@hardDelete` on a relation = hard-delete this child even when
parent soft-deletes (sessions, ephemeral tokens).

### `@@hasTemplates` (definition vs instance)

Same shape as soft-delete for the template/instance distinction.
`@@hasTemplates` adds `isTemplate Boolean @default(false)`, filters by
default. Read flags: `withTemplates`, `onlyTemplates`. Use when one row
generates others (quote templates → quotes, checklist templates →
checklists).

### Co-FK propagation (nested writes)

When parent and child share an FK column with the same name, nested-create
auto-propagates the parent's value to the child. **Strict by default** —
parent overwrites child's value. Opt out: `createClient({ allowChildFkOverride: true })`.

### Database blocks (multi-DB)

Schemas can declare physical database splits with `database name { ... }`
blocks. Drivers: `sqlite` (default), `jsonl` (append-only), `logger`
(audit). When schema declares `database` blocks, **omit `db:` from
`createClient`** — schema is the source of truth.

### Encryption

`@encrypted` (AES-256-GCM, hidden unless `asSystem`), `@secret`
(`@encrypted` + `@guarded(all)` + audit), `@encrypted(searchable: true)`
(HMAC-indexed equality search). Requires `encryptionKey` (64-char hex).
`db.$rotateKey(newKey)` re-encrypts all `@encrypted`/`@secret` fields;
`@secret(rotate: false)` opts out.

### Field attribute reference (most-used)

`@id` `@unique` `@default(value|now()|uuid()|ulid()|cuid())`
`@default(auth().field)` `@default(siblingField)` `@map("col")`
`@updatedAt` (standalone — no paired `@default(now())`) `@omit`
`@guarded` `@encrypted` `@secret` `@allow('read'|'write'|'all', expr)`
`@log(dbName)` `@sequence(scope: fieldName)` `@computed`
`@generated("sql expr")`. Transforms: `@trim` `@lower` `@upper`.
Validators: `@email` `@url` `@date` `@datetime` `@length(min,max)`
`@gte/@gt/@lte/@lt` `@regex("...")` `@minItems` `@maxItems`. File:
`@keepVersions` `@accept("mime/type")`. `@markdown` (semantic hint).

### Model attribute reference

`@@db(dbName)` `@@softDelete[(cascade)]` `@@hasTemplates[(field: "...")]`
`@@fts([f1, f2])` `@@index([...])` `@@unique([...])` `@@strict`/`@@noStrict`
`@@gate("R.C.U.D")` `@@auth` `@@map("table_name")`
`@@allow|@@deny('read'|'create'|'update'|'delete'|'write'|'all', expr)`
`@@log(dbName)`.

### Common pitfalls (from the reference)

1. `createClient` takes a **single options object**. No positional args.
2. Type names are `Int / String / Float / Bytes`. Old `Integer / Text /
   Real / Blob` produce parse errors. `litestone codemod` migrates.
3. Accessor casing matches the schema name **verbatim** (camelCased).
   `model User` → `db.user`. `model Users` → `db.users`. Not auto-pluralized.
4. Don't pass `db:` when schema declares `database` blocks.
5. Unknown fields on writes throw `ValidationError` with "Did you mean"
   hints. Don't catch and ignore — they're real typos.
6. Co-FK propagation is strict by default. Opt out via
   `allowChildFkOverride: true`.
7. `@encrypted` requires `encryptionKey` at client init. The error tells
   you exactly what to do.
8. Use `db.asSystem()` for seeding, migrations, and any code without a
   user context. Passing `null` as `auth` makes plugins/policies treat
   the caller as a stranger.

---

## @frontierjs/auth — v1.1.1

**Session/cookie based** (not JWT). `cookieAuth: true` sets httpOnly session cookie.

**Schema models** (PascalCase singular): `User`, `Credential`, `Session`, `Verification`

**Accessor names** (camelCase singular): `user`, `credential`, `session`, `verification`

**Routes registered automatically:**
```
POST /auth/register
POST /auth/login
POST /auth/logout
GET  /auth/me
POST /auth/password-reset/request
POST /auth/password-reset/confirm
GET  /auth/email/verify?token=
POST /auth/email/verify/request
```

**OAuth (v1.1, when `opts.oauth` is configured):**
```
GET  /auth/{provider}/redirect       — mints state, 302s to provider
GET  /auth/{provider}/callback       — verifies state, merges identity, issues session
```

Built-in providers: `github`, `google`. Custom providers: pass any
`OAuthProvider` config object. Identity merge follows Socialite pattern:
existing oauth credential → user lookup; verified-email match → attach
credential to existing user; otherwise → create user. Step 2 only fires
when the provider says the email is verified — blocks the IdP-side
account-takeover vector.

OAuth identities live in `Credential` as `type: 'oauth:{provider}'`,
`value: providerAccountId`. The existing `accessToken` / `refreshToken`
columns hold tokens when the provider has `storeTokens: true` (default
false — tokens are used to fetch the profile and discarded).

State CSRF: HMAC-SHA256 over `{random, timestamp, providerId}` using
`ENCRYPTION_KEY`. 10-minute TTL. Constant-time signature compare. Stored
in a short-lived cookie alongside `?return_to` for post-login redirect.

`onConnect(event)` hook in `oauth` opts runs after merge, before session
issuance. App-level coordination point — assign `accountId`, send welcome
notification, log signup source, etc. Throwing aborts the flow and
triggers `failureRedirect` with `?reason=on_connect_failed`.

For non-cookie auth, the session token is appended as a URL fragment
(`#token=...`) on the final redirect — fragments aren't sent to servers
so they don't leak via Referer headers; client-side script reads
`window.location.hash` and stores however the app prefers.

Internally exposes `IOAuthOps`: `resolveOAuthIdentity(provider, profile,
tokens, opts?)` and `issueSession(userId)`. `createLitestoneAuth` returns
`IAuth & IOAuthOps & { _sessionTtl }`. The plugin checks for these methods
at register time and throws if the auth backend doesn't implement them
(e.g. a custom IAuth without OAuth support).

**Test suite (v1.1.1):** 57 tests across `tests/oauth.test.ts` (state CSRF,
HTTP helpers, provider mappers), `tests/auth-oauth.test.ts` (merge logic),
and `tests/plugin-oauth.test.ts` (route registration + flow). Run with
`bun test tests/`. Test fixtures (`_stubs.ts`) provide an in-memory
Litestone-shaped client + a recorded fetch mock so no real DB or network
is needed.

**Bug fix uncovered while writing tests:** the unverified-email collision
path in `resolveOAuthIdentity` would have crashed on the User.email
unique constraint. The fix detects collisions and falls back to the
synthesized placeholder email (`{provider}-{providerAccountId}@oauth.local`)
instead of the real email. Test `unverified collision — uses placeholder`
pins this behaviour.

---

## @frontierjs/caravan — full feature set

- Job queue (SQLite-backed, WAL mode)
- Cron scheduler (timezone-aware, `findNext` via walk-forward)
- `unique_key` deduplication via `dispatch({ unique: 'key' })`
- `cleanupAfter` (default 7 days) — cleanup on start + hourly
- `unschedule(name)` — removes cron entry
- Admin HTTP endpoints: `GET/POST /jobs`, `GET /jobs/:id`,
  `GET /jobs/schedules`, `POST /jobs/:id/retry`, `POST /jobs/:id/cancel`
- `shutdown()` in plugin protocol calls `caravan.stop()`
- Telemetry: `caravan.job.start/done/failed` via `app.telemetry`
- Default db: `./db/caravan.db`
- Default jobs dir: `./api/src/caravan`

**`junction.config.js` section:** `caravan` (not `jobs`)

---

## @frontierjs/conduit

- `defineTarget(provider, factory)` — marks file as target factory
- `autoloadTargets(dir, conduit)` — scans `src/conduit/` for `*.target.*` and `*/index.*`
- `conduit.registerFactory(provider, factory)` — stores factory by provider name
- `conduit.buildTarget(provider, creds)` — calls factory with credentials
- `ConduitHooks.onRegistered` / `onDeregistered` — lifecycle callbacks
- Plugin `boot()` calls `autoloadTargets` from `opts.dir` or `_junction.conduit.dir`

**Pattern:** Drop a file in `src/conduit/<provider>/index.ts` → auto-registered, no code changes elsewhere.

---

## @frontierjs/notifications

- `Notification` abstract base class with `via()`, `toInApp?`, `toEmail?`, `toSms?`
- `inApp()` and `mail()` fluent builders
- `notify()` — eager validation, parallel `Promise.allSettled`, channel isolation
- Custom driver interface: `{ channel, send(user, message, app) }`
- `notificationsPlugin` wires `app.notify`
- **WS channel:** `notifications:user:${userId}` (ensure client subscribes to this)
- **Accessor:** `notification.create()` (singular)

---

## Example apps

### minimal-fjs
Clean reference implementation. Key patterns:
- `api/index.ts` → `import app; await app.start()`
- `api/src/app.ts` → `export default app`
- `api/src/core/service.ts` → `createService` wrapper
- Global `withLitestoneDb` + `publish` in `core/hooks.ts`
- Services autoloaded from `services.dir` in `junction.config.js`

### auth-fjs
Minimum viable cookie auth:
- `api/src/env.ts` — `defineEnv` validates all env vars at startup
- `api/src/core/db.ts` — wraps `createClient` with helpful error if DB missing
- `api/src/core/auth.ts` — `createLitestoneAuth` + `createAuthPlugin({ cookieAuth: true })`
- Schema: `User @@auth @@softDelete`, `Credential`, `Session`, `Verification`

### ela-api (Elite Lawn Care)
Working Zello integration app:
- `src/conduit/zello/` — `defineTarget` factory
- `src/caravan/` — `zello-sync-locations.job.ts`
- `core/conduit-setup.ts` — `onTargetRegistered`/`onDeregistered` lifecycle
- `core/boot.ts` — reads `integration` rows, calls `app.conduit.buildTarget()`
- **Pending:** Pull new Conduit zip, remove `buildTarget` fallback in `boot.ts`

---

## Config conventions

### `junction.config.js` sections
```js
export default {
  app:        { name, port, apiPrefix },
  services:   { dir: './api/src/services' },
  conduit:    { dir: './api/src/conduit' },
  caravan:    { db, jobsDir: './api/src/caravan', queues, cleanupAfter, admin },
  middleware: { cors, helmet, requestLogger, correlationId, rateLimit },
  plugins:    { health, manifest, openapi, devtools },
}
```

### Model name conventions (Litestone)
- Schema: `PascalCase` singular (`User`, `Integration`, `LocationSnapshot`)
- Accessor: camelCase **verbatim** from the schema name. `model User` →
  `db.user`. `model order_lines` → `db.orderLines`. `model leads` →
  `db.leads` (not `db.lead` — the schema name wins). **Not auto-pluralized
  or auto-singularized.**

### Litestone scalar types (post-rename)
- `String` (TEXT), `Int` (INTEGER), `Float` (REAL), `Bytes` (BLOB)
- `Boolean` (INTEGER 0/1), `DateTime` (TEXT, ISO-8601), `Json` (TEXT)
- `File` (JSON ref to S3/R2/local; bytes in object storage)
- **Hard cut from old names.** `Text`/`Integer`/`Real`/`Blob` produce a
  parse error pointing at the new name. No aliases. `litestone codemod`
  migrates existing `.lite` files.
- Arrays: `tags String[]`. Optional: `bio String?`. Both: `tags String[]?`.

### Gate levels (full set)
- `0` = STRANGER (public, no auth)
- `1` = VISITOR
- `2` = READER
- `3` = CREATOR
- `4` = USER (authenticated)
- `5` = ADMINISTRATOR
- `6` = OWNER (the row's owner — typical for `delete`)
- `7` = SYSADMIN
- `8` = SYSTEM (only reachable via `asSystem()`)
- `9` = LOCKED (absolute wall — unreachable by anyone)

`getLevel()` is clamped to 0–7. `asSystem()` always grants 8.

### Gate format
- Four segments in RCUD order: `@@gate("0.4.4.6")` = read=STRANGER,
  create=USER, update=USER, delete=OWNER. This is the project's
  default-write pattern: public read, user write, owner-only delete.
- Single digit short form: `@@gate("4")` means all four ops require ≥ 4.
- `@@gate("8")` makes the model SYSTEM-only — only `db.asSystem()` can
  touch it. The auth package uses this on `User`/`Credential`/`Session`/
  `Verification`.

---

## Standing conventions

- **Opt-out security:** CORS default `[]`, helmet auto-applied, rate limiting opt-in
- **Zero coupling between packages:** Cross-package coordination at app layer via hooks
- **`$tapQuery` requires explicit `stop()` cleanup** — queued on `ctx._cleanups`
- **`ctx.app` is read-only on hook context** — enables calling other services from hooks
- **`object: 'list'` discriminator** follows Stripe envelope pattern
- **Reserved query params:** `$limit`, `$offset`, `$orderBy`, `$select`, `$wrap`,
  `$populate`, `$search`, `$withDeleted`, `$onlyDeleted`, `$first`
- **`createResource` returns** `{ service, store, make, validate, fields }`
- **Litestone `DateTime` fields require ISO 8601 strings**, not Date objects
- **Bun-native:** `Bun.connect()`, `Bun.gzipSync()`, `bun:sqlite`, `bun:crypto`

---

## Known low-priority items (not addressed in V5)

- **`example/app.ts` references `app.db`**, which is not on the App interface.
  This is a leftover from before Litestone integration. The example would need
  rewriting to use a Litestone-style getter. Doesn't affect the framework
  itself — only the demo file.
- **README has stale paths.** `database/index.ts`, `filestorage/index.ts`,
  etc., listed at top level — actual locations are nested under `src/`. The
  prose is otherwise correct.

---

## Roadmap / open items

- **ela-api:** Pull new Conduit, remove `buildTarget` fallback in `boot.ts`,
  remove Caravan debug log
- **Notifications:** Wire into minimal-fjs and ela-api examples
- **Sierra devtools toolbar (Option C):** Spec at `SIERRA_DEVTOOLS_SPEC.md`
- **Presence tests:** Need WS harness extension
- **Junction `$cursor` query param:** Litestone supports `findManyCursor`;
  Junction's HTTP query parser doesn't surface it yet. v2 adapter item.
- **Richer `_meta`:** `hasFts`, `hasPolicy`, `encrypted`, `relations` from schema
- **`fli add notifications` scaffold CLI command**
- **Email Tier 2 (campaign/bulk):** Provider-wired via Conduit; deferred from Tier 1
- **Update `example/app.ts`** to drop the legacy `app.db` references
- **Update `README.md`** to reflect actual `src/` layout

---

## File map (src/ root)

```
src/
  core/
    app.ts              ← createApp, App interface, plugin lifecycle
                          (V5: setAuth mirrors onto app.auth, conduit?: unknown declared,
                                start() config merge is now proper deep merge)
    service.ts          ← callService, createService, ServiceRegistry
    hooks.ts            ← pipeline runner, built-in hooks
                          (V5: protect() handles single-record envelope correctly)
    litestone.ts        ← Litestone adapter (find/get/create/patch/remove/restore)
                          (V5: findFirst honours $withDeleted/$onlyDeleted)
    schema.ts           ← Junction validation schema
    errors.ts           ← NotFound, BadRequest, Forbidden, etc.
    loader.ts           ← autoloadServices
    logger.ts           ← ILogger, createLogger, writers
    env.ts              ← defineEnv, generateEnvExample
                          (V5: corrected EnvOutput type inference)
  transport/
    http.ts             ← Bun.serve, request parsing, ctx construction, cookies
                          (V5: cache-control reads ctx.user?.userId)
    ws.ts               ← WebSocket handling
    router.ts           ← route matching, route cache
    bridge.ts           ← ServiceContext, toContext, internal
    channels.ts         ← channel manager, publish hook, presence
    health.ts           ← healthPlugin
    body.ts             ← parseBody, parseQuery, parseCookies
    static.ts           ← range, etag, gzip
    middleware.ts       ← cors, helmet, rateLimit, requestLogger, correlationId
    types.ts            ← TransportContext (includes cookies/setCookie)
  plugins/
    ai/                 ← AI registry
    devtools/           ← devtools plugin + admin UI
    email/              ← mailer plugin, campaign, system
                          (V5: now re-exported from index.ts)
    manifest/           ← manifestPlugin
                          (V5: imports + JSDoc fixed)
    openapi/            ← OpenAPI + Scalar
    scheduler/          ← in-process cron
    webhooks/           ← webhook plugin
  storage/
    database/           ← internal SQLite (used by webhooks)
    filestorage/        ← file storage
  auth/
    types.ts            ← IAuth, SessionContext, RateLimitHookOptions
    providers/          ← Better Auth adapter
  config/
    index.ts            ← loadConfig, defaultConfig, JunctionConfig types
                          (V5: apiPrefix comment matches '' default)
  cache/
    index.ts            ← createMemoryCache, ICache
  events/
    index.ts            ← createEventBus, IEventBus
  mail/
    index.ts            ← IMail, mailerPlugin, createSmtpMailer, createResendMailer
  client/               ← Sierra/browser client (JunctionClient)
  workers/              ← worker pool
  tools/
    repl.ts             ← HTTP REPL
    init.ts             ← project scaffolding
    setup.ts            ← env setup helper
  testing/
    index.ts            ← createTestApp, createTestRequest, TestHarness
  tests/
    index.test.ts
    telemetry.test.ts
    changes.test.ts
    client.test.ts
    email.test.ts
```
