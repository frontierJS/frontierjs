---
id: list-controller
status: proposed
dated: 2026-09-12
---

# Idea — `resource.list()`: the layer above the table

**Status: PROPOSED. The block is gone.** `FJS-1070` closed 2026-09-12 — the
compiler no longer freezes a binding over a value a call handed back — and with
it the reason this could not be built. Two of the nine questions failed on
2026-09-10 and both failed on that defect; they are re-answered below and the
answers are dated, because an answer that changed is the one a reader must not
mistake for the original.

**What the fix also removed was the signature.** The design was forced into a
destructure by a compiler behavior, and the shape that reads better is now the
shape that works. Claims here were read off the source and RUN on 2026-09-10
and re-run on 2026-09-12. See `VERIFYING.md`.

---

## Trigger

`tables-from-the-seed.md` shipped `columns()`, `filters()`, `<Cell>` and
`<FilterBar>`, and said in its own words what it did not build:

> `Table.mesa` and `Pagination.mesa` are presentational and **should stay that
> way** — they take the columns they are given. What is missing is the layer
> above them, exactly as `<Form>` is the layer above nine controls.

That layer was never built. `core/crud-templates.js` became it by copy, and the
copy is now in every app a scaffold has written.

## The receipt

The generated list page is ~50 script lines. Lines that are about the model it
lists: **zero**. Everything else is the same five wirings — subscribe to the
store, derive the columns, reassemble the URL's query, navigate on change,
reload on navigation — restated per page, per app.

Three callers of `columns()` exist and they give three different answers to
*how does this list bind to its URL*:

| caller | URL is the state | sort marker | `omitted` |
| --- | --- | --- | --- |
| the generated page | yes | absent until 2026-09-10 | destructured, unused |
| `example` invoices | yes | hand-derived off `page.directives` | rendered |
| `basecamp` deployments | no | n/a | rendered |

Two hand-fixes of one wiring, diverged. *Paved road vs. the workaround* calls
that a measurement rather than an edge case: **one use is a choice, two is a
finding.**

The missing marker was a defect and is fixed — `<Table>` derives the NEXT sort
direction from the `sortKey` it was handed, so a page that reported a sort
without stating the current one had a header that never reversed and an
`aria-sort` stuck at `none`, with the rows correct the whole time because the
boundary had the directive. Two tripwires in `generated-mesa.test.js` hold it,
each measured against a mutant.

---

## What the compiler decided, and no longer does

The obvious signature — return an object, dot into it — did not work on
2026-09-10, and the way it failed was worse than not working. Mounted in
happy-dom over a real controller reading a real `page` object, driven by a real
navigation:

| binding site | `const list = users.list()`, 2026-09-10 | since `FJS-1070` |
| --- | --- | --- |
| `<Table sortKey={list.sortKey} />` | live — `pushProps` sits in an effect | live |
| `{#each list.rows() as r}` | live — a thunk | live |
| `<span data-sort={list.sortKey}>` | **frozen** | live |
| `{list.sortKey}` in text | **frozen** | live |

A page over that controller was half live: the table moved and the sentence
beside it did not. The compiler now names the fact in the analysis
(`opaqueValues` — every name a call's result was bound to) instead of guessing
it from emitted text, and all four positions agree.

**So the signature is a choice again, and the readable one is available:**

```mesa
const list = users.list()
$.onDestroy(list.destroy)
```

```mesa
<FilterBar filters={list.filters} search={list.search} value={list.value} onchange={list.apply} />
<Table columns={list.columns} rows={list.rows()} sortKey={list.sortKey} sortDir={list.sortDir}
       onsort={list.sortBy} striped hover emptyText="Nothing here yet." />
```

The destructure still works and is what a page wanting bare names writes. Which
of the two the generator emits is worth deciding when it is built rather than
here — one line versus a dozen names in scope is an ergonomics question, and
both are now correct, which is the only thing this file had to establish.

## The other half a plain module has to own

A controller is not compiled by Mesa, so it gets no `$:` and no rewrite. It does
not need one: `watchProxy`'s get trap subscribes the current effect only to a
watch that **already exists**, and the bare `$: (page.query, page.directives)`
line in a page is precisely what creates that watch. A module can call
`watchPath(page, 'query')` itself.

Probed with a real navigation: memos, the load effect and a consumer effect all
re-ran on every write. It also **side-steps `FJS-1065` entirely** — nothing here
relies on a `const` being promoted, because the derivations are explicit
`trackDerived` handles the controller owns.

---

## The nine

- **Another origin of truth?** No, and it retires one — *how a list binds to its URL* becomes one implementation instead of one per page.
- **Concept budget?** Shrinks. One verb beside `columns()`, `filters()` and `load()`; no noun coined. A page goes from six concepts to one.
- **Whose complexity?** The problem's. URL-as-state, a live store and schema-derived columns are each essential; re-assembling them per page is what we added.
- **Predictability?** Improved for the road, worse for the deviation — mitigated because the escape is `load()` and its own markup, which already has a caller in `example/customers`.
- **Derived rather than restated?** Yes, and this is the question that carries the proposal: every line of the page is a restatement of a derivation.
- **One owner?** Sierra's resource layer, the layer that already owns `columns()`. It owns no markup — `<Table>` and `<FilterBar>` stay presentational — and reads `@frontierjs/toolbelt/directives` rather than copying it.
- **Boundary named, typed, tested?** Only if they land together: a sierra test driving a real navigation against a real `page`, plus both app callers.
- **Failure proportional?** *2026-09-10: no* — a one-keyword slip produced a half-live page. **2026-09-12: yes.** `FJS-1070` is closed, the keyword decides nothing, and what is left is a wrong list, which is a visible wrong list.
- **Wrong with nothing saying so?** *2026-09-10: yes, three ways.* One of the three is gone with `FJS-1070`. The other two remain and each is covered by a test that has to ship with the controller anyway: a missing `watchPath` loads nothing and raises nothing, and a `sortKey` that drifts from what `load()` sends is the defect fixed in the generator on 2026-09-10.

**Passes, as of 2026-09-12.** It failed the last two when written and the repair
was an order rather than a redesign — settle the compiler question first — which
is what happened. The alternative considered and not taken was a `fli check`
rule refusing the dotted form: it would have widened the shoulder and recorded
the hole.

**Adjudications.** *Paved road vs. the workaround* is in tension and favors
building: two hand-fixes of one wiring is the measurement, and the road either
changes or the reason it does not is written down — this file is that writing
either way. *Batteries vs. smallness* passes: severable, one owner, one seam,
composed of public parts a page may decline. Preservation vs. evolution,
familiarity vs. precision and ergonomics vs. strictness are **not in tension**.

**Tier** (`PHILOSOPHY.md` § VII): assessment while proposed; the signature
becomes a ruling in `DECISIONS.md` when it lands; the shipped fact belongs in
sierra's `CLAUDE.md` and the bridge index.

**Tiebreak, six months out:** a developer who types one destructure predicts
more from less knowledge than one who must hold six seams — `useStore`,
`page.query` against `page.directives`, `directiveParams`, two-arg `goto` over a
stripped path, the bare `$:`, and three legal `orderBy` shapes.

---

## What is in, and what is deliberately not

**In:** the store subscription and its teardown, the URL round-trip in both
directions, the load and its re-run on navigation, the sort pair, the error, the
column and filter derivations, `omitted`, paging through `more()`.

**Out, named so the omission is a decision:**

- **the markup** — this is a controller and not a `<DataTable>`. Every app diverges exactly there: `example`'s customers page puts a Popover in a cell and a Drawer beside the table, its invoices page puts a Pill inside one. A component would grow a snippet per divergence; a controller grows nothing.
- **a default sort** — `example` invoices wants `-issuedAt` and the generated page wants whatever the URL says. It is one argument, not a policy.
- **anything the resource already answers** — `can()`, `conflict()`, `options()` are reached through the resource, not re-exported here.

## Order

1. ~~`FJS-1070` is ruled.~~ **Closed 2026-09-12.** No enforcer is needed.
2. The controller, with its sierra test driving a real navigation.
3. `core/crud-templates.js` becomes a consumer, the way it consumed `columns()`.
4. `example` invoices and `basecamp` deployments adopt it — **both**, because between them they take the ranking pinned and unaided, and one caller measures nothing.

## Relationship to the other files

- `tables-from-the-seed.md` — the file whose closing paragraph this is
- `forms-from-the-seed.md` — the sibling one surface over, and the shape to copy: `<Form>` is what this is to a table
- `IDEAS/overview.md` 1.1 — the row both belong to
