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

**The evidence base widened the same day, and it moved three things** — a survey
of twenty list features in `my.maid.tech`, the first real application read
against this framework that was neither built on it nor a schema import. Paging
stops being a bullet and becomes the reason; *ergonomics vs. strictness* stops
being *not in tension*; and the four shapes a shared controller must not be bent
for are now named rather than imagined. § *The evidence base* carries it and the
answers below are dated where they moved.

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

## The evidence base

Three in-tree callers is a finding. Twenty is a requirements document, and it
came from `my.maid.tech` — a seven-year-old production app on the OLD
`@frontierjs/*` line, being converted, whose lists were written by people who
had no framework answer for any of this. Its `createResource` is CRUD only: a
store, a service, and nothing about filtering, sorting, paging or the URL. Every
list fills that gap by hand.

| | of 20 |
| --- | --- |
| have paging of any kind | **0** |
| write filter state to the URL | **1** |
| read the URL once at mount, then diverge permanently | 6 |
| are the same shape — `let search` → `$: query` → `debounce(find, 300)` → `onMount` | **13** |
| are one-offs that must not be forced into a shared controller | 4 |
| share any list-state abstraction | **0** |

Three of those rows change this design and each gets a section below. The other
three are the road's instrument reading. **Nobody finished the URL round-trip
twice over**: `core/params.js` holds a complete `createUrlParamsStore` with
`syncWithUrl` and `updateUrl`, commented out, its first line reading *this is an
experiment*; `core/router.js` holds a `cleanFilters` and a sync store, fully
written, entirely commented out. What survives instead is the hybrid — read the
query once at mount and never write back — which is the worst of the three
because a refresh loses the filters and the back button does nothing, and the
page looks correct the whole time. **Two search boxes are decorative**: groups
and webhooks have the search commented out of the query, so every keystroke
refetches identical rows, and three more features declare a `search` that is
never bound to anything.

## Paging is the reason, not an item in the list

`more()` and `hasMore()` already exist on the resource, already keyset rather
than offset, minted by the server and handed back verbatim, and documented
against the case this framework is best at and was worst for — a list being
written to while somebody reads it (`FJS-D145`).

**No page in either app calls either of them, and no list in `my.maid.tech` has
paging at all.** Every one of the twenty is a hard `$limit` between 100 and
1,000,000 with the rows past the ceiling silently invisible; the clients list
caps at 120 and there is no way to reach row 121. Six of them fetch `total`
purely to print a number on an export button.

So the mechanism is built, correct, and unreachable, because wiring it costs
more ceremony than anybody will pay for a button. That is the strongest
statement this file can make about why the layer belongs to the framework: the
alternative is not that pages do it worse, it is that pages do not do it.

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

## Where the state lives, which is a parameter and not a rule

The receipt above already carries the counterexample and the first draft of this
file did not act on it: `basecamp` deployments answers *no* to *is the URL the
state*, in its own words, because that list is read while a release is running
and a navigation would drop the live subscription under it. The survey turns
that from one dissenter into the majority — **nineteen of twenty are not
URL-bound**, and most of them cannot be: a list embedded in a detail screen is
not the page, so it may not own the page's address. Emails appear on seven
detail screens, notes on four, properties on seven, and none of the three has a
route of its own.

```mesa
notes.list()                                        // the URL is the state
notes.list({ state: 'local' })                      // embedded, or must not navigate
notes.list({ state: 'local', where: { clientId } }) // scoped by a parent
```

**Default `'url'`, and the default is the whole decision.** *Ergonomics vs.
strictness* resolves per-surface by what a mistake destroys, and the two
mistakes are not symmetrical: a route-level list wrongly left local loses its
filters on every refresh and answers the back button with nothing, which is the
six-of-twenty failure and is invisible until somebody complains. An embedded
list wrongly left on `'url'` writes to an address that is not its own and says
so on the first click. The cheaper mistake to make is the visible one, so the
silent one is what the default rules out.

A string of two values rather than a boolean, because a third is already
legible — a saved view, a stored segment — and a second flag beside a first is
how a shoulder widens. **`where` is applied OVER the caller's filters and is not
part of `query`**, so a bar can neither see it nor widen it — which is what makes
an embedded list scoped rather than merely pre-filtered.

**The debounce belongs here too.** Thirteen of the twenty hand-rolled
`debounce(find, 300)`, two wired it to a query that ignores it, and three
declared the variable and bound it to nothing. It is a tuning number rather than
a mode — `debounce:` to change it — and it applies to text-valued changes, since
a select that debounces is a control that feels broken.

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

- **Another origin of truth?** No, and it retires one — *how a list binds to its state* becomes one implementation instead of one per page.
- **Concept budget?** Shrinks, and pays for it once. One verb beside `columns()`, `filters()` and `load()`; no noun coined; a page goes from six concepts to one. *2026-09-12:* the one enlargement is `state:`, which is a choice a page genuinely has and nineteen of twenty real lists answer the non-default way.
- **Whose complexity?** The problem's. URL-as-state, a live store, keyset paging and schema-derived columns are each essential; re-assembling them per page is what we added. `state:` is the problem's too — an embedded list cannot own the page's address.
- **Predictability?** Improved for the road, worse for the deviation — mitigated because the escape is `load()` and its own markup, which already has a caller in `example/customers` and four more in the survey.
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
composed of public parts a page may decline. **Ergonomics vs. strictness moved
on 2026-09-12 and is now in tension**, on the `state:` default alone: it is
resolved per-surface by what a mistake destroys, and § *Where the state lives*
carries the answer — the default rules out the silent mistake and leaves the
visible one. Preservation vs. evolution and familiarity vs. precision are **not
in tension**; the seams below are this framework's own past and are governed by
the first of those, never the second.

**Tier** (`PHILOSOPHY.md` § VII): assessment while proposed; the signature
becomes a ruling in `DECISIONS.md` when it lands; the shipped fact belongs in
sierra's `CLAUDE.md` and the bridge index.

**Tiebreak, six months out:** a developer who types one call predicts more from
less knowledge than one who must hold six seams — `useStore`, `page.query`
against `page.directives`, `directiveParams`, two-arg `goto` over a stripped
path, the bare `$:`, and three legal `orderBy` shapes. Three of those six stop
existing with the seams below rather than being hidden by this file, which is
the better outcome and is why they go first.

---

## What is in, and what is deliberately not

**In:** the store subscription and its teardown, where the state lives and the
round-trip in both directions, the load and its re-run, the debounce, the
loading and error flags, and **paging through `more()`/`hasMore()`**.

`columns()` and `filters()` stay OUT and are called by the page beside this —
they are shipped verbs with a caller that wants no controller at all
(`basecamp` deployments), and folding them in would make this the only door to
something that already has one. The sort pair goes out with the second seam
below, and `value` with the third.

**Out, named so the omission is a decision:**

- **the markup** — this is a controller and not a `<DataTable>`. Every app diverges exactly there: `example`'s customers page puts a Popover in a cell and a Drawer beside the table, its invoices page puts a Pill inside one. The survey says it louder — properties toggles between a card grid and a table, pages renders its rows as a folder TREE, boards renders a kanban with drag-reorder, and tags renders three lists on one screen. A component would grow a snippet per divergence; a controller grows nothing.
- **a default sort as an ARGUMENT** — it is a fact about the model rather than the page, so it is declared once in the resource file (§ *What the resource file declares*) and a page states one only to differ.
- **anything the resource already answers** — `can()`, `conflict()`, `options()` are reached through the resource, not re-exported here.
- **the four shapes that are not lists**, named from the survey so that bending the controller toward one of them is a decision somebody has to argue rather than a drift: **tasks** filters and sorts entirely client-side over a fetched array, with bulk selection and a priority comparator; **pages** reshapes its rows into a tree and patches them from a socket; **employees** takes its rows out of JSON blobs inside unrelated records and groups them; **tags** has no route, mounts three times on one screen, and mutates the store through a binding. Each reaches `load()` and writes its own markup, which is what the escape is for.

## What the resource file declares

*Added 2026-09-12.* `example` invoices restates two things on its page that are
true of `Invoice` wherever it is listed: the six columns it shows and the order
`-issuedAt`. A customer's invoices tab would restate both. They belong beside the
model, and the resource file already holds two members of that family —
`detailQuery` is what `get(id)` asks for and `optionsQuery` what `getOptions()`
asks for. **`listQuery` is the third, and `columns:` defaults the verb of the
same name:**

```mesa
<script module>
  export const invoices = createResource('invoices', {
    listQuery: { directives: { orderBy: '-issuedAt' } },
    columns:   { only: ['number', 'status', 'customerId', 'total', 'issuedAt', 'dueAt'] },
  })
</script>
```

Three layers, the shape forms already have — **the schema ranks, the resource
file picks, the page overrides** — and a page's statement replaces the file's key
for key rather than merging inside one.

**`listQuery` reaches `list()` and nothing else.** Not a bare `find()`, not
`load()`. `detailQuery` may reach `get(id)` because a directive over one row
cannot hide a record; a filter over many can, and a default filter reaching
every `find()` narrows pickers, jobs and live stores with nothing saying so.

**Three places for the three kinds of flexibility, and all three already exist
or are this file:**

| the value is | where | example |
| --- | --- | --- |
| a fact, true of every list of this model | `listQuery` / `columns:`, static | `orderBy: '-issuedAt'` |
| computed, true of every READ of this model | `hooks.before.find`, already built | narrow to the session's workspace |
| derived from the page or a parent | the call | `invoices.list({ state: 'local', where: { customerId } })` |

**A function of the page in the resource file was considered and is not taken.**
The resource module is imported by every screen, picker and job, and a page is
one route's: `page.params.id` inside `Invoice.mesa` bakes a URL layout into the
model, and the second route mounting that list with different captures gets a
wrong list silently. It is also opaque — `crud-templates`, `fli check` and the
agent surface can read `{ orderBy: '-issuedAt' }` and cannot read a function
without calling it with an invented page. The flexibility it offered is the
table's middle row, which is a hook and has been one all along.

**The markup half stays the form.** A default `<Invoices />` list component
wants a second markup slot the language does not have, and lists diverge exactly
where markup is. Revisit once three adopters exist: if all three render the same
bar-table-pager shell, the component has earned its place.

The nine, for this addition: **no new origin** — it retires the per-screen
restatement; **no new concept** — the third member of a family; **the problem's
complexity** — a model has a natural order; **predictable** — `detailQuery`
teaches it; **stated once** and readable by generators, which is the case against
the function form; **one owner**, the resource layer, read by `list()` and
`columns()`; **tested** by a row asserting a bare `find()` ignores it beside
`list()` honoring it; **proportional** — a wrong default order is a visibly wrong
list; **wrong silently** only if it reached `find()`, which the scope rules out.
*Ergonomics vs. strictness* is the one adjudication in tension, over the function
form, and resolves by what a mistake destroys: the function's mistake is the
silent one.

## Three seams underneath, and why they come first

The generated page is not one problem. It is four seams that each lack an owner,
and only the fourth wants a controller — the other three are defects with an
owner already, they are independent of everything above, and **they pay a
hand-written page that declines the controller, which the controller cannot**.

| seam | owner today | fix |
| --- | --- | --- |
| a schema column against a table column | **nobody** — every page hand-maps `c.name` onto `key` | one spelling |
| an `orderBy` against a sort arrow | **nobody** — three hand copies, already drifted | `@frontierjs/toolbelt/directives`, and `<Table>` reads it |
| the URL against `(query, directives)` | **half** — the router splits inbound and nothing reassembles | the router |
| the list's own state machine | **nobody** | this file |

The order matters because the seams are *in* the controller's surface until they
are fixed underneath it:

| | controller first | seams first |
| --- | --- | --- |
| what a page destructures | `rows columns cols filters search value apply sortBy sortKey sortDir omitted error destroy` | `rows loading error apply more hasMore destroy` |

`sortKey` and `sortDir` exist only because `<Table>` cannot read an `orderBy`;
`value` exists only because the router hands back a split query and nothing puts
it together. Building the controller first makes all three permanent, and every
page that declines it goes on paying them — three legal `orderBy` shapes parsed
by hand, of which `basecamp` servers handles one and throws on the object form
`example` invoices sends.

**The first two are governed by *preservation vs. evolution*** — nothing here
has shipped to anyone, so a rename is a rename, no alias and no second name for
one thing. The `key` → `name` rename fails *failure proportional* on its own: a
page still saying `key` renders a table that looks correct with a dead sort
header, so it owes a `fli check` rule rather than a note.

## Order

1. ~~`FJS-1070` is ruled.~~ **Closed 2026-09-12.** No enforcer is needed.
2. ~~**The three seams**~~ **Done 2026-09-12** — `<Table>` columns say `name`, `<Table orderBy>` reads the directive through `orderByPair`, and the router owns the round-trip (`page.pathname` + `page.search`, `goto(path, query, { directives })`, `<FilterBar directives>` emitting both halves).
3. ~~The controller~~ **Built 2026-09-12**, with `listQuery` / `columns:` on `createResource` — `packages/sierra/src/junction/list.js`, driven through the real router and Junction's real client in both `state:` modes by `tests/resource-list.test.js`, 19 rows, every mutant tried reds at least one. **It is eleven names, not seven**, and the four are honest rather than drift: `query` and `directives` exist because a LOCAL list has no `page` to read them from, `sort` because `<Table onsort>` reports one ordering and not two halves, and `reload` because `stale` offers a reload and something has to answer it. Not yet proven: that dotted access to it stays live in a compiled `.mesa` page, which is what the first adopter asks.
4. ~~`core/crud-templates.js` becomes a consumer~~ **Done 2026-09-12.** The generated list page is one `list()` call, a bar and a table handed its halves, and a *Load more* — the first generated page that can reach row 21. `generated-mesa.test.js` pins it, and the `scaffold` CI phase builds a scaffolded model's page from packed tarballs.
5. ~~Three adopters, chosen to disagree~~ **All three landed 2026-09-12.**
   - **`example` invoices, `state: 'url'`, the set pinned** — landed. The six columns and `-issuedAt` moved into `resources/Invoice.mesa`, so the page restates neither. `verify` gained three rows that MOVE the list, which is the half a compiled page could get wrong while every static row passed: the default order marked with nothing on the URL, a header click that navigates and reorders, and Back restoring it. Removing `listQuery` reds all three; `verify` and `verify:build` are 66/66, so the dotted reads stay live in the minified build too.
   - **`basecamp` projects → environments, `state: 'local'` with a `where`** — landed, in place of an `example` screen: every embedded candidate there is a one-off (the variant grid loads availability beside its rows). The router remounts a leaf when its own params change, so a scope read once cannot outlive its project. `verify --reset` 322/322.
   - **`basecamp` deployments, `state: 'local'`, ranking unaided — `list({ composed: true })`.** `deployments.find` includes the app and the environment, and a live push carries the row alone; the store's `upsert` REPLACES a row, so held in the store the first step of a running release would blank both relation cells. Two answers were on the table — **re-read the window on a push**, or **merge the push over the held row** — and the re-read was chosen: the merge is free and goes stale in silence the day a push moves a key an include was read through (*ergonomics vs. strictness*: strictness follows cost). It is `record(id, { composed: true })` for a list. A composed list's rows are its own and never enter the store, since a node holding one screen's includes would hand them to every other list over the model; any announcement on the service or a reconnect is the trigger, a burst is one more read, and growing the window widens the limit rather than resuming from a cursor. `tests/resource-list.test.js` carries six rows for it, the push paired with a store-backed control that loses the relation; `basecamp`'s `verify` patches a release from the list page and asserts the row MOVES while the app cell keeps the name.
     **The gap it shares with `record()`**: nothing notices an author who omits the flag. The relation cell shows the id rather than a blank, which a person sees and nothing reports. A detector is decidable — a held row carrying a relation key the pushed row lacks — and is not built.

## Relationship to the other files

- `tables-from-the-seed.md` — the file whose closing paragraph this is
- `forms-from-the-seed.md` — the sibling one surface over, and the shape to copy: `<Form>` is what this is to a table
- `IDEAS/overview.md` 1.1 — the row both belong to
