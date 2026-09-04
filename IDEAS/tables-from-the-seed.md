---
id: tables-from-the-seed
status: proposed
dated: 2026-08-26
---

# Idea — The other three surfaces: a table, a detail view, a filter bar

**Status: ARGUED. Nothing here is built.** Three questions want a ruling before
any code is written; two more gaps are filed as defects with ids rather than
argued here. Claims about current behavior were read off the source on
2026-08-26 with the files named. See `VERIFYING.md`.

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

On the wire, `x-gate`, `x-relations`, `x-label-field`, `x-labels`, `x-values`,
`x-transitions`, `x-money`, `x-scale`, `x-time` and `x-litestone-kind` all reach
the browser already and are read by nothing that draws a row.

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

## Question 3 — what a detail view IS

**A form is a model. A detail view is a model plus its relations**, and nothing
here says how far that goes:

- how deep — one level of relation, or the graph
- whether a child collection is a nested table, a link, or a count
- what happens to a relation the caller's gate refuses: hidden, or shown empty.
  `x-gate` is an affordance and the server enforces regardless, so both are
  legal and they read very differently
- whether the detail view and the edit form are one screen with a mode, or two

It also inherits a rule that only became statable this week: **a detail screen
KEEPS a row, so it must watch one.** `resource.record(id)` exists now and
`detail-read-dead` (`fli check`'s 29th rule) found sixteen screens across
`example` and basecamp holding a plain object from `service.get()` that no write
can ever reach (`FJS-533`). A generated detail view must not be the seventeenth.

---

## Filed rather than argued

Two inputs the browser needs and does not get. Both are one emit each, both are
narrow, and neither is a design question — so they are ids, not sections here:

- **`FJS-541`** — sortability does not reach the client, so a generated header
  would offer a sort the Data boundary throws on.
- **`FJS-542`** — filterability does not reach the client, so a filter bar
  cannot know which columns it may offer or with which operators.

They are two ids rather than one because **sortable is a narrower question than
filterable and the code already says so**: `collectOrderByKeyProblems` cannot
reuse the where set, since a `@computed` field can be neither sorted nor
paginated by SQLite while a `@from` field is a correlated subquery aliased into
the SELECT list and sorts fine. One key may carry both answers; one answer
cannot serve both questions.

## Order

**Questions 1 and 2 before any code** — they are the two that decide a
signature, and the form half's cleanliness came from settling exactly this much
first. Question 3 can follow the table, since a detail view built on
`displayFor` is mostly composition once the renderer exists.

`FJS-541` and `FJS-542` can land at any point. They block a *correct* table, not
a table.

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
