---
id: tables-from-the-seed
status: shipped
dated: 2026-08-26
---

# Idea — The other three surfaces: a table, a detail view, a filter bar

**Status: BUILT — all three surfaces ship.** Every question is answered and
ruled (`FJS-D242`, `FJS-D243`, `FJS-D244`, `FJS-D246`, 2026-09-08): the table is
`columnList`, `displayFor` and its two registries, `<Cell>` and
`resource.columns()`; the detail view is `summary()` + `children()` over a
watched `record(id)`; the filter bar is `filterOpFor`, `resource.filters()`,
`registerFilterComponent` and `FilterBar.mesa`, with sortable headers beside it.
`crud-templates.js` consumes all of it and its hand-rolled `cell()` is deleted.
Four defects were found underneath and are closed: `FJS-1035`, `FJS-1036`,
`FJS-1037`, `FJS-1043`.

**One gap was an emit, not a design, and it is closed**: `FJS-1040` — `@@fts`
now reaches the browser as `x-search`, naming the columns `@@fts` covers.

Claims about current behavior were read off the source on 2026-08-26 and re-read
2026-09-08 with the files named. See `VERIFYING.md`.

**A second consumer arrived the same day** and is worth knowing about before the
filter bar is designed: `conversion-maid-tech.md` reads a real application whose
web surface is 292 route files, most of them a list, a detail and a filter bar
over one model. Every wire input these three surfaces need already reaches that
app's browser.

---

## Trigger

`IDEAS/overview.md` 1.1's remainder. The form half shipped 2026-08-15 with a
record behind it (`forms-from-the-seed.md`) and three feeder issues
(`FJS-077`, `FJS-078`, `FJS-079`) cleared first, which is why it landed
cleanly. **The other three surfaces have one prose sentence in the 1.1 row and
nothing else** — no argued record, no ids, no ruling. This file is that record.

---

## What already exists, so the work is composition

`sierra/src/junction/field-rules.js` is a leaf module with no Junction-client
import, so it runs in plain Node and can be compared against Junction's server
rules rather than copied. Twenty-four exports, and most of what these three
surfaces need is among them:

| Have | Answers |
| --- | --- |
| `formFieldList(fields, {only, except, model})` | narrowing and ordering, with a field it cannot place reported by name |
| `labelFieldInfo(fields, fallback, declared)` | which column identifies a row, and how sure it is (`declared` · `conventional` · `scan` · `fallback`) |
| `buildGate` + `canAtLevel(gate, op, level)` | which actions this caller may be offered |
| `buildTransitions` + `transitionsAt(spec, row, level)` | which moves *this row* offers, per row |
| `buildRelations` + `resource.options(fk)` | a foreign key renders a name rather than an id |
| `matchesQuery` + `comparatorFor(orderBy)` | a pushed row placed, or removed because it left the filter |
| `resource.stale` | the gap a removal leaves, and the rows a live list refused past page 1 |
| `more()` / `hasMore()` / `$after` | paging under a list being written to (`FJS-D145`) |
| `page.query` / `page.directives` | the filter state lives in its URL, split by the same module the bridge uses |
| `registerControl` / `registerFormControl` | the two-half extension pattern to copy verbatim (`FJS-D17`) |
| `x-sortable` / `x-filterable` | which header may offer a sort and which column a filter, answered from the two functions the Data boundary refuses with (`FJS-553`, `FJS-554`) |

On the wire, `x-gate`, `x-relations`, `x-label-field`, `x-labels`, `x-values`,
`x-transitions`, `x-money`, `x-scale`, `x-time`, `x-litestone-kind`, `x-sortable`
and `x-filterable` all reach the browser already and are read by nothing that
draws a row.

**`x-sortable` and `x-filterable` are emitted as EXCEPTIONS ONLY** — absent means
yes and a string says why not (`computed` · `transient` · `opaque` · `encrypted`),
because most columns are ordinary and this ships in a bundle whose size is already
an argument. A consumer reading either key truthily is wrong about every ordinary
column, which is the one way this input can be misused silently.

`Table.mesa` and `Pagination.mesa` are presentational and **should stay that
way** — they take the columns they are given. What is missing is the layer above
them, exactly as `<Form>` is the layer above nine controls.

## The receipt

`forms-from-the-seed.md` justified itself with a count: `orders/create.mesa` was
~150 lines, half of them a hand-rolled loop over `Object.entries(fields)`
deciding control-per-type. The equivalent count for this file is in the
generator itself.

`packages/cli/core/crud-templates.js` emits every generated list page, and it
carries a five-line renderer:

```js
function cell(record, name) {
  const v = record[name]
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean')        return v ? 'yes' : 'no'
  if (typeof v === 'object')         return JSON.stringify(v)
  return String(v)
}
```

It knows nothing about `@money` (so a price stored as minor units renders as
`1299`, which is wrong in the way that looks right), nothing about `x-time`,
nothing about a relation, an enum's `@label`, or a `File`. Every generated page
gets a copy. Its own comment names the shapes it is patching around — *a boolean
as `true`, a Json column as `[object Object]`* — which is a renderer being
written by hand at the one place that should not have to.

And its column choice, in the derived mode, is `.slice(0, 5)` over
`Object.keys(res.fields)`, described in the file as *"the one choice in this
file that is not a consequence of the schema"*. That description is honest and
it is the thing to fix.

---

## Question 1 — `displayFor` is the mirror of `controlFor`, and it is a second registry

**A control renders a value for EDITING; a column renders it for READING, and
they are not the same function.** The distinction is already recorded in
`controlFor` itself, which refuses a `readOnly` column and says why:

> *A read-only value shown on a form is a detail renderer wearing a control's
> clothes, and it wants the surface that does not exist yet rather than this
> one.*

So the surface has already been named from the inside. What it must answer, all
of it declared and none of it currently read:

- `@money` → `formatMoney` from `@frontierjs/toolbelt/units`, which already
  derives the scale from the currency rather than assuming two places
- `x-time` → an instant or a wall clock, and which zone resolved it
  (`FJS-D143`)
- a relation → the related row's `labelField`, which `resource.options()`
  already resolves for pickers
- an enum → its `@label`, not its member name
- a `File` → a thumbnail, or a name and a size
- a `Json` column → the folding viewer `@frontierjs/ui` already ships
- a boolean → yes/no; `null` → an em dash rather than an empty cell

**Two halves, for `FJS-D17`'s reason unchanged**: `registerDisplay(name,
resolve)` in sierra, because the naming side must run in plain Node, and
`registerDisplayComponent(name, Component)` in the kit, because the rendering
side may not import sierra. Last registered asked first, so an app beats the kit
it imported.

**The rule to carry over is the reporting one.** A field `displayFor` cannot
render answers `display: null` **with a reason**, exactly as `controlFor` does —
never dropped. Filtering it out would reproduce, inside the generator, the bug
the generator exists to end: a column added to `.lite` that does not appear and
nothing says so.

This is the largest of the three pieces and the other two compose it.

### Answered — the mirror stands, and the reason is that the naming rule inverts

**The cheaper shape was priced first and it does not work.** One registry with a
mode on the component — a control that also renders read-only — fails on the
input rather than on taste: `controlFor` answers `{ control: null, reason:
'readOnly' }` for `@system`, `@computed`, `@generated`, `@from` and `@version`,
and never offers those columns to the registry at all, because *a control is a
thing that writes and the Data boundary refuses this column by name*. A table
wants exactly those columns most. **The two resolvers disagree at their first
branch, so they are two resolvers**; and where they agree they agree on a NAME,
which is the only thing that has to cross.

Which also settles the second cheap shape: one resolver, two component slots.
The naming side is where the divergence is, so sharing it is sharing the half
that differs and doubling the half that does not.

So: `registerDisplay(name, resolve)` in sierra and
`registerDisplayComponent(name, Component)` in the kit, the same two halves for
`FJS-D17`'s reason unchanged, last registered asked first. **The symmetry is the
argument** — the six-months-out tiebreak is a developer who learned the control
pattern once and can predict the display pattern without reading anything, which
a third spelling (`registerControlPair`, a `readonly:` option) spends for nothing.

**The deliverable includes a deletion, and without it the feature is not done.**
`crud-templates.js`'s five-line `cell()` is the second renderer, and two
renderers is how `@money` goes on being rendered as `1299` in one of them. One
owner or it comes back.

**What makes it visible when it is wrong**, because this whole class fails
quietly — a price that reads as a plausible number, a timestamp in the wrong
zone, an enum member instead of its label. Three artefacts, none optional:
`display: null` carries a reason and is never dropped; a `fli check` rule over an
app for a hand-rolled cell renderer, which is `detail-read-dead`'s shape one
surface along; and the drive assertion that reads a `@money` cell in dollars and
asks the DATABASE what it stored — the read direction of the one `example`
already makes for forms.

*Nine questions, answered before the first edit; § IV's adjudication in tension
is **coherence vs. convention** — a second registry enlarges the concept budget,
and it is paid for by the vocabulary being the one already learned rather than a
near-miss of it. Tier: Assessment; the ruling is owed a `DECISIONS.md` entry when
the two functions land.*

### Built — `displayFor`, and the walk both registries now share

`displayFor(rule, ctx)` in `field-rules.js`, `registerDisplay` /
`unregisterDisplay` / `registeredDisplays` beside the control trio, and
`defaultDisplayFor` for a resolver that wants to add to an answer rather than
restate it. In the kit: `registerDisplayComponent` in `controls.js` and
`Cell.mesa`, which is `FormField.mesa` one surface along.

**The registry WALK is one function now, not two.** The control half and the
display half differ only in which map they read and which key names the answer,
so copying it would have put the decline rule, the throw guard and the `by`
stamp in two places — three rules whose whole value is being the same for both.
`_askRegistry(entries, rule, ctx, { noun, key })`; the control path is a
one-line caller of it and its 53 existing cases pass unchanged.

**Every answer is read off the DECLARATION, and each case is one where the JS
type gives a plausible wrong answer rather than an obviously wrong one** — which
is why the five-line renderer this replaces looked correct for years. `@money`
and a count are both integers; a bound enum's `@label` against its member name;
a foreign key against the id it holds; a `DateTime` against a string that cannot
say whether it is an instant or a wall clock; `Json`, which arrives as
`{ type: null }` rather than `object` and which the control table already
carries a comment about.

Fourteen cases in `tests/display-for.test.js`. The one that states the design is
a PAIR on one column: `lines` is `@computed`, so `controlFor` answers
`{ control: null, reason: 'readOnly' }` and `displayFor` answers `number` —
either assertion alone is satisfied by a table that says the same thing about
everything. Measured against stubs: removing the money branch reds 5, ignoring
`@label` 1, skipping the registry 3, removing the relation branch 1.

`resource.columns()` resolves the renderer WITH the column rather than leaving
it to the caller, for `formFields()`' reason: the model name has to travel so a
registration can claim `Order.total` rather than every money column in the app,
and a caller assembling that context by hand is one who can get it wrong on one
screen out of six.

## Question 2 — a column list selects on a different rule from a field list

`formFieldList` cannot be reused, and the reason is a rule rather than a detail.
**A form shows what is WRITABLE. A table shows what is READABLE and
IDENTIFYING**, and the two sets differ at both ends:

- `@system`, `@computed`, `@generated`, `@from` and `@version` are `readOnly`,
  so they are absent from a form **by rule** — and a server-written status or a
  computed total is among the columns a table most wants.
- `@guarded` is absent from both, and `@encrypted` is absent from a table for a
  different reason than it is absent from a form.
- **Quantity is the other half.** A form showing every writable column is
  right; a table showing forty columns is not a table. So a column list needs an
  input a field list never needed: *which few columns identify this row to a
  person.*

`@@label(field)` answers that for exactly one column and pickers already read
it. Nothing answers it for a set.

**The open question is whether the seed says more.** Against: the seed is the
Data realm and a column order is presentation, which is the argument that keeps
`.lite` small. For: `.slice(0, 5)` is presentation being decided by *the order
columns happen to sit in a file people reorder for unrelated reasons*, which is
presentation being decided badly and invisibly. A third answer worth pricing is
that the heuristic stays and is made explicit and overridable, with the
generator emitting it as a named list rather than a slice — the same move
`crud-templates.js` already offers as its non-derived mode.

Rule this before the table is written. It decides whether `columnList()` takes
its answer from the schema or from its caller, and that is its signature.

### Answered — the caller answers, over a derived default that is a stated rule

**Decided by counting readers rather than by taste.** A person-facing column
*set* is chosen in exactly one place in this tree: `crud-templates.js`'s
`.slice(0, 5)`. `@@label` answers the singular question and has readers in six
modules; Studio's row browser shows every column; `@@export` declares its own.
**One reader is a caller argument, not a declaration** — a keyword serving a
single consumer is an origin of truth bought for nothing, and the seed is the
Data realm.

So `columnList(fields, { only, except, model, limit })` answers
`{ columns, omitted: [{ name, reason }] }`, the generator writes the derived
answer into the file a person edits as a named list, and the derivation is a
**stated ranking rather than file order**: the label field, then a column that
identifies, then a bound enum, then money and time, then the rest, capped.
`.slice(0, 5)` is presentation decided by the order columns happen to sit in a
file people reorder for unrelated reasons; a ranking is presentation decided
where it can be read and argued with.

**What reopens this is a second reader, and the file names the candidates in
advance** so the count is checked rather than remembered: a detail-view summary
line, a picker's subtitle, a ⌘K result row, an audit-trail row. Two of those
wanting the same list makes it a fact with many possible answers that must have
one, and it is then spelled `@@label([a, b, c])` — the existing noun widened,
never a second one beside it.

**One input the ranking needs is not on the wire**, and the seed turned out to
have already answered it. Addendum below.

**The reporting rule is `controlFor`'s and is not optional here.** A column the
ranking leaves out is returned in `omitted` with a reason. Filtering it away
silently would reproduce inside the generator the bug the generator exists to
end: a column added to `.lite` that does not appear, and nothing says so.

*Nine questions, answered before the first edit; § IV's adjudication in tension
is **paved road vs. the workaround** — the derived default is the road and
`only`/`except` is the shoulder, instrumented by `omitted` rather than silent.
Tier: this is an Assessment and the ruling that binds is owed a `DECISIONS.md`
entry when the signature lands.*

### Built — `columnList`, and the mode gap underneath it

`columnList(fields, { only, except, limit, identify, label })` in
`field-rules.js`, answering `{ columns, omitted }`. Five tiers — `label` ·
`identify` · `state` · `quantity` · `rest` — declaration order breaking a tie
WITHIN a tier and never across one, `only` bypassing the ranking with its own
order, and every field not returned named in `omitted` with a reason.

**The label tier refuses `labelFieldInfo`'s `scan` answer**, which is the first
plain string column: taking it would be the arbitrariness this function
replaces, one guess further down. `declared` and `conventional` are answers;
the tier is simply empty otherwise.

**What it is worth is visible against the slice it replaces**, and the
row-tenancy case is the one that carries it:

```
Server    ranked : name[label] slug[identify] status[state] role[state] …
          slice  : workspaceId name slug status role
Domain    ranked : hostname[identify] workspaceId[rest] appId[rest] …
          slice  : workspaceId appId hostname isPrimary redirectTo
```

Every generated table in a row-tenant app led with the tenant column, which
holds the same value in every row on screen. Ten cases in
`tests/column-list.test.js`; measured against stubs, removing the rank sort reds
2, the identify tier 2, the `only` path 3, and the over-limit reporting 1.

**Building it found the next gap, and it is now closed.** The browser was
handed `generateJsonSchema(schema)` at its DEFAULT mode,
which is `create`, plus an update PATCH (`diffSchemaModes`, `FJS-807`) — two
tables, no read mode. In create mode a `@computed` column is **absent
entirely** rather than present-and-`readOnly`:

```
create  s(ro) name
full    id n(ro) s(ro) name
```

So *a computed total is among the columns a table most wants* — this file's own
example of what separates a column list from a field list — **reached no browser
at all**, and neither did `id`. `columnList` shows every read-only column its
rule map holds; the map did not hold these.

**Answered by measuring, which reversed the assumption.** The reason to hesitate
was `FJS-785`, the bundle: a second copy of the `$defs` is +7 KB gzipped on
`example`. But a mode ships as a DELTA, and the read delta is **cheaper than the
update delta already shipping** — 640 bytes gzipped against 1361 on `example`,
485 against 517 on basecamp. The argument that kept mode two a patch does not
reach mode three at all.

**Built as a third table**, matching what is there rather than reopening it for
tidiness: `_readModels` beside `_models` and `_updateModels`, `readSchemaFor()`
beside `updateSchemaFor()`, a fourth argument to `registerSchemas` that degrades
to the create table exactly as the third one does. `diffSchemaModes` and
`applySchemaModePatch` were already general and took it unchanged.

**The resource hands the right table out rather than letting a caller ask**, and
that is the half worth the words: `resource.columns()` reads the READ rules
where `formFields()` reads the create ones. The failure it prevents is silent in
the direction nobody checks — a table handed the write table ranks a model that
appears to have no computed columns and renders a screen that looks finished.

**Read is not a superset of create**, which is why it is a third table and not a
replacement: a `@transient` column — written once, never read back — is in both
write modes and in neither display list. Four cases in
`tests/resource-schema-modes.test.js`, including the pair that is the whole
point: one resource, `lines` absent from `formFields()` and present in
`columns()`, plus the patch round-trip asserted over both real apps. Measured
against stubs: ignoring the read patch reds 2, pointing `columns()` at the write
table reds 2.

### Addendum — the identifying tier, and the fact the seed already carries

Uniqueness reaches no browser: there is no `x-unique` among the emitted keys.
The obvious repair is a boolean per field, and **it is wrong in half of the
apps in this repo**, silently. `example` runs `strategy database`, so its
business keys are single-column — `sku`, `reference`, `code`, `email`.
`basecamp` runs row tenancy, and nearly every key a person recognizes is
`@@unique([workspaceId, name])` · `([workspaceId, slug])` ·
`([workspaceId, email])`. A boolean marks three columns in one app and
**nothing at all** in the other, and a ranking that finds no identifying column
does not fail — it falls through to the next tier.

**The seed already draws this distinction and already computes the subtraction.**
`@unique(global)` and `@@unique([…], global: true)` are the declaration for
*unique across the installation rather than within a tenant*, and the parser
grades every other unique against a transitive fixpoint:

```js
const perTenant = (cols) =>
  cols.includes(t.column) || cols.some(c => scopedSet.has(fks.get(c)))
```

`[serverId, name]` is per-tenant because a `Server` is, and a grandchild
resolves for free. Measured where it is written, against basecamp: **12 of 23
name the tenant column, 10 reach a scoped parent, and the last is a `@guarded`
token that is global on purpose** — which is why the naive rule was rejected
there too, for the same reason it is rejected here.

So *which columns identify a row to a person* is **a unique tuple minus its
scoping members**, and that is a fact this repo computes today for a different
purpose. Deriving it a second time in the browser — a tuple emitted raw, and a
member discounted for being a foreign key — reads the same question off a
different input: `fkColumnsOf` walks `@relation(fields:)` where the browser's
`x-relations` is built elsewhere, so the two disagree wherever they are built
differently. Two origins for one fact, which is the first of the nine.

**So the emit is the ANSWER rather than its inputs**: `x-identify`, per model,
the columns already subtracted — `["sku"]`, `["name"]` — beside `x-label-field`,
which is the same shape for the singular question and has the same consumer.
It clears Q2's reader test at two: the ranking's identifying tier, and a filter
bar deciding which column deserves an equals box rather than a LIKE.

**Two shapes exclude themselves and neither is a judgement call**, which is what
makes the emit small: a `partialUnique` is a separate node kind whose predicate
says only SOME rows are constrained, and `nullsDistinct: true` says the tuple is
merely unique when present — the parser refuses those two together rather than
ranking them, so neither identifies a row and each is one line.

**Building it removed the last piece of the plan.** The intent was for the
parser to record its fixpoint, since `scopedSet` is local to validate and thrown
away. It is not needed: **subtracting every foreign key subsumes the fixpoint**,
because the tenant column's own relation and every scoped parent above it are
foreign keys already — `[serverId, name]` loses `serverId` for being a key, not
for a Server being scoped. The fixpoint answers *is this tuple per-tenant*,
which is the warning's question; this one asks *which members identify*, and
never needs the first answered. So `identifyingKeysFor` is a pure function over
one model and the tenancy block, the parser is untouched, and the tenancy
analysis keeps its single reader.

Shipped as `identifyingKeysFor` in `core/query.js`, beside `sortableKeysFor` and
`filterableKeysFor` — the same shape and the same consumer — emitted as
`x-identify` beside `x-label-field`, and only where there is one. Measured
across both apps: **20 of `example`'s 42 models and 23 of `basecamp`'s 50**, and
the two answer in the shapes the argument predicted — `sku` · `reference` ·
`code` where tenancy is a database, `slug` · `name` · `hostname` where it is a
row. Nine cases in `test/identifying-keys.test.ts`, every exclusion paired with
a column of the same model that survives it; measured against stubs, removing
the foreign-key subtraction reds 2, the exclusion set 3, and the
partial/`nullsDistinct` split 3.

## Built — the generator, and the renderer that is now deleted

`crud-templates.js`'s list page asks `resource.columns()`. **The five-line
`cell()` is gone**, and with it the `.slice(0, 5)` and the second column mode:
what were two branches — derive at runtime, or name the columns at generate time
— are one path, because both were a judgement being made in the wrong place. The
generate-time list froze the columns at the moment the file was written; the
slice led every row-tenant table with the tenant column.

`only` remains as the pinning escape and the page says so, which is the same
shoulder `columnList` already offered.

**A column header now comes from the seed.** `columnLabel(name, rule)` puts
`@label` on the entry — `Discount amount`, `Shipping cost`, `Provider
reference` — and humanizes the name otherwise. It is not `fieldLabel`, which
answers the same question for a validation MESSAGE and wants the bare column
name: *placedAt must be a string* is a sentence about a field a caller sent, and
a header is a word a person reads.

Proven where the generator can be: `fli admin:generate` over `example` writes 98
files, `fli check` reports nothing on them, and all 98 compile clean and emit
JavaScript that parses (Invariant 15). `tests/generated-mesa.test.js` gained the
two shapes that were not covered — the ranked default and a pinned `only` — plus
the admin variant with its gate notice and per-row delete, which nothing had ever
compiled.

**Two of the three artefacts Question 1 called for are still owed**, and they
are what would make this provable rather than merely working: a `fli check` rule
over an app for a hand-rolled cell renderer, and a drive assertion that reads a
`@money` cell in dollars and asks the DATABASE what it stored. The third —
`display: null` carrying a reason and never being dropped — is built and tested.
No drive covers a generated admin route, which is why the second one is not
free.

## Built — the prep Question 3 turned out to need

The record said *a generated detail view must not be the seventeenth*. It
already was, and every generated detail page in the repo was one:
`editPage` emitted

    orders.service.get(id)
      .then(row => { record = row })

which is exactly `FJS-533`'s shape — a plain object no WS push, job or other tab
can reach. One `fli admin:generate` over `example` wrote 32 of them.

**And `fli check` was silent on it.** `detail-read-dead` matches `NAME =
…service.get(…)` on the line, walking at most three lines BACKWARD for the
wrapped ternary a person writes. The assignment here is forward, inside the
callback that resolves the call, so the rule never saw the one spelling a
GENERATOR reaches for — the worst place for a blind spot, since a hand-written
screen is one screen and a generated one is every screen.

Both fixed, and in that order so the second is proved by the first: the rule
gained a bounded forward walk over a `.then`/`.catch`/`.finally` continuation,
fired on the generated tree at **32 findings**, and then the generator moved to
`record(id)` + `subscribe` + `release` and the same rule went to **0** with
nothing about it changed.

**The forward walk's first draft was too loose and its own control caught it.**
Accepting any line holding an arrow reported `total` for a
`lines.forEach(x => { total = … })` sitting three lines under an unrelated
one-shot read. The line must CONTINUE the call — a leading `.then` and nothing
else. Three cases in `tests/checks.test.js`, two of them controls: a `.then`
that acts on the row rather than parking it, and the unrelated assignment. Both
halves are load-bearing — removing the forward walk reds 1, removing the
continuation guard reds 1.

## Question 3 — what a detail view IS

**ANSWERED AND BUILT.** The four below are ruled at the end of this section.

**A form is a model. A detail view is a model plus its relations**, and nothing
here said how far that goes:

- how deep — one level of relation, or the graph
- whether a child collection is a nested table, a link, or a count
- what happens to a relation the caller's gate refuses: hidden, or shown empty.
  `x-gate` is an affordance and the server enforces regardless, so both are
  legal and they read very differently
- whether the detail view and the edit form are one screen with a mode, or two

### Answered — the 80% of it, and what was deliberately left

**How deep: one level.** The graph is a screen designer's call and `record(id,
{ composed: true })` already covers a `get()` that answers more than the row
(`FJS-D161`). Nothing here walks it.

**A child collection is a LINK, not a nested table.** A nested table is the
richer answer and it is a judgement per screen — how many rows, which columns,
what it does when there are four hundred. A link is right without knowing the
model, and it costs no second query on a page nobody asked one of.
`resource.children()` resolves each one: a `hasMany` names the child model and
carries NO key, because the key is a column on the child, so the child's own
schema is asked for the `belongsTo` pointing back — matched by MODEL rather than
by name, since a child may call the relation anything and two children of one
parent is ordinary.

**A relation with nowhere to point is reported, not skipped** — the case a
generated admin meets first is a child model with no service, which is
registered nowhere. Silence there is a collection missing from a screen with
nothing said.

**Detail and edit are one screen**, which they already were, and the read mode
is what makes that honest: the columns a form refuses now have a surface above
it rather than being absent from the app.

**What the form cannot show is the biggest half of it.** `resource.summary()` is
every column `formFields()` offers no control for — a `@computed` total, a
`@generated` name, a `@system` timestamp, the `@version`. **Defined against the
form rather than restated**, so the two cannot drift, and asserted as a
PARTITION: every column is in one list or the other and never both. The
discriminator is `f.control` and not `f.name`, because a `@system` column IS in
the form's field list carrying `{ control: null, reason: 'readOnly' }` — the
list reports a field it cannot place rather than dropping it — and excluding by
name would take that column out of both lists and lose it from every screen.

**A filtered list is a URL** (Invariant 10). The generated list reads
`page.query` and `page.directives`, so a child link IS the filter — copied,
bookmarked, survived by the back button — and the filter bar, the third surface,
now has its state in the one place both boundaries already read.

The route a child lives on is the one thing a page cannot derive: the child
knows its model and its key, and only the command writing the folders knows
where they went. So `admin:generate` writes `_routes.js` once and every detail
page imports it — **thirty-two inlined copies of one map is the same
written-twice failure `crud-templates.js` exists to end**, and a single-model
regeneration would leave thirty-one of them stale.

### The rule it inherits

It also inherits a rule that only became statable this week: **a detail screen
KEEPS a row, so it must watch one.** `resource.record(id)` exists now and
`detail-read-dead` (`fli check`'s 29th rule) found sixteen screens across
`example` and basecamp holding a plain object from `service.get()` that no write
can ever reach (`FJS-533`). A generated detail view must not be the seventeenth.

---

## Question 4 — the filter bar

Named in this file's title and never argued, because the table had to exist
first. It does now, and so does most of what the bar needs.

**What is already true**, measured 2026-09-08 rather than assumed:

| Have | Answers |
| --- | --- |
| `$limit` · `$offset` · `$after` · `$orderBy` · `$search` · `$withDeleted` | every control a bar offers has a `$` key already, in one table both boundaries read (Invariant 10) |
| a generated list reading `page.query` / `page.directives` | the state is in the URL, so a filtered list is a link |
| `x-filterable` · `x-sortable` | which column may be offered, and with which reason when it may not |
| `matchesQuery` | grades **the same operator set** the boundary compiles, so a row that leaves a filter already leaves a live list — nothing to build |
| `Table.mesa`'s `sortable` / `sortKey` / `sortDir` / `onsort` | a sortable header is wiring, not a component |

### Answered — a filter is a SECOND BINDING on `displayFor`'s names, not a third resolver

The obvious shape is the mirror of `FJS-D242` one surface along: `filterFor`,
`registerFilter`, `registerFilterComponent`. **It fails on *can this be derived
instead of restated*, and the measurement is what says so.**

Deriving from `controlFor` is impossible and structurally so — `346` filterable
columns in `example` and `482` in basecamp, of which **61 and 32 answer
`control: null` for being read-only**. Those are precisely what an operator
filters by: `variantCount`, `priceFrom`, `onHand`, every foreign key, the
`@version`. A control refuses them BY RULE and never offers them to a registry,
so no registration patches it.

**Deriving from `displayFor` works, because it refuses nothing for being
read-only and its names already partition the filter space:**

| display | operator | what it renders as |
| --- | --- | --- |
| `text` | `contains` | a text box |
| `number` · `money` · `scale` · `time` | `gte` + `lte` | a range |
| `enum` · `relation` | `in` | a multi-select, a picker |
| `boolean` | `equals` | any · yes · no |
| `list` | `hasSome` | a multi-select |
| `json` · `file` | — | no filter, with a reason |

Same NAME, different COMPONENT. So the addition is `filterOpFor(display)` — one
table, display name → operator — plus `registerFilterComponent(name, Component)`
in the kit, and **no third resolver**. A column has ONE kind, named once, and an
app that registers a display name gets no filter until it binds a filter
component for that name too, which is correct and symmetric.

*§ IV's adjudication in tension is **coherence vs. convention**: convention says
a developer who learned control-then-display expects filter as a third peer, and
coherence says a column has one kind. Coherence, and the six-months-out tiebreak
agrees — predicting `registerFilterComponent('money', …)` from
`registerDisplayComponent('money', …)` needs less knowledge than a third
resolver contract. Nine questions answered before any code; the proposal that
failed two of them was changed rather than the answers.*

### The seam that can be wrong with nothing saying so

**The operator table and the Data boundary's refusals are two statements of one
rule.** `$checkWhere` refuses a TEXT operator on a column that does not hold
text — BY NAME, which is the good direction — so a bar deriving `contains` for a
kind the boundary refuses offers a filter that 400s. One owner, or the two are
asserted against each other: every display name's operator, run through
`$checkWhere` for a column of that kind.

The worse half is quieter. A refused operator is a visible 400; a **legal but
wrong** one is not. `equals` where `contains` was meant returns a smaller answer
that looks like a real one, which is the failure this file has met at every
surface so far.

### Two more that decide behavior rather than a signature

**A cleared filter is an ABSENT parameter, not an empty one.** `?status=` is a
filter FOR the empty string and `@frontierjs/toolbelt/query` will faithfully
deliver it. The bar deletes the key. Nothing about this is visible until
somebody clears a filter and gets an empty table.

**A filter change RESETS paging.** Page 3 of a different question is not page 3,
so `$offset` and `$after` go when the filters move — otherwise the first thing
anybody does is filter from page 2 and see nothing.

### What the 80% is, and what is deliberately not in it

**In:** sortable headers, the bar over the same ranked columns the table already
shows, one derived operator each, clear-by-removal, paging reset, all of it in
the URL.

**Out, and named so the omission is a decision rather than an oversight:**

- **a per-column operator dropdown** — the enterprise-admin move that doubles
  the surface for the 20%, and is what `only` and a registered filter component
  are for
- **saved views** — a URL already is one
- **relation filters beyond the id** — the picker's rows have to be loaded, and
  a foreign key filters as an id today
- **AND/OR trees** — the boundary takes the shape; the UI over it is a product

### Built

`filterOpFor(display)` in `field-rules.js` — one table, no third resolver —
`registerFilterComponent` in `@frontierjs/ui/controls`, `FilterBar.mesa`, and
`resource.filters()`, which asks `x-filterable` whether the boundary will take a
`where` at all before asking the table what to ask with. Ranked and labelled by
`columns()`, so the bar offers filters over the columns the table shows.

**The seam is graded by an ORACLE rather than restated.** The table and
`buildWhere` are two statements of one rule, so `tests/filter-operators-real.mjs`
puts every operator the table hands out to a REAL Litestone client over a column
of that kind, and asserts every kind it refuses is refused by the boundary in
the boundary's OWN words. It runs under bun beside `static-safety-real.mjs` and
for that file's reason: Litestone imports `bun:sqlite` and this package's suite
is Node, and a fake boundary here would agree with whatever the table says,
which is the entire thing under test. 12 rows; mutating `text` to `equals` reds
1, `json` to `contains` 1, `list` to `contains` 2.

**Sortable headers came with it, and carried a defect worth naming.**
`Table.mesa` already had `sortable`/`sortKey`/`sortDir`/`onsort`, so a header was
wiring — but `x-sortable` was not in `_CARRIED`, so it never reached a rule and
`!rule['x-sortable']` answered TRUE for every column including the ones the
boundary throws on. The exception-only emit is what makes that shape of bug
invisible: absent reads as permitted. Both keys are carried now, and sortability
travels ON the column entry with `sortRefusal` beside it, so a page never
re-reads the rule and gets the polarity backwards. Filed as **`FJS-1043`**,
closed, since neither key had ever had a consumer and so nothing could have
failed.

The ruling is **`FJS-D246`**.

### Built — the search box, and the polarity nobody had written down

**`FJS-1040` is closed.** `x-search` on the model names the columns `@@fts`
indexes; `resource.filters()` answers it beside the column filters, refused with
a reason rather than `null`; `FilterBar.mesa` draws a box only where the fields
are there. It was filed as *one emit, no design question* and there was one in
it after all: the `x-` keys come in **two polarities** and nothing said so.
`x-sortable` and `x-filterable` are REFUSALS, where absent means permitted;
`x-label-field`, `x-identify`, `x-gate` and this are FACTS, where absent means
there is none. Reading one family by the other's rule is silent in both
directions and wrong about every ordinary column, which is the corpus any test
would use — `FJS-1043` was exactly that mistake. Ruled `FJS-D249`, which is also
why the name is not `x-searchable`.

**Two defects came out from under it, and both had shipped green here.**
`FJS-1046` — every built-in branch of `FilterBar` passed `onvalue` to controls
that have no such prop, so the whole bar rendered and wrote nothing; `onvalue` is
`FormField.mesa`'s own vocabulary and that file translates it per control. It
survived because nothing had ever pressed a key: the drive had opened 70 of 72
components and this was one of the two. `FJS-1047` — a generated list handed its
bar `page.query`, which by construction holds no directive, so sorting a column
and then typing in a filter dropped the sort.

**The `$` table writes now as well as reads.** A page cannot rebuild the URL's
query without both directions, and junction's client already held a
field-by-field copy of the write half. `directiveParams` is beside
`parseDirectives` in the owner, off the same rows.

### Built — the header and the box, side by side

**`FJS-1044` is closed and it is `search()` that changed.** Of the three answers
— refuse the pair, honor the order, disable a control — only the middle one
survived the questions. Refusing sends every caller to *fetch all and sort in
JS*, which cannot page: a workaround the road would be creating. Doing it in the
bar leaves HTTP, WS and every service caller silently wrong, and the Data
boundary owns what a read does.

The doctrine that looked like it forbade this does not. `query.js`'s *an `@@fts`
`$search` filters and cannot be ordered by* sits in a paragraph about which KEYS
a caller may name — `$search` is not a sortable key, which is silent on ordering
a result SET. That citation was mine, in the issue, and it was wrong.

**Paging MOVES rather than the sort being applied to a page.** By relevance it
stays on the FTS index, where rank lives and a LIMIT lets SQLite stop early;
under a caller's order it moves to the base table, because ordering in step 1
would need a join in which an unqualified column is ambiguous — the fts table
carries columns of the same NAMES as the indexed ones. Materializing the match
set is the cost of the request: nothing can page a base-column order without
knowing what matched.

**The reason it could happen was the shape of the verb.** `search` is the only
read whose options are not the first argument, so it cannot go through the
generic wrapper and its guards were a hand copy — `checkOrderBy` was never added
to the copy, and `select` had been forgotten there once already (`FJS-601`).
Both take one sequence now, so this cannot recur by omission.

---

## Built — the first two APP callers, and the four defects they found

Everything above shipped with its callers being the GENERATOR and the kit's own
fixtures. That is the arrangement this repo keeps paying for, and it paid again:
pointing two real screens at the surfaces found four defects in a day.

**`example/web/src/routes/invoices/index.mesa`** names its six columns with
`only:` — the escape hatch, because `Invoice` declares three money columns and
five timestamps and the tiers fill with `subtotal` and `tax` ahead of the day a
document was due. **`packages/basecamp/web/src/routes/deployments/index.mesa`**
takes the ranking unaided. Between them both halves have a caller, and that is
an instrument rather than a coincidence: *paved road vs. the workaround* says
the same escape used in the same place over and over is a measurement of the
road, so one use is a choice and two would have been a finding.

The four are `FJS-1054` (a tenancy stamp ranked like an ordinary column),
`FJS-1055` (the `quantity` tier read `x-time` and so caught almost no time),
`FJS-1056` (a relation's header was the one lowercase one) and `FJS-1057` (the
display registry's naming half was never exported, which is why it had zero app
callers) — plus `FJS-1058` in the kit, where no control the bar renders had an
accessible name.

**Which app found which is the part worth keeping.** Three of the five are
visible in either; two are not. A tenancy stamp only exists under
`strategy row`, so `example` cannot see `FJS-1054` at all. An unnamed control
only fails where something audits, and only basecamp does. The surfaces were
correct against every question their own package knew how to ask.

## Landed since this file was written

Two inputs the browser needed and did not get. Both were one emit each and
neither was a design question, so they were ids rather than sections — and both
are now closed: **`FJS-553`** (sortability) and **`FJS-554`** (filterability),
emitted per field by `packages/litestone/src/jsonschema.js`.

They are two ids rather than one because **sortable is a narrower question than
filterable and the code already says so**: `collectOrderByKeyProblems` cannot
reuse the where set, since a `@computed` field can be neither sorted nor
paginated by SQLite while a `@from` field is a correlated subquery aliased into
the SELECT list and sorts fine. One key may carry both answers; one answer
cannot serve both questions.

*(This section previously named `FJS-541` and `FJS-542`. Those ids were cited
here on the day this file was written and taken the same day by two unrelated
defects found in the `File`-control work; the gaps were refiled as 553/554.
Struck in place rather than deleted: an id that was cited and then meant
something else is the one kind of correction a reader cannot make for
themselves. `IDEAS/overview.md` 1.1's row carried the same two and is corrected
with it.)*

## Order

**Questions 1 and 2 are answered, which is what unblocks code** — they were the
two that decide a signature, and the form half's cleanliness came from settling
exactly this much first. Two things stand between the answers and a first
commit: **`x-identify` is built and reaches the browser**, so what is left is a
`DECISIONS.md` entry for each answer, minted when the function it binds lands
rather than now.

Question 3 can follow the table, since a detail view built on `displayFor` is
mostly composition once the renderer exists.

**The admin (`fli admin:generate`, `FJS-065`) is downstream of all of it** and
must consume these three surfaces rather than become a fourth copy of the
templates. `core/crud-templates.js` is already the one owner of what a generated
CRUD page is, which makes it the consumer and not a peer.

## Relationship to the other files

- `forms-from-the-seed.md` — the sibling that shipped, and the shape to copy
- `IDEAS/overview.md` 1.1 — the row this file is the missing half of
- `IDEAS/value-sets.md` — `x-values` is what gives the filter bar its control
  for a bound column, and `FJS-D120` already crossed the boundary
- `IDEAS/permission-sets.md` — once capabilities are built, *which actions a
  row offers* has a second input beside the gate and the transition list
- `IDEAS/ecosystem-gaps.md` — `admin:generate`, the consumer
