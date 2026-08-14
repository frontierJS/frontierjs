# @frontierjs/conduit

Outbound transport layer for FrontierJS Junction apps.

Junction handles everything inbound — routing, hooks, WebSocket channels, auth. Conduit handles the other direction: **any request your app needs to make to something outside itself**. Provider APIs, remote outposts, local sidecars — you register a destination once, then call it by name from anywhere in your app.

```
Browser / API  ──►  Junction (inbound)
                         │
                    app.conduit
                         │
              ┌──────────┴──────────┐
        outpost:srv-abc        provider:hetzner
              │                     │
        hub-outpost:7700        api.hetzner.cloud
```

---

## Installation

```bash
bun add @frontierjs/conduit
```

---

## Quick start

```ts
import { conduit }           from '@frontierjs/conduit'
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { Database }          from 'bun:sqlite'

const db = new Database('hub.db')

app.configure(conduit({
  store:   createSQLiteStore(db),
  targets: [
    {
      id:            'provider:hetzner',
      kind:          'provider',
      protocol:      'http',
      address:       'https://api.hetzner.cloud/v1',
      auth:          { type: 'bearer', ref: 'HETZNER_TOKEN' },
      registered_at: Date.now(),
      last_seen_at:  null,
    }
  ],
}))
```

Targets carry a credential *reference*, not the credential. `ref: 'HETZNER_TOKEN'` is resolved at send time — by default from `process.env`. See [Credentials](#credentials).

After `app.configure()`, `app.conduit` is available everywhere:

```ts
const result = await app.conduit.send({
  target: 'provider:hetzner',
  method: 'GET',
  path:   '/servers/123',
})

if (result.error) {
  console.error(result.error.kind, result.error.message)
} else {
  console.log(result.data)
}
```

---

## Core concepts

### Targets

A **target** is a named remote endpoint. Every call goes through a target — you never pass raw URLs to `send()`.

```ts
interface TargetDescriptor {
  id:            string      // "provider:hetzner" | "outpost:srv-abc"
  kind:          'provider' | 'outpost' | 'local'
  protocol:      'http' | 'websocket' | 'unix'
  address:       string      // base URL or socket path
  auth:          TargetAuth
  registered_at: number      // unix ms
  last_seen_at:  number | null
}
```

Targets can be registered statically at startup (see `opts.targets`) or dynamically at runtime (see `register()`).

### Auth

Auth is declared on the target and applied automatically on every request. Callers never touch headers manually.

| type      | behaviour |
|-----------|-----------|
| `bearer`  | Adds `Authorization: Bearer <secret>` |
| `api_key` | Adds a custom header: `{ header: 'X-Api-Key', ref: 'STRIPE_KEY' }` |
| `hmac`    | Signs a canonical string with HMAC-SHA256 — see below |
| `none`    | No auth headers added |

Applied on **every** protocol: HTTP and Unix on each request, WebSocket on the connection upgrade.

#### HMAC signing

The signature covers a canonical string, not just the body:

```
<METHOD>\n<path>\n<timestamp>\n<nonce>\n<sha256-hex of body>
```

emitted as three headers (prefix configurable via `header_prefix`, default `X-Hub`):

```
X-Hub-Signature: sha256=<hex>
X-Hub-Timestamp: <unix seconds>
X-Hub-Nonce:     <uuid>
```

This binds each signature to one method and one path, so a captured signature cannot be replayed against a different endpoint on the same target, and the timestamp and nonce let the receiver reject stale or repeated requests. Requests with no body sign the hash of the empty string, so `POST /reboot` and `DELETE /servers/42` are signed like anything else.

**The receiving outpost must do its part:** recompute the same canonical string, compare in constant time, reject signatures outside a freshness window (60s is typical), and remember recent nonces. A signature check that ignores the timestamp gives you no replay protection.

#### WebSocket auth

Credentials go on the **upgrade request**, using Bun's `headers` option on the `WebSocket` constructor. For an `hmac` target the upgrade is signed with method `CONNECT` and the address path.

This authenticates the *connection*. There is no per-frame signature — anything able to write to an established socket can issue any command on it. If you need per-command authentication, terminate the socket per operation or add frame signing on both ends.

### Credentials

A `TargetDescriptor` holds a credential **reference**, never the secret:

```ts
auth: { type: 'bearer', ref: 'HETZNER_TOKEN' }
```

The reference is resolved at send time by a `CredentialResolver`, so secret material never enters the registry, `resolve()`, `list()`, the hooks, or the management routes.

```ts
interface CredentialResolver {
  get(ref: string): Promise<string | null>
}
```

Four are built in:

```ts
import {
  createEnvResolver,     // reads process.env[ref] — the default
  createStaticResolver,  // fixed { ref: secret } map, for the composition root and tests
  createNullResolver,    // resolves nothing; every ref fails closed
  withCache,             // TTL cache around any resolver
} from '@frontierjs/conduit'

app.configure(conduit({
  credentials: withCache(createVaultResolver(), { ttl_ms: 300_000 }),
}))
```

**Unresolvable refs fail closed.** If `get()` returns `null` or an empty string, the request is not sent — `send()` returns `error.kind === 'auth_failed'` with `retryable: false`. The error names the target and the ref, never the value.

Transports resolve once per attempt, so a retried request calls the resolver up to `retry_limit + 1` times. Wrap anything networked in `withCache`.

### Protocols

| protocol    | status | used for |
|-------------|--------|----------|
| `http`      | ✅ v1  | Provider REST APIs, remote outposts |
| `websocket` | ✅ v1  | Persistent outpost connections with reconnect |
| `unix`      | ✅ v1  | Local sidecar processes |
| `ssh`       | 🔜 future | — |
| `nats`      | 🔜 future | — |

### Results

`send()` never throws. It always returns a `ConduitResult`:

```ts
const result = await app.conduit.send({ ... })

if (result.error) {
  // result.error.kind    — 'target_not_found' | 'timeout' | 'auth_failed' | ...
  // result.error.retryable — whether it's worth retrying
  // result.data          — null
} else {
  // result.data          — parsed JSON response
  // result.meta.status   — HTTP status code
  // result.meta.duration_ms
}
```

This holds for bad input too: a body that will not serialise (a cyclic object, a `BigInt`) returns `invalid_request` rather than throwing out of `send()`.

| `error.kind` | retryable | meaning |
|---|---|---|
| `target_not_found` | no | no target registered under that ID |
| `auth_failed` | no | 401/403 from the target, or a credential ref that would not resolve |
| `invalid_request` | no | body would not serialise, response exceeded `max_response_bytes`, or the method is not a valid HTTP verb |
| `timeout` | yes | exceeded `timeout_ms`, including during the response body read |
| `connection_failed` | yes | could not reach the target, or the conduit has been destroyed |
| `server_error` | 5xx and 429 yes, 4xx no | the target responded with an error status |
| `not_implemented` | no | the target's protocol has no transport yet (`ssh`, `nats`) |
| `circuit_open` | no | the target's breaker is open — nothing was sent |
| `overloaded` | no | the target's concurrency cap is full — nothing was sent |

`stream()` throws a `ConduitStreamError` if the stream cannot be established — target not found, connection failed before the first chunk, unresolvable credential, or a protocol that cannot stream. Once streaming, chunks arrive as `AsyncIterable<ConduitChunk>`.

It also throws if the socket **drops mid-stream**, so a network blip during a log tail terminates the consumer instead of blocking it forever. Chunks already yielded are yours to keep; wrap the `for await` in a `try/catch` to distinguish "the log ended" from "the connection died".

Only `websocket` targets can stream. `http` and `unix` throw `not_implemented` rather than yielding an empty iterator — "this protocol cannot stream" must not look like "there was no output".

---

## API

### `app.conduit.send(req)`

Send a request to a registered target. Returns `ConduitResult<T>`.

```ts
const result = await app.conduit.send<ServerResponse>({
  target:     'provider:hetzner',   // required — registered target ID
  method:     'POST',               // HTTP verb or protocol-specific method
  path:       '/servers',           // path on the remote
  query:      { page: 2, tag: ['a', 'b'] },  // ?page=2&tag=a&tag=b
  body:       { name: 'web-01' },   // JSON-serialisable
  headers:    { 'X-Custom': '1' },  // merged with auth headers — auth wins
  timeout_ms: 5_000,                // overrides global default
})
```

**Auth headers take precedence over `headers`.** A caller cannot override or strip the target's credential, so a code path where user data reaches `req.headers` cannot become credential substitution.

`query` merges with any query string already on `path`, and array values produce repeated keys. For GET requests a plain `body` is still flattened into the query string as a shorthand; `query` is applied after and wins on conflict.

#### Retries

`GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` are retried on retryable errors, up to `retry_limit`.

**`POST` and `PATCH` are never retried by default.** A timed-out `POST /servers` may have committed on the target, and re-sending it bills for a second server. The timeout is returned to you and the decision is yours.

Backoff is jittered, so N callers hitting the same degraded provider don't retry in lockstep, and the whole call — every attempt plus every sleep — is capped by `deadline_ms`.

On an HTTP or Unix target, a method that isn't a valid HTTP verb returns `invalid_request` rather than being coerced to `POST`. A typo like `'GTE'` used to become a live write.

#### Load shedding

Retries alone make an outage worse: every call costs `retry_limit + 1` attempts against a dependency that is already struggling, while holding one of your request handlers. A per-target circuit breaker stops that.

```ts
conduit({
  resilience: {
    failure_threshold: 5,       // consecutive failures before opening (0 disables)
    reset_ms:          30_000,  // how long it stays open
    max_concurrent:    10,      // per-target in-flight cap (default: unlimited)
  }
})
```

Open → requests fail immediately with `circuit_open` and **nothing leaves the process**. After `reset_ms` exactly one trial request is admitted; success closes the breaker, failure reopens it for another full window.

Only failures that implicate the target count — `connection_failed`, `timeout`, `server_error`. An unresolvable credential, an unserialisable body or a typo'd method is your bug, and tripping a breaker on it would hide the real error behind `circuit_open` forever.

Beyond `max_concurrent`, requests fail fast with `overloaded` rather than queueing — a bounded queue just moves the pile-up somewhere less visible. Breaker state per target shows up in `stats().breakers`, and only for targets that are not healthy-and-idle.

#### Validating responses

`data` is otherwise an unchecked cast: a provider returning `{"error": "quota exceeded"}` under HTTP 200 flows through as a success.

```ts
const result = await app.conduit.send<Server>({
  target: 'provider:hetzner',
  method: 'GET',
  path:   '/servers/42',
  validate: {
    validate: (data) => isServer(data)
      ? { ok: true,  value: data }
      : { ok: false, errors: ['expected a Server'] },
  },
})
```

The interface is structural, not tied to a schema library, so Junction's `createSchema`, zod, valibot or a hand-written predicate all fit with a small adapter. A failure returns a non-retryable `server_error` with the raw payload on `error.raw`.

To opt a specific call in, pass an idempotency key — your assertion that the target collapses duplicates. It is forwarded as an `Idempotency-Key` header:

```ts
await app.conduit.send({
  target:          'provider:hetzner',
  method:          'POST',
  path:            '/servers',
  body:            { name: 'web-01' },
  idempotency_key: 'create-web-01',
})
```

### `app.conduit.stream(req)`

Stream responses from a target. Throws `ConduitStreamError` if setup fails.

```ts
try {
  for await (const chunk of app.conduit.stream({ target: 'outpost:srv-abc', method: 'logs' })) {
    console.log(chunk.data, chunk.sequence)
  }
} catch (err) {
  if (err instanceof ConduitStreamError) {
    console.error(err.conduit.kind)
  }
}
```

### `app.conduit.register(descriptor)`

Register or update a target at runtime. Evicts any pooled connection for that target so the next `send()` uses the updated config.

```ts
// Typically called when an outpost sends its first heartbeat
await app.conduit.register({
  id:            `outpost:${serverId}`,
  kind:          'outpost',
  protocol:      'http',
  address:       data.outpost_url,
  auth:          { type: 'hmac', ref: `outpost-secret:${serverId}` },
  registered_at: Date.now(),
  last_seen_at:  Date.now(),
})
```

The outpost's secret itself goes wherever your `CredentialResolver` reads from — not into the descriptor.

### `app.conduit.touch(id)`

The heartbeat path. Refreshes `last_seen_at` without rewriting the descriptor and without evicting the pooled connection — an outpost saying "still here" should not tear down the socket it said it on.

```ts
await app.conduit.touch(`outpost:${serverId}`)
```

Static targets from `opts.targets` keep whatever `last_seen_at` the store already holds across a restart, so rebooting does not wipe heartbeat state.

### `app.conduit.deregister(id)`

Remove a target and evict its pooled connection.

### `app.conduit.resolve(id)`

Look up a target by ID. Returns `TargetDescriptor | null`.

### `app.conduit.list()`

Returns all registered targets, ordered by `registered_at`.

### `app.conduit.destroy()`

Closes all pooled transport connections. Wired to the plugin's `shutdown()`, so it runs on `app.stop()`.

**Terminal.** A conduit is not reusable afterwards: a late in-flight `send()` returns `connection_failed` and `stream()` throws, rather than quietly opening a fresh connection after shutdown.

---

## Plugin options

```ts
conduit({
  // Registry backend. Defaults to in-memory (lost on restart).
  // Pass createSQLiteStore(db) for persistence.
  store?: ConduitStore

  // Resolves a target's auth.ref to secret material at send time.
  // Defaults to createEnvResolver() — refs are read from process.env.
  credentials?: CredentialResolver

  // Targets to register immediately on boot.
  // Use for provider integrations known at startup time.
  targets?: TargetDescriptor[]

  // Request timeout in ms. Default: 10_000.
  // Covers the whole exchange including the response body read, so a
  // server that sends headers and then stalls still times out.
  // Can be overridden per-request via req.timeout_ms.
  timeout_ms?: number

  // Retry limit on retryable errors (5xx, 429, timeout, connection failure).
  // Default: 3. Set to 0 to disable retries.
  // Only applies to idempotent methods — see Retries below.
  retry_limit?: number

  // Total wall-clock budget for one send(), across every attempt and every
  // backoff sleep. Default: 45_000.
  deadline_ms?: number

  // Hard cap on a response body, in bytes. Default: 10 MiB.
  // Reading stops at the cap and the request fails with `invalid_request`
  // rather than buffering an unbounded response.
  max_response_bytes?: number

  // Lifecycle hooks for observability and debugging.
  hooks?: ConduitHooks

  // Per-target circuit breaker and concurrency cap. See Load shedding.
  resilience?: ResilienceOptions

  // Returns headers to attach to every outbound request.
  // See createTraceContext() below.
  trace?: (req: ConduitRequest) => Record<string, string> | null

  // Expose a management service for listing and deregistering targets.
  // Disabled by default. Requires auth.
  management?: boolean | { path?: string }
})
```

---

## Registry backends

### In-memory (default)

Zero dependencies. Targets are lost on process restart. Suitable for stateless apps or local development.

```ts
import { createMemoryStore } from '@frontierjs/conduit/stores/memory'

conduit({ store: createMemoryStore() })
// or just:
conduit() // in-memory is the default
```

### SQLite

Targets survive restarts. Use when outposts register dynamically at runtime and you need them to survive a Hub restart.

```ts
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { Database }          from 'bun:sqlite'

conduit({ store: createSQLiteStore(new Database('hub.db')) })
```

Creates a `conduit_targets` table automatically on first boot.

### Custom

Every `ConduitStore` method is async, so a networked registry — Redis, Postgres, an HTTP service — is implementable. This is what lets more than one replica share a set of dynamically registered outposts.

```ts
interface ConduitStore {
  init():   Promise<void>
  get(id: string): Promise<TargetDescriptor | null>
  set(descriptor: TargetDescriptor): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<TargetDescriptor[]>
  touch(id: string): Promise<void>
}
```

Two requirements: `set()` must preserve the existing `registered_at` on upsert, and `get()`/`list()` must return copies rather than live references.

`stats()` never reads the store — it reports counters maintained in the conduit — so a slow backend does not slow down `/metrics`. The trade-off is that writes made directly to a shared store behind the conduit's back are not reflected in `stats()` until the next `init()`.

---

## Hooks

```ts
conduit({
  hooks: {
    onRequest(req) {
      // Fires before every send() and stream()
    },
    onResponse(req, result) {
      // Fires after a successful send()
    },
    onError(req, err) {
      // Fires on any error — target_not_found, timeout, auth_failed, etc.
      // Also fires when a stream fails to establish or drops mid-flight.
    },
    onRetry(req, err, attempt) {
      // Fires once per retried attempt, before the backoff sleep.
      // `attempt` is 1-based. Retries happen inside the transport, so
      // this is the only place they are visible.
    },
    onStreamStart(req) {},
    onStreamEnd(req, chunks) {
      // `chunks` is how many were yielded before the stream ended cleanly
    },
    onReconnect(targetId) {
      // Fires when a WebSocket transport attempts reconnection
    },
    onRegistered(descriptor) {
      // Fires after register()
    },
    onDeregistered(targetId) {
      // Fires after deregister()
    },
  }
})
```

Hooks may be `async`. They are **never awaited** — an exporter that takes 200 ms does not add 200 ms to your request — and a throw or rejection is caught and logged rather than failing the caller.

### Trace context

Nothing otherwise ties a Hub request to the outpost call it produced. `createTraceContext()` emits a W3C `traceparent` and a correlation id on every outbound request:

```ts
import { createTraceContext } from '@frontierjs/conduit'

conduit({
  trace: createTraceContext({
    // Join the inbound request's trace instead of starting a new one.
    // Junction exposes a correlation id via requestMeta().
    current: () => ({ trace_id: requestMeta()?.correlationId }),
  }),
})
```

A fresh span id is minted per call, so the target's work hangs off yours rather than replacing it. A malformed upstream trace id is discarded and replaced rather than propagated — collectors drop a bad `traceparent`, so passing one through loses the span entirely.

Precedence: trace headers sit under `req.headers`, which sit under auth. A caller can override a traceparent; nobody can displace a credential.

---

## Management service

Conduit can register a Junction service named `conduit-targets` that exposes:

| method | route | |
|---|---|---|
| `find` | `GET {apiPrefix}/conduit-targets` | list all registered targets |
| `get` | `GET {apiPrefix}/conduit-targets/:id` | look up a single target by ID |
| `remove` | `DELETE {apiPrefix}/conduit-targets/:id` | deregister a target |

Junction's `apiPrefix` defaults to `''`, so out of the box these sit at `/conduit-targets`.

Responses carry credential **refs**, never secret material — see [Credentials](#credentials).

**Enabling it requires an access decision.** These routes enumerate every target in the system and can deregister them, so "forgot to add the hook" is not a reachable state — `conduit({ management: {} })` throws at `configure()`.

Attach auth to the service:

```ts
conduit({
  management: { hooks: { before: { all: [authenticate()] } } }
})
```

…or opt out explicitly, if your app already authenticates every service:

```ts
app.hooks({ before: { all: [authenticate()] } })   // covers this service too
conduit({ management: { public: true } })
```

`public: true` is exactly as open as it sounds. It exists so that serving these routes unauthenticated is something you typed, not something you forgot.

Use a custom path if needed:

```ts
conduit({ management: { path: 'ops-conduit-targets', public: true } })
```

The path must be a **single path segment** — Junction routes services as `{apiPrefix}/{service}` and `{service}` matches one segment. A path containing `/` throws at `configure()` rather than registering a service that silently 404s on every request.

---

## Testing

Use `createTestConduit` for unit and integration tests. It gives you a fully wired conduit with stub transports — no real HTTP calls, no database.

```ts
import { createTestConduit } from '@frontierjs/conduit/testing'

const { conduit, stubs } = await createTestConduit({
  'outpost:srv-abc': {
    '/pull':         { ok: true },
    '/deploy':       { deployed: true },
    '/health-check': { healthy: true },
  },
  'provider:hetzner': {
    '/servers/42': { id: 42, status: 'running' },
  },
})

// Run the code under test
await deploymentEngine.run(conduit, 'srv-abc')

// Assert on recorded calls
expect(stubs['outpost:srv-abc'].calls).toHaveLength(3)
expect(stubs['outpost:srv-abc'].calls[0].path).toBe('/pull')
expect(stubs['outpost:srv-abc'].calls[1].path).toBe('/deploy')

// Reset between test cases
stubs['outpost:srv-abc'].reset()
```

It is `await`ed because the store is async. Stubbed targets are registered in the store as well as intercepted, so `resolve()`, `list()` and `stats()` see them — code that calls `send()` alongside `resolve()` is testable in one place.

### Simulating failure

Stubs are not success-only. This is what makes retry logic, the error taxonomy and timeout handling testable:

```ts
const stub = stubs['outpost:srv-abc']

stub.mockError('POST /deploy', 'timeout', { retryable: true })
stub.mock('/slow', { ok: true }, { delay_ms: 500 })     // exercise timeouts
stub.mockStream('/logs', ['line-1', 'line-2'])          // stream chunks
stub.mockDefaultError('target_not_found')               // fail unexpected calls loudly
```

Mocks are keyed on **method + path** when you qualify them, so `GET /servers/42` and `DELETE /servers/42` are different mocks. A bare path (`'/health'`) still matches any method, and a method-qualified entry wins over a bare one.

### Mixing stubs with real targets

```ts
const { conduit } = await createTestConduit(
  { 'outpost:stubbed': { '/ping': { pong: true } } },
  { targets: [hetznerDescriptor] },   // registered, not stubbed
)
```

Hooks work in tests too:

```ts
const errors: ConduitError[] = []

const { conduit } = await createTestConduit(
  { 'outpost:srv-abc': {} },
  { hooks: { onError: (_req, err) => errors.push(err) } }
)
```

---

## What Conduit is not

**Not a queue.** `send()` is synchronous — you call it and await the result. Retry on failure, durability across restarts, and job scheduling belong in a separate queue layer that *uses* Conduit after dequeuing a job.

**Not a service mesh.** Conduit carries Hub control-plane commands (deploy, pull, stop, sync). It does not proxy application traffic between services.

**Not part of Junction core.** If you build a product on Junction that has no outbound infrastructure needs, don't install this package.

---

## File layout

```
@frontierjs/conduit
├── package.json
├── README.md
├── LICENSE
├── src/
│   ├── index.ts               public exports (no test doubles, no bun:sqlite)
│   ├── types.ts               all types and interfaces
│   ├── conduit.ts             createConduit() core factory + counters
│   ├── plugin.ts              Junction plugin (app.configure)
│   ├── router.ts              target ID → transport resolution + pool
│   ├── credentials.ts         CredentialResolver implementations
│   ├── resilience.ts          per-target circuit breaker + concurrency gate
│   ├── trace.ts               W3C traceparent propagation
│   ├── testing.ts             createTestConduit() test factory
│   ├── stores/
│   │   ├── memory.ts          in-memory ConduitStore (default)
│   │   └── sqlite.ts          SQLite-backed ConduitStore
│   └── transports/
│       ├── base.ts            BaseTransport + canonical auth signing
│       ├── http.ts            fetch-based HTTP with retry + deadline
│       ├── websocket.ts       persistent WS with reconnect + ping
│       ├── unix.ts            HttpTransport over a unix socket
│       ├── stub.ts            test double — records calls, mocks responses and failures
│       └── not_implemented.ts fails clearly for ssh/nats (future)
├── conduit.test.ts            unit + transport suite
└── junction-integration.test.ts   plugin against a real Junction app
```
