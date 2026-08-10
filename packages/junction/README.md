# Junction

A pragmatic, batteries-included backend framework for Bun. Built on three ideas: Total.js's transport performance, Feathers's service model, and Bun's native SQLite. The goal is a framework you can understand completely in one sitting, ship real products with immediately, and extend without fighting the internals.

---

## Quick start

```bash
git clone <this repo>
cd packages/junction
bun run dev        # starts example/app.ts with --watch

# In another terminal — fire up the interactive REPL:
bun run repl
```

Or test manually with curl:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/users
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com"}'
```

Run the test suite:

```bash
bun test            # tests/ — 776 tests across 25 files
```

The example app is entirely in-memory — no database, no external services, runs immediately.

---

## Where Junction lives in an app

A FrontierJS app puts one directory at the root per realm, and Junction owns `api/`:

```
my-app/
├── db/                      ← Data realm — schema.lite, migrations
│   └── schema.lite
├── api/                     ← Junction. Everything below is yours
│   ├── index.ts             ← bun --watch entry
│   ├── config/              ← junction.config.js — autoload paths, plugins
│   ├── src/
│   │   ├── app.ts
│   │   ├── core/            ← env, Litestone client, auth, hooks
│   │   └── services/        ← *.service.ts — autoloaded at boot
│   └── test/
└── web/                     ← UI realm — Sierra + Mesa
```

Every sub-project uses the same folders — `config/` `src/` `public/` `test/` `dist/`
`deploy/` — so `api/config/junction.config.js` sits exactly where
`web/config/sierra.config.js` does.

`api/` and `web/` are peers, and `db/` belongs to neither — the schema is shared, so it
sits above both. The API points Litestone's `createClient` at that one file, and the UI
build reads the same one; nothing is copied down into either. The full layout is in the
[root README](../../README.md#project-structure); `fli create` scaffolds it.

---

## Structure

The package itself:

```
packages/junction/
├── index.ts              ← single public API — one import for everything
│
├── src/core/
│   ├── app.ts            ← createApp() — lifecycle, plugins, service routing
│   ├── service.ts        ← createService(), createBaseService(), callService()
│   ├── context.ts        ← ServiceContext, CallOptions, RequestMeta (ALS)
│   ├── envelope.ts       ← THE result envelope — wrap/unwrap, one owner
│   ├── hooks.ts          ← around/before/after/error pipeline
│   ├── hooks-builtin.ts  ← authenticate, requireRole, paginate, protect, …
│   ├── hooks-resilience.ts ← circuitBreaker, rateLimit
│   ├── litestone.ts      ← Litestone adapter, gateAuth, autoValidate
│   ├── schema.ts         ← createSchema(), v.* — zero-dep validation
│   ├── loader.ts         ← auto-discovery of *.service.ts files
│   ├── logger.ts         ← ILogger — pretty dev / JSON prod
│   ├── env.ts            ← defineEnv() — typed, validated at startup
│   └── errors.ts         ← named HTTP error classes
│
├── src/transport/
│   ├── http.ts           ← Bun.serve wrapper + public fetch() for tests
│   ├── router.ts         ← two-tier route cache (O(1) fixed + linear dynamic)
│   ├── bridge.ts         ← THE hard boundary between transport and services
│   ├── channels.ts       ← WebSocket channels, publish() hook, channels() plugin
│   ├── presence.ts       ← presence tracking + heartbeat
│   ├── health.ts         ← /health + /metrics endpoints (healthPlugin)
│   ├── body.ts           ← JSON / multipart / urlencoded parser
│   ├── static.ts         ← range requests, etag, gzip, cache headers
│   ├── types.ts          ← TransportContext, WsContext, WsHandlerSet, SSE types
│   └── middleware.ts     ← cors, helmet, rateLimit, requestLogger, correlationId
│
├── src/plugins/
│   ├── manifest/         ← manifestPlugin — schema + migration state at /manifest
│   ├── openapi/          ← openapi() plugin, generateOpenAPI() — 3.1 from the registry
│   ├── email/            ← mailer plugin, system + campaign senders
│   ├── webhooks/         ← at-least-once delivery, IWebhookStore, SQLite adapter
│   ├── devtools/         ← devtools plugin + admin UI
│   └── ai/, scheduler/   ← re-export shims for src/ai, src/scheduler
│
├── src/storage/
│   ├── database/index.ts    ← createDatabase() — WAL, foreign keys, migrations
│   └── filestorage/index.ts ← chunked disk storage, range, etag, stream
│
├── src/auth/
│   ├── types.ts          ← IAuth, SessionContext
│   └── providers/better-auth.ts
│
├── src/config/index.ts   ← loadConfig(), layered config files, deepMerge
├── src/events/index.ts   ← IEventBus (in-process, Redis-swappable interface)
├── src/cache/index.ts    ← ICache — in-memory
├── src/scheduler/index.ts ← cron + interval + once, aligned ticks
├── src/workers/index.ts  ← Bun native thread pool, auto-respawn
├── src/mail/index.ts     ← IMail + SMTP/Resend adapters
├── src/ai/index.ts       ← IAIModel interface + OpenAI + Anthropic adapters
├── src/client/index.ts   ← browser/Sierra client — service(), resource()
├── src/testing/index.ts  ← createTestApp(), request(), withTestMeta()
│
├── tools/                ← repl.ts, init.ts, setup.ts, build-app.ts, generators
├── example/              ← runnable apps (elegant.ts is the modern demo)
└── tests/                ← 25 files, 776 tests
```

---

## The REPL

The fastest way to explore a running API. Start your app, then in a second terminal:

```bash
bun run repl                              # connects to localhost:3000
bun run tools/repl.ts --port 4000
bun run tools/repl.ts --host staging.myapp.com --https
```

```
──────────────────────────────────────────────────────
  Junction REPL  → http://localhost:3000
──────────────────────────────────────────────────────
  tab  completes commands, paths & $vars
  type help for all commands  ·  ctrl+c to exit

○ › health
○ › get /users
○ › post /users {"name":"Alice","email":"a@b.com"}
● › auth my-token
● › set id = $_.id
● › get /users/$id
● › watch /health 2000
```

**Tab autocomplete** — commands, live API paths (fetched from `/metrics` on connect), and `$variable` names.

**Variables** — `$_` is auto-set to every response body. Named variables with `set`:

```
set payload {"name":"Alice","role":"admin"}
post /users $payload

set id = $_.id               ← capture a field from the last response
get /users/$id            ← expand in a path

last .data[0].email           ← dot-path extraction without a variable
inspect $_                    ← pretty-print last response
```

**Watch** — poll an endpoint on an interval. `ctrl+c` stops the watch without exiting.

**History replay** — `!3` replays history entry 3.

**Shortcuts** — `health`, `metrics`, `services` hit the built-in endpoints directly.

**Tutorial** — embedded interactive guide for onboarding new developers:

```
tutorial                    ← start from the beginning
tutorial auth               ← jump to the auth chapter
tutorial list               ← list all chapters (basics, auth, variables, power)
skip                        ← skip the current step
quit tutorial               ← pause (progress saved)
```

Four chapters, 18 hands-on steps. The REPL stays live throughout — you run real commands against your actual app and the tutorial validates what happened.

---

## The secret sauce

### 1. The transport bridge — `transport/bridge.ts`

**This is the most important file in the codebase.**

```
HTTP request
    ↓
bridge.toContext()   ← THE hard boundary
    ↓
hook pipeline
    ↓
service method
    ↓
bridge.toResponse()
    ↓
HTTP response
```

Nothing above the bridge ever touches `req`/`res`. Nothing below it knows what HTTP is. Services are completely transport-agnostic — the same service handles HTTP, WebSocket, and internal calls identically.

```typescript
bridge.toContext(httpCtx, 'users', 'users', 'http', app)  // HTTP
bridge.toContext(wsCtx,   'users', 'users', 'websocket', app) // WebSocket
bridge.internal('users',  'create', { name: 'Alice' })        // internal — zero HTTP
```

**The call context.** What every hook and service method sees, on every
transport. There is no `ctx.params` — it was an open bag whose contents
propagated into sub-calls, which is the FeathersJS shared-mutation footgun. It
is four typed fields instead, each with one propagation rule:

```typescript
ctx.auth.user       // WHO is calling. Frozen. Propagates to internal calls.
ctx.client.headers  // caller environment — ip, userAgent, headers. Read-only,
ctx.client.ip       //   propagates. `{}` on internal calls.
ctx.route.roomId    // path captures ({id}, {room}). Router-only; {} internal.
ctx.locals.db       // per-call scratch. FRESH {} every call, does NOT propagate
                    //   — a sub-service cannot reach its caller's locals.
```

Alongside them, the two halves of what used to be one query object:

```typescript
ctx.query       // FILTERS ONLY — becomes the WHERE clause. Never sees a `$`.
ctx.directives  // { limit, offset, orderBy, select, … } — how to SHAPE the
                //   result. The bridge translates `$limit` on the wire into
                //   this; nothing past the bridge reads a `$`.
```

Internal callers pass directives under their own key — a flat `{ limit: 10 }`
is not a directive and is ignored:

```typescript
await app.service('posts').find({ status: 'open' }, { directives: { limit: 10 } })
```

Request-wide values — correlation id, idempotency key, locale — belong to the
whole request rather than any one call, so they ride an `AsyncLocalStorage`
store instead of being threaded through arguments:

```typescript
import { requestMeta } from '@frontierjs/junction'
const { correlationId } = requestMeta() ?? {}   // readable at any call depth
```

`TransportContext.params` is a different thing and is unchanged: route and WS
handlers (`app.get('/x/{id}', ctx => ctx.params.id)`) keep working as before.
Route patterns use `{id}`, not `:id` — a `:id` segment is matched literally and
the route silently never fires.

### 2. The hook pipeline — `core/hooks.ts`

```
around:enter → before → [method] → after → around:exit
                              ↓
                         error (if thrown)
```

Cross-cutting concerns — auth, validation, rate limiting, caching, real-time push — all live in hooks and compose without touching service method bodies.

```typescript
createService({
  name: 'deployments',
  hooks: {
    around: { all: [logTiming(logger)] },
    before: {
      all:    [authenticate, requireWorkspace()],
      create: [requireRole('developer'), validate],
    },
    after: {
      all: [publish((_, ctx) => app.channel(`workspace:${ctx.auth.user?.workspaceId}`))],
    },
    error: { all: [logError] },
  },
})
```

**Short-circuit**: set `ctx.result` in a `before` hook to skip the method. This is how caching hooks work.

**Built-in hooks**: `authenticate`, `requireRole`, `paginate`, `protect`, `allow`, `timestamps`, `logTiming`, `circuitBreaker`, `rateLimit`.

`protect()` supports dot-path notation for nested fields:

```typescript
// Top-level field
service.hooks({ after: { all: [protect('passwordHash')] } })

// Nested field — strips user.meta.internal from every result
service.hooks({ after: { all: [protect('meta.internal', 'auth.refreshToken')] } })
```

**`rateLimit` hook** — per-service, per-method rate limiting. Keys on `userId` for authenticated requests, falls back to IP for anonymous. Different from `app.configure(rateLimit(...))` which applies globally to all HTTP routes.

```typescript
import { rateLimit } from '@frontierjs/junction'

// Per-service: limit create to 10/minute per user
app.services.register(createService({
  name: 'posts',
  hooks: {
    before: {
      create: [rateLimit({ max: 10, window: '1 minute' })],
      all:    [authenticate],
    }
  }
}))

// Custom key — rate limit by organisation
hooks: {
  before: {
    create: [rateLimit({
      max:     100,
      window:  '1 hour',
      key:     (ctx) => ctx.auth.user?.accountId ?? ctx.client.ip,
      message: 'Organisation limit reached',
    })]
  }
}
```

Note: `rateLimit` hook uses an in-process counter — correct for single-instance deployments. For multi-instance, provide a custom `key` function and an external counter (Redis, etc.) via a custom hook.

**`IEventBus.onAny()`** — subscribe to all events with the event name included:

```typescript
// Named subscription — no event name
app.events.on('orders:created', (data) => { /* data only */ })

// onAny — event name + data, unsubscribe function returned
const off = app.events.onAny((event, data) => {
  logger.info('event', { event, data })
})

// Useful for audit logs, metrics, and webhook fan-out
```

### 3. Custom methods as first-class citizens

Custom methods are defined directly on the service alongside CRUD — no separate wrapper needed.

```typescript
createService({
  name: 'servers',

  async reboot(ctx)    { /* ... */ },
  async heartbeat(ctx) { /* ... */ },
  async events(ctx)    { /* ... */ },

  hooks: {
    before: { reboot: [requireRole('developer')] },
  },
})
```

**Dispatch is by header, not by path** — *over HTTP*. A custom method follows the
same transport rule as CRUD: the browser client sends it over the WebSocket when
one is connected (a `service_call` frame naming the method, no URL involved), and
falls back to HTTP otherwise. The HTTP form calls the service's own URL with
`X-Service-Method`, which keeps the URL space flat and stops a method name from
colliding with a record id:

```bash
curl -X POST http://localhost:3000/servers \
  -H 'x-service-method: reboot' -H 'content-type: application/json' -d '{"id":1}'
```

There is no `POST /servers/1/reboot` route — that 404s. CRUD names are blocked
from header override, and the case you write is the case that dispatches
(`getStats` stays `getStats`).

Custom methods run through the full hook pipeline — identical to CRUD methods. Hook targets use the method name as the key.

Works the same when the service is model-backed — the generated CRUD and your custom methods sit side by side:

```typescript
createService({
  name:   'servers',
  model:  'servers',
  schema: jsonSchema,

  async reboot(ctx) {
    const db = ctx.locals.db
    return db.servers.update({ where: { id: ctx.id }, data: { status: 'rebooting' } })
  },

  hooks: {
    before: { reboot: [authenticate, requireRole('developer')] },
  },
})
```

### 4. WebSocket routing — `app.ws()`

Same `{param}` path syntax as HTTP routes. Handlers receive `WsContext` — params, query, headers, user all pre-resolved, no raw Bun types:

```typescript
app.ws('/chat/{roomId}', {
  open(ctx) {
    // ctx.params.roomId — extracted from the path
    // ctx.user          — auth resolved before open() is called
    ctx.send({ type: 'welcome', room: ctx.params.roomId })
  },
  message(ctx, msg) { ctx.send({ echo: msg }) },
  close(ctx, code, reason) { },
})
```

### 5. Channels — real-time without polling

```typescript
app.configure(channels(app => {
  app.channels.on('connection', (session, conn) => {
    if (session?.workspaceId)
      app.channel(`workspace:${session.workspaceId}`).join(conn)
  })
}))

// In a service hook
after: {
  create: [publish((_, ctx) => app.channel(`workspace:${ctx.auth.user?.workspaceId}`))],
}
```

Client: `{ type: 'event', event: 'deployments created', data: { ... } }`

### 6. Compiled hook pipelines

Hook pipelines are merged and compiled once per service during `app.start()`, after all plugins have registered. Per-request cost is a plain array lookup — no allocation, no merging.

---

## Response helpers

```typescript
ctx.json(data, status?)
ctx.text(data, status?)
ctx.html(data, status?)
ctx.empty(status?)
ctx.redirect(url, status?)
ctx.file(path, download?)
ctx.stream(readable, type, status?)

// Pagination envelope with next/prev links built from the request URL
ctx.paginate(rows, total, { limit, skip })
// → { data, total, limit, offset, next: '/posts?$offset=20&$limit=20', prev: null }

// Server-Sent Events
const { response, send, close, onDisconnect } = ctx.sse()
send({ event: 'update', data: { ts: Date.now() } })

// onDisconnect — fires when the client closes the connection.
// Use it to clean up timers and subscriptions — no more hard timeouts needed.
const off = app.events.on('orders:created', (order) => send({ event: 'order', data: order }))
const heartbeat = setInterval(() => send({ event: 'ping', data: {} }), 30_000)
onDisconnect(() => { off(); clearInterval(heartbeat) })

return response
```

---

## Health and metrics

```typescript
import { healthPlugin } from '@frontierjs/junction'

app.configure(healthPlugin())

// With auth, custom path, and custom readiness checks:
app.configure(healthPlugin({
  path:  '/_internal',
  token: process.env.METRICS_TOKEN,
  checks: {
    redis:      async () => { await redis.ping(); return true },
    thirdParty: async () => (await fetch('https://api.x.com/ping')).ok,
  },
}))
```

**`GET /health`** — `200` when healthy, `503` when any check fails. Safe as a Kubernetes `readinessProbe` / `livenessProbe` target.

**`GET /metrics`** — process memory, request counts, response types, WebSocket connections, cache hit rate, service registry.

---

## Middleware

```typescript
import { cors, helmet, rateLimit, requestLogger, correlationId, csrf } from '@frontierjs/junction'

app.configure(cors({ origins: ['https://myapp.com'] }))
app.configure(helmet())
app.configure(rateLimit({ limit: 100, window: 60_000 }))
app.configure(requestLogger())

// Generates/forwards X-Request-ID, stamps ctx.requestId, echoes in every response
app.configure(correlationId())

// CSRF protection for cookie-session APIs — see section below
app.configure(csrf({ origins: ['https://myapp.com'] }))
```

> **Rate limiting is per-process.** Counters live in memory and are not shared across workers or machines. For single-process deployments this is not an issue. For multi-process deployments, apply rate limiting at the load balancer layer (nginx `limit_req`, Cloudflare, Fly.io, etc.) in addition to or instead of this middleware.

---

## CSRF protection

The bearer token pattern (`Authorization: Bearer ...`) is **inherently CSRF-safe** — a cross-origin page cannot set arbitrary request headers, so it can never forge a bearer-token request on behalf of a victim. `csrf()` is only needed if your auth provider is configured to use **cookie-based sessions**.

```typescript
// Run cors() first so preflight is handled before csrf() checks the origin
app.configure(cors({ origins: ['https://myapp.com'] }))
app.configure(csrf({ origins: ['https://myapp.com'] }))
```

For every `POST/PUT/PATCH/DELETE` request it reads the `Origin` header, falls back to `Referer` if absent, and rejects with 403 if neither matches your allowed list.

**`combineOrigins()` — share one list between cors and csrf:**

```typescript
import { combineOrigins } from '@frontierjs/junction'

const origins = combineOrigins(['https://myapp.com', 'https://admin.myapp.com'])

app.configure(cors(origins.forCors()))   // passes origins as-is (supports '*')
app.configure(csrf(origins.forCsrf()))   // same list, '*' coerced to allow-all
```

**Full options:**

```typescript
// Function predicate — wildcard subdomains etc.
app.configure(csrf({ origins: (o) => o.endsWith('.myapp.com') }))

// Allow server-to-server calls with no origin (curl, internal services)
app.configure(csrf({ origins: ['https://myapp.com'], allowMissingOrigin: true }))

// Custom rejection handler — log instead of throwing
app.configure(csrf({
  origins:    ['https://myapp.com'],
  onRejected: (ctx, reason) => logger.warn('CSRF blocked', { reason, ip: ctx.ip }),
}))
```

**With Better Auth cookie sessions:**

```typescript
import { createBetterAuthAdapter, createBetterAuthPlugin } from '@frontierjs/junction'
import { combineOrigins } from '@frontierjs/junction'
import { betterAuth } from 'better-auth'

const betterAuthInstance = betterAuth({
  // ... Better Auth config
  // If you configure Better Auth to use cookies, CSRF protection is needed
  // for your app's own service routes (Better Auth protects its own /auth/* routes).
})

const auth    = createBetterAuthAdapter({ auth: betterAuthInstance })
const origins = combineOrigins(['https://myapp.com'])

const app = createApp({ config, auth })

// 1. cors() first — handles OPTIONS preflight before csrf() runs
app.configure(cors({ ...origins.forCors(), credentials: true }))

// 2. csrf() second — protects POST/PUT/PATCH/DELETE against cross-site requests
//    Only needed because Better Auth sets a session cookie
app.configure(csrf(origins.forCsrf()))

// 3. Mount Better Auth routes (/auth/sign-in, /auth/sign-out, etc.)
app.configure(createBetterAuthPlugin(betterAuthInstance))
```

If you use **bearer tokens only** (no cookies), omit `csrf()` entirely — bearer tokens are already CSRF-safe.

---

## Circuit breaker


```typescript
import { circuitBreaker } from '@frontierjs/junction'

service.hooks({
  around: {
    all: [circuitBreaker({
      threshold: 5,         // open after 5 consecutive failures
      timeout:   30_000,    // wait 30s before probing again (OPEN → HALF_OPEN)
      onOpen:    (ctx) => logger.warn(`Circuit open: ${ctx.service}`),
      onClose:   (ctx) => logger.info(`Circuit closed: ${ctx.service}`),
    })]
  }
})
```

Throws `Unavailable` (503) in open state so error hooks and logging still run.

---

## API versioning

```typescript
const app = createApp({
  config: { ...config, apiPrefix: '/api/v1' },
})
// All services now at: /api/v1/users, /api/v1/notes, etc.
// /health and /metrics are unaffected
```

Default is `''` — services mount at `/{service}`. Handles missing/extra slashes automatically, so `api`, `/api` and `/api/` all mean the same thing.

The browser client takes the same option and must be given the same value:

```typescript
createJunctionClient({ url, apiPrefix: '/api/v1' })
```

---

## Bulk operations

Bulk `patch` and `remove` without an `id` are disabled by default — a guard against accidental whole-table mutations:

```typescript
createService({
  name:      'logs',
  allowBulk: true,    // opt in explicitly
})
// DELETE /logs?status=archived  ← now allowed
// DELETE /logs                  ← still rejected (no filter conditions)
```

---

## Config options

| Key | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `3000` | HTTP port |
| `hostname` | `string` | `'0.0.0.0'` | Bind address |
| `apiPrefix` | `string` | `''` | Prefix for auto-routed service URLs — `''` mounts them at `/{service}` |
| `http.drainTimeout` | `number` | `5000` | ms to drain requests on shutdown |
| `http.compress` | `boolean` | `true` | gzip responses |
| `http.maxBodySize` | `number` | `262144` | max request body bytes |
| `cache.defaultTtl` | `string` | `'5 minutes'` | default cache entry TTL |

---

## Auth

```typescript
import { createBetterAuthAdapter, createBetterAuthPlugin } from '@frontierjs/junction'

const auth = createBetterAuthAdapter({ auth: betterAuthInstance })
const app  = createApp({ config, auth })
app.configure(createBetterAuthPlugin(betterAuthInstance))  // mounts /auth/* routes
```

`authenticate` hook reads `Authorization: Bearer` or `X-API-Key`, calls `auth.verifySession()`, stamps `ctx.auth.user`.

### Sessions from a cookie

Off by default. Turn it on and the transport reads the session token from a
cookie as well — on HTTP requests **and** on the WebSocket upgrade:

```typescript
app.http.setAuthCookie('session')      // or config: { auth: { cookie: 'session' } }
```

Using `@frontierjs/auth` you never write that: `createAuthPlugin(auth, { cookieAuth: true })`
declares it from its own `register()`, so cookie mode is one switch.

Three rules worth knowing:

- **Explicit beats ambient.** `Authorization: Bearer` and `X-API-Key` both win
  over the cookie, so acting as someone else for one call still works from a
  browser holding a session cookie.
- **An empty cookie is not a token** — that is what a logout leaves behind.
- **It is off by default for a security reason, not caution.** A bearer token has
  to be attached by script, so a cross-origin page cannot forge one. A cookie is
  attached by the browser automatically, which is what makes CSRF possible at
  all — so an app takes that exposure deliberately. What makes it safe once on is
  `SameSite=Lax` (which `@frontierjs/auth` sets): the browser withholds the
  cookie from cross-site writes. Set your own session cookie `SameSite=None` and
  you re-open the hole — see `csrf()` below.

**`SessionContext` shape** — what `ctx.auth.user` looks like inside hooks and services:

```typescript
interface SessionContext {
  userId:       string                           // always present
  userType:     string                           // 'user' | 'admin' | 'service'
  authMethod:   'session' | 'apiKey' | 'oauth'  // how they authenticated
                | 'created' | 'verified'
  email?:       string
  name?:        string
  accountId?:   string                           // multi-tenant account scope
  workspaceId?: string                           // multi-tenant workspace scope
  role?:        string
  scopes?:      string[]

  // Standing — read by sessionGateLevel() to grade a caller on Litestone's
  // 0–7 @@gate scale. `undefined` = the app doesn't model this stage (not an
  // objection); `null` = it does and this user hasn't reached it.
  verifiedAt?:     Date | string | null
  activatedAt?:    Date | string | null
  isAdmin?:        boolean    // → ADMINISTRATOR (5)
  isOwner?:        boolean    // → OWNER (6)
  isSystemAdmin?:  boolean    // → SYSADMIN (7)
}
```

**`IAuth` optional flow methods** — implement these on your auth adapter to support password reset and email verification. The plugin's route handlers call them if present.

```typescript
// Password reset flow
auth.requestPasswordReset?(email)                        // sends reset email
auth.confirmPasswordReset?(token, newPassword)           // consumes token, sets password

// Email verification flow
auth.requestEmailVerification?(userId)                   // sends verification email
auth.verifyEmail?(token)                                 // consumes token, returns session
```

These are optional on `IAuth` — if your provider handles them differently (e.g. Better Auth has its own email flows), implement them in the provider adapter or leave them unset and handle the routes yourself.

---

## Schema validation

```typescript
import { createSchema, v } from '@frontierjs/junction'

const CreateUserSchema = createSchema({
  name:     v.required.string({ minLength: 2, maxLength: 100, trim: true }),
  email:    v.required.email(),
  age:      v.number({ min: 0, max: 150 }),
  role:     v.string({ enum: ['user', 'admin'], default: 'user' }),
  tags:     v.array(v.string(), { minItems: 0, maxItems: 10 }),
  address:  v.object(AddressSchema),
})

// Use as a before hook
service.hooks({ before: { create: [CreateUserSchema.hook()] } })

// Or call directly
const data = CreateUserSchema.parse(ctx.data)   // throws BadRequest on failure
const { valid, errors } = CreateUserSchema.validate(raw)

// Schema combinators
const UpdateSchema  = CreateUserSchema.partial()          // all fields optional
const PublicSchema  = CreateUserSchema.omit('passwordHash')
const LoginSchema   = CreateUserSchema.pick('email', 'password')
```

**Convenience types** (`v.*` and `v.required.*`):

```typescript
v.string()        v.required.string()
v.number()        v.required.number()
v.boolean()       v.required.boolean()
v.email()         v.required.email()
v.url()           v.required.url()
v.uuid()          v.required.uuid()
v.date()          v.required.date()
v.array(items)    v.required.array(items)
v.object(schema)  v.required.object(schema)
v.any()
```

**Array constraints**: `minItems`, `maxItems` — `v.array(v.string(), { minItems: 1, maxItems: 5 })`.

**Passthrough unknown fields**:

```typescript
// Default: unknown fields are stripped (safe for APIs)
const Strict = createSchema({ name: v.required.string() })

// passthrough: true — extra fields flow through unchanged
const Loose = createSchema({ name: v.required.string() }, { passthrough: true })
```

---

## Service caching

Add `cache: true` to any service to automatically cache `find` and `get` responses. Writes (`create`, `patch`, `remove`) bust the cache for that service automatically.

```typescript
createService({
  name:  'products',
  cache: true,           // 30s TTL, auth-scoped automatically
})

// Custom TTL
createService({
  name:  'config',
  cache: { ttl: '5 minutes' },
})

// Custom key function — full control
createService({
  name:  'reports',
  cache: { keyBy: (ctx) => `report:${ctx.id}:${ctx.query.format}` },
})
```

Cache keys include the authenticated user's ID when present — `GET /orders` for user A never serves user B's cached result. Public routes share a single cache entry per query.

The underlying store is shared across all services. Override it at the app level with a SQLite-backed cache for persistence across restarts:

```typescript
import { setServiceCache, createSqliteCache } from '@frontierjs/junction'

setServiceCache(createSqliteCache({ path: './cache.db', defaultTtl: '1 minute' }))
```

---

## Database

```typescript
const app = createApp({ config, migrations: './migrations' })
// app.db ready on start() — app.db.db is the raw bun:sqlite Database
```

Production pragmas applied automatically: WAL mode, foreign keys, 5s busy timeout, 32MB page cache.

For tests: `createInMemoryDatabase()` gives the same interface with `:memory:`.

---

## Litestone ORM

[Litestone](https://github.com/frontierjs/litestone) is Junction's first-party SQLite ORM. When installed, `createService` replaces manual CRUD — all five methods are generated from the schema, validation is auto-generated from the JSON Schema output, and `@file` fields wire up to object storage transparently.

```typescript
import { createService, withLitestoneDb } from '@frontierjs/junction'
import { createClient, generateJsonSchema, GatePlugin, LEVELS } from '@frontierjs/litestone'

const SCHEMA = `
  model Post {
    id        Int  @id
    title     String     @length(1, 200) @trim
    body      String
    authorId  Int
    createdAt DateTime @default(now())
    updatedAt DateTime @default(now()) @updatedAt

    @@gate("0.4.4.6")   // R=public  C/U=USER  D=OWNER
  }
`

const db = await createClient('./app.db', SCHEMA, {
  plugins: [new GatePlugin({ async getLevel(user) {
    if (!user) return LEVELS.STRANGER
    return (user as { role: string }).role === 'admin' ? LEVELS.ADMINISTRATOR : LEVELS.USER
  }})]
})

const jsonSchema = generateJsonSchema(db.$schema)

// Wire per-request auth scoping — runs as an around hook before every service call
app.hooks({ around: { all: [withLitestoneDb(db)] } })

// createService generates find/get/create/patch/remove automatically.
// schema: jsonSchema auto-generates create + patch validators from the Litestone schema.
app.services.register(createService({
  name:       'posts',
  model:      'post',      // optional — resolved per call from the service name
                            //   ('posts' → db.post) when omitted
  schema:     jsonSchema,   // optional — enables auto-validation
  softDelete: 'deletedAt',  // optional — soft-delete via a nullable DateTime field
  allowBulk:  false,        // optional — default false, blocks bulk patch/delete
  cache:      true,         // optional — cache find/get responses, bust on writes
  methods:    ['find','get'],  // optional — narrow what this service answers.
                               //   Omitted = everything. See below.
  hooks: {
    before: {
      create: [authenticate],
      patch:  [authenticate],
      remove: [authenticate],
    },
  },
}))
```

### `methods:` — what a service does *not* answer

A model service answers every CRUD verb through the base **with validation**,
whether or not your file declares one. Writing only `find()` does not make a
service read-only; it makes the writes invisible. An append-only audit trail
built that way accepts a forged `POST`.

Declare the narrower set with one key. Two forms:

```typescript
createService({ name: 'audit',   model: 'AuditEvent', methods: 'readOnly' })
createService({ name: 'tickets', methods: ['find', 'create', 'approve'] })
```

- **Omitted means everything** — existing services are unaffected.
- `'readOnly'` is shorthand for `['find', 'get']`.
- **CRUD and custom actions share the list.** Being defined on the service is
  not being offered; an action the list omits is refused like any verb.
- An unlisted method answers **405**, on every transport *and* to an in-process
  `app.service('audit').create()` — the check is in `callService`, which every
  caller goes through, so a job or a hook cannot do what a request cannot.
- A name the service does not have **throws at construction**, so `['find','gett']`
  fails immediately instead of silently blocking `get`.
- `/manifest`, `/metrics` and the OpenAPI spec all filter by the policy, so what
  a service answers and what it advertises cannot drift.

Because the policy is structural rather than authorization, it is checked ahead
of the hook pipeline — an anonymous caller gets 405, not 401.

**`withLitestoneDb(db)`** attaches the base Litestone client to `ctx.locals.db` as an around hook. Auth scoping (`$setAuth`) happens inside `getTable()` at call time — after the `authenticate` hook has run — so the right user is always applied to every query.

**`deriveModelName`** converts a service name to a Litestone model name: `'users'` → `'user'`, `'blogPosts'` → `'blogPost'`. Pass `model` explicitly if your naming doesn't follow this pattern.

**`jsonSchemaToJunctionSchema`** is available directly if you need to build a schema manually:

```typescript
import { jsonSchemaToJunctionSchema } from '@frontierjs/junction'

const schema = jsonSchemaToJunctionSchema('Post', jsonSchema, 'create')
// Returns a Junction Schema object — pass to createSchema()
```

---

## Transactions

Multi-step operations that need atomicity — create a user and a workspace together, or not at all — require a transaction. Litestone exposes `db.$transaction()` for this.

```typescript
createService({
  name: 'accounts',

  async provision(ctx) {
    const db = ctx.locals.db

    return db.$transaction(async (tx) => {
      const user      = await tx.users.create({ data: ctx.data })
      const workspace = await tx.workspaces.create({ data: { ownerId: user.id } })
      return { user, workspace }
    })
  },

  hooks: {
    before: { provision: [authenticate] },
  },
})
```

**What this bypasses — be explicit:**

- Service hooks on `users` and `workspaces` do not run — no `before`/`after` hooks on the individual writes
- No real-time events fire for the individual writes inside the transaction
- Gate rules on the sub-models are bypassed — the gate on the calling service (`accounts`) is still enforced
- Cache is not busted for affected services automatically

**When this is acceptable:**

- The operation is internal and has no real-time subscribers on the individual sub-writes
- The calling service's own hooks handle any necessary side effects (e.g. an `after` hook on `provision` that publishes a single composite event)
- Consistency matters more than the hook pipeline for this operation

```typescript
// Handle side effects in the provision service's own after hook
createService({
  name: 'accounts',
  async provision(ctx) { /* ... db.$transaction(...) ... */ },
  hooks: {
    after: {
      provision: [
        // Publish once after the whole transaction succeeds
        publish((_r, ctx) => app.channel('accounts')),
        // Bust cache for affected services explicitly
        async () => { bustServiceCache('users'); bustServiceCache('workspaces') },
      ]
    }
  }
})
```

> ⚠️ **V2 — `app.transaction()`** will provide a transaction-aware service caller that preserves the hook pipeline and defers events until commit. Until then, `db.$transaction()` is the documented escape hatch with the tradeoffs above.

---

## File uploads

Junction handles multipart file uploads transparently. The bridge merges uploaded files into `ctx.data` as native `File` objects before the service method runs — no special handling required in service code.

**Receiving a file upload** — clients `POST` or `PATCH` with `multipart/form-data`:

```bash
curl -X PATCH https://api.example.com/users/1 \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=Alice" \
  -F "avatar=@photo.jpg"
```

`ctx.data` arrives as `{ name: 'Alice', avatar: File }` — all standard text fields and file fields merged together. When using Litestone with `@file` / `File?` fields, the `FileStorage` plugin detects the `File` instance, uploads to R2/S3, and stores a JSON ref in SQLite. The service never knows storage happened.

**Accessing files in custom routes** — use `ctx.files` (already parsed, no manual `formData()` call):

```typescript
app.patch('/users/{id}/avatar', async ctx => {
  const upload = ctx.files.find(f => f.name === 'avatar')
  if (!upload) return ctx.json({ message: 'avatar file required' }, 400)

  const file = new File([upload.data], upload.filename, { type: upload.type })
  // pass file to your storage layer
})
```

**Expanding file refs in responses** — Litestone stores file references as JSON. Use an after hook to expand them to URLs before the response goes out:

```typescript
import { fileUrl } from '@frontierjs/litestone'

app.services.register(createService({
  name: 'users',
  hooks: {
    after: {
      all: [async (ctx) => {
        const rows = Array.isArray(ctx.result) ? ctx.result
          : (ctx.result as Record<string, unknown>)?.data ?? [ctx.result]
        for (const row of rows as Record<string, unknown>[]) {
          if (row.avatar) row.avatar = fileUrl(row.avatar as string) ?? row.avatar
        }
      }],
    },
  },
}))
```

**Presigned uploads — not supported yet.** This section used to show a
`/avatar/presign` route built on `storage.sign(key)`. That code cannot work:
litestone's `useStorage().sign(value)` signs an **existing stored reference**
(it runs the value through `parseRef()` and throws `invalid file reference` on
a bare key), and the URL it returns is a **GET** — `provider.sign()` calls
`presignUrl('GET', …)`. Nothing in litestone signs a PUT, so there is no upload
URL to hand a browser.

Presigned uploads need a `signUpload(key, { expiresIn, contentType })` on the
storage provider — litestone's `presignUrl(method, …)` already takes a method,
so the primitive is there, but the API is not. Until then, upload multipart
through the API (the pattern above) and let the FileStorage plugin do the
put.

---



```typescript
import { createTestApp, testCtx, request, callService } from '@frontierjs/junction'

const app = await createTestApp({
  services: [createNotesService],
  users:    [{ id: 'u1', role: 'admin' }],
})

// Direct service call — no HTTP at all
const ctx = testCtx('notes', 'create', { title: 'Hello' }, { user: { user_id: 'u1' } })
await callService(app.services.get('notes')!, ctx)
expect(ctx.result.title).toBe('Hello')

// HTTP-style assertion — no real port
// Supports: .get() .post() .patch() .put() .delete() .options()
const res = await request(app)
  .post('/notes')
  .auth(app.tokenFor('u1'))
  .send({ title: 'Hello', body: 'World' })
expect(res.status).toBe(201)   // create returns 201 by default
```

**Lifecycle:** `createTestApp` returns a fully wired app without binding a port. The first `request()` call lazily runs `_startForTest()` — which fires all queued plugin `register()` calls, registers service routes, and compiles hook pipelines. This means you can call `app.configure(middleware)` freely between `createTestApp()` and the first request and the middleware will wrap the routes correctly.

```typescript
const app = await createTestApp({ services: [...] })
app.configure(cors({ origins: ['https://myapp.com'] }))  // queued
app.configure(csrf({ origins: ['https://myapp.com'] }))  // queued
// First request call triggers _startForTest() → plugins run → routes registered
const res = await request(app).options('/notes')
expect(res.status).toBe(204)
```
```

---

## OpenAPI

```typescript
app.configure(openapi({
  title:   'My API',
  version: '1.0.0',
  ui:      '/docs',
  schemas: { notes: { create: { body: CreateNoteSchema } } },
}))
// GET /openapi.json  — machine-readable spec
// GET /docs          — Swagger UI (CDN, no extra deps)
```

The generator respects `config.apiPrefix` — if your routes live at `/api/v2`, the spec paths will too. The default endpoint also moves: `/api/v2/openapi.json`.

Schema registration improves the generated docs. Both raw `Schema` objects and compiled `CompiledSchema` objects work — compiled schemas expose their field definitions automatically:

```typescript
import { createSchema, v } from '@frontierjs/junction'

const CreateNoteSchema = createSchema({
  title: v.required.string({ minLength: 1, maxLength: 200 }),
  body:  v.string(),
  tags:  v.array(v.string(), { maxItems: 10 }),
})

app.configure(openapi({
  title:   'Notes API',
  version: '1.0.0',
  schemas: {
    notes: {
      create: { body: CreateNoteSchema },   // compiled schema — fields introspected automatically
      find:   { response: CreateNoteSchema },
    },
  },
}))
```

Action schemas are also supported:

```typescript
schemas: {
  servers: {
    reboot: { body: RebootOptionsSchema, response: JobSchema },
  },
}
```

---

## Webhooks

At-least-once webhook delivery built on the existing event bus. Every service mutation that fires `orders:created` etc. automatically fans out to registered HTTP endpoints with signed payloads and exponential-backoff retries.

```typescript
import { webhooks } from '@frontierjs/junction'

app.configure(webhooks({
  events: ['orders:created', 'orders:patched', 'users:created'],
  // or catch everything:
  // events: ['*'],
}))
```

The plugin listens for declared events, writes a `webhook_deliveries` row, fires the HTTP request immediately, and schedules retries on failure: 1m → 5m → 30m → 2h → 8h → 24h. After 7 attempts the delivery is marked `dead` and stays in the table permanently.

**Registering a subscriber:**

```typescript
const hook = await app.webhooks.register(
  'https://partner.com/hooks/orders',
  ['orders:created', 'orders:patched']
)
// hook.secret — show once; the receiver stores this to verify signatures
```

**Verifying a payload on the receiver:**

```typescript
// Every delivery sends:
//   X-Webhook-Signature: sha256=<hmac>   ← HMAC-SHA256 over `${timestamp}.${rawBody}`
//   X-Webhook-Timestamp: <unix seconds>
//   X-Webhook-Event:     orders:created
//   X-Webhook-Id:        <delivery id>

import { createHmac } from 'node:crypto'

function verify(secret: string, timestamp: string, rawBody: string, sig: string) {
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`).digest('hex')
  return expected === sig
}
```

**Other API:**

```typescript
await app.webhooks.deliver('orders:created', payload)  // manual fan-out
await app.webhooks.retry(deliveryId)                   // force-retry a dead delivery
const list = await app.webhooks.list()                  // all registrations
const log  = await app.webhooks.deliveries(hookId)     // delivery history
```

**HTTP management routes** (auto-registered, guard with your own auth middleware):

| Route | Description |
|---|---|
| `GET {apiPrefix}/webhooks` | list registrations |
| `POST {apiPrefix}/webhooks` | register `{ url, events }` |
| `DELETE {apiPrefix}/webhooks/:id` | unregister |
| `POST {apiPrefix}/webhooks/:id/test` | fire a test ping |
| `GET {apiPrefix}/webhook-deliveries` | delivery history |
| `POST {apiPrefix}/webhook-deliveries/:id/retry` | manually retry |

**REPL commands:**

```
webhooks                                  list registrations
webhooks add https://x.com/h event [...]  register
webhooks remove <id>                      unregister
webhooks deliveries [webhook-id]          delivery log
webhooks retry <delivery-id>              force-retry dead/failed
webhooks test <webhook-id>                fire a test ping
```

**Custom store** — implement `IWebhookStore` for Postgres, Redis, etc.:

```typescript
app.configure(webhooks({ events: ['*'], store: myPostgresStore }))
```

---

## Scheduler

```typescript
app.scheduler.every('5 minutes', async () => { /* cleanup */ })
app.scheduler.cron('0 2 * * *',  async () => { /* backup */ })
app.scheduler.once('30 seconds', async () => { /* warmup */ })
```

---

---

## Browser client

`@frontierjs/junction/client` is a zero-dependency browser client for connecting Sierra/Mesa frontends (or any browser app) to a Junction API. Import as ESM or bundle with Vite.

```typescript
import { createJunctionClient } from '@frontierjs/junction/client'

const client = createJunctionClient({ url: 'http://localhost:3000' })

// Authenticate — stores token automatically
const { token } = await client.authenticate({ email: 'alice@example.com', password: 'secret' })

// Or set a token directly (e.g. from localStorage)
client.setToken(token)

// Connect WebSocket for real-time events — must call after setToken()
client.connect()
```

**Service proxy** — CRUD methods prefer WebSocket when connected, fall back to HTTP automatically. File uploads always use HTTP (multipart/form-data):

```typescript
const posts = client.service('posts')

// TypeScript — typed generic (optional, JS users omit)
const posts = client.service<Post>('posts')

// find(query?, params?) → ListResult<T> — the list envelope, same as HTTP
const res  = await posts.find({ status: 'published' }, { limit: 20 })
res.data     // the rows
res.total    // total matching — pagination works in the browser too
const rows = await posts.findData({ status: 'published' })  // rows only
// A find that answers anything but a list throws ResultShapeError, at the server
// and in the browser. find means a list; a service answering one thing gives it
// a name and is called as an action, which is handed back whole.

// get(id) or get(query) → T  (query form uses $first routing)
const post    = await posts.get(1)
const first   = await posts.get({ status: 'draft' })   // findFirst

// create(data) → T
const newPost = await posts.create({ title: 'Hello', body: 'World' })

// patch(id, data) or patch(query, data) → T | T[]
await posts.patch(1, { title: 'Updated' })
await posts.patch({ status: 'draft' }, { status: 'published' })  // bulk → T[]

// remove(id) → T  /  remove(query) → string[]  (ids)
await posts.remove(1)
await posts.remove({ status: 'archived' })   // bulk → id[]

// restore(id) or restore(query) — soft-delete reversal
await posts.restore(1)

// upsert — data.id != null → patch, else → create
await posts.upsert({ id: 1, title: 'Updated' })
await posts.upsert({ title: 'New' })

// File upload — detected automatically, sent as multipart/form-data
const file = input.files[0]
await posts.create({ title: 'With image', cover: file })
```

**Real-time events** — the server broadcasts mutations over WebSocket:

```typescript
posts.on('created', (post) => console.log('new post', post))
posts.on('patched', (post) => updateRow(post))
posts.on('removed', (post) => removeRow(post))

// A custom action announces under its own name — no past tense is invented.
posts.on('publish', (post) => updateRow(post))
```

Reads never announce. An action that only reads says so with `ctx.dispatch =
false`, which suppresses the broadcast to browsers and the in-process bus alike.

**`resource()`** — convenience wrapper that combines a service proxy, a reactive `Store`, and a `load()` function. The store stays in sync with real-time events automatically:

```typescript
const { service, store, load } = client.resource('posts')

// Initial fetch from server — load(query?, params?)
await load({ status: 'active' })

// Subscribe to changes — emits immediately with current value
store.subscribe(posts => render(posts))

// Mutations update the store via WS events
await service.create({ title: 'New post' })  // store auto-updates on 'created' event
```

**`Store<T>`** is framework-agnostic. Works with Svelte, Mesa, or plain JS:

```typescript
// Svelte
const posts = writable([])
store.subscribe(v => posts.set(v))

// Mesa
const posts = useStore(store)   // reactive binding

// Plain JS
store.subscribe(list => document.querySelector('#count').textContent = list.length)

// Direct manipulation
store.upsert({ id: 1, title: 'Updated' })   // upsert by id
store.remove(1)                              // remove by id
store.set([])                                // replace all
```

**URL normalisation** — pass `http://`, `https://`, `ws://`, or `wss://` — the client normalises to `http(s)://` for requests and converts back to `ws(s)://` for the WebSocket connection:

```typescript
createJunctionClient({ url: 'ws://localhost:3000' })   // works fine
createJunctionClient({ url: 'wss://api.example.com' }) // works fine
```

---

## Email

Junction ships a built-in email plugin with two independent tiers. Start with zero-config native SMTP and upgrade to a third-party provider later — without changing any call sites.

```typescript
import { email } from '@frontierjs/junction/email'
```

---

### Tier 1 — Native SMTP (zero dependencies)

Point it at any SMTP server and it works. No external packages, no accounts, no API keys. Bun handles the TCP connection natively.

```typescript
app.configure(email({
  system: {
    from: 'system@acme.com',
    smtp: {
      host: env.SMTP_HOST,  // your mail server, Google Workspace, Zoho, local Postfix
      port: 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    }
  }
}))
```

Send from anywhere you have access to `app`:

```typescript
await app.email.system.send({
  to:      'alice@example.com',
  subject: 'Your password has been reset',
  html:    '<p>Click here to set a new password.</p>',
  text:    'Visit https://... to set a new password.',  // plain-text fallback
})
```

**SMTP ports:**

| Port | Protocol     | Notes |
|------|--------------|-------|
| 587  | STARTTLS     | Default — plain TCP upgraded to TLS after connect |
| 465  | Implicit TLS | `tls` auto-enabled |
| 25   | Plain        | Blocked by most providers |

`AUTH PLAIN` is used when the server supports it, falls back to `AUTH LOGIN`. Both methods are only sent after the connection is encrypted.

This tier is for system notifications — password resets, account alerts, admin emails. The audience is always known users of your system.

---

### Tier 2 — Third-party providers via Conduit

When you need higher deliverability, open rate tracking, or bulk sending, add a provider. Tier 2 routes through [Conduit](#tier-1-plugins) — register your provider as a Conduit target, tell the email plugin which target to use, and `app.email.campaign.send()` handles the rest.

Supported providers (auto-detected from the target address): **Resend**, **Postmark**, **Sendgrid**.

**Step 1 — configure Conduit with your provider:**

```typescript
import { conduit } from '@frontierjs/conduit'

app.configure(conduit({
  targets: [{
    id:            'provider:resend',
    kind:          'provider',
    protocol:      'http',
    address:       'https://api.resend.com',
    auth:          { type: 'bearer', token: env.RESEND_API_KEY },
    registered_at: Date.now(),
    last_seen_at:  null,
  }]
}))
```

**Step 2 — add `campaign` to the email config:**

```typescript
app.configure(email({
  system: {
    from: 'system@acme.com',
    smtp: { host: env.SMTP_HOST, port: 587, user: env.SMTP_USER, pass: env.SMTP_PASS },
  },
  campaign: {
    target: 'provider:resend',  // matches the Conduit target id
    from:   'hello@acme.com',
  },
}))
```

**Step 3 — send:**

```typescript
// System email — goes through native SMTP, unchanged
await app.email.system.send({ to, subject, html })

// Campaign email — goes through Resend (or Postmark, Sendgrid)
await app.email.campaign.send({ to, subject, html })
// result.status: 'sent' | 'queued'
// 'queued' means the provider accepted it — Sendgrid returns 202
```

Swapping providers later is a one-line change to the Conduit target. The rest of your code stays the same.

---

### Hook factories

Send email as part of a service hook without boilerplate. Failures are logged and swallowed by default so a transient SMTP hiccup never rolls back a successful write operation. Set `optional: false` when delivery must be confirmed.

```typescript
import { sendSystemEmail, sendCampaignEmail } from '@frontierjs/junction/email'

app.service('users').hooks({
  after: {
    create: [
      // Welcome email — optional (default): SMTP failure is logged, not thrown
      sendSystemEmail(app, ctx => ({
        to:      (ctx.result as { email: string }).email,
        subject: 'Welcome to Acme',
        html:    `<p>Your account is ready.</p>`,
      })),
    ],
    patch: [
      // Password reset — optional: false: failure throws and the patch is rolled back
      sendSystemEmail(app, ctx => ({
        to:      (ctx.result as { email: string }).email,
        subject: 'Your password was changed',
        html:    `<p>If this wasn't you, contact support.</p>`,
      }), { optional: false }),
    ],
  }
})
```

`sendCampaignEmail` has the same signature — swap it in when you want a send to go through your Tier 2 provider instead.

---


## Tier 1 Plugins

First-party plugins built specifically for Junction. Each is a separate package that wires into Junction via `app.configure()` and integrates cleanly with the hook pipeline, `/metrics`, and the plugin lifecycle.

### `@frontierjs/caravan` — Job Queue

SQLite-backed background job queue. Zero external dependencies. Jobs survive process restarts.

```ts
import { createCaravan } from '@frontierjs/caravan'

const queue = createCaravan({
  db:      './jobs.db',       // default
  queues: {
    default:  { concurrency: 2 },
    critical: { concurrency: 5 },
    email:    { concurrency: 1 },
  },
  jobsDir: './jobs',          // autoload *.job.ts files
})

app.configure(queue)

// Dispatch from anywhere
await app.jobs.dispatch('send-email', { to: 'alice@example.com' })
await app.jobs.dispatch('provision-account', { userId: '123' }, {
  queue:    'critical',
  delay:    5_000,
  priority: 10,
})

// Register handlers
app.jobs.handle('send-email', async (job) => {
  await mailer.send(job.data)
}, { queue: 'email', maxAttempts: 5, retryDelay: [60_000, 300_000, 1_800_000] })
```

File-based handlers via `defineJob()` — mirrors `autoloadServices`:

```ts
// jobs/send-email.job.ts
import { defineJob } from '@frontierjs/caravan'

export default defineJob('send-email', async (job) => {
  await mailer.send(job.data)
}, { queue: 'email', maxAttempts: 5 })
```

Job stats are automatically included in `GET /metrics` under `jobs`:

```json
"jobs": {
  "queues": { "default": { "pending": 4, "running": 2, "dead": 1 } },
  "total":  { "pending": 4, "running": 2, "dead": 1 }
}
```

Dead jobs (exhausted retries) stay in the database — use `app.jobs.retry(id)` to re-queue them.

---

### `@frontierjs/conduit` — Outbound Transport

One interface for talking to third-party systems — REST APIs, server agents, local processes. Abstracts HTTP, WebSocket, and Unix socket protocols behind a single `send()` call.

```ts
import { conduit }           from '@frontierjs/conduit'
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'

app.configure(conduit({
  store:   createSQLiteStore(app.db.db),  // persist targets across restarts
  targets: [
    {
      id:       'provider:hetzner',
      kind:     'provider',
      protocol: 'http',
      address:  'https://api.hetzner.cloud/v1',
      auth:     { type: 'bearer', token: process.env.HETZNER_TOKEN },
    },
  ],
  management: true,   // registers a service at {apiPrefix}/conduit-targets
                      // (rename with `management: { path: '…' }` — one path
                      //  segment, no slashes)
}))

// Send from anywhere — hooks, services, routes
const result = await app.conduit.send({
  target: 'provider:hetzner',
  method: 'GET',
  path:   '/servers',
})

// Register targets at runtime (e.g. when an agent connects)
await app.conduit.register({
  id:       'agent:srv-abc',
  kind:     'agent',
  protocol: 'websocket',
  address:  'ws://10.0.0.5:7700',
  auth:     { type: 'hmac', secret: process.env.AGENT_SECRET },
})
```

Streaming for agents that push data:

```ts
for await (const chunk of app.conduit.stream({ target: 'agent:srv-abc', method: 'logs' })) {
  console.log(chunk.data)
}
```

Conduit stats appear in `GET /metrics` under `conduit`:

```json
"conduit": {
  "targets": { "total": 3, "byKind": { "provider": 1, "agent": 2 }, "byProtocol": { "http": 1, "websocket": 2 } }
}
```

Testing with stub transports — no real HTTP calls:

```ts
import { createTestConduit } from '@frontierjs/conduit/testing'

const { conduit, stubs } = createTestConduit({
  'provider:hetzner': { '/servers': [{ id: 1, status: 'running' }] },
})

expect(stubs['provider:hetzner'].calls).toHaveLength(1)
```

---

## Interface-first adapters

| Subsystem    | Interface      | Swap to                    |
|---|---|---|
| Auth         | `IAuth`        | Better Auth, Clerk, custom |
| Mail         | `IMail`        | Resend, Postal, SMTP       |
| AI           | `IAIModel`     | OpenAI, Anthropic, Ollama  |
| Cache        | `ICache`       | memory, SQLite, Redis       |
| Events       | `IEventBus`    | in-process (`on`, `once`, `onAny`), Redis pub/sub  |
| File storage | `IFileStorage` | disk, S3, R2               |

The blast radius of swapping a provider is exactly one file.

---

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start example app with `--watch` |
| `bun run start` | Start in production mode |
| `bun test` | Run the full test suite |
| `bun run repl` | Open the interactive REPL |
| `bun run tools/repl.ts --port 4000` | REPL on a custom port |
| `bun run tools/repl.ts --host x.com --https` | REPL against a remote host |
| `bun run build:app ./app.ts` | Bundle an app for deployment |

---

## Deploying

`bun run build:app <entry>` (also `junction build <entry>`) turns an app into a deployable artifact.

```bash
bun run build:app ./app.ts                        # → dist/app/app.js   ~348 KB
bun run build:app ./app.ts --mode=binary          # → dist/app/app       ~95 MB
bun run build:app ./app.ts --mode=docker          # + a matching Dockerfile
bun run build:app ./app.ts --mode=docker --artifact=binary --target=bun-linux-x64-musl
```

| Mode | Output | Needs on the host |
|---|---|---|
| `js` *(default)* | one bundled `.js`, app + framework inlined | bun |
| `binary` | `--compile` executable, Bun runtime embedded | nothing |
| `docker` | either artifact plus a `Dockerfile` and `.dockerignore` | docker |

`js` is the default because it is ~270× smaller and most hosts already have a bun image. Both artifacts read `PORT` from the environment.

Generated Dockerfiles pick a base image from what the artifact actually links against — `oven/bun:1-slim` for js, `debian:bookworm-slim` for glibc binaries, and `alpine:3.20` plus `apk add libstdc++` for `-musl` targets. Neither binary is statically linked, so `scratch` will not work. The base image architecture must match `--target`.

Other options: `--outdir`, `--port` (Dockerfile `ENV`/`EXPOSE`, default 80), `--no-minify`, `--sourcemap`, `--allow-autoload`.

### Autoload does not survive bundling

This is the one thing that will bite you. A bundled app **must register its services statically** and set `autoload: false`:

```ts
import { createMessagesService } from './messages.service.ts'

const app = createApp({ autoload: false, config: { /* … */ } })
app.services.register(createMessagesService())
```

Directory autoload fails in a bundled build for two independent reasons:

1. The scan root resolves against `Bun.main` — the **output** file, not your source tree. Bundling `./app.ts` to `./dist/app.js` makes junction look for `./dist/services`; inside a compiled binary it looks in `/$bunfs/root`.
2. `findServiceFiles()` globs `**/*.service.ts` — TypeScript source only. Bundled `.js` services are invisible to it, so shipping them alongside does not help.

A missing services directory is a deliberate no-op, so nothing throws. You get a clean boot logging `"services":0` and a 404 on every autoloaded route.

`build:app` guards against this: it **errors** when it finds a services directory that would be skipped, and **warns** when it cannot rule the case out (no `autoload: false` in the entry, or a `junction.config.js` that may set `services.dir`). The one exception it allows silently is an in-place `js` build — `--outdir` equal to the entry's directory — where the output sits beside the original `.ts` services and autoload genuinely still works.

### Not Cloudflare Workers

`bun build --target` accepts only `browser`, `bun`, and `node`. Junction is built on `Bun.serve`, `bun:sqlite`, `Bun.file`, and `Bun.main`, none of which exist on workerd. Running on Workers would mean replacing the transport with a `fetch` handler and the database layer with D1 — an architecture port, not a build flag. Container-based hosts (CapRover, Fly, Railway, Cloudflare's container product) work like any other Docker target.

---

## Dependencies

**Runtime**: `bun >= 1.0.0`

**Framework core**: zero external dependencies. Router, hook pipeline, logger, schema validator, scheduler, event bus, cache, body parser, static serving, WebSocket routing — all built on Bun's native APIs.

**Optional**: `better-auth` (auth), `resend` (mail), `zenstack` + `@zenstackhq/runtime` (ORM). Each isolated behind an interface — none required to run the framework.
