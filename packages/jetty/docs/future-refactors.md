# Future Refactors

## Option B — Extract `@frontierjs/resources-core` (REFUSED, and superseded)

**Status: refused 2026-08-15 and answered 2026-08-17** — `DECISIONS.md`
§ `FJS-D16` and its amendment, closing `FJS-059`. Kept because the analysis
below is what the ruling was argued against, not because it is the plan.

**What happened instead.** No fifth published package: a release cadence, a peer
range, an install entry and a `files:` field is too much for ~190 lines that are
pure and zero-dependency, which is the definition `@frontierjs/toolbelt` already
wrote for itself (`FJS-D26`). `createMakeFromSchema` and `derefFieldSchema` are
`@frontierjs/toolbelt/jsonschema`; the four-phase pipeline is
`@frontierjs/toolbelt/hooks`. Both sides import them.

**Two pieces this document lists did NOT move, deliberately.** `createStore` is
state, and toolbelt's licence is that every export is a pure function — and the
two stores were never one fact anyway: Sierra's is service-backed and stamps
each request, jetty's takes no service at all because Junction lives in Harbor.
And the `defineResource({ transport })` seam below is refused rather than
deferred: Sierra calls `client.service(name)` where jetty calls
`harbor.request('service:call')`, and a transport is not one fact with two
owners, it is two facts. Duplication is not the defect.

---

### The original analysis, kept for the argument

### Context

Phase 3 ships a Resources module in jetty (`src/resources/`) that mirrors
Sierra's `createResource(name, schema, opts) → { service, store, make, load,
context, hooks }` API. The implementation duplicates ~200 lines of logic that
exists in `@frontierjs/sierra/junction/resource.js`:

- `createMakeFromSchema` — pure JSON-schema → defaults factory (~55 lines)
- `createStore` — in-memory upsert/remove/find store (~45 lines)
- `mergeHooks`, `runHooks`, `runAroundHooks`, `runPhase` — pure hook pipeline
  utilities (~32 lines)
- The `createResource` orchestrator itself (~60 lines), which is partly pure
  and partly transport-aware

Sierra calls Junction directly (`client.service(name).find(query)`); jetty
routes through the port (`harbor.request('service:call', {...})`). The
orchestration around the call (hooks, ctx assembly, error recovery) is
identical in both.

### The plan

1. Create `@frontierjs/resources-core` package containing:
   - `createMakeFromSchema(properties, skip?)`
   - `createStore(opts)` — backend-agnostic in-memory store
   - `mergeHooks`, `runPhase`, `runAroundHooks` — hook utilities
   - `defineResource({ transport, name, schema, hooks, idField, model, optionsQuery })`
     where `transport` is an object implementing
     `{ find, get, create, patch, remove, restore, call, on }` (each returning
     a Promise of result for the data methods, function for `on`).
   - `bridgeStoreToSignal(store)` — adapter helper that converts a `createStore`
     into a Mesa-compatible signal/getter (this is `useStore` made transport-agnostic).

2. Refactor `@frontierjs/sierra/junction/resource.js` to consume
   `resources-core`. Sierra's transport implementation stays in Sierra:
   wraps `client.service(name)` with the existing methods.

3. Refactor `@frontierjs/jetty/src/resources/` to consume `resources-core`.
   Jetty's transport implementation routes through `harbor.request`.

### Why deferred

- Phase 3 needs to ship and stabilize before extracting the third package.
- Sierra is on its own release cadence. Coordinating a Sierra refactor with
  jetty's Phase 3 introduces risk for both projects.
- The public API of `createResource` is identical in both implementations
  (same args, same return shape, same hook semantics). Apps consuming it
  can't tell which underlying implementation runs them. So Phase 3 can ship
  A (duplicated) and migrate to B (extracted) later without breaking any
  consumer code.

### When to do it

Trigger conditions, any of:
- A bug is found in one implementation that needs to be fixed in the other
  (i.e. drift becomes real, not theoretical).
- Sierra grows a new feature in `createResource` (new hook phase, new
  resource method, schema introspection change) — port to jetty by
  extracting first, then porting once.
- Apps want to share Resource files (`Lead.mesa`) between Sierra-built web
  apps and jetty-built extensions, and a behavior diff bites someone.

### How to do it without breaking anyone

1. Land `resources-core` in the FrontierJS monorepo with full unit tests
   (port the existing tests from both Sierra and jetty).
2. Add a deprecation-free internal flag to Sierra's `createResource` that
   delegates to `resources-core` under the hood. Run Sierra's existing test
   suite — must pass unchanged.
3. Same for jetty: jetty's `createResource` becomes a thin shim over
   `defineResource` from `resources-core` with jetty's transport injected.
   Run jetty's tests — must pass unchanged.
4. Once both pass, remove the shim wrappers. The public API is unchanged
   throughout.

### What is explicitly NOT in resources-core

- Anything Junction-specific (token storage, `connected`/`reconnecting`
  signals, `client.on('reconnect', ...)`)
- Anything Mesa-specific (signal bridges, runtime imports). The
  `bridgeStoreToSignal` helper would be in a sub-export to keep the core
  tree-shakeable.
- Anything transport-specific. Transport is supplied by the consumer.

The core is the **shape** of resources — the hook pipeline, the schema-driven
factory, the in-memory store, the orchestration of method dispatch — without
caring how methods reach a server or how stores reach a UI.
