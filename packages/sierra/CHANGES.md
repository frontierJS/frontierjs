# Changes — @frontierjs/sierra

Applied during the 2026-07-25 performance/correctness pass. Baseline was the
2026-07-25 archive. Requires the matching `@frontierjs/mesa` build (see its
CHANGES.md — the async-declaration compiler fix is independent but was found via
this app).

Test status: **505 passing, 25 files.**

---

## 1. Boot navigation ran without guards — `src/router/index.js`

`initRouter()` started the boot `_navigate()` synchronously during
`virtual:sierra` module evaluation. App code registers guards when the root
component mounts, one tick later — by which point the guard loop had already
iterated an empty `_beforeGuards`. `_navigate` then awaits the lazy component
import, which yields long enough for the app to mount, so `_afterHooks` *did*
fire. Net effect: `afterNavigate` saw the boot navigation, `beforeNavigate`
never did.

Consequence: an auth guard protected client-side navigation to a route but not a
direct page load or refresh of it.

Fix: boot navigation is deferred by one `queueMicrotask`. Static imports and the
`mount()` that follows them are the same synchronous turn, so the microtask
lands after guards are registered.

Also: both hook loops now iterate a snapshot (`[..._beforeGuards]`,
`[..._afterHooks]`). Guards may await, and a registration landing during that
await was previously picked up by the in-flight loop.

**New:** `tests/boot-guard-order.test.js` — 3 tests.

Note: `activeRoute` is now null for one extra microtask after `initRouter`
returns. `RouterView` already gates on `{#if activeRoute}` and the boot
navigation was always async, so this should be invisible.

## 2. HMR: 3 full page reloads per save → 0

Measured with `smoke-test/probes/trace-order.mjs`. One save of a route file
produced three reloads from three distinct causes:

| cause | fix |
|---|---|
| Vite escalating — no `import.meta.hot.accept` in the chain | `injectHMR` |
| `scanner-plugin.js:162` explicit `full-reload` | conditional invalidation |
| Vite escalating on the rewritten `config/routes.js` | byte-stable manifest |

**`src/build/hmr-inject.js`, `src/build/hmr-client.js` (new)** — ported from
`@frontierjs/mesa-vite`. Declares the HMR boundary Sierra was missing. Wired into
`mesa-plugin.js`, dev only; production output is unchanged (verified: no
`__mesa_register` / `__mesaHMRWrap` in `dist/`). `canInject()` guards both
regexes, so an unexpected compiler output shape falls back to the old reload
behaviour rather than emitting broken code.

**`src/build/mesa-plugin.js`** — also tracks which files received a boundary and
suppresses `sierra:hmr` for them. Mesa's accept handler owns those updates;
emitting the custom event too would drive a route remount on top of the in-place
swap.

**`src/scanner/generate-manifest.js`** — removed the generation timestamp and
made `generateManifest` a no-op when bytes are unchanged. The manifest lives
inside the Vite root and is imported by `virtual:sierra`, so rewriting identical
bytes invalidated the whole app on every save.

**`src/build/scanner-plugin.js`** — the rescan still runs on every route save,
but `invalidateVirtualSierra` now fires only when the manifest actually changed.
Add/remove remain unconditional.

Result by edit type: route body **0**, layout body **0**, feature route **0**,
non-route module **0**, route frontmatter **2** (correct — it changes routing
metadata; the second is redundant and could be tightened).

Scope caveat: `__mesa_hot_update` is **not** state-preserving. It removes the
component's DOM and re-invokes the factory with the props captured at mount, so
component-local signals reset. What survives is router state, scroll position,
sibling components, and the rest of the page.

## 3. Sierra's parallel signal system removed

`src/router/signals.js` contained a second signal implementation, justified by a
comment claiming the router could not import `@frontierjs/mesa/runtime` without
a circular dependency. It can: `runtime.js` has zero imports, and `compiler.js`
is a separate entry point only the Vite plugin loads. router → runtime and
component → runtime is a diamond, not a cycle.

`signals.js` is now a thin wrapper over Mesa's `createSignal`. The `$$bridge`
block — 60 generated lines that monkey-patched `.get` on every exported signal —
is deleted from `src/virtual/virtual-sierra.js` (246 → 204 generated lines).

Also removed:

- **`.value`** — the bridge patched `.get` but left the `.value` getter on the
  old closure, so `sig.value` was a silently untracked read; an effect reading it
  never re-ran. In templates the accessor rewrite turned `{s.value}` into
  `s.get().value`, a property lookup on the value object. Same syntax, two
  meanings, no diagnostic.
- **`derived()`** — exported, imported once by `router/index.js`, never called.
  Recomputed k+1 times at creation for k sources and had no unsubscribe path.
  Use Mesa's `createMemo`.

`tests/build.test.js` gained two guards asserting the bridge is *not* emitted.

### ⚠ Behaviour change: `.subscribe()` coalesces

Subscribers previously fired synchronously on every `set`. Mesa coalesces writes
through `queueMicrotask`, so a subscriber now sees the latest value once per
flush:

```js
s.set(1); s.set(2)   // was [0, 1, 2] — now [0, 2]
```

Nothing inside Sierra uses `.subscribe()` any more, so this is internally safe.
Six tests encoded the old contract and were updated to use `flushSync()` between
writes. **If anything downstream depends on observing intermediate values, this
is where it breaks.**

This is the same mechanism that makes a navigation's eight signal commits produce
one render. Measured at 1 render/navigation both before and after — the bridge
was redundant, not harmful.

## 4. Build-time code no longer imports the client runtime

`src/theme/script.js` (new) holds `buildThemeScript`, a pure string builder.
`theme/index.js` re-exports it for compatibility; `postbuild/inject-theme.js`
imports it directly.

Previously the chain

```
vite.config.js → sierra/build → postbuild/index.js
              → postbuild/inject-theme.js → theme/index.js
              → router/signals.js
```

pulled client runtime code into Node-side config resolution. Harmless only while
`signals.js` had no imports; the moment it imported the Mesa runtime,
`vite build` failed with `Cannot find package '@frontierjs/mesa'` before
compiling anything.

Worth a wider sweep — this is unlikely to be the only build module reaching into
client code.

## 5. Prefetch — dedupe key, cache bounds, delegation

`src/router/prefetch.js`, plus the cache read site in `src/router/index.js`.

**Dedupe was keyed by route id** (`_prefetched.has(node.id)`), so a dynamic route
prefetched exactly once per session — hovering `/blog/alpha/` permanently blocked
`/blog/beta/`. The cache it populated was keyed per-URL, so the gate was coarser
than the thing it gated. Prefetch failures are silent by design, so the only
symptom was navigation feeling slow for every slug after the first.

Now keyed by the full cache key. Chunk imports keep a separate route-id set
(`_prefetchedChunks`) — every `/blog/:slug/` shares one JS chunk, so importing it
once is right, while each slug needs its own `load()`. The old gate conflated
these and deduped the chunk correctly by accident.

**Cache is now bounded and expiring** — 32 entries, FIFO eviction, 30 s TTL.
Previously entries were removed only on consumption, so anything prefetched and
never visited held its full payload for the session, and a route prefetched at
t=0 served ten-minute-old data at t=10min. The router reads through
`_prefetchCacheHas()` / `_prefetchCacheTake()` so expiry is enforced at the
navigation site.

**MutationObserver replaced with event delegation.** The observer watched
`document.body` with `subtree: true` and ran `querySelectorAll('a[prefetch]')`
for every element inserted anywhere in the app — rendering a 1 000-row list meant
1 000 subtree queries, 1 000 attribute writes and up to 2 000 `addEventListener`
calls. Hover and mousedown now need no per-element setup at all; four delegated
listeners cover every link that will ever exist. `visible` and `immediate` still
need element registration, handled by `scanPrefetchLinks()` on boot and after
each navigation commit.

`immediate` mode also gained a concurrency limit (3). Previously a page with 100
bare `prefetch` links scheduled 100 idle callbacks that all timed out together at
2 s and stampeded.

**New:** `tests/prefetch-dedupe.test.js` — 10 tests.

## 6. Layouts load per route instead of all at boot

`src/router/index.js`, `src/router/internals.js`, `src/router/prefetch.js`.

`initRouter` used to invoke every factory in the `layouts` map immediately, so
every layout chunk in the app sat on the critical path regardless of which route
was being visited — including for `reset: true` routes that render no layout at
all. The justification was that `resolveChain()` would otherwise see
`component === undefined` on first visit to a layout-using route.

That is a sequencing problem, not a preloading one. `_navigate()` already awaits
the page component before committing signals; it now also awaits
`loadLayoutChain()` for the target route, started in parallel with the component
so the two network requests overlap. The chain is complete before `activeRoute`
is set, so `resolveChain()` never sees a hole, and layouts a session never visits
are never fetched.

`loadLayoutChain()` lives in `internals.js` because `prefetch.js` needs it too
and cannot import from `router/index.js` (which imports `prefetch.js`). Prefetch
now warms the chain as well — without that, a prefetched route would still block
on its layout chunk at navigation, which is the latency prefetch exists to
remove.

A failing layout is reported and skipped rather than aborting the navigation:
a broken layout should not make a route unreachable, and `resolveChain()`
already omits missing entries.

**New:** `tests/layout-loading.test.js` — 7 tests.

**Also added:** `_resetInternals()` in `internals.js`. `_fileToComponent`,
`_layoutParents`, `_chainCache` and `_entryCache` are module-scoped for the
module's lifetime, which is fine for a single browser app but means a second
`initRouter()` call in the same process inherits the previous tree's
registrations — `buildLayoutMap`'s `if (!_layoutParents.has(...))` guard makes
that stale rather than merged. Relevant to tests today, and to SSR or a
re-mounted micro-frontend later.

## 7. matchRoute — 6× faster, identical resolutions

`src/router/match.js`. Measured against the smoke test's 24-node tree:
**2.99 µs → 0.50 µs per match** (300 000 matches, 896 ms → 149 ms).

matchRoute runs on every navigation *and* every prefetch, so it is the hottest
pure function in the router. Three sources of waste:

- **The pathname was re-split at every node visited.** `matchPattern` called
  `splitPath(pathname)` itself, so a 24-node tree meant 24 identical splits and
  24 throwaway arrays per match. Now split once in `matchRoute` and threaded
  down.
- **Pattern segments were re-split and re-lowercased per comparison.** Patterns
  are static for the life of the tree, so they are now precomputed once per node
  into `{ dynamic, name }` / `{ dynamic, lower }` and cached in a `WeakMap`. A
  WeakMap rather than a field on the node, because the tree is serialised into
  the manifest and tests build trees by hand.
- **The params object was allocated before the first comparison.**
  `matchPattern` opened with `{ ...inheritedParams }`, so every failed match
  against a deep static route paid for an object. Now allocated only once a
  dynamic segment is actually captured; a purely static match reuses the
  inherited object.

`normalizePath` also gained a fast path. Both callers pre-normalize and
`matchRoute` normalizes again for safety, so the common input is a string that
needs no work — that case now returns immediately instead of running two
`split()` calls that allocate three strings and two arrays.

Equivalence was checked by differential-testing the old and new implementations
over 328 path × option combinations and 270 `normalizePath` cases: identical
throughout, including case-insensitive statics, percent-encoded params, all
three `trailingSlash` modes, catch-all fallthrough and malformed input.

**New:** `tests/match-semantics.test.js` — 20 tests locking the observable
behaviour so a future optimisation has something to fail against.
**New:** `smoke-test/probes/match-bench.mjs` — rerunnable benchmark.

## 8. Devtools — quadratic under traffic bursts

`src/devtools/buffer.js`, `src/devtools/ui.js`, `src/devtools/tabs/requests.js`.

Dev-only, so this is DX rather than shipped performance — but the panel became
unusable under a busy WebSocket connection. 300 requests with 1 200 hooks and
600 queries (2 100 `render()` calls), panel open: **45 262 ms → 132 ms**. Panel
closed: **316 ms → 1.3 ms**.

Four causes:

- **`ui.render()` ran fully on every inbound message.** A burst of 50 messages in
  one tick meant 50 complete panel rebuilds, each clearing `tabContent` and
  re-creating every row. Now coalesced onto one `requestAnimationFrame`.
  `renderNow()` is available for synchronous callers and tests.
- **The pill was rebuilt via `innerHTML` on every message**, including
  status-only updates — reparsing the markup and recreating five elements each
  time. Structure is now built once; only changed text nodes are written.
- **The ring buffer was `push()` + `shift()`**, O(n) per push once full. Now a
  true circular buffer with a write index. This is the part that was
  *algorithmic*: 20 000 pushes took 60 / 420 / 1 581 ms at caps of 200 / 2 000 /
  20 000 before, and a flat ~15 ms after — the old cost scaled with buffer size,
  the new one doesn't.
- **`addHook`/`addQuery` scanned the ring** with `reqs.all().find(...)` to locate
  their request, once per event, with hooks arriving several times per request.
  Now an id → entry index. The ring reports what each push evicted so the index
  stays in sync in O(1).

Also: the requests tab caches its formatted timestamp per entry rather than
calling `toLocaleTimeString()` per row per render (Intl formatting is expensive),
builds into a `DocumentFragment` and swaps once instead of appending row-by-row,
and iterates the ring newest-first via a generator instead of copying and
reversing.

**New:** `tests/devtools-perf.test.js` — 13 tests covering ring semantics,
index/eviction consistency and frame coalescing.
**New devDependency:** `happy-dom`, for the DOM the coalescing tests need.

### A note on how this one went

The first version of the id index reconciled itself by calling `reqs.all()` on
every request — which copies the whole ring once full, and made the buffer
*slower* than before (4.6 → 6.3 ms in isolation) while the headline number still
looked like a 300× win. It only showed up because the benchmark measured buffer,
panel-closed and panel-open separately. Worth keeping that decomposition if this
code is touched again: a large aggregate win can hide a regression in a
component of it.

## 9. Junction — boot no longer blocks on the server

`src/junction/index.js`, `src/virtual/virtual-sierra.js`. Verified against the
real `@frontierjs/junction` client (`src/client/index.ts`).

`virtual:sierra` emitted `await initJunction(sierraConfig.junction)` at the top
level of the app entry module, so every importer — including whatever mounts the
app — waited. Nothing rendered until it resolved.

Inside, with a stored token, it awaited the client's `'connect'` event or a
2 000 ms timeout. The real client only emits `'connect'` when the **server**
sends `{ type: 'connected' }`, which it does at the end of its open handler after
`verifySession` and connection registration — so the wait was a full round-trip
plus server-side session verification, not merely a socket open. Every returning
visitor has a stored token, so this was the common path, and an unreachable API
meant a 2 s blank screen.

The justification was that the first `load()` should see `_wsReady === true` and
use WebSocket rather than HTTP. But the client's `_wsCall()` opens with:

```ts
if (!this._wsReady || !this._ws) return this._httpFallback(service, method, id, data, query ?? null)
```

so calls made before the socket is ready already work — they take the HTTP path.
**Blocking first paint bought a transport preference, not correctness.**

`initJunction` is now synchronous and exports `whenReady` for anything that
specifically needs the socket. `virtual:sierra` emits a bare call; no top-level
await remains in the generated module (asserted in the tests).

Two smaller things in the same file:

- The redundant `client.connect()` after `setToken()` is gone. `setToken` opens
  a socket itself when none is open, and `connect()` returns early if
  `readyState < 2` — so it was always a no-op. (Confirmed by test: exactly one
  socket is created.)
- **Debug logging is now opt-in.** `_wrapDebug` was gated on
  `config.debug || import.meta.env?.DEV`, i.e. on for every dev session. It
  wraps all seven service methods and `console.debug`s `{ request }` and
  `{ response }` per call; console-logged objects are retained by devtools, so
  every response payload stayed reachable for the tab's lifetime. Now
  `debug: true`. The wildcard event logger is `debug: 'verbose'`.

**New:** `tests/junction-boot.test.js` — 7 tests using fake timers, covering
synchronous return, `whenReady` resolution on connect, the 2 s fallback, and the
single-socket property.

## 10. Cross-package resolution now reads exports maps

`src/virtual/virtual-sierra.js`, `vitest.config.js`.

Reported from a real `bun link` setup in a `repo/packages/*` layout:

```
Failed to resolve import "@frontierjs/junction/client"
  from ".../packages/sierra/src/junction/index.js"
```

Sierra's source lives outside the consuming app, so when Vite follows the link it
transforms Sierra's *real* path — which has no node_modules of its own. Node
resolution can't help from there, so `virtual-sierra.js` resolves
`@frontierjs/*` against sibling packages. That fallback guessed file paths:

```
<pkg>/client.ts   <pkg>/client.js   <pkg>/client/index.ts   <pkg>/client/index.js
```

None match Junction, whose real file is `<pkg>/src/client/index.ts`, declared as
`"./client": "./src/client/index.ts"`. The resolver now reads the target
package's `exports` map — handling bare strings, conditions objects
(browser → import → module → default) and wildcards — and keeps `main` plus the
old path guesses as fallbacks for packages that declare neither.

`vitest.config.js` had the same class of problem: a prefix alias rewrote
`@frontierjs/junction/client` to `<pkg>/client`. It now derives per-subpath
aliases from each sibling package's exports map.

**New:** `tests/frontier-resolution.test.js` — 11 tests over the export shapes
the four packages actually use.

### How this was missed

This was written up in the previous revision of this file as a known weakness
that "works today only because Vite's normal node_modules resolution picks it up
after Sierra's hook returns undefined." It was described as latent. It was not:
it fails outright under `bun link`.

The build passed locally only because, earlier in the same session, symlinks had
been added under `sierra/node_modules/@frontierjs/` for an unrelated probe. Those
made both the app build *and* `tests/junction-boot.test.js` pass for the wrong
reason. Removing them reproduced the reported error immediately.

The lesson is narrow and worth keeping: **a package's own `node_modules` must
stay empty of its siblings**, or cross-package resolution is never actually
under test. Both apps and the full suite are now verified with
`sierra/node_modules/@frontierjs` absent.

## 11. Junction signals were missing from externalSignals

`src/build/mesa-plugin.js`.

Reported from the fullstack smoke test: the connection badge read "ws connected"
with the API stopped, didn't update when it was killed, and still said connected
after a page reload.

Sierra exports module-level signals, and a bare read of one in a Mesa template
has to be rewritten to `name.get()` or it isn't reactive. That rewrite is driven
by the `externalSignals` map handed to the compiler. It listed the router and
theme signals but not `connected` / `reconnecting` from `sierra/junction`, so:

```
{connected ? 'ws connected' : 'ws offline'}
```

compiled to a bare object reference. A signal object is always truthy, so the
badge was permanently "connected" — and because the expression read nothing
reactive, Mesa hoisted it as static, which is why it never updated and survived
a reload. No error, no warning.

Both specifiers now declare them.

**New:** `tests/external-signals.test.js` — 13 tests. Walks `src/` for
`export const x = signal(...)`, parses the `externalSignals` map out of
`mesa-plugin.js`, and asserts they agree in both directions: every exported
signal is declared under both the scoped and bare specifier, and nothing is
declared that isn't exported (`node` is allowed as a documented alias for
`activeRoute`). Verified to fail with the junction entry removed.

### Why this class of bug keeps happening

This is the third instance of the same shape, and worth naming. Reactivity in a
Mesa template depends on a hand-maintained list living in a different package's
build plugin. Nothing at the import site or the use site marks `connected` as a
signal, and nothing checks the list against reality — so a signal added to
Sierra is silently non-reactive in every consuming app until someone notices a
value that never changes.

The test above closes it for signals Sierra itself exports. It does not help a
consuming app that re-exports one through a barrel, or reads one via a namespace
import — both of which silently lose reactivity. (Aliasing is fine; the rewrite
follows the local binding. Reads inside a `<script>` block are never rewritten
at all — only template expressions are.)

The durable fix is a compiler diagnostic: warn when an imported identifier is
read in a template, isn't in `externalSignals`, and isn't provably static. See
`mesa/EXTERNAL_REACTIVITY.md` for the full failure matrix and the options.

## 12. junction state is a plain object — the plain-object pilot

`src/junction/index.js`, `src/build/mesa-plugin.js`.

First module migrated off signals, per `mesa/PLAIN_OBJECT_STATE.md`. Chosen as
the pilot because it is the smallest — two fields — and had a real consumer.

```js
// before
export const connected = signal(false)
export const reconnecting = signal(null)
connected.set(true)                       // in the WS callback

// after
export const status = { connected: false, reconnecting: null }
const _status = watchProxy(status)        // the module's writer handle
_status.connected = true                  // notifies $: status.connected
```

Consumers opt in per file, and the reactivity is visible at the use site:

```svelte
import { status } from '@frontierjs/sierra/junction'
$: (status.connected, status.reconnecting)

<span class="status {status.connected ? 'on' : 'off'}">…</span>
```

**`sierra/junction` is now absent from `externalSignals`** — there is nothing for
the accessor rewrite to do. That is the point of the exercise: the compiler no
longer needs to know anything about this part of Sierra, so it cannot drift out
of sync with it. `tests/external-signals.test.js` still passes because both
sides went empty together.

Verified end to end against the real runtime — module writes through its proxy,
component watches paths:

```
initial                    : ws offline
client.on("connect")       : ws connected
client.on("disconnect")    : ws offline
client.on("reconnecting")  : reconnecting… (2)
reconnected                : ws connected
```

### Note on the write side

`status.connected = true` from outside the module would update the object and
notify nobody — RULE 45. The module holds `_status = watchProxy(status)` and
writes through that. `watchProxy` is idempotent and cached per object, so it is
the same proxy instance every component's `$:` resolves to.

This is the one genuinely new discipline the plain-object model asks for, and it
is confined to the module that owns the state.

### Remaining signals

`theme` (1). The router migration follows below.

## 13. router state is one plain `page` object

`src/router/index.js`, `page-fields.js` (new), `internals.js`, both components,
`build/slot-rewrite.js`, `build/scanner-plugin.js`, `build/warnings.js`,
`build/mesa-plugin.js`.

Eight signals — `params`, `activeRoute`, `pendingRoute`, `meta`, `data`,
`loadError`, `pageSlots` and the old `page` descriptor — collapsed into one:

```js
export const page = {
  path: '/', params: {}, meta: {},
  route: null, pending: null, data: null, error: null, slots: {},
}
```

Frontmatter still spreads on top, so `{page.title}` works as before.
`PAGE_RESERVED` names the eight fields the router assigns afterwards, and the
scanner now warns when a route's frontmatter uses one — previously a route
declaring `data:` would have had it silently replaced by the loader result.

**`sierra/router` is gone from `externalSignals`**, as `sierra/junction` already
was. Only `theme` remains. The map the compiler uses to know about Sierra is
nearly empty, which is the point: nothing left to drift.

The commit block writes field by field rather than replacing the object, so a
component watching `page.params` doesn't re-render because `page.data` arrived.

### The write handle is resolved per write, not captured

`watchProxy` is a no-op without a DOM (RULE 19), so a handle taken at module
load in a non-browser environment stays the raw object **forever** — even after
the environment changes, which is exactly what `mesa-render` and the test suite
do via `setRenderEnvironment()`. The router therefore resolves it per write:

```js
const _w = () => watchProxy(page)
```

`watchProxy` caches per object, so this is a WeakMap hit. Found because a slot
test failed while the code looked correct.

### Build-time code must not import the client router

`PAGE_RESERVED` lives in `router/page-fields.js`, a dependency-free module,
because the scanner warning runs in Node while `vite.config.js` is loading.
Importing it from `router/index.js` pulled the Mesa runtime into config
resolution and failed the build with `Cannot find package '@frontierjs/mesa'`.

Same shape as the `theme/script.js` fix earlier in this file — that is twice now,
so it is a pattern rather than an accident. Anything the build pipeline needs
from a client module should be extracted to its own import-free file.

### The diagnostic paid for itself

Migrating the smoke test, the external-reactivity diagnostic caught three reads
I had missed:

```
'page.siteName' is read in the template but no '$: page.siteName' watch covers it
'page.title'    …
'page.path'     …
```

Frontmatter keys are easy to forget precisely because they don't look like state.

## 14. devtools bootstrap bypassed Vite's transform pipeline

`src/build/devtools-plugin.js`.

Reported from a running dev server:

```
Loading module from "http://localhost:3000/@frontierjs/sierra/devtools-module"
was blocked because of a disallowed MIME type ("").
```

`configureServer` served the bootstrap directly with `res.end()`. That skips
Vite's transform pipeline entirely, so the import inside it —

```js
import { initToolbar } from '/@frontierjs/sierra/devtools-module'
```

— was never rewritten. The browser requested that URL literally, a second
middleware passed it through with `next()`, Vite's SPA fallback answered with
`index.html`, and the browser refused to execute HTML as a module.

The plugin already had `resolveId` + `load` serving the same virtual module, so
the middleware was redundant as well as harmful. Removed; the bootstrap now goes
through the pipeline and its import resolves to a real path:

```
/@frontierjs/sierra/devtools-bootstrap → 200 text/javascript
  import { initToolbar } from "/@fs/…/src/devtools/index.js" → 200 text/javascript
```

Pre-existing — the raw `res.end()` and the URL import are both in the original
archive. It surfaced now because the fullstack smoke test is the first app to
run the dev server with devtools enabled.

**Covered by** `smoke-test-fullstack/web/verify-web.mjs`, which now asserts the
bootstrap is injected, serves JavaScript, has its import rewritten, and that the
module behind it loads.

## 15. Client model schemas are generated from the .lite file

`src/build/schema-plugin.js` (new), `src/junction/schema-registry.js` (new),
`src/virtual/virtual-sierra.js`, `src/build/index.js`, `src/junction/resource.js`.

A resource file used to restate its model's field shape so `make()` had
defaults:

```js
const schema = {
  properties: {
    name:   { type: 'string' },
    status: { type: 'string', default: 'new' },
    value:  { type: 'number', default: 0 },
  },
}
createResource('leads', schema, { idField: 'id' })
```

That duplicated `db/schema.lite`. Once Junction started deriving server
validation from the Litestone client's own `$schema`, the hand-written client
copy became the **only** place the two halves of an app could drift — and it
drifts silently, as wrong `make()` defaults rather than an error.

The build now reads the same `.lite` file, runs `generateJsonSchema`, and emits
a `registerSchemas()` call into `virtual:sierra`, which runs before any route
module is evaluated. Resources name a model:

```js
createResource('leads', { model: 'Lead', idField: 'id' })
```

Lookup accepts the model name, the Litestone accessor, or the conventional
plural service name, so `createResource('leads')` resolves `Lead` unaided.
Editing the `.lite` file in dev triggers a full reload — `make()` defaults are
read when a resource module is first evaluated, so an HMR update would not take.

Configured as `schema: './db/schema.lite'` in `sierra.config.js`; omit to
auto-detect, `false` to disable.

**New:** `tests/schema-generation.test.js` — 14 tests.

### Two resolution traps, both previously hit in this file

**`createRequire().resolve()` cannot see Litestone.** Its exports map declares
only `import` and `types`, and require-resolution needs a `require` condition —
the same dead fallback found in `virtual-sierra.js` earlier in this document. The
plugin reads the package manifest and follows its exports map by hand instead.

**The package root pulls in `bun:sqlite`.** Importing `@frontierjs/litestone`
resolved fine and then threw `Only URLs with a scheme in: file, data, and node`
— this plugin runs wherever Vite runs, which is usually Node. The parser and
JSON-schema generator have no driver dependency, so they are imported by
subpath. **Litestone gained a `./jsonschema` export** for this; `./parser`
already existed.

The first failure presented as "could not be resolved" when the package had
resolved perfectly well and failed to *load*. The warning now says "could not be
loaded".

### Note on the test fixture

`generateSchemas` tests build their own temp root with a `node_modules` symlink
to Litestone, rather than linking it into `sierra/node_modules`. Sierra's own
tree must stay free of sibling packages or `frontier-resolution.test.js` stops
testing anything — the contamination lesson from §10 applies here too.

---

## Not changed

Still-open findings from the audit, in rough priority order:

Nothing outstanding from the original audit.

Observations made while reading Junction that were **not** acted on, since they
are that package's concern rather than Sierra's:

- **`src/client/index.ts` has zero imports** and no Bun or Node built-ins — it is
  cleanly browser-safe. Worth keeping that way; it is what makes the client
  bundle small.
