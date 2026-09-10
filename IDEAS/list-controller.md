---
id: list-controller
status: proposed
dated: 2026-09-10
---

# Idea — `resource.list()`: the layer above the table

**Status: PROPOSED and BLOCKED.** The design is settled by measurement rather
than by argument — the compiler decides the signature, not taste — and it cannot
land until `FJS-1070` is ruled, because the shape it would ship is the shape that
freezes. Claims here were read off the source and RUN on 2026-09-10; every
number below came from a probe, not from a reading. See `VERIFYING.md`.

The nine questions were answered before any code was written and are in
§ *The nine*, which is the unusual half of this file: two of them fail, and the
repair is an ORDER rather than a redesign.

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

## What the compiler decides, which is most of the design

The obvious signature — return an object, dot into it — does not work, and the
way it fails is worse than not working. Mounted in happy-dom over a real
controller reading a real `page` object, driven by a real navigation:

| binding site | `const list = users.list()` |
| --- | --- |
| `<Table sortKey={list.sortKey} />` | **live** — `pushProps` sits in a `createEffect`; it saw `-` then `total` |
| `{#each list.rows() as r}` | **live** — a thunk, re-invoked per pass |
| `<span data-sort={list.sortKey}>` | **frozen** |
| `{list.sortKey}` in text | **frozen** — emitted as `$$el0.nodeValue = …`, outside any effect |

A page over that controller is half live: the table moves and the sentence
beside it does not. Filed as `FJS-1070`.

Four shapes were then measured against the same driven navigation, and only one
survives:

| shape | text and attribute |
| --- | --- |
| `const list = …` → `{list.sortKeyProp}` (getter) | frozen |
| `const list = …` → `{list.sortKey()}` (method) | frozen |
| `let list = …` → `{list.sortKey}` | live |
| `const { sortKey } = users.list()` → `{sortKey()}` | **live** |

**A call of a bare local is tracked; a call of a member is not.** `let` is live
for the wrong reason — the binding is never reassigned, so the keyword is a lie
told to the analysis, and a design that depends on one is a design that breaks
when somebody tidies it.

So the signature is forced, and it is the idiom the file already uses one line
higher for `const { get: rows, unsubscribe } = useStore(users.store)`:

```mesa
const { rows, columns, cols, filters, search, value, apply, sortBy,
        sortKey, sortDir, omitted, error, destroy } = users.list()
$.onDestroy(destroy)
```

```mesa
<FilterBar {filters} {search} value={value()} onchange={apply} />
<Table columns={columns()} rows={rows()} sortKey={sortKey()} sortDir={sortDir()}
       onsort={sortBy} striped hover emptyText="Nothing here yet.">
```

Every name is a bare local and every read is a call, so there is no position in
a page that can freeze. **That property is the reason for the signature** — the
alternative reads better and is the one that breaks.

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
- **Failure proportional?** **No.** A one-keyword slip produces a half-live page, which is the maximum-confusion outcome.
- **Wrong with nothing saying so?** **Yes, three ways.** The dotted form freezes; a missing `watchPath` loads nothing and raises nothing; a `sortKey` that drifts from what `load()` sends is the defect just fixed in the generator.

**Fails the last two.** The repair is an order, not a redesign: `FJS-1070`
settled first removes the freezing hazard outright, and the remaining two are
each covered by a test that has to ship with the controller anyway. A
`fli check` rule refusing the dotted form is the other answer and is the worse
one — it widens the shoulder and records the hole.

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

1. **`FJS-1070` is ruled.** Blocking, and the ruling decides whether the controller needs an enforcer at all.
2. The controller, with its sierra test driving a real navigation.
3. `core/crud-templates.js` becomes a consumer, the way it consumed `columns()`.
4. `example` invoices and `basecamp` deployments adopt it — **both**, because between them they take the ranking pinned and unaided, and one caller measures nothing.

## Relationship to the other files

- `tables-from-the-seed.md` — the file whose closing paragraph this is
- `forms-from-the-seed.md` — the sibling one surface over, and the shape to copy: `<Form>` is what this is to a table
- `IDEAS/overview.md` 1.1 — the row both belong to
