# Orion

Developer-first workflow automation engine. DAG execution, typed expressions, event-driven triggers.

> The SQLite of automation tools — lean, portable, fast.

---

## Stack

- **Runtime**: [Bun](https://bun.sh) — native HTTP server, no Express
- **Language**: TypeScript (strict)
- **Tests**: Vitest
- **Store**: In-memory (default) → SQLite → Postgres

---

## Quick start

```bash
bun install
bun run dev
```

Server starts on `http://localhost:3000`.

---

## Project structure

```
src/
  types/        — Flow, Node, Edge, Expression, ExecutionPlan (all primitives)
  expression/   — Expression resolver (48 built-in functions)
  compiler/     — 14-step DAG compiler pipeline
  cache/        — IExecutionCache, InMemoryCache
  executor/     — NodeExecutor (retry, timeout, cache)
  runtime/
    context.ts  — ExecutionContext, ExecutionRecord
    queue.ts    — IExecutionQueue, InMemoryQueue
    store.ts    — IExecutionStore, InMemoryExecutionStore, IPlanCache
    scheduler.ts — Scheduler (parallel stage execution, event emission)
    index.ts    — re-exports
  events/       — EventBus (named pub/sub, webhook mappers, schema registry)
  triggers/
    registry.ts — TriggerRegistry (central source of truth)
    cron.ts     — CronScheduler (drift-corrected, jittered)
    router.ts   — TriggerRouter (Bun HTTP handler)
    activator.ts — WorkflowActivator (boot + hot reload)
  server.ts     — entry point
```

---

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/hooks/:path` | Webhook trigger |
| `POST` | `/webhooks/:path` | Mapped webhook → event |
| `POST` | `/events/:name` | Emit named event |
| `POST` | `/flows/:id/trigger` | Manual trigger |
| `GET`  | `/admin/health` | System health |
| `GET`  | `/admin/triggers` | Registered triggers |

---

## Trigger types

```typescript
trigger.webhook   // POST /hooks/:path → enqueue
trigger.cron      // "0 * * * *" → enqueue on schedule
trigger.event     // "user.created" → fan-out to all subscribers
trigger.manual    // POST /flows/:id/trigger → enqueue
```

---

## Event bus

```typescript
// Subscribe a flow to an event
eventBus.subscribe("user.created", flowId, version)

// Emit — fans out to all subscribers as parallel jobs
await eventBus.emit("user.created", { userId: "u_123" })

// Map external webhooks to internal events
eventBus.registerMapper({
  path: "/webhooks/stripe",
  map: (body) => ({ name: `stripe.${body.type}`, payload: body.data.object }),
})

// Attach schema for compiler validation
eventBus.defineSchema("user.created", {
  type: "object",
  properties: { userId: { type: "string" }, email: { type: "string" } },
  required: ["userId", "email"],
})
```

---

## Tests

```bash
bun run test
```

322 tests across 6 modules — compiler, expression resolver, executor, runtime, events, triggers.

---

## Build status

| Module | Status | Tests |
|--------|--------|-------|
| Types / Primitives | ✅ | — |
| Compiler | ✅ | 60 |
| Expression Resolver | ✅ | 99 |
| Node Executor | ✅ | 37 |
| Execution Runtime | ✅ | 54 |
| Event Bus | ✅ | 20 |
| Trigger System | ✅ | 52 |
| **Total** | | **322** |
| State Store (SQLite) | ⬜ | — |
| Plugin Registry | ⬜ | — |
| Core Node Implementations | ⬜ | — |

---

## Philosophy

1. **Minimalism** — no bloat, no framework
2. **Compiler-first** — catch errors before runtime
3. **O(1) routing** — pre-computed at compile time
4. **Composable** — subflows, events, plugins
5. **Deterministic** — fully serializable execution state
