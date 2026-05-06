# Junction

A pragmatic, batteries-included backend framework for Bun. Built on three ideas: Total.js's transport performance, Feathers's service model, and Bun's native SQLite. The goal is a framework you can understand completely in one sitting, ship real products with immediately, and extend without fighting the internals.

---

## Quick start

```bash
git clone <this repo>
cd framework
bun run dev        # starts example/app.ts with --watch

# In another terminal — fire up the interactive REPL:
bun run repl
```

Or test manually with curl:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/users
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com"}'
```

Run the test suite:

```bash
bun test tests/index.test.ts
```

The example app is entirely in-memory — no database, no external services, runs immediately.

---

## Structure

```
framework/
├── index.ts              ← single public API — one import for everything
│
├── core/
│   ├── app.ts            ← createApp() — lifecycle, plugins, service routing
│   ├── service.ts        ← createService(), ServiceRegistry, callService()
│   ├── hooks.ts          ← around/before/after/error pipeline + built-in hooks
│   ├── schema.ts         ← createSchema(), v.* — zero-dep validation
│   ├── loader.ts         ← auto-discovery of *.service.ts files
│   ├── logger.ts         ← ILogger — pretty dev / JSON prod
│   └── errors.ts         ← 15 named HTTP error classes
│
├── transport/
│   ├── http.ts           ← Bun.serve wrapper + public fetch() for tests
│   ├── router.ts         ← two-tier route cache (O(1) fixed + linear dynamic)
│   ├── bridge.ts         ← THE hard boundary between transport and services
│   ├── channels.ts       ← WebSocket channels, publish() hook, channels() plugin
│   ├── health.ts         ← /health + /metrics endpoints (healthPlugin)
│   ├── body.ts           ← JSON / multipart / urlencoded parser
│   ├── static.ts         ← range requests, etag, gzip, cache headers
│   ├── types.ts          ← TransportContext, WsContext, WsHandlerSet, SSE types
│   └── middleware.ts     ← cors, helmet, rateLimit, requestLogger, correlationId
│
├── database/
│   └── index.ts          ← createDatabase(), createInMemoryDatabase()
│                            WAL mode, foreign keys, migration runner
│
├── testing/
│   └── index.ts          ← createTestApp(), request(), testCtx(), createStubAuth()
│                            no real server, no ports, all in-memory
│
├── openapi/
│   └── index.ts          ← openapi() plugin, generateOpenAPI()
│                            auto-generates 3.1 spec from service registry
│
├── auth/
│   ├── types.ts          ← IAuth interface
│   └── providers/
│       └── better-auth.ts ← Better Auth adapter
│
├── config/index.ts       ← loadConfig(), layered TS config files, defaultConfig
├── events/index.ts       ← IEventBus (in-process, Redis-swappable interface)
├── cache/index.ts        ← ICache — memory + SQLite backends
├── scheduler/index.ts    ← cron + interval + once, aligned ticks
├── workers/index.ts      ← Bun native thread pool, auto-respawn
├── filestorage/index.ts  ← chunked disk storage, range, etag, stream
├── mail/index.ts         ← IMail interface + Resend adapter + MailBuilder
├── ai/index.ts           ← IAIModel interface + OpenAI + Anthropic adapters
├── webhooks/index.ts     ← at-least-once delivery, IWebhookStore, SQLite adapter
│
├── tools/
│   └── repl.ts           ← interactive HTTP REPL with autocomplete + tutorial
│
└── tests/
    └── index.test.ts     ← full test suite (bun test)
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
○ › get /api/users
○ › post /api/users {"name":"Alice","email":"a@b.com"}
● › auth my-token
● › set id = $_.id
● › get /api/users/$id
● › watch /health 2000
```

**Tab autocomplete** — commands, live API paths (fetched from `/metrics` on connect), and `$variable` names.

**Variables** — `$_` is auto-set to every response body. Named variables with `set`:

```
set payload {"name":"Alice","role":"admin"}
post /api/users $payload

set id = $_.id               ← capture a field from the last response
get /api/users/$id            ← expand in a path

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
      all: [publish((_, ctx) => app.channel(`workspace:${ctx.params.workspace_id}`))],
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
app.services.register(createLitestoneService({
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
      key:     (ctx) => ctx.params.user?.accountId ?? ctx.params.ip,
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

  async reboot(ctx)    { /* ... */ },  // POST /api/servers/:id/reboot
  async heartbeat(ctx) { /* ... */ },  // POST /api/servers/:id/heartbeat
  async events(ctx)    { /* ... */ },  // GET  /api/servers/:id/events

  hooks: {
    before: { reboot: [requireRole('developer')] },
  },
})
```

Custom methods run through the full hook pipeline — identical to CRUD methods. Hook targets use the method name as the key.

Works the same with `createLitestoneService`:

```typescript
createLitestoneService({
  name:   'servers',
  model:  'servers',
  schema: jsonSchema,

  async reboot(ctx) {
    const db = ctx.params.db
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
    if (session?.workspace_id)
      app.channel(`workspace:${session.workspace_id}`).join(conn)
  })
}))

// In a service hook
after: {
  create: [publish((_, ctx) => app.channel(`workspace:${ctx.params.workspace_id}`))],
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
// → { data, total, limit, offset, next: '/api/posts?$offset=20&$limit=20', prev: null }

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

Default is `/api`. Handles missing/extra slashes automatically.

---

## Bulk operations

Bulk `patch` and `remove` without an `id` are disabled by default — a guard against accidental whole-table mutations:

```typescript
createService({
  name:      'logs',
  allowBulk: true,    // opt in explicitly
})
// DELETE /api/logs?status=archived  ← now allowed
// DELETE /api/logs                  ← still rejected (no filter conditions)
```

---

## Config options

| Key | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `3000` | HTTP port |
| `hostname` | `string` | `'0.0.0.0'` | Bind address |
| `apiPrefix` | `string` | `'/api'` | Prefix for auto-routed service URLs |
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

`authenticate` hook reads `Authorization: Bearer` or `X-API-Key`, calls `auth.verifySession()`, stamps `ctx.params.user`.

**`SessionContext` shape** — what `ctx.params.user` looks like inside hooks and services:

```typescript
interface SessionContext {
  userId:       string                           // always present
  userType:     string                           // 'user' | 'admin' | 'service'
  authMethod:   'session' | 'apiKey' | 'oauth'  // how they authenticated
  email?:       string
  name?:        string
  accountId?:   string                           // multi-tenant account scope
  workspaceId?: string                           // multi-tenant workspace scope
  role?:        string
  scopes?:      string[]
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

Cache keys include the authenticated user's ID when present — `GET /api/orders` for user A never serves user B's cached result. Public routes share a single cache entry per query.

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

[Litestone](https://github.com/frontierjs/litestone) is Junction's first-party SQLite ORM. When installed, `createLitestoneService` replaces manual CRUD — all five methods are generated from the schema, validation is auto-generated from the JSON Schema output, and `@file` fields wire up to object storage transparently.

```typescript
import { createLitestoneService, withLitestoneDb } from '@frontierjs/junction'
import { createClient, generateJsonSchema, GatePlugin, LEVELS } from '@frontierjs/litestone'

const SCHEMA = `
  model posts {
    id        Integer  @id
    title     Text     @length(1, 200) @trim
    body      Text
    authorId  Integer
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

// createLitestoneService generates find/get/create/patch/remove automatically.
// schema: jsonSchema auto-generates create + patch validators from the Litestone schema.
app.services.register(createLitestoneService({
  name:       'posts',
  model:      'posts',      // defaults to deriveModelName(name) if omitted
  schema:     jsonSchema,   // optional — enables auto-validation
  softDelete: 'deletedAt',  // optional — soft-delete via a nullable DateTime field
  allowBulk:  false,        // optional — default false, blocks bulk patch/delete
  cache:      true,         // optional — cache find/get responses, bust on writes
  hooks: {
    before: {
      create: [authenticate],
      patch:  [authenticate],
      remove: [authenticate],
    },
  },
}))
```

**`withLitestoneDb(db)`** attaches the base Litestone client to `ctx.params.db` as an around hook. Auth scoping (`$setAuth`) happens inside `getTable()` at call time — after the `authenticate` hook has run — so the right user is always applied to every query.

**`deriveModelName`** converts a service name to a Litestone model name: `'users'` → `'user'`, `'blogPosts'` → `'blogPost'`. Pass `model` explicitly if your naming doesn't follow this pattern.

**`jsonSchemaToJunctionSchema`** is available directly if you need to build a schema manually:

```typescript
import { jsonSchemaToJunctionSchema } from '@frontierjs/junction'

const schema = jsonSchemaToJunctionSchema('posts', jsonSchema, 'create')
// Returns a Junction Schema object — pass to createSchema()
```

---

## Transactions

Multi-step operations that need atomicity — create a user and a workspace together, or not at all — require a transaction. Litestone exposes `db.$transaction()` for this.

```typescript
createService({
  name: 'accounts',

  async provision(ctx) {
    const db = ctx.params.db

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
curl -X PATCH https://api.example.com/api/users/1 \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=Alice" \
  -F "avatar=@photo.jpg"
```

`ctx.data` arrives as `{ name: 'Alice', avatar: File }` — all standard text fields and file fields merged together. When using Litestone with `@file` / `File?` fields, the `FileStorage` plugin detects the `File` instance, uploads to R2/S3, and stores a JSON ref in SQLite. The service never knows storage happened.

**Accessing files in custom routes** — use `ctx.files` (already parsed, no manual `formData()` call):

```typescript
app.patch('/api/users/:id/avatar', async ctx => {
  const upload = ctx.files.find(f => f.name === 'avatar')
  if (!upload) return ctx.json({ message: 'avatar file required' }, 400)

  const file = new File([upload.data], upload.filename, { type: upload.type })
  // pass file to your storage layer
})
```

**Expanding file refs in responses** — Litestone stores file references as JSON. Use an after hook to expand them to URLs before the response goes out:

```typescript
import { fileUrl } from '@frontierjs/litestone'

app.services.register(createLitestoneService({
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

**Presigned uploads** — for large files, skip the server entirely. Generate a presigned URL, let the client upload directly to R2, then `PATCH` the ref:

```typescript
app.post('/api/users/:id/avatar/presign', async ctx => {
  const key       = `users/${ctx.params.id}/avatar/${crypto.randomUUID()}.jpg`
  const uploadUrl = await storage.sign(key, { expiresIn: 600 })
  return ctx.json({ uploadUrl, key })
  // Client: PUT uploadUrl with file bytes, then PATCH /api/users/:id { avatar: JSON.stringify({ key, ... }) }
})
```

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
  .post('/api/notes')
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
const res = await request(app).options('/api/notes')
expect(res.status).toBe(204)
```
```

---

## OpenAPI

```typescript
app.configure(openapi({
  title:   'My API',
  version: '1.0.0',
  ui:      '/api/docs',
  schemas: { notes: { create: { body: CreateNoteSchema } } },
}))
// GET /api/openapi.json  — machine-readable spec
// GET /api/docs          — Swagger UI (CDN, no extra deps)
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
| `GET /api/webhooks` | list registrations |
| `POST /api/webhooks` | register `{ url, events }` |
| `DELETE /api/webhooks/:id` | unregister |
| `POST /api/webhooks/:id/test` | fire a test ping |
| `GET /api/webhook-deliveries` | delivery history |
| `POST /api/webhook-deliveries/:id/retry` | manually retry |

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

// find(query?, params?) → T[]
const list = await posts.find({ status: 'published' }, { limit: 20 })

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
```

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
  management: true,   // exposes GET/DELETE /api/conduit/targets
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

---

## Dependencies

**Runtime**: `bun >= 1.0.0`

**Framework core**: zero external dependencies. Router, hook pipeline, logger, schema validator, scheduler, event bus, cache, body parser, static serving, WebSocket routing — all built on Bun's native APIs.

**Optional**: `better-auth` (auth), `resend` (mail), `zenstack` + `@zenstackhq/runtime` (ORM). Each isolated behind an interface — none required to run the framework.
