# Mesa
## Reactive UI Language — Vision & Specification
### v1.9

---

## 1. Design Philosophy

Mesa is a JavaScript-native reactive UI language inspired by Svelte 4/5, SolidJS, and Malina.
It makes top-level reactivity natural through compiler-detected state, eliminates the need for
store APIs through ordinary JavaScript module exports, and provides clean idiomatic syntax
that is fully valid JavaScript AST throughout.

Mesa is built on five foundational principles:

- **Valid AST first** — every piece of Mesa syntax is valid JavaScript. No invented keywords,
  no special compiler-only tokens. A JavaScript parser can always parse Mesa source files.
- **Compiler over runtime** — as much work as possible is moved to build time. Dependency
  tracking, template binding detection, DOM wiring, and subscription management are all
  compiler responsibilities. The runtime is minimal.
- **Explicit intent** — the language rewards explicitness. Developers declare what they watch,
  what is reactive, and what intentionally floats outside the reactive graph. There is no
  silent magic.
- **Minimal API surface** — Mesa reuses existing JavaScript semantics (`let`, `const`, `var`,
  `export`, `await`, `$:`) and extends them with meaning rather than replacing them with new
  primitives.
- **DX parity with Svelte 4, performance parity with SolidJS** — familiar authoring experience,
  fine-grained reactive output.

### Compiled Output Strategy

Mesa's compiler targets `@mesa/runtime` and emits a named function per component:

```js
import * as $runtime from '@mesa/runtime';

// Template factory — cloned once per mount via cloneNode(true)
var $tpl0 = $runtime.template(`<p> </p>`, 0);

export default function Counter(__anchor, __props, __block) {
  // In dev builds: $runtime.push_component('Counter', 'Counter.mesa')
  // In prod: $runtime.push_component()
  $runtime.push_component();
  const $option = { props: __props };
  const $slots  = $runtime.makeSlots(__block);

  // Reactive signals (let → track, const → createMemo, export let → makeExternalProperty)
  const $$sig_count = $runtime.track(0, void 0, void 0, __block);
  const $$set_count = (v) => $runtime.set($$sig_count, ...);

  {
    // Sequential DOM traversal — computed at compile time, runs once per mount
    const $parentElement = $tpl0();
    var el0 = $runtime.child($parentElement, true);

    // Auto-tracking reactive binding — reruns only when count changes
    $runtime.render((__prev) => {
      var __a = `${$runtime.get($$sig_count)}`;
      if (__prev.a !== __a) $runtime.set_text(el0, __prev.a = __a);
    }, { a: ' ' });

    // Mount before the anchor comment
    $runtime.append(__anchor, $parentElement);
  }
  $runtime.pop_component();
}
$runtime.$$delegate(['click']);  // event delegation at module scope
```

Key properties of the output:
- **`var` for templates** — `var $tpl0 = $runtime.template(...)` avoids TDZ checks on every mount
- **Named function export** — `export default function Counter(anchor, props, block)` — the same `(anchor, props, block)` signature used everywhere: `mount()`, `keyBlock()`, `{#if}` branches, child components
- **`push_component()` in prod, `push_component(name, file)` in dev** — dev mode passes the component name and source filename for DevTools instance tracking. The compiler emits the dev form when `config.dev: true`.
- **Sequential traversal** — `child()`/`sibling()`/`pop()` replace path strings; calculated at compile time, O(1) per node at runtime
- **`render()` dirty-checking** — groups multiple text/attr bindings into one `createEffect`, compares with a `__prev` object, only updates changed nodes
- **`$slots`** — compiler-injected local from `$runtime.makeSlots(__block)`; reactive object indicating which named slots have content (used as `{#if $slots.sidebar}`)

### Static Component Detection

The compiler automatically detects when a component is fully static — no reactive state,
no event handlers, no context, no async. Static components are flagged with `ctx.isStatic = true`
and can be rendered to HTML strings with zero JavaScript using `renderToHTML()`. See Section 17.

### File Types

| Extension | Meaning |
|---|---|
| `.mesa` | Mesa component — HTML template |
| `.md`   | Mesa component — Markdown template with frontmatter |

Both compile to the same output format. Use `compileSource(src, { filename })` or `compileFile(path)`
and the compiler routes automatically based on extension.

---

## 2. Top-Level Variable Semantics

Mesa's reactive model is built entirely on three existing JavaScript keywords. Their meaning
at the top level of a component script block is extended, not replaced.

### 2.1 `let` — Mutable Reactive State

A top-level `let` declaration is the primary reactive primitive in Mesa. The compiler tracks
it, wires it to the reactive graph, and re-renders any template bindings when its value
changes. A `let` variable can be assigned at any time — by the developer, by a `bind:value`
directive, or by any function in scope.

```js
let count = 0             // reactive signal, instance-scoped
let selectedState = ''    // reactive, bindable
let query = ''            // reactive, bind:value target
```

The initializer is evaluated **once at component init** and never re-runs. `let` is always
a snapshot — it does not track its initializer for future changes. To derive a `let`
variable from other reactive state on an ongoing basis, use the `$:` writable derived form
(see Section 4.5).

```js
let selectedCity = cities[0]       // snapshot of cities[0] at init — independent after that

$: selectedCity = cities[0]        // writable derived — re-derives when cities changes,
                                   // but can still be overridden by bind:value
```

> **RULE 1** — `$:` annotations are top-level scope only — never inside functions, blocks,
> or callbacks.

> **RULE 2** — The compiler detects derived values. Any top-level `const` that references
> another reactive variable is automatically derived and recomputes when dependencies change.

### 2.2 `const` — Derived / Static

A top-level `const` is either a static value or a compiler-detected derived value. If it
references other reactive variables, the compiler automatically re-derives it when
dependencies change. The developer cannot manually assign to it — but the compiler can
re-derive it. This is not a contradiction: `const` means the developer cannot override it,
not that the value never changes.

```js
const double = count * 2              // derived — reruns when count changes
const isDark = theme === 'dark'       // derived from theme
const cities = await getCities(state) // async-derived — reruns when state changes
const MAX = 100                       // static — no reactive deps, inlined as literal
```

### 2.3 `var` — Non-Reactive Sampler

A top-level `var` intentionally floats outside the reactive graph. It can **read** reactive
values without subscribing to them — capturing a snapshot at a point in time. Writing to
a `var` notifies nobody. It is invisible to the reactive system in both directions.

```js
let price = 100
var snapshot = price        // captures current value of price, but does NOT subscribe
                            // snapshot stays 100 even if price changes later

var previous = null         // capture last-known value before an async update
var stagedInput = ''        // hold user input before committing to reactive state
var cache = new Map()       // memoization cache — reads/writes don't trigger re-renders
```

> **RULE 3** — The compiler detects template bindings. Every top-level reactive variable
> referenced in the template is automatically wired for rendering — no manual subscription
> needed.

> **RULE 4** — Scoped variables (declared inside functions or blocks) are NEVER tracked by
> the compiler. They are plain JavaScript. However, they CAN read and write top-level
> reactive state.

> **RULE 5** — All Mesa source code and all compiler output must be valid JavaScript AST.

---

## 3. Component Props

Mesa uses all three variable keywords after `export` for prop declarations. `export` signals
the value comes from outside the component. The keyword after `export` determines the
component's relationship to that value — exactly as it does for internal variables.

```js
export let  price    = 49.99   // reactive prop — parent can update, component can reassign
export const sku     = 'WGT'   // immutable prop — parent can update, component cannot reassign
export var  taxRate  = 0.08    // non-reactive prop — snapshot at mount, ignores future parent changes
```

### 3.1 `export let` — Reactive Prop

The parent can pass a new value at any time and the component re-renders. The component can
also reassign the variable directly. Two-way binding with `bind:` is supported and meaningful.

```js
export let quantity = 1        // parent writes, component reads and writes
export let selected            // no default — undefined until parent provides
```

### 3.2 `export const` — Immutable Prop

The parent can pass a value. The component **cannot** reassign it — the compiler enforces
this as an error. The value is derived from the parent's binding and recomputes if the parent
passes a new value. Use for values the component should treat as read-only configuration.

```js
export const sku      = 'WGT-001'   // component cannot do: sku = 'other'
export const currency = 'USD'       // stable within component, parent-controlled
```

### 3.3 `export var` — Non-Reactive Prop

The parent passes a value at mount. The component snapshots it immediately and **never
re-reads it**, even if the parent later passes a different value. Use for mount-time
configuration that the component treats as fixed for its lifetime.

```js
export var taxRate = 0.08      // captured once at mount — parent changes ignored
export var region  = 'US'      // stable for the component's lifetime
```

### 3.4 `bind:` Validity

| Prop declaration | `bind:prop` valid? | Reason |
|---|---|---|
| `export let p`   | ✓ Yes | Child can reassign — parent observes changes |
| `export const p` | ✗ Compiler error | Child cannot reassign — nothing to bind back |
| `export var p`   | ✗ Compiler error | Child ignores parent updates — binding is inert |

> **RULE 22** — `bind:` is only valid on `export let` props.

---

## 4. The `$:` Annotation System

Mesa repurposes the JavaScript labeled statement syntax (`$:`) as its reactivity annotation
layer. Every `$:` form is valid JavaScript AST. The compiler interprets the shape of the
labeled statement to determine its behavior.

### 4.0 What `$:` is for

`let` / `const` / `var` (§2) cover reactive *values*. `$:` covers everything that isn't a
value declaration, and it is exactly three things:

| | | |
|---|---|---|
| **Watches** | make inert state observable | §4.1 |
| **Effects** | run code when something changes | §4.2, §4.3, §4.4 |
| **Writable derived** | a value `const` can't express | §4.5 |

Two facts explain nearly every question about which form to use.

> **RULE 43** — **Replacement is reactive. Mutation is not.**
> `o = { … }` notifies. `o.n = 2` does not, unless a `$:` path watch covers it.
> This holds identically for local `let` objects and imported ones.

> **RULE 44** — The compiler tracks what it compiled. It knows every `let` and `const`
> in the component, so those need no annotation to be read reactively. It knows nothing
> about an imported binding, so anything imported is inert until a `$:` says otherwise.

Everything below follows from those two.

---

### 4.1 Watches — making inert state observable

A watch has no body. Its only effect is that the component re-renders when the watched
path changes. It exists because imported objects are opaque to the compiler, and because
mutation is not reactive by default.

```js
import { user, cart } from './store.js'

$: user              // whole object — any mutation re-renders
$: user.name         // surgical — only when user.name changes
$: cart.total        // ignores cart.items entirely
$: (cart.items, cart.total)   // multi-path — either one re-renders
```

The imported object is untouched. Mesa wraps it in a Proxy at the component level; the
`.js` file stays plain JavaScript with no Mesa awareness. See §5.

The same syntax opts a **local** `let` object into deep watching, because RULE 43 applies
there too:

```js
let filters = { q: '', page: 1 }

$: filters.q         // now `filters.q = 'x'` re-renders, not just `filters = {…}`
```

> **RULE 6** — Path watching uses optional chaining semantics.
> `$: cart.items.length` is a hard watch — `cart` and `items` must exist.
> `$: cart.items?.length` is a soft watch — handles `items` being undefined.

> **RULE 45** — A watch only fires for writes that go **through** the proxy Mesa
> created. A write on the raw object from outside is invisible. Within a component this
> is automatic. A `.js` module that owns state and wants its own writes to notify must
> take a handle with `watchProxy(state)` and write through that — see §5.

> **RULE 46** — A watch declared at a path covers that path **and everything beneath
> it**. `$: page` opts the whole object into deep reactivity; `$: page.user.preferences`
> opts in that subtree at any depth; a sibling subtree stays silent. A read subscribes to
> the nearest declared watch covering it, so granularity follows the watch you declared,
> not the depth of the property you read.
>
> A property key is a single segment whatever it contains: `obj['a.b'] = 1` is a write to
> the key `a.b`, and does not notify a watch on `obj.a`.

> **RULE 48** — `delete obj.key` notifies the watches covering that key, exactly as
> `obj.key = undefined` does. Deleting a key that was not present notifies nothing.

> **RULE 49** — Values with internal slots — `Date`, `Map`, `Set`, `RegExp`, `Promise`,
> typed arrays, `Error` — are handed through the proxy untouched. Their methods work
> normally, and their **contents are not reactive**: mutating a `Map` or advancing a
> `Date` fires nothing. Reassigning the property that holds one is reactive as usual.
> Wrapping them could never have made them reactive — their state lives in slots no
> proxy trap observes — and doing so broke every method call with an
> "incompatible receiver" `TypeError`. Class instances using **private fields** have the
> same limitation and are not detected; keep them out of watched state.

> **RULE 47** — Watches are a property of the **object**, not of the component that
> declares them. The registry is keyed by the object and shared process-wide, so if any
> component declares `$: page`, every other component's reads of `page.*` become covered
> by that watch and will re-render on any write to `page` — even components that declared
> nothing. Likewise, a finer watch declared elsewhere (`$: page.user`) becomes the nearest
> cover for other components' reads under it.
>
> This is always fail-safe — it can cause an extra render, never a missed one — but it
> means a component's update granularity is not always determined by its own source.
> It is a known and accepted limitation: `$: page` reads as "this object is now deeply
> reactive", which is inherently global. If you need a component's reactivity to be
> locally explainable, declare the specific paths it reads rather than relying on a
> coarse watch declared elsewhere.

---

### 4.2 Effects with explicit dependencies — `$: deps, handler`

The dependency list is declared; the handler runs untracked, so reads inside it never
add subscriptions. This is the form to reach for by default.

```js
$: cart.total, () => syncToServer()
$: cart.total, syncToServer                    // function reference shorthand
                                               // (unbraced form only — see RULE 52)
$: (cart.total, selectedId), () => sync()      // multi dep
```

> **RULE 7** — Watch+handler: the handler is always last, always outside parentheses.
> Parentheses group multiple dependencies only.

**Deferred.** The handler does not run on mount. It runs on the first change and every
change after.

```js
$: userId, () => { localCount = 0 }   // does NOT reset on first render
```

"When X changes, do Y" reads as change-triggered, and firing on mount is usually wrong.
The eager case is `$onMount`. The "initialise, then keep in sync" case is almost always a
`const` memo in disguise — if you find yourself writing an effect whose whole body assigns
a value derived from its own dependency, you wanted `const`.

**Previous value.** The handler receives the current and previous values:

```js
$: userId, (id, prevId) => load(id, prevId)
$: (a, b), ([a, b], [prevA, prevB]) => …       // multi dep gives arrays
```

Deferring is what makes `prev` meaningful — the first invocation *is* the first change,
so there is always a real previous value rather than `undefined`.

> **RULE 46** — `prev` holds a reference. A **replaced** object gives a genuine previous
> value; an object **mutated in place** gives the same reference for both. Producing a
> distinct previous would mean deep-cloning every read, so Mesa doesn't.

**Cleanup and async.** The handler's return value is registered as a cleanup, run before
the next invocation and on destroy:

```js
$: selectedId, () => {
    const c = new AbortController()
    fetch(`/api/${selectedId}`, { signal: c.signal }).then(…)
    return () => c.abort()                     // cancels the in-flight request
}

$: selectedId, async () => {
    const c = new AbortController()
    $onCleanup(() => c.abort())                // before the first await
    result = await (await fetch(`/api/${selectedId}`, { signal: c.signal })).json()
}
```

---

### 4.3 Effects with automatic dependencies — `$: expr` and `$: { block }`

The dependencies are whatever the body reads.

```js
$: console.log(count)
$: document.title = `${count}`

$: {
    console.log(cart.total)
    document.title = `${count}`
}
```

> **RULE 47** — Auto-tracked effects run on mount and cannot be deferred. They discover
> their dependencies **by running**; withholding the first run would subscribe to nothing.
> Only the explicit-dependency form of §4.2 can defer, and that is a mechanical
> consequence, not a style choice.

Auto-tracking sees reactive values the compiler knows about. It does **not** register path
watches on imported objects — `$: { cart.total }` reads an inert property. Use the
unbraced form (§4.1) for those.

---

### 4.4 Ordered watch groups

When several handlers share a dependency and must fire in a defined order, wrap them in a
block. Each line is a `dep, handler` pair:

```js
$: {
    stateSignal, () => resetPage()
    stateSignal, () => fetchData()
    stateSignal, () => logAnalytics()
}
```

Handlers fire in declaration order, once per reactive flush.

> **RULE 52** — Inside a `$: { }` block the handler must be an **inline function**. The
> reference shorthand (`$: dep, syncFn`) is available only on the unbraced form, because
> `{ a, syncFn }` and `{ a, b }` have identical ASTs — there is no way to tell an intended
> handler from a pair of values being read.

```js
$: { userId, () => load() }     // ✅
$: { userId, load }             // ❌ compile error — write `() => load()`
$: userId, load                 // ✅ unbraced — shorthand is fine here
```

#### Block versus sequence

`$: (a, b)` and `$: { (a, b) }` have **identical ASTs** — both are a sequence expression
of two identifiers. The parentheses are the only thing that distinguishes them, and the
compiler reads them from source position.

```js
$: (cart.items, cart.total)      // multi-path watch — §4.1
$: { (cart.items, cart.total) }  // compile error — see §4.8
```

> **RULE 14b** — `$: (a, b)` is a multi-path watch. `$: { … }` is a block: it runs code.
> A block whose body only reads values is an error, not a watch.

---

### 4.5 Writable Derived — `$: name = expr`

An assignment-shaped `$:` creates a writable derived signal — it re-derives when its
dependencies change, but can be overridden by `bind:value` or direct assignment at any
time.

```js
$: selectedCity = cities[0]    // re-derives when cities changes,
                               // but bind:value on a <select> can still override it
$: doubled = count * 2
```

This is the one value form `const` cannot express: `const` is derived *and authoritative*,
so it would clobber a user's selection on every recompute.

> **RULE 14a** — A writable derived signal re-derives unconditionally whenever its
> dependencies change. Overrides are temporary. For permanent detachment, use `let` with
> a `$:` watch+handler:

```js
let selectedCity = cities[0]                     // plain let — snapshot at init
$: cities, () => { selectedCity = cities[0] }    // only resets when you say so
// a user override via bind:value now persists across cities changes
```

Note that under RULE 47 the watch+handler no longer fires on mount, so the initial value
comes from the `let` initialiser rather than from the handler.

---

### 4.6 Debug Labels — `$_name:`

A `$_name:` prefix on any `$:` annotation attaches a debug name visible in the Graph panel
and runtime dev tools.

```js
$_fetchData: selectedId, async () => { ... }
$_computeTotal: total = items.reduce(...)
```

---

### 4.7 Timing and phase

Signal writes coalesce. Multiple writes anywhere in the same tick — event handlers,
timers, promise callbacks — accumulate into a single flush on the next microtask.

> **RULE 48** — Within a flush, everything that builds the DOM runs before user effects.
> A `$:` effect therefore observes the DOM **as it is after** the change it is reacting
> to, matching Solid's `createEffect` and Svelte's `$effect`.

```js
$: items, () => { count = el.childNodes.length }   // sees the new children
```

Two consequences worth knowing:

**The DOM has not updated yet inside your own handler.** Writes are deferred to the
microtask, so synchronous code after a state change still reads the *previous* DOM. That
is the "before update" window, and it is the whole remainder of the handler:

```js
function addMessage(m) {
    messages = [...messages, m]
    const wasAtBottom = atBottom(el)             // still the OLD DOM
    $tick(() => { if (wasAtBottom) scrollToBottom(el) })
}
```

**`$tick()` resolves after the DOM has updated.** Use it to read the result of a change
you just made.

> **RULE 49** — The *initial* run of an auto-tracked effect happens during component
> setup, before the template exists. Only updates are ordered after the DOM. Explicit-
> dependency effects are unaffected, having no initial run at all (RULE 47).

---

### 4.8 Compile errors

> **RULE 50** — A `$: { }` block runs code. If every top-level statement in it is a bare
> read, it is a compile error.

```js
$: { }               // error — empty
$: { count }         // error — reads, does nothing
$: { (a, b) }        // error — reads, does nothing
$: { cart.total }    // error — reads, does nothing; and registers no path watch
```

Effects do not drive renders in Mesa — a template's `{a}` tracks its own reads — so an
effect with no side effect is unobservable. Every form above is someone reaching for
braces to express a watch. The error names the form they wanted.

`$: if (…) { }`, `$: for (…) { }` and other statement forms are also errors; wrap the
body in a block instead.

> **RULE 53** — Compiler diagnostics are reported as build warnings, not fatal errors.
> The build still produces output. "Error" describes the intent — the code is wrong and
> will not do what it says — not the exit code.

---

### 4.9 Complete `$:` Pattern Reference

| Form | Purpose | Runs on mount |
|---|---|---|
| `$: path` | Watch a path — external or local object | — |
| `$: (p1, p2)` | Watch several paths | — |
| `$: dep, fn` | Effect, explicit deps, `fn(value, prev)` | no |
| `$: (d1, d2), fn` | Effect, multi dep, `fn([…], […])` | no |
| `$: expression` | Effect, auto-tracked | yes |
| `$: { block }` | Effect, auto-tracked, multi-statement | yes |
| `$: { dep, fn`<br>`   dep, fn }` | Ordered watch group | no |
| `$: name = expr` | Writable derived signal | — |
| `$_label: …` | Debug label on any form | — |
| `$: { (a, b) }` | **Compile error** — §4.8 | — |
| `$: { dep, fnRef }` | **Compile error** — handler must be inline (RULE 52) | — |

---

## 5. Shared State — Plain JavaScript Modules

Mesa has no store API. There is no `writable()`, no `readable()`, no `derived()`, and no
`$store` prefix in templates. Shared state is plain JavaScript.

```js
// store.js — completely plain JavaScript, no Mesa, never compiled
export const user = { name: 'Alice', role: 'admin' }
export const cart = { items: [], total: 0 }
```

```js
// Component.mesa
import { user, cart } from './store.js'

$: user.name         // this component re-renders when user.name changes
$: cart.total        // this component re-renders when cart.total changes
```

```html
<p>{user.name}</p>
<p>{cart.total} items</p>
```

> **RULE 8** — Shared state is plain JavaScript. Any exported object from a `.js` file
> can be made reactive in a Mesa component with a `$:` path declaration.

#### Writing to shared state

A component's `$:` watch only sees writes that go **through** the proxy Mesa created
(RULE 45). Reads and writes from inside components are automatic. A module that owns
state and mutates it itself must take its own handle:

```js
// store.js
import { watchProxy } from '@frontierjs/mesa/runtime'

export const cart = { items: [], total: 0 }
const _cart = watchProxy(cart)               // same instance every component gets

export function add(item) {
    _cart.items = [..._cart.items, item]     // notifies $: cart.items
    _cart.total = _cart.items.length         // notifies $: cart.total
}
```

`watchProxy` is cached per object and idempotent, so every component and the module share
one proxy — a write through any of them fires exactly the paths that are watched, and
nothing else.

> **RULE 51** — Reactive *logic* does not belong in `.js` modules. A store holds state and
> the functions that write it; deriving and reacting happen in components. Anything shared
> and derived is computed at the write site, not the read site.

That rule is a discipline, not an enforcement — `createSignal` and `createEffect` are
ordinary functions and work anywhere. Mesa deliberately provides no scope primitive
(`createRoot`, `effectScope`) because naming the pattern is what blesses it. When you
genuinely need an effect outside a component, `createEffect` returns a disposer and owns
any effects created inside it; `onCleanup` with no owner warns rather than silently
dropping the callback.

> **RULE 9** — Store files cannot import from component files — compiler enforced.

> **RULE 10** — Circular reactive store imports are a compiler error.

---

## 6. `var` in the Component — Non-Reactive Sampling

`var` is the reactive system's escape hatch. It can sample reactive values at a point in
time without subscribing to future changes. Writes are invisible — nothing re-renders.

```js
let price = await fetchPrice(id)      // reactive signal
var snapshot = price                  // samples price NOW — does not subscribe
var previous = null                   // holds last value for comparison

$: selectedId, async () => {
    previous = price                  // capture before async — no re-render
    price = await fetchPrice(selectedId)
}
```

**`var` does not belong in the template.** If you need a value in the template, it should
be `let` or `const`. `var` is for script-side bookkeeping only.

> **RULE 13** — `var` is a non-reactive sampler — reads without subscribing, writes
> without notifying. Using `var` in a template is a compiler warning.

---

## 7. Context

`$context` provides subtree-scoped shared state — values flow down the component tree
without explicit prop drilling. Unlike stores (which are global), context is instance-scoped
to each component that provides it.

### 7.1 Providing Context

Write to `$context.key` at the top level of the script block. The value is reactive — if
the right-hand side references a signal, descendants re-render when it changes.

```js
let darkMode = false
$context.theme = darkMode ? 'dark' : 'light'   // provides reactive value
$context.locale = 'en-US'                       // provides static string
```

A component can both consume a key from an ancestor and re-provide it under the same name.
This is the override-and-pass-down pattern — the component reads from above, transforms the
value, and provides the modified version to its own descendants.

```js
const theme = $context.theme                    // consume from ancestor
$context.theme = theme + '-high-contrast'       // re-provide modified version downward
```

### 7.2 Consuming Context

Read from `$context.key` using any variable keyword. The keyword determines the consumer's
relationship to the value — the same semantics as regular variable declarations.

```js
const theme = $context.theme    // pure derived — always re-derives when provider changes
let   theme = $context.theme    // initialized from context at mount, then independent
var   theme = $context.theme    // snapshot at mount — non-reactive
```

`const` and `let` differ in the same way they do for `export` props:

- **`const theme = $context.theme`** — the compiler drives this. Every time the provider's
  value changes, `theme` re-derives. The consumer cannot reassign it.
- **`let theme = $context.theme`** — the context value boots the signal at mount, exactly
  like `export let prop = defaultValue`. After mount the consumer owns the signal
  independently. Future provider changes do **not** flow in.
- **`var theme = $context.theme`** — snapshot at mount, fully outside the reactive graph.

### 7.3 Lookup Rules

- **Nearest ancestor wins** — when multiple ancestors in the same tree provide the same key,
  the value from the closest ancestor is used.
- **Missing key** — if no ancestor provides the key, the value is `undefined` and the runtime
  emits a warning. No build error.

### 7.4 Instance Isolation vs Stores

| | `$context` | Plain JS Store |
|---|---|---|
| Scope | Subtree — one instance | Global — all instances |
| Multiple instances | Each tree is isolated | All share the same state |
| Use case | Theme, locale, auth within a subtree | App-wide cart, session |

> **RULE 25** — `$context` provides and consumes must be at the top level of the script block.

> **RULE 25a** — `const` context consumers always track the provider. `let` consumers
> initialize from context at mount and are independent thereafter. `var` consumers snapshot
> at mount only.

---

## 8. Events

### 8.1 DOM Events

```html
<button on:click={handler}>Click</button>
<form on:submit|preventDefault={onSubmit}>...</form>
<input on:input|debounce(300)={search}>
<div on:click|once|stopPropagation={handler}>...</div>
```

**Modifiers:**

| Modifier | Effect |
|---|---|
| `once` | Remove listener after first call |
| `passive` | `addEventListener` `passive: true` |
| `capture` | Capture phase |
| `preventDefault` | `e.preventDefault()` |
| `stopPropagation` | `e.stopPropagation()` |
| `self` | Only when `target === currentTarget` |
| `trusted` | Only real user events |
| `debounce(ms)` | Debounce — arg can be reactive: `\|debounce({delay})` |
| `throttle(ms)` | Throttle |

### 8.2 Component Events

`on:event` on a **component** is a compiler error. Component communication uses props:

```js
// MyButton.mesa
function handleClick(e) {
    $emit('click', e)   // calls parent's onclick / onClick prop
}
```

```html
<!-- Parent -->
<MyButton onclick={handleClick} />
```

`$emit(name, data)` looks for `on{name}` and `on{Name}` in `$option.props` and calls it
if present.

> **RULE 23** — `on:event` on a component is always a compiler error. Use `onclick={fn}` prop.

---

## 9. Block Directives

Block directives are valid JavaScript labeled statement syntax (`{#...}`, `{:...}`, `{/...}`)
that the compiler interprets structurally.

### 9.1 Conditional — `{#if}`

```html
{#if count > 0}
  <p>Positive: {count}</p>
{:else if count < 0}
  <p>Negative: {count}</p>
{:else}
  <p>Zero</p>
{/if}
```

### 9.2 Lists — `{#each}`

```html
{#each items as item (item.id)}
  <li>{item.name}</li>
{:else}
  <p>No items.</p>
{/each}
```

The `(key)` expression is optional but recommended for stateful lists. It must be
the last parenthesised group after the item binding.

**Destructuring in `as` clause** — both array and object patterns are supported:

```html
<!-- Array destructuring -->
{#each commandGroups as [namespace, commands] (namespace)}
  <section>
    <h3>{namespace}</h3>
    {#each commands as cmd}<p>{cmd.name}</p>{/each}
  </section>
{/each}

<!-- Object destructuring -->
{#each users as {name, id, role} (id)}
  <div>{name} — {role}</div>
{/each}

<!-- Destructuring with index -->
{#each items as {name}, i}
  <p>{i}: {name}</p>
{/each}
```

Destructured variables are plain values inside the block (not signals). The runtime
uses a synthetic `$$item` signal internally and destructures it at the top of each
rendered block.

### 9.3 Async — `{#await}`

```html
{#await fetchData()}
  <p>Loading…</p>
{:then result}
  <DataView {result} />
{:catch error}
  <p>Error: {error.message}</p>
{/await}
```

### 9.4 Key Block — `{#key expr}`

Destroys and recreates its content whenever `expr` changes. Use to reset internal
component state, replay CSS enter animations, or force `$onMount` to re-run.

```html
{#key selectedUserId}
  <UserProfile id={selectedUserId} />
{/key}
```

### 9.5 Snippets — `{#snippet}` / `{@render}`

Snippets define reusable template fragments inline. They close over reactive
variables from the outer component scope. Arguments are plain values — not signals.

```html
{#snippet badge(status)}
  <span class="badge {status}">{status}</span>
{/snippet}

{#snippet row(person)}
  <tr>
    <td>{person.name}</td>
    <td>{@render badge(person.status)}</td>
  </tr>
{/snippet}

<table>
  {#each people as person (person.id)}
    {@render row(person)}
  {/each}
</table>
```

**Snippet props** — snippets can be passed to child components as props. On the child side,
a snippet prop is declared with `export let` — it is just a function under the hood.

```js
// Table.mesa
export let row              // required snippet prop
export let header = null    // optional snippet prop
```

```html
<!-- Parent passes snippet as a prop -->
<Table>
  {#snippet row(item)}
    <tr><td>{item.name}</td></tr>
  {/snippet}
</Table>
```

Named snippets defined directly inside a component tag are automatically passed as same-name
props — no explicit `row={row}` attribute needed.

**Optional rendering** — use optional chaining on `{@render}` for snippets that may not
be provided:

```html
{@render row?.(item)}       <!-- safe: no-op if row is null/undefined -->
{@render header?.()}        <!-- safe: no-op if header not passed -->
```

### 9.6 Slots — `<slot />`

Slots are content holes a component declares for its parent to fill. Unlike
snippet props (which require an `export let` declaration and `{@render}` call),
a slot is a single tag that mounts whatever content the parent passes inside
the component's tag.

**Default slot** — for unattributed content from the parent:

```html
<!-- Card.mesa -->
<div class="card">
  <slot />
</div>

<!-- Parent -->
<Card>
  <p>Some content</p>   <!-- mounts at the <slot /> position -->
</Card>
```

**Named slots** — multiple holes, addressed by name. The child uses
`<slot:name />` (or the equivalent `<slot name="x" />`); the parent uses a
`slot="name"` attribute on any element to route it to the corresponding slot.

```html
<!-- Card.mesa -->
<div class="card">
  <header><slot:header /></header>
  <main><slot /></main>
  <footer><slot:footer /></footer>
</div>

<!-- Parent -->
<Card>
  <h1 slot="header">Title</h1>
  <p>Body content (default slot)</p>
  <p slot="footer">Footer line</p>
</Card>
```

**Fallback content** — content placed between `<slot>` and `</slot>` is the
fallback rendered when the parent provides nothing for that slot.

```html
<slot:header>
  <h1>Default heading</h1>
</slot:header>
```

**`$slots` — checking for slot content** — `$slots` is a compiler-injected
local. `$slots.name` is true when the parent provided content for that slot,
false otherwise. Use it to conditionally render slot wrappers:

```html
{#if $slots.footer}
  <footer><slot:footer /></footer>
{/if}
```

**`<slot />` vs the `children` snippet pattern** — older Mesa code used
`export let children = null` plus `{@render children?.()}` to receive
unattributed content. `<slot />` is the preferred form for new code: it
removes the prop declaration, removes the optional-chain call, and supports
named slots and fallback content directly. The `children` pattern still works
and remains valid for components that want to pass slot content as a snippet
to a deeper child.

> **RULE 35a** — `<slot />` is the preferred mechanism for receiving content
> from the parent. The `export let children` + `{@render children?.()}`
> pattern is supported but should be considered legacy for new components.

### 9.7 Virtual List — `{#virtual each}`

Renders only the items visible in the viewport. Uses top/bottom padding spacers to
maintain correct scroll height without creating DOM nodes for every item. Only
fixed-height items are supported (variable height: planned).

```html
{#virtual each rows as row height=48 viewport="500px"}
  <div class="row">
    <span>{row.name}</span>
    <span>{row.value}</span>
  </div>
{/virtual}
```

Options:
- `height=N` — item height in pixels (required)
- `viewport="400px"` — scrollable container height (default: `"100%"`)

The directive creates a scrollable viewport div with `padding-top`/`padding-bottom`
spacers. On scroll, a `requestAnimationFrame` handler computes the new `[start, end]`
window, disposes blocks that scrolled out, and mounts new ones. Each rendered row is
a full reactive Mesa block — signals, `bind:value`, and child components all work
inside `{#virtual each}`.

---

## 10. Template Element Directives

Element-level directives appear as attributes on HTML elements.

### 10.1 Two-Way Binding — `bind:value`

```html
<input bind:value={query}>
<textarea bind:value={body}>
<select bind:value={selectedId}>
```

#### Input masking — `bind:value|mask({pattern})`

The `|mask` modifier enforces a character pattern as the user types and writes
the masked value back through the binding. The pattern uses `9` for digit
positions, `a` for letter positions, and `*` for any character; all other
characters are literal separators.

```html
<!-- Static pattern — string literal -->
<input bind:value|mask({"99/99/9999"})={birthday}>
<input bind:value|mask({"(999) 999-9999"})={phone}>
<input bind:value|mask({"aaa-9999"})={code}>
```

The pattern argument must be wrapped in `{ }`. Pass a string literal for a
fixed pattern, or a reactive expression to drive the pattern from state:

```html
<!-- Reactive pattern — re-applies whenever cardType changes -->
<input bind:value|mask({cardPattern})={cardNumber}>
```

When the inner expression is a known reactive variable, the compiler wraps the
binding in `createEffect` so a pattern change re-applies cleanly to the
existing element. Mask-aware bindings still satisfy Rule 22 — the underlying
binding target must be `let` (or `export let` on the parent side).

> **RULE 41** — `bind:value|mask` requires a pattern argument wrapped in `{ }`
> — either a string literal or a reactive expression. A bare modifier without
> argument is a compiler error.

### 10.2 Element Reference — `bind:this`

**On DOM elements** — sets the variable to the live `HTMLElement` after mount. Cleared to
`null` on destroy.

```html
<script>let canvas</script>
<canvas bind:this={canvas}></canvas>
<!-- After mount: canvas is the HTMLCanvasElement -->
```

**On components** — sets the variable to the component's exported interface: all
`export let` props and exported functions declared in the child's script. The DOM root
element is not exposed.

```js
// Counter.mesa
export let count = 0
export function reset() { count = 0 }
export function increment() { count++ }
```

```html
<!-- Parent -->
<script>let counterRef</script>
<Counter bind:this={counterRef} />

<!-- After mount: -->
<!-- counterRef.count      — current value of the exported prop -->
<!-- counterRef.reset()    — calls the exported function -->
<!-- counterRef.increment() -->
```

Multi-root components and single-root components behave identically — `bind:this` on a
component always gives the exported API, never a DOM node.

### 10.3 Group Binding — `bind:group`

```html
<!-- Checkboxes — signal is an array -->
<script>let selected = []</script>
<input type="checkbox" bind:group={selected} value="apples">
<input type="checkbox" bind:group={selected} value="bananas">

<!-- Radios — signal is a scalar -->
<script>let size = 'M'</script>
<input type="radio" bind:group={size} value="S">
<input type="radio" bind:group={size} value="M">
```

> **RULE 24** — `bind:group` requires a top-level `let` variable.

### 10.4 Class Directive — `class:name`

```html
<div class:active={isActive}>
<div class:dark>                    <!-- shorthand: applies when variable 'dark' is truthy -->
```

### 10.5 Style Directive — `style:prop`

```html
<div style:color={textColor}>
<div style:font-size="{size}px">    <!-- mixed value with units -->
<div style:display>                 <!-- shorthand -->
```

### 10.6 Element Lifecycle — `{@attach}`

`fn(el)` is called when the element mounts. Return value determines cleanup:

```js
// Return nothing — no cleanup
(el) => el.focus()

// Return a function — cleanup before re-run and on destroy
(el) => {
    el.addEventListener('mousedown', start)
    return () => el.removeEventListener('mousedown', start)
}

// Return a Promise — element stays in DOM until resolved (exit animations)
(el) => el.animate([{opacity:1},{opacity:0}], 300).finished
```

### 10.7 Raw HTML — `{@html}`

```html
<div>{@html markdownContent}</div>
```

Injects raw HTML into the DOM before the anchor comment. Re-runs reactively when the
expression changes. Previous nodes are removed before the new HTML is inserted.

> **Warning** — `{@html}` does not sanitize input. Only use with trusted content.

### 10.8 Class Prop Passthrough

`class` is a JavaScript reserved word and cannot be used as an identifier.
The compiler handles class-prop passthrough automatically through an internal
`$class` rename — but `$class` is a compiler implementation detail and is
never authored directly.

**Parent side** — `class="..."` or `class={expr}` on a component is forwarded
to the child's class prop with no special syntax required:

```html
<Btn class="active btn-lg" />
<Btn class={isPrimary ? 'btn-primary' : 'btn-secondary'} />
```

**Child side** — use one of two shorthand forms on the element that should
receive the parent's class. Both auto-declare the prop and wire the value
through; no script-side declaration is needed.

```html
<!-- {class} — one-way passthrough, parent pushes the value down -->
<button {class}>Click</button>

<!-- bind:class — two-way, value flows in and out -->
<button bind:class>Click</button>
```

`{class}` is the common case. `bind:class` is for components that mutate
their own class set and want the parent to observe the change.

> **RULE 31a** — `$class` is a compiler-internal name. Components never declare
> `export let $class` directly — use the `{class}` or `bind:class` element
> shorthand on the child side. Parents pass class with the regular `class=`
> attribute.

---

## 11. Module Script — `<script module>`

Code that runs once at module load time, shared across all instances. Equivalent
to Svelte 5's `<script module>` / Svelte 4's `<script context="module">`. Both
attribute forms are supported.

```html
<script module>
  // Runs once — shared state across all component instances
  let instanceCount = 0
  export function getCount() { return instanceCount }
</script>

<script>
  instanceCount++   // per-instance
</script>
```

Module script content is emitted at ES module scope, before the component function.
Named exports from `<script module>` are available to other modules that import
this component file.

---



## 12. Global Elements

### 12.1 `<mesa:window>`

```html
<mesa:window
    on:resize={handleResize}
    on:keydown|preventDefault={handleKey}
    bind:innerWidth={width}
    bind:scrollY={scrollPos}
    bind:online={isOnline}
>
```

Bindable: `innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`, `scrollX`, `scrollY`,
`devicePixelRatio`, `online`.

### 12.2 `<mesa:document>` and `<mesa:body>`

Bind event listeners to `document` or `document.body`.

```html
<mesa:document on:visibilitychange={handleVisibility}>
<mesa:body on:mouseenter={startTracking} on:mouseleave={stopTracking}>
```

### 12.3 `<mesa:head>`

Injects reactive content into `document.head`. Removed on component destroy.

```html
<mesa:head>
    <title>{pageTitle}</title>
    <meta name="description" content={description}>
</mesa:head>
```

### 12.4 `<mesa:portal>`

Renders children into any DOM node, escaping overflow and stacking context.

```html
<mesa:portal to={document.body}>
    <div class="modal">I'm in body, not the component tree</div>
</mesa:portal>
```

### 12.5 `<mesa:boundary>` and `<mesa:mounted>`

Both elements gate template content behind an async operation and share the same
snippet convention and runtime infrastructure. They differ only in what triggers them.

#### Shared Snippet Convention

Both elements look for `pending` and `failed` snippets in the same priority order:

1. Snippets defined inside the wrapping element (co-located form)
2. Global `{#snippet pending()}` / `{#snippet failed(error)}` defined anywhere in the template
3. Nothing — blank pending state, error is silently swallowed

```html
<!-- global snippets — shared by both mesa:boundary and mesa:mounted -->
{#snippet pending()}
  <p>Loading...</p>
{/snippet}

{#snippet failed(error)}
  <p>{error.message}</p>
{/snippet}
```

#### `<mesa:boundary>` — Async Derived Data Gate

Gates template content behind the `$async` state of script-level async derived `const`
values. Renders the `pending` snippet while any watched `$async.x` is in flight.
Renders the `failed` snippet if any throws.

```html
<script>
  let selectedState = 'CA'
  const cities = await getCities(selectedState)   // $async.cities generated
</script>

<mesa:boundary>
  {#snippet pending()}<p>Loading cities...</p>{/snippet}
  {#snippet failed(error)}<p>{error.message}</p>{/snippet}
  <select bind:value={selectedCity}>
    {#each cities as city}<option>{city}</option>{/each}
  </select>
</mesa:boundary>
```

`<mesa:boundary>` can be used anywhere in the template, wrapping only the portion
of the UI that depends on async data. Multiple boundaries are allowed per component.

#### `<mesa:mounted>` — Imperative Mount Gate

Gates the **entire component template** behind a Promise returned by `$mounted()`.
Nothing renders until the Promise resolves. Unlike `<mesa:boundary>`, this always
applies to the whole template regardless of where it appears.

**`$mounted(fn)`** — a builtin that wraps an async function in a Promise that
resolves after the component mounts. The variable name is the developer's choice.
Only one `$mounted()` call is allowed per component — compiler error if used twice.
For multiple async operations, use `Promise.all` inside a single `$mounted`.

```js
// Single operation
const mounting = $mounted(async () => {
  user = await usersService.get(currentUser.id)
})

// Multiple operations — Promise.all inside single $mounted
const mounting = $mounted(async () => {
  [user, notes] = await Promise.all([
    usersService.get(currentUser.id),
    notesService.getAll()
  ])
})
```

**Self-closing form** — gates everything after it in the template. Snippets are
picked up from global definitions.

```html
<mesa:mounted />
```

**Self-closing with error handler** — `onerror` fires programmatically on rejection,
runs alongside the `failed` snippet if both are present. Use for redirects, logging,
or resetting state.

```html
<mesa:mounted onerror={(err) => goto('/error')} />
```

**Wrapping form** — identical behavior, but snippets are co-located inside the element.
Still gates the whole template.

```html
<mesa:mounted onerror={(err) => goto('/error')}>
  {#snippet pending()}<p>Loading...</p>{/snippet}
  {#snippet failed(error)}<p>{error.message}</p>{/snippet}
</mesa:mounted>
```

**Full example:**

```mesa
<script>
  import { usersService } from '@/resources/User.mesa'
  import { currentUser } from '@/core/app'
  import { goto } from '@/core/router'

  let user

  const mounting = $mounted(async () => {
    user = await usersService.get(currentUser.id)
  })
</script>

<mesa:mounted onerror={(err) => goto('/error')} />

<section>
  <h1>{user.name}</h1>
  <p>{user.email}</p>
</section>

{#snippet pending()}
  <p>Loading profile...</p>
{/snippet}

{#snippet failed(error)}
  <p>Could not load profile: {error.message}</p>
{/snippet}
```

> **RULE 37** — `$mounted(fn)` may only appear once per component. Use `Promise.all`
> inside a single `$mounted` for multiple async operations.

> **RULE 38** — `<mesa:mounted>` always gates the entire component template regardless
> of wrapping or self-closing form.

> **RULE 39** — `onerror` on `<mesa:mounted>` runs programmatically on rejection and
> is independent of the `failed` snippet — both run if both are present.

> **RULE 40** — Both `<mesa:boundary>` and `<mesa:mounted>` resolve snippets in the
> same order: co-located inside the element → global template snippets → blank/silent.

---

## 13. Async Model

### 13.1 Top-Level Await

> **RULE 15** — Component files are always treated as ESM modules. Top-level `await` is
> valid in all component script blocks.

```js
// one-shot — runs once on init, no reactive deps
const states = await getStates()

// async derived — reruns when selectedState changes
// cancellation generated automatically via AbortController
const cities = await getCities(selectedState)
```

### 13.2 `$async` State Object

When a `const` is initialized with `await` and references reactive variables, the compiler
generates an async state object:

```js
const cities = await getCities(selectedState)
// compiler generates:
//   $async.cities.loading   — true on first fetch only
//   $async.cities.fetching  — true any time a fetch is in flight
//   $async.cities.error     — Error | null
//   $async.cities.status    — 'pending' | 'success' | 'error'
```

> **RULE 16** — `$async.x` only exists on variables declared with `await` at the top level.

### 13.3 Optimistic Updates

`var` is the natural staging area for optimistic updates:

```js
let displayPrice = await fetchPrice(id)
var optimistic = null

function applyDiscount() {
    optimistic = displayPrice * 0.9       // silent — no re-render
    displayPrice = optimistic             // push to reactive — DOM updates immediately
}
```

> **RULE 17** — Any non-const reactive variable can be manually assigned at any time.
> Last write wins — no special reconciliation API.

---

## 14. Dynamic Paths and Runtime Effects

> **RULE 11** — For static member expression paths (`cart.total`), the compiler generates a
> targeted accessor. For dynamic paths where the full path cannot be known at build time
> (`cart.items[index].price`), it generates a runtime effect that re-evaluates when any
> detected top-level variable in its trigger set changes.

```js
const price = cart.items[index].price     // trigger set: [cart, index]
const total = cart[dynamicKey].total      // trigger set: [cart, dynamicKey]
```

> **RULE 12** — Template path references are always safe. The compiler wraps all member
> expression chains in the template with optional chaining and a nullish coalescing fallback.
> `cart.user.prefs.theme` generates `cart?.user?.prefs?.theme ?? ''` — zero runtime errors.

---

## 15. Object and Array Reactivity

Array and object mutations (`push`, `splice`, property assignment) are invisible to the
reactive graph unless the compiler is told to watch the relevant path.

```js
let cart = { items: [], total: 0 }

$: cart.items          // push/pop/splice now reactive
$: cart.total          // assignment reactive
$: (cart.items, cart.total)   // both in one statement
```

Object getters on reactive objects are invisible to the compiler — their internal
dependencies cannot be statically detected. At runtime a getter is invoked with the
watch proxy as `this`, so the properties it reads subscribe normally; watch **what the
getter reads**, not the getter itself:

```js
let user = { first: 'Ada', last: 'L', get full() { return this.first + ' ' + this.last } }

$: user.first        // ✅ {user.full} updates when first changes
$: user              // ✅ whole-object watch covers it too
$: user.full         // ❌ never fires — nothing ever writes that path
```

Watching the getter's own path is inert, because a derived value is never assigned to.
Mesa warns at runtime when a watch is declared on a get-only accessor. A top-level
derived `const` remains the clearer choice where it fits.

---

## 16. Animations

### 16.1 `$.transition(fn)` — View Transitions

Wraps a state change in the browser's View Transitions API. Falls back to an immediate
update in unsupported browsers.

```js
$.transition(() => show = !show)
$.transition(() => { tab = 'home'; items = newData })
```

```css
::view-transition-old(card) { animation: fade-out 200ms ease; }
::view-transition-new(card) { animation: fade-in  200ms ease; }
```

### 16.2 `$.entrance({ in, out })` — Element Enter/Exit

Creates an attachment function for enter/exit animations on individual elements.

```js
const fade = $.entrance({
    in:  (el) => el.animate([{opacity:0},{opacity:1}], {duration:250, fill:'forwards'}),
    out: (el) => el.animate([{opacity:1},{opacity:0}], {duration:200, fill:'forwards'}).finished
})
```

```html
{#if show}
    <div {@attach fade}>content</div>
{/if}
```

If `out` returns a Promise, the element stays in the DOM until it resolves — no height collapse.

---

## 17. Built-in Functions (`$` Builtins)

> **RULE 18** — Mesa built-in functions are auto-injected by the compiler as local
> variables inside the component function. Developers never write import statements
> for them. Only builtins that are actually used are injected — full tree-shaking.

| Builtin | Purpose |
|---|---|
| `$onMount(fn)` | Runs after component mounts to DOM. No-op on server. |
| `$onDestroy(fn)` | Runs when component is removed from DOM. |
| `$onCleanup(fn)` | Registers cleanup inside a `$:` watch+handler. Runs before next execution or on destroy. Must be called before the first `await`. |
| `$mounted(fn)` | Wraps an async function in a Promise that resolves after mount. Gates the whole template via `<mesa:mounted>`. One per component. |
| `$emit(event, data?)` | Calls the parent's `on{Event}` / `on{event}` prop. Prop callbacks (`onchange?.(value)`) are preferred for new code; `$emit` is supported for compatibility. |
| `$inspect(...exprs)` | Dev-only reactive inspector. Logs label + values when any tracked expression changes. Supports `.with(fn)` to replace the default logger. **Stripped entirely when `config.debug: false`.** Top-level only. |
| `$props` | All props passed to this component, including undeclared ones. |
| `$attributes` | All attributes passed to this component. Use for forwarding to a child element. |
| `$slots` | Reactive object indicating which named slots have content from the parent. Use as `{#if $slots.footer}`. See §9.6. |
| `$context` | Subtree-scoped shared state. See §7. |
| `$async.x` | Compiler-generated async state for any top-level `await` variable `x`. |
| `$.transition(fn)` | Wraps a state change in the View Transitions API. |
| `$.entrance(opts)` | Creates an enter/exit animation attachment. |

`$onMount` and `$onDestroy` are also exported from `@mesa/runtime` as `onMount` and
`onDestroy` for use inside composable helper functions outside component scope.

#### `$inspect` examples

```js
let count = 0
let user  = { name: 'Alice' }

$inspect(count)                       // logs label='count' on every change
$inspect(count, user.name)            // multi-arg — logs both, retracks on either
$inspect(count).with(console.trace)   // custom logger — replaces default
```

> **RULE 42** — `$inspect` is dev-only. With `config.debug: false` the compiler
> emits no code for it — the call site is removed entirely. It must appear at
> the top level of the script block (not inside a function or block).

---

## 18. Markdown and Frontmatter

Mesa treats `.md` files as first-class components. A `.md` file is a Mesa component whose
template is Markdown-processed HTML. Everything else — the script block, template
expressions, Mesa component tags, `{#if}`, `{#each}` — works identically to `.mesa` files.

### 18.1 Frontmatter

Frontmatter values become `export const` props automatically. The page receives their
values via `renderToHTML(factory, frontmatter)` at build time.

```md
---
title: My Post
date: 2024-01-15
featured: true
layout: BlogLayout
---

# {title}

Published on *{date}*.
```

The compiler generates `export const title = undefined`, `export const date = undefined` etc.
from the frontmatter keys and merges them with any explicit `<script>` block.

### 18.2 Script Block in Markdown

Add a `<script>` block anywhere in the Markdown body for derived values or watch handlers:

```md
---
title: Post
date: 2024-01-15
---

<script>
  export const title = undefined
  export const date  = undefined
  const formatted = new Date(date).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  })
</script>

# {title}

*Published {formatted}*
```

### 18.3 Mesa Components in Markdown

Mesa component tags pass through Markdown processing untouched:

```md
Here is an interactive counter:

<Counter initialCount={5} client:idle />

And some more content.
```

### 18.4 Block Directives in Markdown

`{#if}`, `{#each}`, and other block directives work in Markdown body:

```md
{#if featured}
**This post is featured!**
{/if}

{#each tags as tag (tag)}
- {tag}
{/each}
```

### 18.5 `client:*` Directives

Build tools can annotate Mesa components with `client:*` directives to control island
hydration strategy. The Mesa core compiler strips these — they are build-layer concerns.

| Directive | Meaning |
|---|---|
| *(none)* | Auto-detect: static if no reactivity, interactive if reactive |
| `client:static` | Force static — no JS even if component is reactive |
| `client:load` | Force interactive — hydrate immediately |
| `client:idle` | Hydrate when `requestIdleCallback` fires |
| `client:visible` | Hydrate when element enters viewport |
| `client:media="(query)"` | Hydrate when media query matches |

### 18.6 Compilation API

```js
import { compile, compileSource, compileFile } from '@mesa/compiler'
import { compileMd, parseFrontmatter } from '@mesa/compiler-md'

// Explicit .mesa compilation (unchanged)
const ctx = await compile(source, config)

// Unified — routes by filename extension
const ctx = await compileSource(source, { filename: 'Post.md' })
const ctx = await compileFile('./pages/about.md')

// ctx always returns the same shape:
//   ctx.result       — compiled JS module string
//   ctx.analysis     — reactive graph analysis
//   ctx.isStatic     — true if component has no JS at runtime
//   ctx.frontmatter  — parsed frontmatter (undefined for .mesa files)
//   ctx.layout       — frontmatter.layout value (null if not set)
```

#### Markdown plugin extension

`compileMd` (and `compileSource` / `compileFile` when routing to it) accepts
user-supplied `remark` and `rehype` plugins through two config options.
Plugins integrate into the default processor between Mesa's own stages —
user remark plugins run after `remark-gfm`; user rehype plugins run after
`rehype-slug` and before `rehype-stringify`.

```js
import remarkMath  from 'remark-math'
import rehypeKatex from 'rehype-katex'

const ctx = await compileSource(src, {
  filename: 'Post.md',
  remarkPlugins: [
    remarkMath,                                  // bare plugin
    [remarkSomething, { option: 'value' }],      // plugin + options tuple
  ],
  rehypePlugins: [rehypeKatex],
})
```

Each entry is either a plugin function or a `[plugin, options]` tuple —
matching unified's standard `.use()` signature. Passing no plugins falls
through to a singleton default processor with no allocation overhead.

---

## 19. Static Detection and Server-Side Rendering

### 19.1 Automatic Static Detection

The compiler sets `ctx.isStatic = true` when a component has:

- No `let` declarations
- No `export let` props
- No `$:` watch handlers, path watches, or side effects
- No `$context` provides or consumes
- No `async` derived values
- No DOM event handlers (`on:event`)
- No `{@attach}` lifecycle directives

Static components can be rendered to HTML at build time with no JavaScript shipped.

### 19.2 `renderToHTML`

```js
import { initRenderer, renderToHTML, wrapPage } from '@mesa/render'

// Call once before importing any compiled components
initRenderer()

// Render a component to an HTML string
const html = await renderToHTML(ComponentFactory, { title: 'Hello', items: [...] })

// Render a full <!DOCTYPE html> page
const page = await renderToHTML(ComponentFactory, props, {
    full: true,
    title: 'My Site',
    css: '/styles.css',
    scripts: ['/_mesa/islands.js'],
    meta: { description: 'Built with Mesa' }
})

// Or wrap separately
const inner = await renderToHTML(ComponentFactory, props)
const page  = wrapPage(inner, { title: 'My Site', css: '/styles.css' })
```

`initRenderer()` installs a happy-dom virtual DOM environment. It must be called before any
compiled component modules are imported, because compiled components call `htmlToFragment()`
at module load time.

### 19.3 SSR Notes

> **RULE 19** — During `renderToHTML`: signals are synchronous, no reactive graph is built.
> `$onMount` is a no-op. `$context` is instance-scoped to that render call.
> `watchProxy` / `watchPath` return the raw object and inert stubs, so `{page.path}` still
> reads the right value — it is simply not reactive, which is all a one-shot render needs.
>
> This is gated on a *client* flag, not on DOM availability. `initRenderer()` must make a
> DOM reachable, because compiled components call `htmlToFragment()` at module load — but
> a DOM is not a client. `setRenderEnvironment(hasDOM, isClient)` carries both;
> `initRenderer()` passes `(true, false)`. Conflating them made every guard above dead
> code on the server: `$onMount` ran once per render against a `window` that outlived the
> request, and path watches built signals nothing disposed.

> **RULE 20** — Full per-request SSR (hydration, async data serialization) is deferred to a
> future version.

### 19.4 `renderComponent` / `renderFile` — Source-In Pipeline

`renderToHTML` accepts a compiled component factory. `renderComponent` and
`renderFile` are higher-level entry points that take raw `.mesa` / `.md`
**source** and run the full pipeline: compile, recursive import resolution,
CSS extraction, optional CSS inlining, optional UnoCSS scanning, and render.
They are the primary API for build-time templating, email rendering, and
server-side fragment generation.

```js
import { renderComponent, renderFile } from '@frontierjs/mesa/render-component'

// From a source string
const result = await renderComponent(source, {
  filename: 'WelcomeEmail.mesa',
  cwd:      '/path/to/templates',
  data:     { firstName: 'Alice' },
  target:   'email',
})

// From a file path on disk
const result = await renderFile('/path/to/templates/WelcomeEmail.mesa', {
  data:   { firstName: 'Alice' },
  target: 'email',
})
```

**Targets** — `target` selects the output shape:

| Target | Output |
|---|---|
| `html` | Full `<!DOCTYPE html>` document with collected CSS in a `<style>` block |
| `email` | Full document with CSS *inlined* into `style=""` attributes (MSO/VML namespaces, `@media` queries preserved in `<head>`). Includes `result.text` plain-text fallback and `result.subject` extracted from `<script module>`. |
| `fragment` | Inlined HTML chunk, no document wrapper — for embedding into a host page |
| `js` | Map of compiled JS modules (`result.modules`, `result.entry`) for client bundling — does not render to HTML |

**Result shape** depends on the target. Common fields: `result.html`,
`result.css` (collected CSS before inlining). Email adds `result.text` and
`result.subject`. JS replaces `html`/`css` with `result.modules` (a
`Map<filename, compiledJS>`) and `result.entry`.

**Subject extraction** — for the `email` target, exporting `subject` from
`<script module>` makes it available as `result.subject`:

```mesa
<script module>
  export const subject = 'Welcome to the platform!'
</script>
```

**Plain-text fallback** — the `email` target also generates `result.text` by
running the rendered HTML through a text-extraction pass.

`renderComponent` resolves `.mesa` and `.md` imports from `cwd`, compiling
each module once and caching it. CSS from every component in the tree is
collected and either inlined (email/fragment) or emitted as a `<style>` block
(html). Static and reactive components are both supported — reactive
components hydrate to their initial render and serialize cleanly.

---

## 20. Compiler Rules and Errors

### 20.1 Errors (Build Fails)

| Condition | Error |
|---|---|
| Circular derivation (`const a = b`, `const b = a`) | Circular reactive dependency |
| Store file imports from component file | Stores cannot import from components |
| Circular import between watched stores | Circular reactive import |
| `$:` annotation inside function or block | `$:` annotations are top-level only |
| `$: if/for/while/switch` (statement form) | Wrap in a `$: { }` block — only expression and block forms are valid |
| Assigning to a derived `const` | Cannot assign to derived const |
| `bind:` on `export const` prop | Cannot two-way bind an immutable prop |
| `bind:` on `export var` prop | Cannot two-way bind a non-reactive prop |
| `on:event` on a component | Use `onclick={fn}` prop instead |
| `$mounted(fn)` used more than once | Only one `$mounted` per component — use `Promise.all` for multiple operations |
| `bind:value\|mask` without pattern argument | `\|mask` requires a pattern wrapped in `{ }` |
| `$inspect` inside a function or block | `$inspect` must be at the top level of the script block |

### 20.2 Warnings (Build Succeeds)

| Condition | Warning |
|---|---|
| Getter on reactive object | Getter deps not tracked — use derived `const` |
| `$async.x` on non-async variable | `$async` state does not exist on sync variables |
| Function call inside template `${}` | Internal deps not tracked |
| `var` used in template binding | `var` is non-reactive — template will not update |

---

## 21. Component Conventions

| Convention | Rule |
|---|---|
| File extension | `.mesa` for components, `.md` for Markdown components |
| Component naming | PascalCase — `CartItem.mesa` exports `CartItem` |
| Store files | Plain `.js` — lowercase, no `.mesa` extension |
| Multiple root elements | Fully supported — components may have any number of top-level elements |
| CSS scoping | Styles in `<style>` block are component-scoped by default |
| `{#each}` keying | `(item.id)` key recommended for stateful lists |
| DOM events | `on:eventname={handler}` with optional `\|modifier` chain |
| Component events | `onclick={fn}` prop preferred; `$emit('click', data)` supported |
| Two-way binding | `bind:value={variable}` (with optional `\|mask({pattern})` modifier) |
| Group binding | `bind:group={array}` for checkboxes; `bind:group={scalar}` for radios |
| Ref capture | `bind:this={variable}` for DOM elements and component instances |
| Class passthrough | `class={expr}` on the parent; `{class}` or `bind:class` on the child element |
| Class toggle | `class:name={expr}` or shorthand `class:name` |
| Inline styles | `style:prop={expr}` or `style:prop="{expr}unit"` for mixed values |
| Element lifecycle | `{@attach fn}` — enter, cleanup, and deferred exit |
| Raw HTML | `{@html expr}` |
| Parent content | `<slot />` (preferred) or `export let children = null` + `{@render children?.()}` (legacy) |
| Dev-mode logging | `$inspect(expr1, expr2, ...)` — stripped in production |

---

## 22. Complete Rules Reference

| # | Rule |
|---|---|
| 1 | `$:` annotations are top-level scope only |
| 2 | Compiler detects derived values — `const` referencing reactive vars auto-derives |
| 3 | Compiler detects template bindings — all reactive vars used in templates are auto-wired |
| 4 | Scoped variables are never tracked — but CAN read and write top-level reactive state |
| 5 | All Mesa source and compiler output must be valid JavaScript AST |
| 6 | `$:` path watching uses optional chaining semantics — `?.` for soft, none for hard |
| 7 | Watch+handler: handler is always last, always outside parentheses |
| 8 | Shared state is plain JavaScript — `$:` path declaration makes it reactive per-component |
| 9 | Store files cannot import from component files — compiler enforced |
| 10 | Circular reactive store imports are a compiler error |
| 11 | Static paths → targeted accessors; dynamic paths → runtime effects |
| 12 | Template path references always safe — compiler wraps with `?.` and `?? ''` |
| 13 | `var` is a non-reactive sampler — reads without subscribing, writes without notifying |
| 14 | `let` initializers are snapshots — use `$: name = expr` for ongoing re-derivation |
| 14a | Writable derived overrides are temporary — dep change always wins back; use `let` + watch+handler for permanent detachment |
| 14b | `$: (a, b)` is a multi-path watch (sequence). `$: { ... }` is an auto-tracked block effect. Wrapping a sequence inside a block produces a block effect, not multi-path watches. |
| 15 | Component files are always ESM — top-level `await` is valid |
| 16 | `$async.x` only exists on variables declared with `await` at the top level |
| 17 | Non-const reactive vars can be manually assigned anytime — last write wins |
| 18 | `$builtins` are auto-injected by the compiler — never manually imported |
| 19 | SSR: signals synchronous, `$onMount` no-op, `$context` instance-scoped |
| 20 | Full hydration SSR deferred to a future version |
| 21 | Compiler target is `@mesa/runtime` — full stack ownership |
| 22 | `bind:` is only valid on `export let` props |
| 23 | `on:event` on a component is a compiler error — use `onclick={fn}` prop |
| 24 | `bind:group` requires a top-level `let` variable |
| 25 | `$context` provides and consumes must be at the top level of the script block |
| 25a | `const` context consumers always track the provider; `let` initializes at mount then is independent; `var` snapshots at mount only |
| 26 | `client:*` directives are stripped by the Mesa core compiler — build-layer concern |
| 27 | `{#key expr}` destroys and recreates content on every change of `expr` |
| 28 | `{#snippet name(args)}` defines a reusable template fragment; `{@render name(args)}` mounts it |
| 29 | Snippets close over outer reactive variables; args are plain values, not signals |
| 30 | `<script module>` runs once at module load — shared across all instances |
| 31 | `class="..."` on a component is forwarded to the child's class prop automatically |
| 31a | `$class` is a compiler-internal name — never declare `export let $class` directly. Use `{class}` or `bind:class` on the child element. |
| 32 | `bind:class` and `{class}` on an element auto-wire the parent's class through |
| 33 | `{@html expr}` injects raw HTML — only use with trusted content |
| 34 | `{#virtual each}` requires `height=N` (fixed item height in px); variable height is not yet supported |
| 35 | Snippet props are declared with `export let`; `<slot />` is the preferred mechanism for receiving content from the parent |
| 35a | `<slot />` is preferred for unattributed content; the `export let children = null` pattern is supported but legacy for new code |
| 36 | `bind:this` on a component exposes exported `let` props and exported functions — never a DOM node |
| 37 | `$mounted(fn)` may only appear once per component — use `Promise.all` inside for multiple operations |
| 38 | `<mesa:mounted>` always gates the entire component template — wrapping and self-closing forms are equivalent |
| 39 | `onerror` on `<mesa:mounted>` runs programmatically on rejection, independent of the `failed` snippet |
| 40 | `<mesa:boundary>` and `<mesa:mounted>` resolve snippets in the same order: co-located → global → blank |
| 41 | `bind:value\|mask` requires a pattern argument wrapped in `{ }` — string literal or reactive expression |
| 42 | `$inspect` is dev-only — stripped entirely when `config.debug: false`. Top-level only. |

---

## 23. Full Example Component

```js
// store.js — plain JavaScript, no Mesa, no store API
export const user = { name: 'Alice', prefs: { theme: 'dark' } }
export const cart = { items: [], total: 0 }
```

```mesa
<!-- ShopPanel.mesa -->
<script>
    import { animate } from 'motion'
    import { getStates, getCities } from './data'
    import { cart, user } from './store.js'

    // Watch store paths
    $: user.prefs.theme
    $: (cart.items, cart.total)

    // Props
    export let onSelect                // reactive prop
    export var region = 'US'          // non-reactive prop — snapshot at mount

    // One-shot async
    const states = await getStates()

    // Reactive let — bind:value can override
    let selectedState = states[0]

    // Async derived — reruns when selectedState changes
    const cities = await getCities(selectedState)

    // Writable derived — re-derives from cities, overridable by bind:value
    $: selectedCity = cities[0]

    // Derived const — from watched store path
    const itemCount = cart.items.length

    // var — non-reactive sampler
    var stagedSelection = selectedCity

    // Element ref
    let panelEl

    // Enter/exit animation
    const fade = $.entrance({
        in:  (el) => animate(el, { opacity: [0, 1] }, { duration: 0.2 }),
        out: (el) => animate(el, { opacity: [1, 0] }, { duration: 0.2 }).finished
    })

    // Watch+handler — debounced callback
    $: selectedCity, async () => {
        const t = setTimeout(() => onSelect(selectedCity), 300)
        $onCleanup(() => clearTimeout(t))
    }

    // Auto-tracked side effect — runs when either dep changes
    $: document.title = `${selectedCity}, ${selectedState}`

    $onMount(() => panelEl.focus())
</script>

<!-- Global keyboard shortcut -->
<mesa:window on:keydown|self={handleKey}>

<!-- Reactive head -->
<mesa:head>
    <meta name="region" content={region}>
</mesa:head>

<mesa:boundary>
    {#snippet pending()}
        <p>Loading...</p>
    {/snippet}

    {#snippet failed(error)}
        <p>Error: {error.message}</p>
    {/snippet}

    <div
        bind:this={panelEl}
        data-theme={user.prefs.theme}
        style:font-size="{baseFontSize}px"
        class:loading={$async.cities.fetching}
        {@attach fade}
    >
        <select bind:value={selectedState}>
            {#each states as state (state)}
                <option>{state}</option>
            {/each}
        </select>

        <select bind:value={selectedCity} disabled={$async.cities.fetching}>
            {#each cities as city (city)}
                <option>{city}</option>
            {/each}
        </select>

        {#if $async.cities.error}
            <p>Error: {$async.cities.error.message}</p>
        {/if}

        <p>{selectedCity}, {selectedState}</p>
        <p>{itemCount} items in cart</p>
    </div>
</mesa:boundary>
```

---

*Mesa Vision · v1.8 · TypeScript support and full hydration SSR deferred to a future version*
