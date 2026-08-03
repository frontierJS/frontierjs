# Changes — @frontierjs/mesa

## 2026-08-02 — island markers in SSR output (SSR_SPEC W3)

`ctx.islands` had been populated by the compiler since it was written and read
by nobody: Sierra collected it into `islandMap` and consumed it nowhere, and SSR
emitted an island's markup inline with nothing to identify it. A client loader
had no way to tell `<button>0</button>` from the static text beside it, and
nothing outside Mesa could add a marker, because the markup is produced inside
Mesa's own renderer.

Opt in with `{ islands: true }` — on `compile`/`compileSource`, or as
`renderComponent(src, { islands: true })`, which threads it to every module in
the tree.

```
<!--mesa-island {"component":"Counter","directive":"load","props":{"start":3}}-->
<button>3</button>
<!--/mesa-island-->
```

**Comments, not a `<mesa-island>` element.** The element form is what the spec
sketched and it fails two ways that produce no error. The HTML parser
foster-parents a non-table element out of `<tbody>`, so an island rendering rows
loses the association before any loader runs — checked in headless Chrome, where
the comment marker stays put in `TBODY`. And a wrapper element joins `>`
selectors and flex/grid layout, so a page would style differently prerendered
than client-rendered; `display: contents` fixes the layout half and nothing
fixes the selector half.

**Two guards.** The flag switches emission — omitting it is byte-identical to
before, so RULE 26 holds by default. The environment then decides whether a
marker is written: `island()` calls the component directly on a real client, so
client DOM is unchanged even with the flag on.

**The marker carries props as rendered.** `ctx.islands` is a compile-time view
and sees only literal attributes — `start={2 + 3}` contributes nothing to it,
while the marker says `{"start":5}`. Both ship: `renderComponent` now returns
`.islands`, the flattened build-time list with each entry tagged by the file it
was written in, which is what maps a component *name* onto a module to import.
Props that cannot survive JSON are dropped with a named warning; a props object
that cannot be serialized at all degrades to identity-only rather than losing
the marker.

**Mounting needs no new protocol**: clear the range, then
`mount(openComment, Comp, { props })`. It must be `mount` — a bare
`Comp(anchor, props, null)` renders the right markup and registers no delegation
root, so the island comes back **inert**, the same trap that made all 59 REPL
examples render and respond to nothing. A click in `render-ssr.test.js` pins it.

**Two things found by probing, both worth keeping.** happy-dom 14.12.3 filters
`createTreeWalker(root, NodeFilter.SHOW_COMMENT)` to nothing — the obvious
loader implementation, correct in Chrome, silently finds zero islands under this
repo's SSR harness. And happy-dom ends a comment at the **first `>`**, not at
`-->`, which split a marker in two and made `JSON.parse` throw on the fragment;
the payload now escapes every `-` and `>`, so `a --> b <!-- c > d` round-trips
exactly through both parsers.

Still Sierra's, and untouched: the loader itself, per-island bundling, and
name→module resolution.

11 new cases in `render-ssr.test.js`; 891 → 902 pass, 0 fail.

## 2026-08-02 — two emissions that compiled clean and did not parse

Found by a new `repl.test.js` check that the compiled output of every example is
valid JavaScript. Compiling without errors and emitting valid code are different
claims; nothing had been checking the second. Each bug had silently broken a
shipped REPL example.

### `bind:` on a component prop

`<Input bind:value={name} />` put the raw attribute name in the props object:

```js
Input(el, {bind:value: $runtime.get($$sig_name)}, null)   // not parseable
```

VISION §3.4 documents the form as supported and nothing in the repo used it, so
it appears never to have been implemented. Plain `value={name}` is one-way — the
child's writes never reach the parent — so there was no working two-way binding
across a component boundary at all.

Now implemented rather than rejected. The parent→child half already existed
(`pushProps` over the child's `_propRegistry`); the missing half is
`bindProp(anchor, name, setParent)`, which subscribes to the child's own prop
signal and writes changes back out. No feedback loop: the write lands on the
parent's signal, whose equality check stops it. Binding to anything that is not
a writable top-level `let` is now a compile error naming the variable.

Broke the `uiComponents` example.

### Multi-line interpolated attributes

```html
<div style="background:{done ? '#a' : '#b'};
            width:{pct}%">
```

emitted a template literal that was truncated at the newline and never closed.

`_renderGroup` — the pass that folds consecutive `bindText`/`bindAttribute` calls
into one `render()` block — is regex surgery over generated source, and its line
pattern ended at the first `;` before a newline. A CSS semicolon at end-of-line
looks exactly like a statement terminator. The attribute's first line was pulled
into a grouping run, the run was rewritten, and the continuation was orphaned.

The scanner now walks lines and requires a complete statement — balanced
backticks — before grouping anything. A binding it cannot parse is passed
through untouched: grouping is an optimisation, and leaving a binding alone is
always correct where truncating one never is.

Worth knowing for anyone reproducing it: a preceding text binding is required.
It is what pulls the attribute into the same run, so a single-element fixture
compiles fine even on the broken compiler.

Broke the `guiTimer` example.

**New:** `emission.test.js` — 7 tests. Both fixtures were checked against the
pre-fix compiler to confirm they actually reproduce.

## 2026-08-02 — `$: { }` assignments no longer emit invalid code

`$: { count = count + 1 }` compiled to `$runtime.get($$sig_count) = …`, an
invalid assignment target. The compiler reported nothing; it threw
"Invalid left-hand side in assignment" the first time the effect ran.

Cause: the `$:` effect emitter called `rewriteExpr` but not
`rewriteAssignments` — the only user-code emitter that skipped it. Script
statements and watch handlers had always called both. Member writes
(`obj.n = …`) went through the proxy and were never affected, which is why it
survived: the shapes people reach for first still worked.

Fixed by carrying the body's AST node on the effect record and running
`rewriteAssignments` before `rewriteExpr`, as every other site does. 691
compiler + runtime tests unchanged.

This is why no REPL example used the `$: { }` block form — it could not be made
to work. There is one now.

Applied during the 2026-07-25 performance/correctness pass. Baseline was the
`_built: 2026-05-05` snapshot.

## compiler.js — async function declarations no longer wrapped in an IIFE

`emitScript` decided whether to wrap a top-level statement in an async IIFE with
a regex:

```js
const containsAwait = /\bawait\b/.test(rewritten)
```

A regex cannot distinguish a top-level await from one nested inside a function
body, so

```js
async function handleLogin() { await save() }
```

compiled to `(async () => { async function handleLogin() {…} })()`. The
declaration ended up scoped inside the IIFE, so a template binding
`onclick={handleLogin}` resolved to nothing and threw
`ReferenceError: handleLogin is not defined` at click time — no compile warning,
no build failure.

Replaced with `_hasTopLevelAwait(node)`, an AST walk that stops at function and
class boundaries and refuses to wrap declarations outright (a declaration is a
binding; hiding it is never correct).

Scope of the bug: `async function` **declarations** containing `await`. Arrow
consts (`const go = async () => { await … }`) took a different code path and were
unaffected, which is why most code worked.

Genuine top-level await — `data = await fetch(...)`, a bare
`await new Promise(...)` — is still wrapped, verified by test.

**New:** `async-decl-scope.test.js` — 7 tests covering both directions.

## VISION.md §4 rewritten — v1.9

The `$:` section is now the authoritative reference for reactivity, and every claim in it
is checked by `spec-check.mjs` against the compiler rather than asserted.

Rewritten because §4 had drifted from the implementation in ways that mattered: it
documented `$: { (a, b) }` as a block effect (it compiled to a throwing `orderedGroup`),
said nothing about effect phase, and predated defer, previous values, and the inert-block
error.

New structure — §4.0 what `$:` is for, §4.1 watches, §4.2 explicit-dep effects, §4.3
auto-tracked effects, §4.4 ordered groups, §4.5 writable derived, §4.6 debug labels,
§4.7 timing and phase, §4.8 compile errors, §4.9 reference table.

Eight new rules, no existing rule dropped (verified by diffing the rule sets):

| | |
|---|---|
| **43** | Replacement is reactive; mutation is not — identical for local and imported objects |
| **44** | The compiler tracks what it compiled; imports are inert until `$:` says otherwise |
| **45** | A watch only fires for writes that go *through* the proxy |
| **46** | `prev` holds a reference — replacement gives a real previous value, mutation does not |
| **47** | Auto-tracked effects cannot be deferred; they discover deps by running |
| **48** | DOM-building work runs before user effects within a flush |
| **49** | The initial run of an auto-tracked effect precedes the template |
| **50** | A `$: { }` block whose body only reads is a compile error |

RULES 43 and 44 are the two that explain the rest — they were true all along and stated
nowhere.

§5 gained the **writer** side of shared state, which was the missing half: it documented
how components read a plain-object store but not how the store notifies. Plus RULE 51 —
reactive logic doesn't belong in `.js` modules, stated as discipline rather than
enforcement, with the reasoning for why no `createRoot` exists. *(Superseded
2026-08-02 for lifetime boundaries — VISION RULE 54.)*

## `$: deps, handler` is deferred and receives the previous value

Two changes to the same form, decided together because they reinforce each
other.

**Deferred.** The handler no longer runs on mount, only on change. "When X
changes, do Y" reads as change-triggered, and firing on mount is usually wrong —
`$: userId, () => { count = 0 }` resetting on first render is a no-op at best.
The eager case is already owned by `$onMount`, and the "initialise, then keep in
sync" shape is almost always a `const` memo wearing an effect's clothes.

This is only possible because the deps are explicit: the effect still reads them
on the first run to subscribe, and withholds only the handler. An auto-tracked
`$: { }` block **cannot** be deferred — it discovers its dependencies by
running, so skipping the body would subscribe to nothing and never fire again.
That constraint is why Solid's `defer` hangs off `on()` rather than bare
`createEffect`, and it is why the two forms differ here by mechanics rather than
by convention.

**Previous value.** The handler receives `(value, prev)`; multiple deps give
`([a, b], [prevA, prevB])`, as Solid's `on()` does. Deferring is what makes
`prev` well defined — the first invocation is the first change, so there is
always a real previous value instead of `undefined` needing a guard.

Reference semantics: a *replaced* object gives a genuine previous value; an
object *mutated in place* gives the same reference for both, since producing a
distinct previous would mean deep-cloning every read. Documented, not solved.

**New:** `watch-handler-defer.test.js` — 13 tests.

### Bug found on the way: handler deps never registered a path watch

`$: cart.total, () => sync()` — a form §4.3 documents — compiled to a plain read
of an inert object:

```js
createEffect(() => { cart.total; return untrack(() => sync()) })
```

No `watchProxy`, no `watchPath`. It subscribed to nothing and never fired. Only
the bare `$: cart.total` form registered the path; the handler form was omitted
from the collection that drives proxy setup. Adding a redundant bare watch
alongside it happened to make it work, which is presumably how it went unnoticed.

Fixed by collecting dotted deps from `watchHandlers` as well. Deliberately only
*dotted* deps — adding bare identifiers too registered proxies for local `let`
variables, which switched their accessor from `$runtime.get($$sig_a)` to
`$$proxy_a` and broke three compiler tests. That deep-watch opt-in belongs to the
bare `$: a` form alone.

## runtime.js — onCleanup warns when it has no owner

`onCleanup` — and `$onDestroy`, which forwards to it — silently discarded the
callback when called with no owning scope: at module scope, after an `await`, or
inside a later callback. That is how subscriptions and timers leak for the
lifetime of a page. It now warns.

Reactive code outside a component stays supported but deliberately unadvertised:
`createEffect` works there, returns a disposer, and owns nested effects. No
`createRoot` was added — naming the pattern is what blesses it, and Sierra
demonstrates it isn't needed.

*(2026-08-02: reversed for lifetime boundaries only. `createRoot` now exists and
is exported — see VISION RULE 54. The argument above holds for reactive logic in
a `.js` store, which RULE 51 still forbids; it does not hold for code that owns a
span of work and must end it. `createEffect` cannot substitute there: it
subscribes to what its body reads, so a component that reads then writes a store
during setup ran **1001 times for one page render** under an effect and once
under a root.)* An entire routing framework uses zero reactive
primitives in its `.js` files; every state change is an imperative `.set()` from
an event handler, socket callback or promise resolution.

## runtime.js — user effects now run after the DOM updates

`render()` is `createEffect()`. Control flow — `ifBlock`, `keyBlock`,
`awaitBlock` — is also `createEffect()`. So renders, control flow and user `$:`
effects were all the same kind of node in one queue, and their relative order
fell out of creation order. Since the compiler emits the `<script>` before the
template, a `$:` effect ran *before* the DOM it was reacting to had updated:

```js
$: items, () => { count = el.childNodes.length }
```

measured one update stale, every time. Demonstrated: with 3 items rendered, the
effect reported 1.

This is inverted from both frameworks people arrive from. Solid's `createEffect`
runs after the render phase completes — `createRenderEffect` is the during-render
tier. Svelte's `$effect` runs after the DOM updates, with `$effect.pre` as the
opt-out. In both, the effect you reach for by default is the post-DOM one.

`_flush` now drains in two passes per iteration: everything that builds the DOM,
then user effects. Effects that queue further work are picked up by the next
iteration under the same ordering, so a render triggered by an effect still
lands before any effect it in turn triggers.

**The split is by *user effect*, not by *render*.** The first attempt tagged
render blocks and deferred everything else — which inverted parent/child order
and made inner renders fire against an `{#if}` branch that was about to be
disposed. `compiler_test.js` caught it: *"render() effects inside disposed
ifBlock branch do not run after branch switches"*. Control flow builds DOM and
belongs in the first pass; only the bodies of `$:` forms are deferred, tagged
`{ user: true }` at three emission sites in the compiler.

**New:** `effect-phase.test.js` — 5 tests, including a guard for the
control-flow ordering that the first attempt broke.

### Still pre-DOM: the initial run

`createEffect` runs its body immediately at creation, so on mount a `$:` effect
still runs before the template's render blocks exist. Only updates are
reordered. This mostly resolves itself if explicit-dep effects become lazy — the
decision already taken — since they then have no initial run at all. Auto-tracked
`$: { }` blocks must still run once to discover their dependencies.

## compiler.js — `$: { }` blocks that do nothing are now reported

A `$: { }` block runs code. If its body provably does nothing — every top-level
statement is a bare read — the author reached for braces to express a watch and
got silence. Effects don't drive renders in Mesa: a template's `{a}` compiles to
its own `$runtime.render()` block tracking its own reads, so an effect
subscribing to the same signal has no consumer. Measured: an effect reading a
signal a template also reads produces zero extra renders.

Reported forms:

```js
$: { }              // empty
$: { count }        // bare read
$: { a, b }         // see the note below
$: { (a, b) }       // sequence of bare reads
$: { cart.total }   // bare member read — and no path watch registered either
```

`$: { (a, b) }` is the one that mattered. It previously compiled to
`orderedGroup([{ deps: [a], handler: <the VALUE of b> }])` and threw
`fn is not a function` the first time `a` changed — so this replaces a runtime
crash with a build-time message that names the form the author wanted.

The parenthesised sequence and the handler shorthand have **identical ASTs** —
`{ (a, b) }` and `{ a, syncFn }` are both `SequenceExpression` with an
`Identifier` tail. The parens are the only distinguishing feature, so the check
reads them from source position. That is what RULE 14b is really about.

**New:** `inert-block.test.js` — 18 tests.

### Handlers inside a block must be inline functions — RULE 52

`{ a, syncFn }` and `{ a, b }` have identical ASTs, so the reference shorthand
could not coexist with detecting a bare multi-value read. Blocks now require
`() => …`; the unbraced form keeps the shorthand.

```js
$: { userId, () => load() }     // ✅
$: { userId, load }             // ❌ — write `() => load()`
$: userId, load                 // ✅ unbraced
```

That closes the last ambiguity in the block form: every `$: { … }` whose body
only reads values is now caught, where previously `{ a, b }` slipped through and
threw `fn is not a function` at runtime. The message covers both readings, since
they genuinely cannot be told apart:

> `'$: { a, b }' does nothing. A handler inside a '$: { }' block must be an inline
> function… If 'b' is a handler, write 'a, () => b()'. If you meant to watch both
> values, drop the braces: '$: (a, b)'.`

### Severity: diagnostics stay warnings — RULE 53

`analysis.errors` are emitted through `ctx.warning()`, so a build with an inert
block still produces output. Kept deliberately, and now documented: "error"
describes the intent — the code is wrong and will not do what it says — not the
exit code. A build tool that wants hard failures can escalate warnings.

## compiler.js — external reactivity diagnostic

A template read of an imported signal is only reactive if the name appears in the
`externalSignals` map the consuming build passes — a hand-maintained list living
in a different package from the signals it describes. A miss doesn't error: the
expression reads nothing reactive, so it's hoisted out of the render block and
the signal object, always truthy, renders once and never updates. Three real
bugs came from this, most recently a connection badge that read "ws connected"
with the server stopped and survived a reload.

`emitScript` now runs `_checkExternalReactivity`, which walks the template AST,
collects value reads, and warns when an identifier imported from a **described**
module isn't covered by that module's entry. It also catches namespace access
(`import * as j` → `{j.connected}`), which is never rewritten even when the
member is declared.

Deliberately quiet where it can't know: modules the map doesn't describe at all,
callee position (`{fn(x)}`), event handlers (`on:click={h}`) and directives.
Measured at 0 false positives across 36 real components; the event-handler
exclusion was necessary — without it the diagnostic fired on
`on:click={toggleTheme}`.

**New:** `external-reactivity.test.js` — 26 tests.
**Doc:** `EXTERNAL_REACTIVITY.md` — failure matrix and the remaining options.

### Path-watch tier

The same pass also reports §4.1 path watches that are missing. An imported plain
object is inert; `$: page.path` is what makes a path reactive. A member read with
no covering watch compiles to a static value.

Default level only fires when the file already watches *something* on that
import — intent is clear, so an uncovered path is an oversight. A `strict` level
(`externalReactivityHints: 'strict'`) reports any uncovered member read; opt-in,
because a plain config object and a mutable store look identical. Both defer to
`externalSignals`, so declared signals are never reported.

0 false positives across 36 real components in either mode.

## runtime.js — child watch proxies went stale on reassignment

`_getNestedProxy` cached child proxies by path alone, so replacing an
object-valued property left the previous child proxy in place permanently:

```js
cart.items = ['c']
cart.items      // → ['c']       raw object, correct
proxy.items     // → ['a','b']   stale child proxy
```

A template reading `{cart.items}` therefore rendered the *previous* value after
any reassignment. Primitives were unaffected and mutation in place
(`items.push(...)`) worked, so it looked intermittent — only reassignment of an
object-valued property, and only through the proxy.

Found while working out how to give `$:` handlers a previous value: a watcher on
`cart.items` reported `prev === current` after a replacement, both holding the
old array.

The cache now keys on path AND the object that path currently holds, so it
self-heals however the value changed — including writes that bypass the proxy
entirely, and descendants of a replaced parent.

**New:** `watch-proxy-staleness.test.js` — 8 tests. 5 fail against the previous
implementation.

This matters more than it looks: `PLAIN_OBJECT_STATE.md` proposes making path
watching the primary way components consume framework state. Every `page.data =
result` in that design is an object reassignment.

## runtime.js — watchProxy is idempotent

`watchProxy(alreadyProxy)` built a second proxy layer. `watchPath` then keyed its
signal by the outer proxy while the inner set trap fired signals keyed by the raw
object — they never met, so writes reached no watcher and nothing re-rendered,
silently. That happens whenever a module exports `watchProxy(state)` instead of
the plain object, which is a natural thing to write.

`watchProxy` now returns a proxy input unchanged, and `watchPath` normalizes a
proxy argument to its root object. Both export shapes work.

**Doc:** `PLAIN_OBJECT_STATE.md` — assessment of replacing Sierra's signal
architecture with watched plain objects, which is what motivated both changes.

## Test status

710 passing. The 27 failures in `email-kit.test.js` are pre-existing and
environmental: they need `/tmp/mesa/email/*.mesa` fixtures from the sibling
`@frontierjs/mesa-email` package, which is not part of this archive. Unchanged
from baseline.

## Not changed, but worth knowing

Findings from the audit that were **not** acted on:

- **`exports` map root points at the compiler.** `"." → "./compiler.js"` means a
  bare `import … from '@frontierjs/mesa'` pulls a 234 KB build-time module and
  its 11 dependencies (acorn, astring, css-tree, unified, remark-*…). The root
  export should probably be the runtime.
- **No `"sideEffects": false`.** Measured impact is small — the 119 KB runtime
  lands at ~10 KB raw / 4 KB gzip in a real app build — so this is a tidy, not a
  win.
- **SSR is process-global.** `render.js` installs happy-dom globals on
  `globalThis` and keeps a module-level `_win`; the reactive core
  (`_listener`, `_owner`, `_contextStack`) is singleton. Concurrent
  `renderToHTML()` calls will interleave. Latent today, but Sierra's
  `render: 'static'` / `getStaticPaths` path will want concurrency.
  *(2026-08-01: still process-global, but no longer able to interleave —
  `renderToHTML` is synchronous end to end by contract, with a test asserting
  it, so `renderAll` is serial rather than racy. Real parallelism still needs
  one window per worker. See `STATIC_RENDERING.md` §Concurrency.)*
- **`render-component.js` litters the package directory.** `compileTree()` writes
  temp `__mesa_render_*.mjs` files into the mesa package dir; running the test
  suite leaves ~14 behind. They were removed before archiving.
