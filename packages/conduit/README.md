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
      auth:          { type: 'bearer', token: process.env.HETZNER_TOKEN! },
      registered_at: Date.now(),
      last_seen_at:  null,
    }
  ],
}))
```

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
| `bearer`  | Adds `Authorization: Bearer <token>` |
| `api_key` | Adds a custom header: `{ header: 'X-Api-Key', key: '...' }` |
| `hmac`    | Signs the request body with HMAC-SHA256. Sets `X-Hub-Signature: sha256=<hex>`. Only applied to requests with a body — GET requests are not signed. |
| `none`    | No auth headers added |

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

`stream()` throws a `ConduitStreamError` if the stream cannot be established (e.g. target not found). Once streaming, chunks arrive as `AsyncIterable<ConduitChunk>`.

---

## API

### `app.conduit.send(req)`

Send a request to a registered target. Returns `ConduitResult<T>`.

```ts
const result = await app.conduit.send<ServerResponse>({
  target:     'provider:hetzner',   // required — registered target ID
  method:     'POST',               // HTTP verb or protocol-specific method
  path:       '/servers',           // path on the remote
  body:       { name: 'web-01' },   // JSON-serialisable
  headers:    { 'X-Custom': '1' },  // merged with auth headers
  timeout_ms: 5_000,                // overrides global default
})
```

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
  auth:          { type: 'hmac', secret: agentSecret },
  registered_at: Date.now(),
  last_seen_at:  Date.now(),
})
```

For heartbeat-only updates (just refreshing `last_seen_at`), use the store's `touch()` directly rather than re-registering the full descriptor.

### `app.conduit.deregister(id)`

Remove a target and evict its pooled connection.

### `app.conduit.resolve(id)`

Look up a target by ID. Returns `TargetDescriptor | null`.

### `app.conduit.list()`

Returns all registered targets, ordered by `registered_at`.

---

## Plugin options

```ts
conduit({
  // Registry backend. Defaults to in-memory (lost on restart).
  // Pass createSQLiteStore(db) for persistence.
  store?: ConduitStore

  // Targets to register immediately on boot.
  // Use for provider integrations known at startup time.
  targets?: TargetDescriptor[]

  // Request timeout in ms. Default: 10_000.
  // Can be overridden per-request via req.timeout_ms.
  timeout_ms?: number

  // HTTP retry limit on retryable errors (5xx, timeout, connection failure).
  // Default: 3. Set to 0 to disable retries.
  retry_limit?: number

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
