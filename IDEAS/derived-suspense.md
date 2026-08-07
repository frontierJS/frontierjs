# Idea — Suspense boundaries derived from the dependency graph

**Status: SHIPPED MECHANISM + IDEA.** Dated 2026-08-05. `<mesa:boundary>` exists and
works, and the watch-set defect described below was **fixed the same day** (`ISSUES.md`
FJS-073, mesa `CHANGES.md`, 9 tests) — it is kept because it is the argument for the
derivation, which is unbuilt. See `VERIFYING.md`.

---

## Where FJS stands

Mesa already generates per-value async state. A script-level `await` on a derived
`const` produces a `$$async_<name>` state object, collected into a `$async` container
(`packages/mesa/src/compiler.js:5480-5571`), and `<mesa:boundary>` renders a
`pending` snippet while any watched state is in flight, `failed` on throw
(`docs/VISION.md` §12.5).

So the framework already knows, per value, whether it is pending — which is the input
a suspense system needs and the thing React had to invent a protocol for.

## The defect that started this — fixed 2026-08-05

**Kept in the past tense; the code below is what it used to do.** `compiler.js:3079`
collected the watch set, with the comment stating the behaviour plainly:

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
makes the multiple-boundaries-per-component capability that §12.5 advertises
functionally single.

It failed in the direction that reads as a framework bug and debugs as an application
one. Closed as `ISSUES.md` **FJS-073**.

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
compile time, per node.

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
2. **A read set per node**, exposed from the existing analysis rather than computed
   again: for each template node, the async vars its subtree references.
3. **Placement**: lowest common ancestor per pending value, subject to a
   `pending`/`failed` snippet being resolvable at that point — if neither is in
   scope, walk up rather than render blank.
4. **An opt-out**, because a derived boundary must not surprise: an explicit element
   wins, and `<mesa:boundary auto={false}>` (or a compiler option) turns derivation
   off for a component.

## Open questions

- **Does a value read only in an attribute get its own boundary?** Gating
  `<img src={url}>` on its own is probably right and probably looks wrong. Attribute
  reads may want to bubble to their element's parent.
- **What is the SSR behaviour?** `render.js` produces inert HTML; a derived boundary
  in an SSR pass should presumably emit the `pending` snippet, which makes it the
  first thing a prerendered page shows and therefore a layout decision, not only a
  loading one.
- **Interaction with `{#virtual each}`** — `ISSUES.md` `FJS-067` records that it
  produces no SSR output and wants a `{:static}` fallback. Same shape of question:
  what does a region render when its data is not there yet.
- **Does the derivation want to be visible?** A compiler that silently inserts
  boundaries is a compiler whose output does not match the source. A `--explain`
  listing what was placed where would keep it honest, and is the same reporting
  surface item 5 of `IDEAS/static-safety.md` wants.

## See also

- `packages/mesa/src/compiler.js` — `boundaryWatchSet()` / `templateSource()`, and
  `:5480-5571` for `$async`
- `packages/mesa/docs/VISION.md` §12.5 — `<mesa:boundary>` / `<mesa:mounted>`
- `ISSUES.md` § Closed `FJS-073` — the over-watch defect
- `IDEAS/static-safety.md` — the other build-time classification over the same graph
- `IDEAS/one-mental-model.md` § *The target set's missing member* — the same
  compile-time-known-dependencies property, applied to hydration
