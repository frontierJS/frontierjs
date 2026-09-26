---
id: derived-suspense
status: partial
dated: 2026-08-05
---

# Idea — Suspense boundaries derived from the dependency graph

**Status: SHIPPED MECHANISM + IDEA.** Dated 2026-08-05. `<mesa:boundary>` exists and
works, and the watch-set defect described below was **fixed the same day** (`ISSUES.md`
FJS-073, mesa `CHANGES.md`, 9 tests) — it is kept because it is the argument for the
derivation, which is unbuilt. See `VERIFYING.md`.

**Reassessed 2026-09-23 against Svelte 5: the coordination comes first and the
derivation last, if at all.** Svelte's compiler sees the same reads, places no
boundary for you, and spends the effort on what an unwrapped await holds, updates
that do not tear, and failures that reach the nearest boundary across components.
Mesa has none of the three. The derivation's own obstacle is the fallback: someone
still writes `pending`, and choosing where that snippet goes is choosing where the
boundary goes. § *What Svelte 5 does* has the comparison, § *Open questions* the
choices, § *What would have to be built* the order.

---

## Where FJS stands

Mesa already generates per-value async state. A script-level `await` on a derived
`const` produces a `$$async_<name>` state object, collected into a `$async` container
(`packages/mesa/src/compiler.js`, `boundaryWatchSet` — line numbers have moved
since this was written, search the function name), and `<mesa:boundary>` renders a
`pending` snippet while any watched state is in flight, `failed` on throw
(`docs/VISION.md` §12.6).

So the framework already knows, per value, whether it is pending — which is the input
a suspense system needs and the thing React had to invent a protocol for.

## The defect that started this — fixed 2026-08-05

**Kept in the past tense; the code below is what it used to do.** `boundaryWatchSet`
in `compiler.js` collected the watch set, with the comment stating the behavior plainly:

```js
// Get all async-derived vars — boundary watches all $async state objects
const asyncVars = Object.values(ctx.analysis.vars || {}).filter(v => v.isAsync)
```

**Every async-derived value in the component, regardless of what the boundary's body
reads.** So:

```html
<script>
  const cities  = await getCities(state)      // fast
  const reports = await getReports()          // slow, or hangs
</script>

<mesa:boundary>
  {#snippet pending()}<p>Loading cities…</p>{/snippet}
  <select>{#each cities as c}<option>{c}</option>{/each}</select>
</mesa:boundary>
```

The `<select>` is held behind `reports`, which it does not use. A value that never
resolves — a rejected fetch on an unrelated feature, a slow report — leaves an
unrelated part of the page showing *Loading cities…* forever. With two boundaries in
one component both watch the same union, so they always show and hide together, which
makes the multiple-boundaries-per-component capability that §12.6 advertises
functionally single.

It failed in the direction that reads as a framework bug and debugs as an application
one. Closed as `ISSUES_ARCHIVE.md` **FJS-073**.

**The fix was a narrowing, not a mechanism** — `boundaryWatchSet()` scans the body's
expression sources (interpolations, block headers, attributes, component props,
`@const`) and watches the async values named there. It over-approximates on purpose:
under-watching shows content before its data arrived, so a name that merely *looks*
read counts as read. Two cases keep the whole-component union, and both are load-bearing
for what follows:

- **the body reads no async value** — that is how you say "gate this region on
  everything", and it is the only way to say it
- **the body renders a snippet defined elsewhere** (`{@render foo()}`), whose reads
  are not in the subtree

Emission is otherwise identical: same `boundaryBlock` call, narrower first argument.

## The idea: stop writing the boundary at all

Once the watch set is derived from reads, the element itself is the last hand-placed
part — and hand-placing is exactly what gets granularity wrong. React and Solid both
make the developer guess where `<Suspense>` goes, because their runtimes cannot see
which subtree depends on which promise. Mesa can: dependencies are resolved at
compile time, per node. **So can Svelte, and it chose not to** — § *What Svelte 5
does*.

> **Insert the boundary at the lowest node whose subtree reads a pending value.**

A component with no `<mesa:boundary>` and an async derived `const` gets boundaries
placed where they belong: the `<select>` is gated, the heading beside it is not. An
explicit `<mesa:boundary>` stays available and wins where it appears — it is how you
say *coarser than you would derive*, e.g. to hold a whole panel so it does not
reflow in pieces.

Two properties follow that are worth the work on their own:

- **The pending region matches the data region exactly**, which is what makes
  automatic placement better than careful placement rather than merely cheaper.
- **It composes with the island seam.** An island's props are known at prerender, so
  a derived boundary tells the static build precisely which parts of a prerendered
  page have no resolved data at build time — the same question
  `IDEAS/static-safety.md` § *classify the route* asks from the authorization side.

## What Svelte 5 does

Read 2026-09-23 from svelte.dev (`await-expressions`, `svelte-boundary`). Async
Svelte is `experimental.async` from 5.36, with the flag slated to go in Svelte 6:
`await` in `<script>`, in `$derived`, and in markup.

- **The boundary is hand-placed.** `<svelte:boundary>` takes `pending`,
  `failed(error, reset)` and `onerror`. A compiler with the same read information
  did not derive placement, and put the work into coordination instead.
- **`pending` is shown when the boundary is first created and never again.** Later
  updates are *globally coordinated*: "changes to that state will not be reflected
  in the UI until the asynchronous work has completed", so two values fed by one
  input never show one new and one old. `$effect.pending()` counts what is in flight
  for a spinner, and `settled()` resolves when everything has landed.
- **A pending await or a throw reaches the nearest ancestor boundary**, across
  component edges. `reset` rebuilds the boundary's contents. Event handlers and
  `setTimeout` are not caught.
- **Independent awaits in markup run in parallel**; awaits in `<script>` are
  sequential, as plain JS is.
- **SSR**: inside a boundary with `pending` the snippet is rendered; every other
  await resolves before `await render()` returns.
- `fork()` (5.42) preloads a future update — navigation preloading.

**Against Mesa today.** First-load-only matches: `makeAsyncState` keeps `loading`
(first load, what `boundaryBlock` gates on) apart from `fetching` (a refetch). The
rest differs. Each value commits as it lands, so a multi-value update tears. `$async`
is component-local, so a child's await is invisible to its parent's boundary. There
is no `reset`. A component with an async `const` and no boundary renders immediately
with the value `undefined`, and nothing warns (compiled output, checked the same day).

## The half that is not derived: empty

`pending` and `failed` are structural. **`empty` is not**, and it is the third
branch of the same conditional every data-driven region writes:

```html
<mesa:boundary>
  {#snippet pending()}<Spinner />{/snippet}
  {#snippet failed(e)}<Alert tone="danger">{e.message}</Alert>{/snippet}

  {#if rows.length === 0}
    <EmptyState title="No orders yet" />      <!-- still per call site -->
  {:else}
    {#each rows as r}…{/each}
  {/if}
</mesa:boundary>
```

Three of the four states are handled once, structurally, and the fourth is
copy-pasted — which is the exact shape of the problem `<mesa:boundary>` exists
to remove. `@frontierjs/ui` even ships `EmptyState.mesa` for it, so the
component is there and only the wiring is missing.

The reason it is harder is that "empty" is not a property of the *await*.
`pending` and `failed` are states of a promise and the compiler can see them;
emptiness is a property of the resolved **value**, and only some values have
one. So it needs a rule, and the rule has to be narrow enough not to guess:

> A resolved value is empty when it is an array of length 0, or a list envelope
> whose `data` is. Nothing else — `null`, `0`, `''` and `{}` are values, not
> absences.

That rule is safe precisely because Junction already made the shape canonical:
a list keeps its envelope (`{ kind:'list', data, total, … }`) and a single
record unwraps. `kind:'list'` is a discriminator the compiler can test without
guessing, which is what makes this different from React's version of the same
idea, where "empty" has no wire meaning at all.

Open, and the reason this is a note rather than a proposal:

- **Whose snippet is it?** `{#snippet empty()}` beside `pending`/`failed` reads
  right, but the boundary would then be watching a value's *contents*, not its
  settledness — a wider contract than the element currently has.
- **Which value, when there are several?** A body reading two lists has two
  emptinesses and one region. `pending` unions; empty probably should not.
- **It is a layout decision, not a loading one.** An empty state usually wants
  the surrounding chrome (the toolbar, the pager) still rendered, where a
  pending state usually does not. Placing it at the same node as the boundary
  may be wrong more often than it is right — which argues for deriving the
  *condition* and leaving the placement to the author.

## What would have to be built

1. ~~**Narrow the watch set to the body's reads**~~ — **done 2026-08-05.**
   `boundaryWatchSet()` in `compiler.js`; 9 tests in `test/compiler.test.js`.
2. **The check before the change: no content mounts before the data it reads.**
   Nothing enforces it today, and the `undefined` render passes silently. It is a
   runtime spec: a component whose await has not settled, asserting its gated
   content is absent from the DOM. It fails against today's unwrapped await and
   against a torn update, so it grades steps 3 and 4 as they land.
3. **An unwrapped await holds its nearest boundary**, else its component, until it
   settles. It closes the `undefined` flash with no new noun.
4. **Synchronized updates.** Every region reading a value an update re-awaits keeps
   its old content until all of them settle, then commits once. It is a batch in the
   runtime's scheduler, independent of who places a boundary.
5. **Pending and failure cross component edges** to the nearest ancestor boundary at
   runtime. A failure goes to the nearest boundary with `failed`, else the component
   root and the console, and `failed` receives `reset`. This retires the swallowed
   error in `VISION.md` §12.6.
6. **SSR awaits** everything not under an explicit `pending`.
7. **Derived placement, only once a real screen asks for finer reveal than hand
   placement gives**:
   - a read set per node, exposed from the existing analysis rather than computed
     again: for each template node, the async vars its subtree references
   - placement at the lowest common ancestor per pending value, revealed together
     within a component, subject to a `pending`/`failed` snippet being resolvable at
     that point, walking up rather than rendering blank
   - an opt-out, since a derived boundary must not surprise: an explicit element
     wins, and `<mesa:boundary auto={false}>` (or a compiler option) turns
     derivation off for a component
   - `--explain`, listing what was placed where

## Open questions

- **What does an await with no boundary around it do?** Today the region renders
  with `undefined` and fills in later, silently.
  - **A** — keep that, and make derived placement purely additive.
  - **B** — the await holds its nearest ancestor boundary, else the component,
    until it settles (Svelte).
  - **C** — derive a boundary for it (this paper's idea).
  - **Recommend B** — and C only once a real screen wants finer reveal than hand
    placement gives. B closes the `undefined` flash with no new concept. C is
    then an optimization over B, and the next three questions are its price.
- **How fine is a derived boundary?**
  - **A** — the lowest node per value, as § *The idea* states.
  - **B** — the lowest node, but boundaries in one component reveal together.
  - **C** — the component root: derive the watch set, never the placement.
  - **Recommend B** — if C above lands. A gives the pending region the data region's
    exact shape, and a page whose regions pop in one at a time, shifting layout at
    each arrival. That is right about correctness and wrong about what a person sees.
- **Where does a derived boundary's fallback come from?**
  - **A** — the nearest `pending` snippet in scope, walking up (build step 3).
  - **B** — a blank region.
  - **C** — a skeleton derived from the gated markup.
  - **Recommend A** — and read it as evidence for B in the first question. Once the
    fallback has to be authored, placing the snippet is placing the boundary in all
    but name, and the derivation saves one wrapper element.
- **Does an update that changes several async values tear?** Today each value
  commits as it lands.
  - **A** — per-value commit.
  - **B** — synchronized: every region reading a value the update re-awaits keeps
    its old content until all of them settle, then commits once (Svelte).
  - **Recommend B** — as its own item ahead of any placement work. It is the tearing
    fix and it holds whoever places the boundary. It costs a batch in the runtime's
    scheduler, which is internal and adds no user-facing noun.
- **Does a child component's await or throw reach its parent's boundary?** Today
  `$async` is component-local.
  - **A** — component-local.
  - **B** — the nearest ancestor boundary at runtime, across component edges (Svelte).
  - **Recommend B** — it is what makes one hand-placed boundary per page region
    enough, which is most of what derivation promised. `captureContext()` already
    carries context across the edge.
- **Where does a failure go?** With no `failed` snippet in scope the error is
  swallowed (`VISION.md` §12.6), which is a wrong answer nothing reports.
  - **A** — `failed` placed with `pending`.
  - **B** — a failure bubbles to the nearest boundary that has `failed`, else to the
    component root and the console, and `failed` receives `reset`.
  - **Recommend B** — an error region usually wants to be coarser than a loading one,
    and a swallowed error is the silence § V's ninth question exists to refuse.
- ~~**`FJS-D372` — Does a boundary catch a THROW, or only a rejected await?**~~ **Answered 2026-09-24 (`FJS-D372`): B — a throw during a flush reaches the boundary too: render, block, derivation and `$:` effect. Not an event handler or a timer.**
  ([`FJS-1326`](../ISSUES.md#fjs-1326)). Today `boundaryBlock` reads only the
  `.error` of its `$async` states. A throw during a flush — a render, a block, a
  derivation, a `$:` effect — is caught by `_runNode`, logged, and goes nowhere, so the
  region is left half-drawn with its effects still subscribed. A throw on the FIRST run
  is different: `createEffect` rethrows it, so it reaches whoever called `mount()`. Before
  the first paint an error is loud, and after it the error goes to the console.
  - **A** — rejected awaits only, as today; a throw is the console's.
  - **B** — a throw during a flush reaches the boundary too: render, block, derivation
    and `$:` effect. Not an event handler or a timer.
  - **C** — B, plus event handlers.
  - **Recommend B** — Solid and Svelte 5 draw the same line. A throw in a flush leaves a
    region half-built, while a throw in a handler leaves the DOM as it was, so only the
    first corrupts what the boundary guards. C would wrap every handler the compiler
    emits, to catch a failure that damaged nothing. The questions below are only open
    if this rules B.
- ~~**Which element catches it?**~~ **Answered 2026-09-24 (`FJS-D373`): A — `<mesa:boundary>`'s `failed` snippet, the one it already has.** Only open if `FJS-D372` rules B.
  - **A** — `<mesa:boundary>`'s `failed` snippet, the one it already has.
  - **B** — a separate element, `<mesa:catch>`.
  - **Recommend A** — no new noun, and it is Svelte's shape. **What it costs**: a body
    that reads no async value gates on the whole component's `$async` union today, so
    wrapping a plain region to catch errors would also start gating it on loads. Under A,
    a boundary with no `pending` in scope gates nothing, and RULE 40's global-snippet
    fallback has to say whether a global `pending` counts.
- ~~**How does a throw find its boundary?**~~ **Answered 2026-09-24 (`FJS-D374`): A — `_runNode` walks `_owner` from the node that threw to the nearest owner that carries a handler, and the boundary sets that handler on the owner node its content is built under.** Only open if `FJS-D372` rules B.
  - **A** — `_runNode` walks `_owner` from the node that threw to the nearest owner
    that carries a handler, and the boundary sets that handler on the owner node its
    content is built under.
  - **B** — the context stack, reinstated by `captureContext()`.
  - **Recommend A** — the owner tree IS the render tree, and it is still there during a
    flush, when the context stack has long been popped. It crosses component edges with
    no extra work, which answers *does a child's throw reach its parent's boundary*
    above with B for errors at no cost. The routing stays in `_runNode`, so there is
    one owner.
- ~~**What becomes of the region that threw?**~~ **Answered 2026-09-24 (`FJS-D375`): A — the content subtree is disposed and `failed(error, reset)` is rendered; `reset` rebuilds the content.** Only open if `FJS-D372` rules B.
  - **A** — the content subtree is disposed and `failed(error, reset)` is rendered;
    `reset` rebuilds the content.
  - **B** — the content stays and `failed` renders beside it.
  - **C** — A, and the content retries by itself on the next write to anything it read.
  - **Recommend A** — B keeps exactly the half-drawn, still-subscribed region this
    exists to remove. C re-runs a failure on every keystroke, and whether a retry is
    wanted is the author's call, which `reset` puts in their hands.
- ~~**What happens to a throw with no boundary above it?**~~ **Answered 2026-09-24 (`FJS-D376`): C — Sierra builds each route inside a boundary whose `failed` the app's layout supplies, so a route has an error state by default. Mesa standalone keeps A.** Only open if `FJS-D372`
  rules B.
  - **A** — as today: the first run throws to `mount()`'s caller, and anything later
    is logged and left half-drawn.
  - **B** — the component that threw is disposed and logged, so nothing half-drawn
    keeps running.
  - **C** — Sierra builds each route inside a boundary whose `failed` the app's layout
    supplies, so a route has an error state by default. Mesa standalone keeps A.
  - **Recommend C** — the route is the region a person reads as one page and Sierra
    already owns it. B removes a component from under a layout that then has a hole
    and no message, which is quieter than the log it replaces.
- ~~**What does a throw inside a boundary do in a static build?**~~ **Answered 2026-09-24 (`FJS-D377`): B — the build fails, naming the route and the error.** Only open if
  `FJS-D372` rules B.
  - **A** — the boundary renders `failed` into the HTML.
  - **B** — the build fails, naming the route and the error.
  - **Recommend B** — a prerendered `failed` snippet is an error page published with
    nothing reporting it. The static-safety gate already fails closed for the same
    reason.
- ~~**What makes a boundary WAIT?**~~ **Answered 2026-09-24 (`FJS-D378`): A — a boundary waits on the async values its body reads, and on nothing else. A body that reads none waits on nothing. RULE 40 only chooses what `pending` SHOWS. `{@render snippet()}` keeps the whole-component set, because its reads are not in the subtree and waiting too little is the dangerous direction.** Opened by [`FJS-D373`](../DECISIONS.md#fjs-d373),
  which puts error catching on `<mesa:boundary>` and so makes a boundary written only to
  catch a throw an ordinary thing to write. Today two different things decide whether a
  boundary holds its content back: its body's async reads, and — for a body that reads
  none — every async value in the component. RULE 40 then picks which `pending` to show,
  co-located first, then a global one. Measured 2026-09-24 against the compiler: in a
  component with `const orders = await getOrders()` and a global `pending`, a boundary
  around `<Clock />` compiles to `boundaryBlock(…, () => ([$$async_orders]), …)` and shows
  the global *Loading…* until the orders arrive, though the clock reads nothing. No
  `.mesa` file in this repo writes `<mesa:boundary>`, so nothing depends on either answer.
  - **A** — a boundary waits on the async values its body reads, and on nothing else. A
    body that reads none waits on nothing. RULE 40 only chooses what `pending` SHOWS.
    `{@render snippet()}` keeps the whole-component set, because its reads are not in the
    subtree and waiting too little is the dangerous direction.
  - **B** — as today: a body that reads nothing waits on everything, so a boundary
    written to catch errors also waits on loads.
  - **C** — a boundary waits only if a `pending` resolves for it by RULE 40, co-located
    or global.
  - **Recommend A** — whether a region waits is then read off the region alone. Under B
    an error boundary quietly becomes a loading gate, and under C adding a global
    `pending` for one boundary changes when every other boundary in the file appears.
    What A costs is the only spelling for *hold this region until everything has
    loaded*, which nothing in the repo uses.
- **What is the SSR behavior?** `render.js` produces inert HTML.
  - **A** — emit the `pending` snippet, so a prerendered page opens on its spinners.
  - **B** — await everything not under an explicit `pending`, and emit that snippet
    only where the author wrote one (Svelte).
  - **Recommend B** — a prerendered page of spinners publishes nothing, and B lets
    `IDEAS/static-safety.md`'s read tap see the reads it grades.
- **Does a value read only in an attribute get its own boundary?** This matters
  only under derived placement. Gating `<img src={url}>` on its own is probably right
  and probably looks wrong.
  - **A** — attribute reads bubble to the element's parent.
  - **B** — their own boundary.
  - **Recommend A** — an image gated alone reads as a broken layout, and its parent is the smallest region a person reads as one thing.
- **Interaction with `{#virtual each}`** — it renders its first window on the
  server, computed from the row height because there is no viewport to measure
  (`FJS-067` recorded the opposite and was wrong). Same shape of question: what
  does a region render when its data is not there yet, and a window of rows is
  the answer that block already gives.
- **Does the derivation want to be visible?** A compiler that silently inserts
  boundaries is a compiler whose output does not match the source.
  - **A** — silent.
  - **B** — a `--explain` listing what was placed where, the same reporting surface
    item 5 of `IDEAS/static-safety.md` wants.
  - **Recommend B** — if derived placement is built at all.

## See also

- `packages/mesa/src/compiler.js` — `boundaryWatchSet()` / `templateSource()`
  for `$async`
- `packages/mesa/docs/VISION.md` §12.6 — `<mesa:boundary>` / `<mesa:mounted>`
- `ISSUES_ARCHIVE.md` `FJS-073` — the over-watch defect
- `IDEAS/static-safety.md` — the other build-time classification over the same graph
- `IDEAS/one-mental-model.md` § *The target set's missing member* — the same
  compile-time-known-dependencies property, applied to hydration
