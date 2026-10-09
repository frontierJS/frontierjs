---
id: tenant-authored-workflows
status: proposed
dated: 2026-09-22
---

# Idea — A state machine the TENANT fills in, still enforced at the Data boundary

**Status: PROPOSED.** Measured in the linear stressor (Phase 3, Q2):
`fjs-prototypes/linear/api/test/workflows.test.ts` (19 tests, in-process) and
`web/test/verify-workflow.mjs` (9 checks, over HTTP). Every claim below marked
*measured* was run there on 2026-09-22; *read* means a source file says so.
Decision row: [`FJS-D365`](../ISSUES_ARCHIVE.md#fjs-d365).

## The shape

Every team in an issue tracker edits its own workflow. The states are rows
(`Triage → Backlog → Todo → In Progress → In Review → Done / Canceled`), renamed,
added and reordered per team. Each state belongs to one of five FIXED categories,
and the product's logic reads the category and never the name. One team forbids
`started → backlog` and another allows it. One team lets only an admin reopen.

`@@transitions` is the language's state machine, and it is written in the file:
the states are an enum and the moves are named in the schema. A tenant cannot
touch it. That is the gap `@@extensible` closed for COLUMNS: the schema declares
the shape (*a pool of typed slots*) and the tenant fills it in (*a `CustomField`
row*). This paper asks for the same split for MOVES.

## Where the language stops today (measured)

| Tried | Result |
| --- | --- |
| `@@transitions(stateId, …)` | refused at parse: *'stateId' is String, which is not a closed type. A from-state has to be decidable, so the field must be an enum or Boolean* |
| `@@check` with a subquery over the team's states | refused by SQLite at DDL (*subqueries prohibited in CHECK constraints*), with no model named |
| A copied `category StateCategory` on the issue, carrying `@@transitions` over the five categories | **parses and works**, and is wrong three ways: a second origin for the state's category, stale the moment an admin re-categorises a state, and ONE machine for every team, so the hard version (two teams disagreeing) is still not expressible |
| `@derived(state.category)` to make that copy derived | refused, and the refusal names `@from(state, category)` as the cure, which does not parse ([`FJS-1305`](../ISSUES.md#fjs-1305)) |
| `@@deny('post-update', state.teamId != teamId)` | **works**: *the state is one of this issue's team's* is one hop and needs nothing from before the write. The only part of Q2 the schema could say |
| *This move is in the team's table* | not expressible. `update` sees the row before the write and `post-update` sees it after, **never both**, and a move is the pair |
| `stateId String @default(<the team's entry state>)` | not expressible. `@default` takes a literal or a call, not a lookup |

## What the app had to write instead

A `WorkflowTransition { teamId, fromId?, toId, adminOnly }` model (a null `from`
is an ENTRY, where a new issue may start) and an app-written litestone
`Plugin` (`linear/api/src/core/workflow.ts`, about 90 lines) that restates the
machine: the start state, the default, the moves, the per-move admin gate, and a
refusal of `updateMany` on `stateId`. A plugin rather than a service hook,
because a plugin holds for every caller of `db.` (a job, a seed, `fli tinker`).
**What it costs, measured:**

1. **Invisible to everything derived.** `fli check`'s `transition-methods`
   reports *no @@transitions in db/schema.lite*. The JSON Schema carries no
   `x-transitions`. `issue.transitions(row)` answers `[]` and
   `issue.transition(id, name)` refuses. So a screen cannot derive its buttons
   from the schema, and [`FJS-1255`](../ISSUES.md#fjs-1255) stops being *a move
   name and a method name disagree* and becomes *there is no name*.
2. **The default is unreachable through the API.** In-process the plugin fills
   the team's entry state. Over HTTP, junction's input validator reads `stateId`
   as required off the JSON Schema and refuses first: `400 stateId: stateId is
   required`. `@system` would take it out of `required` and also forbid the
   caller from naming an entry state, which it may. The same wall
   [`FJS-1296`](../ISSUES_ARCHIVE.md#fjs-1296) hit for `@sequence`.
3. **A value a plugin writes into a create is never graded by the create
   policy** ([`FJS-1307`](../ISSUES_ARCHIVE.md#fjs-1307)). `checkCreatePolicy` runs
   before `plugins.beforeCreate`, so the plugin's default escapes the very
   `@@deny` that keeps a state inside its team. The app then had to weaken that
   deny (`stateId != null && …`) so a create naming no state could reach the
   plugin at all.
4. **The compare-and-swap is gone** (read). A declared move narrows the UPDATE's
   `WHERE` to the from-state, so two concurrent movers cannot both win. The
   plugin reads, then the write happens. `@version` closes the gap for a caller;
   `asSystem()` skips both.
5. **The one cross-row rule the schema could say is an ACCESS word.** The
   `@@deny` answers `403 That state belongs to another team` (measured over
   HTTP) for what is the caller's mistake in a value, which is a 400 by rule two
   of `docs/access-control.md`. The plugin's own refusals are 400 (a move the
   team lacks) and 403 (a move only an admin makes), and junction honours both.
6. **The plugin reads the caller's rows through `ctx.tables`**, the flavour's own
   policy-scoped tables, so a caller who cannot read the issue is refused by the
   policy and learns nothing about its state (measured). `ctx.tables` is not a
   documented plugin surface: `FJS-D267` made `Plugin` the public extension
   point and gave it no client to read with.

**What worked, and argues for the design.** With the machine as rows, ENG adds
*In Review* between *In Progress* and *Done* with **no migration and no
backfill**: seven row writes (a state, three moves, one removed shortcut, and two
renumbered positions, which are Q3's cost). The issue in flight in *In Progress*
now has to go through review, the one already *Done* is untouched, and SEC's
workflow is unchanged (measured). With an enum, the same change is a schema
migration for every tenant of the installation. And the moves are readable as
ordinary rows by anyone who can read the team, and hidden with a private team
(measured), so a screen can draw the buttons from DATA where it cannot from the
schema.

## The proposal

```lite
/// The moves a team allows, as rows. The DECLARER's shape is fixed by the
/// attribute below, the way @@extensible fixes CustomField's.
model WorkflowTransition {
  id      String  @id @default(ulid())
  teamId  String
  fromId  String?          // null: an entry, where a new row may start
  toId    String
  gate    Int?             // a per-move @gate(N), as data
  …
}

model Issue {
  stateId String
  state   WorkflowState @relation(…)
  @@transitions(stateId, declaredBy: WorkflowTransition, scope: teamId)
}
```

What the Data boundary would then do, and why each is the enum machine's
existing behaviour with the set read from a table instead of the file:

- **A move** is an UPDATE narrowed to the from-state AND to
  `EXISTS (… fromId = :from AND toId = :to AND teamId = :scope)`. That is one
  statement, so the compare-and-swap survives, and the refusal classes
  (`TransitionViolationError`, `TransitionGateError`, `TransitionConflictError`)
  are the ones that exist.
- **A create** requires an entry row for its state. This is
  [`FJS-1257`](../ISSUES_ARCHIVE.md#fjs-1257)'s missing half, *where may a row begin*,
  and it gives the enum form its spelling too: `@@transitions(status, start: ->
  draft, …)`.
- **The default** is the entry with the lowest position (or the only one), which
  takes `stateId` out of the create schema's `required` and leaves it writable.
- **`transitions(row)`** reads the declarer and answers the same shape it
  answers today, gate included, so FJS-1255's button derivation works. Moves
  have no names in the file, so a move's name is its target's `@@label`.
- **`x-transitions`** says `declaredBy: WorkflowTransition`, and the browser
  reads the rows through the declarer's own resource, under its own policy.
- **`fli check`** grades the declarer's shape once, at parse, the way
  `@@extensible` grades `CustomField`'s uniques.

## What it must not become

A rules engine. `declaredBy` carries exactly what an enum machine carries:
from, to, an entry, and a gate. *You may not start an issue with no assignee* is
a guard, a predicate over the row, and it stays app code or a `post-update`
policy. The line is the one `@@extensible` drew: the tenant fills in a
declared SHAPE and never writes an expression.

## Open questions

- ~~**Q1 — should `@@transitions` grow `declaredBy:`, so a machine's moves can be rows a tenant edits? (`FJS-D365`)**~~ **Answered 2026-09-28 (`FJS-D365`): B — `@@transitions(field, declaredBy: Model, scope: column)` over a foreign key, with a fixed declarer shape (`fromId?`, `toId`, `gate?`), enforced in the UPDATE's own `WHERE`; entries and the default come with it.**
  Measured in linear Phase 3: the schema can say *the state is one of this
  team's* and nothing else about the machine. Everything else is an app plugin
  that `fli check`, the JSON Schema, `transitions()` and the browser cannot see,
  whose default the API's validator refuses before it runs, and whose create
  half escapes the create policy (FJS-1307).
  - **A** — no. Workflow-as-data is an app pattern; document the plugin shape (and make `ctx.tables`, or a real client, part of the `Plugin` contract) and leave `@@transitions` to closed columns
  - **B** — `@@transitions(field, declaredBy: Model, scope: column)` over a foreign key, with a fixed declarer shape (`fromId?`, `toId`, `gate?`), enforced in the UPDATE's own `WHERE`; entries and the default come with it
  - **C** — B, plus a schema-level machine over the target's CLOSED category (`scope` + `category:`) that every tenant's rows must also respect, so *nothing leaves `completed` except by reopening* is declared once and no team can remove it
  - **Recommend B** — it is `@@extensible`'s own argument, where the schema owns the shape and the tenant owns the members, and every cost measured above is a derivation the enum machine already has and the plugin had to give up. C is attractive and can follow B without changing it: layering a fixed machine over a tenant's one is a second question with no product asking it yet. A leaves FJS-1257's start state and FJS-1255's buttons unsolvable for every tenant-edited workflow

## See also

- `IDEAS/shipped/tenant-declared-fields.md` — the `declaredBy` precedent, for columns
- `packages/litestone/docs/schema.md` § State machines — the enum machine this extends
- `fjs-prototypes/linear/PLAN.md` § Q2 — the run, and the table of what was measured
