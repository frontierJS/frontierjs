# Reactivity audit pass — 2026-08-01

> **Superseded in part.** §6 (Block teardown) was extended by the block teardown
> pass — see [`BLOCK_TEARDOWN_PASS.md`](./BLOCK_TEARDOWN_PASS.md), which names
> the two failure shapes behind every bug in that layer, fixes the same shapes
> in `keyBlock`, `awaitBlock`, `$$eachBlock` and `boundaryBlock`, and disproves
> two claims made about `keyBlock` and `mountedBlock`. The rest of this document
> stands.

Handoff document. Baseline was the working tree as of this date (which already
contained the uncommitted two-pass user-effect split — that split is **not**
part of this pass).

Scope: an audit of the reactivity system, then fixes for everything the audit
turned up that could be reproduced. Everything below was verified by running
code, not by reading it.

---

## State

| Suite | Tests | Status |
|---|---|---|
| `compiler.test.js` | 406 | pass |
| `runtime.test.js` | 266 | pass |
| `css-inliner.test.js` | 36 | pass |
| `render-component.test.js` | 29 | pass |
| `external-reactivity.test.js` | 26 | pass |
| `inert-block.test.js` | 23 | pass |
| `watch-handler-defer.test.js` | 13 | pass |
| `watch-proxy-staleness.test.js` | 8 | pass |
| `async-decl-scope.test.js` | 7 | pass |
| `effect-phase.test.js` | 5 | pass |
| `email-kit.test.js` | 27 | **fail — environment, not code** |
| **Total** | **846** | **819 pass / 27 fail** |

Run: `npx vitest run`

**The 27 failures are pre-existing and unrelated.** `email-kit.test.js` needs
`@frontierjs/email-kit`, which is not installed in this checkout. They failed
identically before this pass. Do not chase them; install the dep or ignore.

Sierra was used as the downstream regression check throughout —
`cd ../sierra && npx vitest run` → **521/521**. Re-run it after any runtime change.

---

## Files changed

```
runtime.js               the bulk of it
compiler.js              trackDerived emission (3 sites) + one comment
render.js                initRenderer passes (true, false)
render-component.js      js target no longer strands temp files
VISION.md                RULES 46-49, RULE 19 amended, §15 getters rewritten
PLAIN_OBJECT_STATE.md    "what gets worse, honestly" — added RULE 47 caveat
runtime.test.js          +30 tests
compiler.test.js         1 test updated (trackDerived)
render-component.test.js +4 tests
```

---

## What changed, and why

### 1. `createMemo` propagates from the recompute, not the invalidation

`_notify` used to forward to subscribers the instant a dependency changed —
before `fn()` had run. The equality check only ever gated the *assignment*, so a
`const` derivation could cache a value but never suppress a downstream re-run,
which is the one job a memo exists for. Measured: `count > 0` under three
increments re-ran its consumer 4× instead of 1×.

Now `_notify` queues the memo; `_run` recomputes, compares, and only notifies
`ownSubs` when the value actually moved.

Three things fell out of this:

- **`dirty` is cleared before `fn()`, not after.** A write to a dependency from
  inside the memo body used to be erased by the in-flight recompute, and since
  `_notify` early-returns while dirty, nothing had propagated either — the memo
  served a pre-write value forever.
- **Laziness is preserved.** The first cut made memos eager and broke the
  existing `is lazy — does NOT recompute if not read` test. That test was right.
  `_run` returns early when `ownSubs` is empty, leaving `dirty` set.
- **A derived tier in `_flush`.** Derivations settle to a fixpoint *before*
  renders and user effects, so a chain of memos resolves in one generation.
  `createWritableSignal`'s bridge effect opts in via `{ derived: true }` —
  without that it raced the consumers reading what it writes, and an effect
  could observe `src=2` while the value derived from it was still `10`.

Benchmark, 10k signals × 60 updates over boolean derivations: 600,000 wasted
downstream effect runs → **0**, and 25–37% faster wall-clock.

### 2. Flush resilience

- `_runNode` contains per-node errors. `_flush` drains `_queue` into a snapshot
  before running anything, so an escaping exception didn't just skip the effect
  that threw — every node after it was dropped and never re-notified.
- `_MAX_FLUSH_PASSES = 1000` + `_reportCycle`. A cyclic effect pair used to spin
  forever with no output; it now bails with a message naming the likely cause.

### 3. Watch trie — one rule for both proxy engines

`$: page` opts the whole object into deep reactivity; `$: page.user.preferences`
opts in that subtree at any depth; siblings stay silent. Writes notify every
registered ancestor; reads subscribe to the nearest registered ancestor-or-self
via a precomputed `cover`.

Paths are a **trie of key segments**, not dot-joined strings. Strings could not
express the rule: `obj['a.real'] = 1` produced the path `a.real`, whose textual
parent is `a`, so it woke an unrelated watcher. Resolution was also quadratic in
nesting depth. Segments fix both by construction.

`localWatchProxy` (local `let` objects) now compiles its compiler-supplied
`signalMap` into the same trie. It previously had the same depth bug in a
different shape — `_fireLocalSignals` returned on the first exact match, so
`$: a.b.c` alongside `$: a` stopped the write from ever reaching `a`.

Deep reads got *faster* than the original: 263 ms → **187 ms** on the same bench.

### 4. Proxy repairs

- `deleteProperty` trap — `delete obj.k` notified nothing.
- `set` strips proxies. `state.selected = state.items[0]` stored a Proxy in the
  raw object, after which `indexOf` returned -1 and `structuredClone` threw.
  Fresh containers are cleaned element-wise (`filter`/`map`/spread carry proxies
  out one at a time); nothing is allocated unless something needs replacing.
- `Date`/`Map`/`Set`/`RegExp`/typed arrays pass through untouched. Wrapping them
  broke every method with `incompatible receiver` and could never have made them
  reactive — their state lives in slots no trap observes.
- `Reflect.get(target, key, receiver)` so accessors run with the proxy as `this`
  and their reads subscribe. Restricted to plain containers, decided once per
  proxy, so class instances keep the raw receiver and their private fields work.

### 5. `track()` no longer guesses from arity

It decided value-vs-derivation from `value.length === 0`. But a zero-arg
function is exactly what a user writes for a callback:

```
<Child ondone={() => n++} />      arrow, length 0
<Child handler={bump} />          named fn, length 0
```

and the child's `export let ondone` compiles to `track($option.props.ondone)`.
Both were memoised and **invoked during setup**, so `on:click={ondone}` bound
the callback's return value. `let f = () => …` had it too.

Arity cannot separate a compiler-generated derivation from a user callback —
both are `() => …`. So the compiler now says which it means: `trackDerived()`
always memoises, `track()` always stores. Three emission sites are derivations
(derived `const`, two `$context` reads); the rest are values.

### 6. Block teardown

- **`{#if}` uses a marker comment** it owns, instead of holding the branch's
  first/last DOM nodes. An inner `{#await}` swaps exactly those nodes on
  resolve, after which removal walked from a detached node and removed nothing —
  the branch stayed on screen permanently.
- **`{:then}`/`{:catch}` get a per-resolution owner.** They are built inside
  `promise.then`, where the global `_owner` is whatever ran at microtask time
  (normally `null`), so their effects were parented to nothing and no disposal
  path could reach them.
- **`{#each}` clear removes only its own ranges.** `while (anchor.previousSibling)`
  destroyed any static markup preceding the block.
- **`{#each}{:else}` gets an owner node.** `elseNode?.dispose?.()` was dead code
  (the compiler passes a plain factory returning DOM), so every empty↔non-empty
  toggle stranded another live effect set.

### 7. Component stack exception safety — deliberately NOT try/finally

The obvious fix is wrapping the emitted component body in `try/finally` around
`push_component`/`pop_component`. **Do not do this.** It block-scopes the
component's `function` declarations in strict mode, which is exactly the class
of bug `async-decl-scope.test.js` exists to prevent — it broke 5 of its tests.
There is a comment at the emission site in `compiler.js` saying so.

Fixed in the runtime instead: `_unwindComponents(compDepth, ctxDepth)` truncates
both stacks and restores what `pop_component` would have, called from
`_runNode`, `createEffect`'s initial run (rethrowing — a setup failure is the
caller's to see), and `mount()`. `makeComponent` had the same shape of bug: its
`finally` restored `_owner`/`_listener` but `_mountList`/`_propRegistry` were
restored *after* the try.

### 8. SSR — DOM availability split from client-ness

`initRenderer()` must set a DOM flag, because compiled components call
`htmlToFragment()` at module load. But it used one flag for both meanings, so
enabling the DOM enabled client behaviour and every RULE 19 guard became dead
code. Measured: `$onMount` fired once per server render (against a happy-dom
`window` that outlives the request), `watchProxy` built real proxies, and
effects against module-scope stores accumulated — after 5 renders one write ran
5 effects.

`setRenderEnvironment(isBrowser, isClient = isBrowser)` — the default keeps every
existing caller identical, including Sierra's tests, which call it to simulate a
browser. `initRenderer()` passes `(true, false)`. Exactly four guards were RULE
19 semantics (`$onMount`, `watchProxy`, `watchPath`, `localWatchProxy`); the
other twenty are genuine DOM checks and stayed on `_isBrowser`.

Sierra's router already assumed this — it resolves its write handle per call
specifically because `watchProxy` is meant to be inert without a DOM.

### 9. Smaller

- `createWritableSignal` passes `opts` to both halves. It reached the memo only,
  so a recompute of an `equals`-equal value stayed silent while a manual write of
  the same value notified via the `Object.is` fallback.
- `render-component.js` js target passed `compileTree` a throwaway `[]` for
  `tempFiles`, stranding one `.mjs` per module in the package directory. It now
  uses `noEmit` (the js target never imports them) plus a tracked array.

---

## Documented and accepted, not fixed

**RULE 47 — watches belong to the object, not the declaring component.** The
registry is keyed by the watched object and lives for the process. If any
component declares `$: page`, every other component's reads of `page.*` are
covered by it and re-render on any write — including components that declared
nothing. A finer watch declared elsewhere likewise becomes the nearest cover for
other components' reads beneath it.

Always fail-safe (an extra render, never a stale one), never locally
explainable. It cuts against "reactivity becomes visible at the use site" in
`PLAIN_OBJECT_STATE.md`, which now says so. Accepted deliberately; revisit if
over-rendering shows up. The fix would be scoping the registry per component
instance rather than per object.

---

## Still open

Nothing here has a known reproduction; these are design/surface items.

1. **Context API surface** — `runtime.js` exports two complete, mutually
   invisible context systems over one `_contextStack`: symbol-keyed
   (`createContext`/`provideContext`/`useContext`) and string-keyed
   (`contextProvide`/`contextRead`), plus `$context` whose members belong to the
   symbol system while the `$context.key` language form compiles to the string
   one. Six exports, one effectively dead. Cleanup, no bug.
2. **`{ equals: () => false }` as an always-notify switch** —
   `runtime.js` two sites. A value comparator expressing a delivery policy. Works;
   reads oddly. A rename, not a fix.
3. **Full `_deps`/`_subs` teardown and rebuild per effect run** — 4×D hash ops at
   D dependencies, no slot reuse (Solid), version check (Vue), or lazy
   unsubscription (Preact). A real cost and a coherent choice. **Do not touch
   without a profile motivating it.**
4. **Private-field class instances in watched state** — undetected; their methods
   throw when invoked with the proxy as `this`. Documented in RULE 49. Excluding
   them by prototype would silently drop reactivity for ordinary classes, which
   do work.
5. **Memo disposal** — `_disposed` guards were added, but a disposed-while-clean
   memo still serves its last value on read rather than warning.

---

## Claims that were investigated and are FALSE

Do not re-fix these; they were raised by the audit and died under testing.

- **"`batch()` inside an effect re-enters `_flush` and inverts render/user
  ordering."** Ordering holds. Repro showed `render:b=1` before `user:b=1`.
- **"`equals` freezes a memo's value / crashes on first read."** `!eq` keeps the
  old value only when the comparator says they are *equal*, which is the point of
  a custom comparator. The comparator is no longer invoked against `undefined` on
  a first computation either.

---

## Working notes

- **Verify with running code.** Most of the audit's original findings were
  produced by agents whose adversarial-verification pass never ran; roughly one in
  fifteen turned out to be wrong, and several were stale by the time the
  surrounding code changed. Assume a claim is unproven until a script reproduces it.
- **`compileSource` is async** and returns a ctx whose code is `ctx.result`.
  `compile()` has a different shape. Easy 10 minutes to lose.
- **happy-dom is not resolvable from a scratch directory.** Write throwaway
  repros as `_name.test.js` inside `packages/mesa` and run
  `npx vitest run _name.test.js`, then delete. `vitest.config.js` sets the
  environment.
- **Benchmark head-to-head in the same run.** Absolute numbers on this machine
  moved by 3× between sessions; only same-invocation comparisons meant anything.
- **`render-component.test.js` needs `/tmp/mesa` to exist** or 33 tests fail on
  `ENOENT`. `mkdir -p /tmp/mesa`.
- **Always re-run Sierra** (`cd ../sierra && npx vitest run`) after runtime
  changes. It is the only real downstream consumer in this repo.
