# @frontierjs/conduit

Outbound transport layer for FrontierJS Junction apps.

Junction handles everything inbound — routing, hooks, WebSocket channels, auth. Conduit handles the other direction: **any request your app needs to make to something outside itself**. Provider APIs, remote agents, local sidecars — you register a destination once, then call it by name from anywhere in your app.

```
Browser / API  ──►  Junction (inbound)
                         │
                    app.conduit
                         │
              ┌──────────┴──────────┐
        agent:srv-abc        provider:hetzner
              │                     │
        hub-agent:7700        api.hetzner.cloud
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
  id:            string      // "provider:hetzner" | "agent:srv-abc"
  kind:          'provider' | 'agent' | 'local'
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
| `hmac`    | Signs the request body with HMAC-SHA256. Sets `X-Hub-Signature: sha256=<hex>`. Only applied to requests with a body — GET requests are not signed. |
| `none`    | No auth headers added |

> **Not yet implemented on every protocol.** Auth is applied by the HTTP transport only. The WebSocket and Unix transports currently send unauthenticated traffic regardless of what the target declares. Do not rely on a target's `auth` for anything reached over `websocket` or `unix`.

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
| `http`      | ✅ v1  | Provider REST APIs, remote agents |
| `websocket` | ✅ v1  | Persistent agent connections with reconnect |
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
| `invalid_request` | no | body would not serialise, or the response exceeded `max_response_bytes` |
| `timeout` | yes | exceeded `timeout_ms`, including during the response body read |
| `connection_failed` | yes | could not reach the target, or the conduit has been destroyed |
| `server_error` | 5xx and 429 yes, 4xx no | the target responded with an error status |
| `not_implemented` | no | the target's protocol has no transport yet (`ssh`, `nats`) |

`stream()` throws a `ConduitStreamError` if the stream cannot be established — target not found, or the connection failed before the first chunk. Once streaming, chunks arrive as `AsyncIterable<ConduitChunk>`.

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

### `app.conduit.stream(req)`

Stream responses from a target. Throws `ConduitStreamError` if setup fails.

```ts
try {
  for await (const chunk of app.conduit.stream({ target: 'agent:srv-abc', method: 'logs' })) {
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
// Typically called when an agent sends its first heartbeat
await app.conduit.register({
  id:            `agent:${serverId}`,
  kind:          'agent',
  protocol:      'http',
  address:       data.agent_url,
  auth:          { type: 'hmac', ref: `agent-secret:${serverId}` },
  registered_at: Date.now(),
  last_seen_at:  Date.now(),
})
```

The agent's secret itself goes wherever your `CredentialResolver` reads from — not into the descriptor.

For heartbeat-only updates (just refreshing `last_seen_at`), use the store's `touch()` directly rather than re-registering the full descriptor.

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

  // HTTP retry limit on retryable errors (5xx, timeout, connection failure).
  // Default: 3. Set to 0 to disable retries.
  retry_limit?: number

  // Hard cap on a response body, in bytes. Default: 10 MiB.
  // Reading stops at the cap and the request fails with `invalid_request`
  // rather than buffering an unbounded response.
  max_response_bytes?: number

  // Lifecycle hooks for observability and debugging.
  hooks?: ConduitHooks

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

Targets survive restarts. Use when agents register dynamically at runtime and you need them to survive a Hub restart.

```ts
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { Database }          from 'bun:sqlite'

conduit({ store: createSQLiteStore(new Database('hub.db')) })
```

Creates a `conduit_targets` table automatically on first boot.

### Custom

Every `ConduitStore` method is async, so a networked registry — Redis, Postgres, an HTTP service — is implementable. This is what lets more than one replica share a set of dynamically registered agents.

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

---

## Management service

When `management: true` is set, Conduit registers a Junction service at `conduit/targets` that exposes:

- `find` → list all registered targets
- `get` → look up a single target by ID
- `remove` → deregister a target

The service goes through Junction's full hook pipeline — attach auth hooks to protect it:

```ts
conduit({ management: true })

// In your app hooks:
app.service('conduit/targets').hooks({
  before: { all: [authenticate()] }
})
```

Use a custom path if needed:

```ts
conduit({ management: { path: 'ops/conduit-targets' } })
```

---

## Testing

Use `createTestConduit` for unit and integration tests. It gives you a fully wired conduit with stub transports — no real HTTP calls, no database.

```ts
import { createTestConduit } from '@frontierjs/conduit/testing'

const { conduit, stubs } = createTestConduit({
  'agent:srv-abc': {
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
expect(stubs['agent:srv-abc'].calls).toHaveLength(3)
expect(stubs['agent:srv-abc'].calls[0].path).toBe('/pull')
expect(stubs['agent:srv-abc'].calls[1].path).toBe('/deploy')

// Reset between test cases
stubs['agent:srv-abc'].reset()
```

Hooks work in tests too:

```ts
const errors: ConduitError[] = []

const { conduit } = createTestConduit(
  { 'agent:srv-abc': {} },
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
├── conduit/
│   ├── index.ts               public exports
│   ├── types.ts               all types and interfaces
│   ├── conduit.ts             createConduit() core factory
│   ├── plugin.ts              Junction plugin (app.configure)
│   ├── router.ts              target ID → transport resolution + pool
│   ├── testing.ts             createTestConduit() test factory
│   ├── stores/
│   │   ├── memory.ts          in-memory ConduitStore (default)
│   │   └── sqlite.ts          SQLite-backed ConduitStore
│   └── transports/
│       ├── base.ts            BaseTransport + auth header builder
│       ├── http.ts            fetch-based HTTP with retry + HMAC
│       ├── websocket.ts       persistent WS with reconnect + ping
│       ├── unix.ts            Bun unix socket transport
│       ├── stub.ts            test double — records calls, returns mocks
│       └── not_implemented.ts fails clearly for ssh/nats (future)
└── conduit.test.ts            full test suite
```
