# Changes — @frontierjs/sierra

## 2026-08-08 — `action()` can address a collection, and carry a query

`resource.service.action(name, id, data, query)`: `id` may be null for an
action about the whole collection, and the fourth argument travels as the
request's query string. Both were reachable on the server and neither was
expressible here — see junction's note for why. The hook pipeline, and the
deliberate absence of coercion and validation on an action payload, are
unchanged. 809 tests; `test:safety` 5/5.

## 2026-08-06 — a prerendered page is the app, not a fragment of it

809 tests (was 805). Closes `FJS-108`.

A `target: 'static'` page shipped every `@frontierjs/css` class name the app
uses and **not one rule behind them**. A prerendered document is assembled by
`wrapDocument` rather than by Vite's HTML transform, so the stylesheet the same
build emits had no way into it, and the theme — one class on `<body>`, stated in
`index.html` for the SPA — had none either. The SPA built from the same source
looked right, which is why nobody had seen it.

`wrapDocument` now takes `stylesheets` and `bodyClass`:

```js
// sierra.static.config.js
document: { bodyClass: 'app theme-default' },
```

The stylesheets are the CSS assets of that build, discovered rather than
configured, and they are linked BEFORE the page's own scoped `<style>` blocks —
a component's own rules are the more specific statement and must win.

**Read in `writeBundle`, not `generateBundle`.** Vite's CSS plugin emits the
stylesheet in its own `generateBundle`, which runs after Sierra's, so reading the
bundle one hook earlier saw an empty asset list and linked nothing, silently.

Driven end to end by `example/`'s new `verify:public`, which asserts the link,
the body class, and a theme token resolving in a real browser.

## 2026-08-06 — `@version` works from the browser, not just at the boundary

805 tests (was 789). Closes `FJS-105`.

Litestone shipped optimistic concurrency the same day: a patch on a `@version`
model that does not carry the version it read is refused, and one carrying a
version that moved is a 409. `x-version` named the column in the JSON Schema and
**`createResource` read none of it** — so every patch on such a model 400'd until
an app threaded the column by hand. The framework was enforcing a guarantee its
own client could not satisfy.

`createResource` now remembers the version of every record it reads — `get`,
`find`, `load()`, `create`, and each patch response — and puts it on the next
patch. Two details decided the shape:

- **Kept per record, not read off `store`.** A form usually loads one record with
  `get()`, which does not populate the list store at all.
- **`load()` needed its own call.** It goes through `junctionResource` rather than
  `_call`, so it saw none of this — and a list whose rows cannot be patched is the
  same bug wearing a different hat.

A caller-supplied version still wins — that is someone doing their own
concurrency control. With nothing remembered the patch goes up *without* one and
the server refuses, which is better than inventing a number that would silently
win a race. `resource.version(id)` and `.versionField` expose it.

### A 409 could not say which kind of 409 it was

Litestone throws two, and they want opposite words. `VersionConflictError` and
`TransitionConflictError` are races — re-read and re-apply. `TransitionViolationError`
is a domain refusal, and *its own message* is the right thing to show; telling
someone to retry a move that will never be legal is worse than saying nothing.

The flag already existed on the litestone classes and stopped at the boundary.
Junction's `toFrameworkError` now adopts `retryable` and `FrameworkError.toJSON`
serializes it, so both transports land it at `err.data.retryable`.
`isStaleWrite(err)` reads it and `toFieldErrors` returns

> This record changed while you were editing it. Reload to see the current
> version, then try again.

instead of a column name and two integers. A non-retryable 409 keeps its own
message, and a per-field 400 is untouched.

Verified end to end rather than against a mock — a real litestone update behind a
real route, over a real HTTP round-trip, with the browser client's error shape
rebuilt from the response body: 409 retryable → the sentence, 409 non-retryable →
its own message, 400 → the required-version explanation, success → version 1 → 2.

## 2026-08-06 — a prerendered page must prove it is safe to publish

789 tests (was 755), plus `bun run test:safety` — 5 checks against a real
Litestone client. Typecheck clean.

`render: static` emitted HTML at build time. Every model declares who may read
it. **Nothing connected the two**, so a static route whose `load()` read a model
gated at level 4 wrote that data into a public file — then served, CDN-cached
and indexed, with no warning and no way back. Two correct features, combined the
obvious way. `ISSUES.md` FJS-081.

The prerenderer now collects each route's read set and refuses to emit a page
whose data outranks what the route declares:

```
✗  src/public-site/catalog/index.mesa — render: static
   reads `Invoice`, which is @@gate read 4 — level 4 required to read.
   A prerendered page is public: whatever it contains is served to anyone,
   cached by a CDN and indexed, and cannot be recalled.

   Change the route to `render: spa`, move the data into a client:* island,
   or — if this data really is meant to be public — say so in the route:

       publishes: 4
```

### The read set does not come from the render

`IDEAS/static-safety.md` proposed watching the render, on the grounds that "the
prerenderer knows which resources a route touched (it renders them)". **It does
not.** A static route's data comes from `load()` in the `.meta.js` companion,
*before* render, and arrives as a plain `data` prop. Watching the render would
have observed an empty set and passed everything — a green check proving
nothing, which is worse than no check.

It comes from litestone's `$tapQuery` instead, wrapped around the companion.
That also covers the case a build-time analysis structurally cannot see: a
`load()` that imports a Litestone client directly and queries it, which is how a
real app is written.

One thing only running it could settle: **the tap reports the TABLE name
(`product`) and `$defs` is keyed by the MODEL name (`Product`)**. `modelNameFor()`
already owns that resolution, so it resolves through it rather than
lower-casing by hand.

### Fail closed, with a written escape

A route whose reads cannot be *observed* is not a route known to be safe, so it
is refused rather than assumed clean. The only way past is per-route, in the
frontmatter — never a global flag — so publishing gated data is something
somebody wrote down and a reviewer sees in the diff:

```
---
render: static
publishes: 4
---
```

Absent, the bar is 0. `publishes: true` is **refused**: `Number(true)` is 1, so
coercing it would have accepted "level 1" and turned the check off by accident.

### A fail-open hole in the first version of this, found by running it

`importCompanion` swallows an import error and returns null, so a `.meta.js`
that *throws on import* looked identical to a route with no companion and was
waved through as "reads nothing". Found in `example/`, not by reading — the
first `bun run build:public` ran under Node, the companion's db import died on
`bun:sqlite`, and the page was emitted anyway. A companion that exists but could
not be read is now UNKNOWN, which is the case the check exists to refuse.

### Also

- New config key `db` — a module exporting the Litestone client the build taps.
  Every failure to load it returns null rather than throwing, because "cannot
  import db.js" would send the reader at the wrong problem; the route is then
  refused for being unobservable, which is the real one.
- No `.lite` schema means no gates, so the check stands down entirely. A Sierra
  app with no database is unaffected.
- The build prints what it PROVED, not only what it rejected — a rule whose
  passing case is invisible is one people assume is not running.
- **Sharp edge:** the build's `$defs` come from `db/schema.lite`, which can be
  narrower than what the app composes at runtime. In `example/`, auth's `User`
  is appended by `authSchemaFragments()` and so is not in the build's view — a
  static route reading it is refused as *unknown gate* rather than *gate 8*.
  Both refuse; only the wording differs.

Exercised for real in `example/`: `bun run build:public` prerenders `/catalog/`
from the live database and reports `/catalog/ 0 Product(0)`. Point its `load()`
at a gated model and the build exits 1.

## 2026-08-06 — the payload pipeline is on by default, and a thrown value has an unwrapper

755 tests (was 742).

**`coerce`, `blankToNull` and `validate` now default ON** for
`createResource`. Each was opt-in, and each answers something the DOM does that
the schema has already said no to:

- every control hands back a string, including `<input type="number">`, so a
  Float field arrived as `"42"`
- an untouched text box submits `''`, which SQLite does not treat as the NULL a
  nullable column wants — `String? @unique` accepts any number of NULLs and
  rejects a second `''`
- and without the check, the first "no" is a 400 you still have to map

The evidence they were the wrong default is that every app in the repo set all
three: all three resources in `example/`, and eight of the nine in
`packages/basecamp` (the two that did not are read-only). Those flags are now
deleted from both — a flag every app turns on is a default. Off is
`{ validate: false }`, and the test is `!== false` rather than `?? true`, so a
prop threaded through a component that never set it reads as "not stated"
instead of silently disarming the check.

This is also what makes `<Form>` in `@frontierjs/ui` correct with nothing
declared but a resource: the form does not validate, the resource does, and the
form only renders what came back.

**New: `toFieldErrors(err)` in `field-rules.js`, and `resource.fieldErrors(err)`.**
A failed write arrives in one of three shapes, because each hop adds a wrapper:
`err.errors` (ResourceValidationError — the browser said no), `err.data.data`
(a server 400 as the browser client throws it) and `err.data` (the same list
one wrapper shallower). It returns `{ fields, message }` — `fields` keyed for
`<Field errors={…}>`, `message` the form-level line, empty when the failure was
entirely per-field so a form does not say everything twice.

One owner for that translation, in the leaf module, so a form does not need to
know which shape it is unwrapping and there is nowhere for a second copy to
drift. 10 tests.

## 2026-08-04 — compiler errors now fail the transform

742 tests. `mesa-plugin` read `ctx.analysis.warnings` and never
`ctx.analysis.errors`, so a component the compiler had rejected was served
anyway. A settings screen with five `bind:` errors in it — every one correctly
diagnosed as "must be a writable top-level `let`" — rendered, looked right, and
silently collected nothing. The transform now throws with the list.


## 2026-08-04 — the unexported-snippet warning fired on every kit component

742 tests. `warnUnexportedSnippets` measured "top level" by counting block
directives only, so a snippet written inside a component tag —

```svelte
<Table {rows}>{#snippet row(r)}<tr>…</tr>{/snippet}</Table>
```

— read as top level and warned on every build, advising an export that would
have been wrong: that snippet is the component's `row` prop, not something the
route hands up to its layout. Component tags now count as nesting.

The tag scanner skips attribute expressions by brace and quote depth rather
than scanning to the first `>`, because an ordinary handler contains one:
`onclick={() => run(id)}` ends a `[^>]*>` match inside the arrow, and the tag
is then read as never closed — which would have suppressed the warning for
everything after it. Both cases are pinned in `tests/warnings.test.js`.

## 2026-08-04 — resource.service.action(): custom actions over HTTP

A resource could not call a custom service action at all. Junction has shipped
the whole mechanism for a while — a non-CRUD function on a service definition is
dispatched as `POST /{service}/{id}` with an `X-Service-Method` header, and the
browser client has `action(name, id, data)` — and Sierra's service proxy simply
never exposed it. `orders.service.action('pay', 3)` was a TypeError.

Worse, the pipeline's `default` branch — which handles any method that is not
CRUD — routed through `proxy.call()`, the *explicit WebSocket* escape hatch. That
is WS-or-nothing by name, and with no socket it recursed inside Junction's client
and never settled. The default branch now goes through `action()`, which applies
the framework's transport rule: the socket when one is connected, HTTP when it is
not. `call` stays on the proxy for callers that want to force the socket.

(The corresponding Junction fixes — `action()` and `restore()` now prefer the
socket, and the HTTP fallback no longer recurses — are in that package's
changelog for the same date.)

`action()` runs the full hook pipeline. Coercion, blank-stripping and validation
are deliberately skipped: those are defined against the model's fields for
create/patch payloads, and an action's body is whatever that action declares.

Found the only way this kind of gap is found — by joining the two ends in a real
app. `@@transitions` was declared in a schema, enforced at the Data boundary and
reaching the browser as `x-transitions`, with nothing anywhere calling any of it.

## 2026-08-04 — the browser says the sentence the schema declared

740 tests (was 729).

`buildFieldRules` carries `title` (Litestone's `@label`) and `x-messages` onto
each rule, and `validateAgainstFields` consults the authored wording for the
keyword that failed before falling back to its generated sentence. The fallback
is built from a new exported `fieldLabel(name, rule)`:

    @label   →  "Customer is required"
    relation →  "customer is required"      ← a foreign key borrows its relation's
                                              name with nothing authored at all
    neither  →  "customerId is required"

The middle case is the common one, and the one where the raw column under a
form label reading "customer" looked most like a bug.

`title` is read off the field's OWN schema rather than the deref'd target —
Litestone titles every enum `$def` with the type name, so `status OrderStatus`
was introducing itself as "OrderStatus". It has been removed from `_CARRIED`
for that reason; two existing tests caught it.

The error object still keys on the real field name, so a form can still find
the control it belongs to.

## 2026-08-04 — a relation key defaults to null, not 0

729 tests (was 724). Reported from a form in `example/`: not picking a customer
answered `500 FOREIGN KEY constraint failed` instead of "customer is required".

`createMakeFromSchema`'s `typeDefaults` gave every `integer` a `0`, so
`orders.make()` produced `customerId: 0`. That is not "no customer" — it is
customer #0, a claim the user never made. It is also the one invented default
nothing downstream can catch: a bad enum value fails validation with the
field's name on it, but `0` is a perfectly good integer, so `coerce()` keeps
it, `validateAgainstFields()` approves it, and the database is the first thing
to object — from the server, after a round trip, as a 500.

The function three lines above already made this argument for enums: *"picking
the first member would invent a choice the user never made — so leave it unset
for the form to fill."* A foreign key is the same case.

`createMakeFromSchema` takes a fourth argument, the FK column names, and
defaults them to null. It cannot be derived from `properties`: a belongsTo is
emitted as a plain integer and `x-relations` is the only place the relation
exists on the client, so `createResource` reads `x-relations[].fields` and
passes them in.

`string: ''` is deliberately unchanged. A required string left blank also
fails, but it fails *informatively* — `@length(3,20)` names the field and the
rule — and an empty text box is what the user actually sees. There is no such
honest empty for a numeric key.

Five tests in `tests/make-from-schema.test.js`, one of which pins the crux:
`0` produces no validation error at all, `null` produces "customerId is
required".

Newest first.

## 2026-08-04 — `resource.transitions(row, level)` — the button list, off the schema

Litestone gained `@@transitions`: a state machine declared on the model and
enforced at the Data boundary, with an optional `@gate(N)` per move. It reaches
the browser as `x-transitions` on the model definition, and this is the client
half.

```js
const orders = createResource('orders')

orders.transitions(row, level)
// → [{ name: 'ship',   field: 'status', from: 'paid', to: 'shipped',  gate: null, allowed: true  },
//    { name: 'refund', field: 'status', from: 'paid', to: 'refunded', gate: 5,    allowed: false }]
```

The legal next states for that record, so a view renders exactly the right
controls with no logic of its own. New in `src/junction/field-rules.js` —
`buildTransitions(modelDef)` and `transitionsAt(spec, row, level)` — which stays
a leaf module with no Junction-client import, so both are testable in plain Node
against litestone's own output rather than a copy of it.

Same contract as `canAtLevel()`, and for the same reasons:

- **An affordance, never a boundary.** Litestone re-checks every move and throws
  `TransitionViolationError` / `TransitionGateError` regardless of what the
  client drew.
- **Unknown answers are permissive** — no gate on a move, or no level supplied,
  means `allowed: true`. A missing button is the quieter, worse failure.
- **A gated move the caller can't make is returned with `allowed: false`, not
  dropped.** Rendering it disabled is usually better than making it vanish;
  filter on `allowed` if you disagree.

A resource whose model declares no machine returns `[]` rather than pretending,
matching how `fields` and `relations` already degrade.

`tests/resource-transitions.test.js` builds its fixture by running litestone's
parser and `generateJsonSchema` over a `.lite` source rather than hand-writing
the defs, so drift between what litestone emits and what the client reads fails
here instead of in an app. 724 tests green (was 707).

## 2026-08-03 — probing `client:visible` in headless Chrome: a harness trap, not a product bug

Recorded here because it reads exactly like a broken feature and cost a
debugging cycle: a `client:visible` island that never mounts in a headless
verification run, while mounting correctly in a real browser.

**Headless Chrome delivers almost no rendering lifecycle after load.** Under
`--virtual-time-budget` the page gets a frame or two around load and then
effectively none, so an `IntersectionObserver` set up *after* that window never
reports — the callback simply does not run, and the island stays inert.

What does not help:

- `--run-all-compositor-stages-before-draw` — no effect on this.
- awaiting `requestAnimationFrame` — **hangs**; rAF stalls after one or two
  frames.

The working pattern is in `tests/fixtures/island-site/verify.mjs`: **scroll
first**, before the observers matter, and do it inside a nested scroll container
so the rest of the page stays where the other assertions need it.

Applies to anything in this repo driving headless Chrome for verification,
`@frontierjs/css`'s suite included.

---

## 2026-08-03 — nested islands: the ancestor's mount is authoritative

A `client:*` component inside another one worked by accident and reported itself
as broken. Mesa's `island()` short-circuits on the client, so a mounted island
renders its nested children directly — live, in its own delegation root, before
their directives fire. The loader raced that instead of deferring to it.

Three fixes in `src/islands/loader.js`:

- **A subsumed island resolves nothing.** The scheduled callback checks
  `open.isConnected` before touching the registry, so a nested island neither
  downloads a chunk nor reaches `mount()` with a detached anchor. That throw was
  being caught and logged as `<Inner> failed to load or mount` — a working
  island announced as broken on every page that nested one.
- **Mounting clears the LIVE range**, not `island.nodes` from scan time. A
  descendant that mounted first has already replaced its own markup, so removing
  the captured list would strand its live nodes beside the ancestor's fresh
  render — two copies, one of them dead.
- **A descendant that got there first is disposed**, releasing its delegation
  root instead of leaking it. (`mount().destroy()` does not dispose effects —
  Mesa's mount owns no reactive root — so that limit is documented, not hidden.)

`findIslands` now links each island to its `parent`, which is the client's only
view of nesting: a marker records a component, not a position in a tree.
`client:static` under a live ancestor warns — the parent renders its children,
so "no JS" cannot be honoured — while a `client:static` *parent* never mounts and
therefore does not subsume anything inside it.

Requires the matching Mesa build: the fixture for this uncovered a
double-dispatch bug in Mesa's event delegation (see its CHANGES.md).

Test status: **707 passing, 34 files**, typecheck clean; the browser fixture is
20 → 25 assertions and now builds a nested island end to end.

---

## 2026-07-25 — performance/correctness pass

Baseline was the 2026-07-25 archive. Requires the matching `@frontierjs/mesa`
build (see its CHANGES.md — the async-declaration compiler fix is independent
but was found via this app).

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

## 16. `config/vite.config.js` — the conventional layout could never build

*2026-08-03*

`virtual:sierra` emits a literal `import sierraConfig from '<path>'`, and that path
was derived by string-rewriting the resolved Vite config path:

```js
viteConfig.configFile?.replace(/vite\.config\.[jt]s$/, 'config/sierra.config.js')
```

That assumed `vite.config.js` sat at the Vite root. The FrontierJS layout puts
configuration in a dedicated `config/` folder, so the normal case —
`web/config/vite.config.js` beside `web/config/sierra.config.js` — derived
`web/config/config/sierra.config.js`, and every build failed with `Module not
found`. Reproduced against `example/` before the fix; it is a hard failure, not a
warning. The escape hatch (`_configPath`) existed, but nothing that scaffolds an
app set it — `fli project:new` writes exactly this layout and shipped broken.

`resolveSierraConfigPath()` now **looks instead of assuming**: beside the Vite
config, then `config/` beneath it, then `config/` under the Vite root, then the
root — trying `.js`, `.mjs` and `.ts` at each. Both layouts work, `_configPath`
still wins outright, and when nothing exists the fallback names the conventional
location rather than a doubled path nobody wrote.

`example/` now models the whole convention rather than describing it. It was flat —
`index.html`, `config/`, `public/` and `src/` at the package root beside `api/` and
`db/` — which read as if a Sierra app *were* the app. Those four moved under
`web/`, and `vite.config.js` moved into `web/config/`, so the tree is
`db/` + `api/` + `web/` with configuration in `config/`. The UI now finds the
schema the way a real app does, through `../db/schema.lite`, instead of through
the `db/schema.lite` branch that only worked because the tree was flat.

Verified after the move, not assumed: `bun run build` emits the same bundle and
post-build artifacts to `web/dist/client/`, the build resolves the schema at
`../db/schema.lite`, `virtual:sierra` imports `/config/sierra.config.js` with no
doubled segment, and a CDP pass signs in as admin, submits the generated form
(new row reads `42` and a `null` slug) and deletes it — the API agreeing the row
is gone — with 0 console errors.

`tests/sierra-config-path.test.js` — 9 tests, including one asserting no resolution
ever contains `config/config`.

---

## 17. The example's sign-in failed silently when the API was down

*2026-08-03* — reported from a real run, not found by a test.

Console showed two of these and nothing else:

```
[Sierra] unhandledrejection … reason: SyntaxError
__x00__virtual:sierra:24
SyntaxError: JSON.parse: unexpected end of data at line 1 column 1
```

`virtual:sierra:24` is the dev overlay's `unhandledrejection` listener — the
reporter, not the cause, which is exactly why the trace was useless. The cause was
`signIn()` in `example/web/src/routes/_module.mesa` doing `await res.json()` with
no check on the response. `/login` is proxied to the API on :3500; with that
process not running, Vite answers **502 with an empty body**, and parsing it threw
inside a promise nobody awaited. Reproduced by stopping the API and clicking sign
in.

Now it checks `res.ok` first and shows `API not reachable on :3500 — run bun run
api` in the header. Verified both ways: API down → the message, no console error,
no rejection; API up → sign-in still returns level 5.

Two notes from the fix itself, both worth knowing:

- **`$:` is for fields of plain objects, not for locals.** Adding the new `let` to
  the `$:` tuple compiled cleanly and threw `$runtime.get(...) is not a function`
  on mount (Mesa RULE 43).
- **A dev-overlay report names the listener, not the throw.** When a
  `PromiseRejectionEvent` points at `virtual:sierra`, look at the exception's own
  stack — Chrome gives the real frame (`_module.mesa:39`), the overlay line never
  will.

---

## Not changed

Still-open findings from the audit, in rough priority order:

Nothing outstanding from the original audit.

Observations made while reading Junction that were **not** acted on, since they
are that package's concern rather than Sierra's:

- **`src/client/index.ts` has zero imports** and no Bun or Node built-ins — it is
  cleanly browser-safe. Worth keeping that way; it is what makes the client
  bundle small.
