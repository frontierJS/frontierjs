---
id: cascading-fields
status: idea
dated: 2026-08-04
---

# Idea — Cascading fields: propagating a value to related rows

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. No `@@cascade` attribute
exists in the `.lite` grammar. The *precedent* section below is read off
`packages/litestone/src/core/client.js` and describes shipped code; everything else is
a proposal. Do not cite this file as describing behavior — see `VERIFYING.md`.

---

## The problem it solves

An app sets `task.completedAt`, and every related `message` that is still open must be
stamped with the same instant. An app sets `task.archived`, and its messages must
archive with it. Neither is a workflow — both are structural facts about the data:
**a child cannot outlive its parent's completion.**

Today that fact is written in whichever service closes a task. The second writer — an
admin action, a Caravan job, a migration, Studio, a `fli` script — does not know about
it, and there is no error when it forgets. The rows just drift, silently, and the
drift is only visible as a report that does not add up months later.

Litestone already refuses to let this class of rule live in a handler for *access*
(Invariant 6) and for *legal state* (`@@transitions`). Propagation is the same
category of rule and is currently the exception.

## The precedent, exactly

Litestone already implements this. It just refuses to let you name the field.

`@@softDelete(cascade)` walks FK children breadth-first with a cycle guard
(`getCascadeTargets`, `client.js:745`) and, per child table, runs:

```sql
UPDATE "child" SET "deletedAt" = ? WHERE "fk" IN (?,?,…) AND "deletedAt" IS NULL
```

(`client.js:4352` and `:4357`.) That is the requested feature with two literals frozen
into it: the column is `deletedAt`, and the trigger is `remove()`. **The `AND … IS
NULL` guard is already there** — the shipped cascade is already set-only and
idempotent, which is exactly the semantics a general form should keep.

Two things the precedent does *not* do, both of which the generalization has to settle
rather than inherit:

- **The cascade is invisible.** No `emitter.emit` and no `emitLogs` for child rows —
  only the parent is audited and only the parent fires an event. On a `@@log` model
  that is a hole in the audit trail: rows changed, nothing recorded who or why.
- **The cascade is not wrapped in a transaction.** `tx.wrap` exists and is
  savepoint-based (`client.js:1141`), and `createMany`/`upsertMany` use it — the
  soft-delete cascade path does not. A crash between the parent stamp and the child
  stamps leaves them disagreeing. *(Read off the code, not probed at runtime.)*

Elsewhere in the schema, derivation is read-side only and cannot express this:
`@from(relation, …)` and `@@expr`/`@computed` produce values, they do not write rows.

## Shape

```prisma
model Task {
  id          Int       @id
  completedAt DateTime?
  archived    Boolean   @default(false)
  messages    Message[]

  @@cascade(completedAt -> messages.completedAt)
  @@cascade(archived    -> messages.archived, mirror)
}
```

Read: *when `completedAt` is set on a Task, set it on every related Message that has
no `completedAt` of its own; keep every Message's `archived` equal to the Task's.*

`@@softDelete(cascade)` then desugars to `@@cascade(deletedAt -> <children>.deletedAt)`
plus its filter behaviour — one mechanism where there are currently two, which is the
real reason to build it.

### Why this spelling

The arrow is not new syntax: `@@transitions(status, pending -> paid)` already reads
this way, so `@@cascade` costs a keyword rather than a grammar. Model-level keeps
every propagation obligation of a model visible in one block. Four alternatives were
weighed and are worth recording, because two of them are good later sugar rather than
bad ideas:

| Shape | Reads | Case against |
| --- | --- | --- |
| `completedAt DateTime? @cascade(messages)` — field-level, target name inferred | shortest; type match is automatic when both sides come from one `@@trait` | obligations scatter across fields; a renamed target needs `@cascade(messages.closedAt)` anyway |
| `messages Message[] @cascade(completedAt, archived)` — on the relation field | sits where `@hardDelete` already sits and where Prisma puts `onDelete`; groups by *who receives*, which is the direction the FK walk runs | reads backwards from how the rule is thought about ("when the task completes…") |
| `completedAt DateTime? @from(task.completedAt, on: set)` — child declares its dependence | reads where the value lands | `@from` is read-side today; overloading it to mean a stored write blurs the one line that keeps this feature small |
| `@@cascade { … }` — a block of arrows | best when a model has several | needs block grammar no `@@` attribute has |

**`@@cascade`, not `@@stamp`.** The name has to survive Booleans, enums and tenant
ids, so it cannot be a word about timestamps. `cascade` is already what the codebase
calls this exact FK walk.

## Modes

The guard is the design. `AND target IS NULL` is not the rule — the rule is *only
touch rows this has not happened to yet*, and for a `Boolean @default(false)` the
unset value is `false`, not null.

| Mode | Guard | Semantics | Fits |
| --- | --- | --- | --- |
| **`once`** (default) | `AND "target" IS <unset>` — null if nullable, else the field's `@default` | one-way door; idempotent and monotonic. Clearing the parent does nothing | `completedAt`, `deletedAt`, `publishedAt` |
| **`mirror`** | `AND "target" IS NOT ?` | the child always tracks the parent, in both directions | `archived`, `locked`, `tenantId`, an enum status |

```sql
-- once,  DateTime?              -- once,  Boolean @default(false)
… AND "completedAt" IS NULL      … AND "archived" = 0
-- mirror, any type
… AND "archived" IS NOT ?        -- SQLite IS NOT is null-safe; no IS DISTINCT FROM needed
```

Both modes are idempotent by construction — `once` because a stamped row no longer
matches, `mirror` because an equal row no longer matches. `once` is the default
because it is the mode that cannot destroy a value a child set for itself.

Everything else stays deliberately narrow:

- **Same value.** The child gets the parent's value, never a computed one.
- **Same transaction** as the parent write, via the existing `tx.wrap`.
- **Cycle-guarded**, reusing the BFS the cascade already has, or capped at one hop for
  a first version.

*Honest gap:* `@@softDelete(cascade)` is `once` forward **plus** a reverse on
`restore()` keyed to children whose `deletedAt` matches the parent's. Neither mode
covers that exactly. Either a third mode earns its place or soft delete keeps one
bespoke bit — worth deciding before claiming full desugaring.

## Type rules

Checked at parse time, so a mismatch is a schema error and never a runtime surprise.

1. **Same scalar type, or the same enum.** `DateTime? -> DateTime?`,
   `Boolean -> Boolean`. No coercion, ever.
2. **No cross-type propagation.** `Boolean -> DateTime` ("if true, stamp now") is
   computation, and belongs in a service. This is the clause that stops the feature
   becoming a trigger engine.
3. **`once` needs an unset value.** The target must be nullable or carry a `@default`;
   otherwise there is nothing to test. Reject.
4. **`mirror` needs nullability to match.** A nullable source into a `NOT NULL` target
   propagates null and fails at runtime. Reject.
5. **Warn, do not reject:** a `once` target with `@default(now())` is stamped at
   create, so the cascade can never fire. Silent no-op otherwise, and the kind of
   thing nobody finds for a year.

Rule 1 also does the work when the target field name is inferred rather than written:
same-named fields on parent and child usually come from the same `@@trait`, so the
types agree by construction.

## Why this fits FJS specifically

- It is not a new mechanism. It is **un-hardcoding one that already ships**, and the
  general form is smaller to describe than the special case.
- The rule holds for every writer, not the one service that remembered. That is the
  same argument that put gates and transitions in the seed.
- Rails reaches for this constantly with `belongs_to :task, touch: true` and
  `dependent: :destroy` — narrow, one-directional, per-association, and invisible to
  anything but the ORM. The demand is demonstrated; nobody derives it from a shared
  schema that also reaches the API and the client.

**The honest weakness:** the bar stated in `state-machines.md` is that a seed
declaration should radiate into all three realms, and this one mostly does not. Data
enforcement is the whole feature; the API sees nothing new. The UI half is real but
thin — emit `x-cascade` on the model alongside `x-transitions`, and a Resource can
warn *"completing this also closes 12 messages"* before the write. That is an
affordance on the same permissive contract as `x-gate`, and it is worth having, but it
does not make this a wave-4 differentiator. It is a coherence item that happens to be
useful.

## What would have to be built

1. **Grammar + AST** for `@@cascade(field -> relation.field[, mode])`, plus the five
   type rules above. Structural validation too: the relation must be `hasMany` on this
   model and both columns must exist.
2. **Write-path hook** in `update`/`upsert` — fires when the named field is present in
   `data` and its value changes. Reuses `getCascadeTargets` for the walk; the
   statement is the shipped one with the guard chosen by mode.
3. **`tx.wrap` around parent + children**, and fix the soft-delete cascade to use it
   at the same time — one path, both benefit.
4. **Audit + events for cascaded children**, which the soft-delete cascade also lacks.
   Under Invariant 7 the child entries redact protected fields like any other. This is
   the part most likely to be more work than the feature itself, since the cascade
   uses bulk SQL and has no rows in hand.
5. **`x-cascade` emission** into JSON Schema, following `x-transitions`.

## Open questions

- **Does `asSystem()` bypass it?** Same question `@@transitions` raises, and the answer
  should probably match. An integrity rule a bypass can skip is not an integrity rule.
  Note the shipped transition check *does* bypass under `ctx.isSystem`
  (`client.js:1950`), so "match transitions" currently means "bypass" — which may be
  the wrong precedent to inherit.
- **Does `updateMany` cascade?** Transitions explicitly do not fire on bulk ops, by a
  documented decision. A cascade that silently does not propagate on `updateMany`
  reproduces exactly the drift the feature exists to prevent, so the answer here
  probably has to differ — and then two schema rules behave differently on the same
  call, which needs a ruling rather than an implementation choice.
- **Gates on the child.** The cascade writes rows the caller may have no level to
  write. Soft delete already made this choice implicitly (it does not check). Stating
  it is the point: a cascade is a system write caused by an authorized one.
- **How many hops?** BFS matches the cascade precedent; one hop is easier to reason
  about and easier to explain in an error message.
- **Direction.** Only parent → children is proposed. Child → parent (Rails' `touch`)
  is a different rule — an aggregate — and belongs with `@from(relation, max:)`.
- **Does `mirror` fight `@@transitions`?** A mirrored enum writes a child's status
  without going through its transition table. Either the cascade respects transitions
  on the child (and can therefore fail mid-write) or it is a declared bypass. The
  second is simpler and has to be written down.
- **Does this open the door to triggers generally?** It should not, and the boundary
  is type rule 2 plus: no computed values, no conditions beyond the mode guard, no
  side effects. A cascade that can send email is a framework inside the framework —
  the same line `state-machines.md` draws for transitions.

## See also

- `IDEAS/state-machines.md` — the sibling argument, and where the "must radiate into
  three realms" bar comes from. *(That file says nothing is built; `@@transitions` has
  since shipped — it is stale, not wrong about the design.)*
- `packages/litestone/docs/soft-delete.md` — the shipped special case
- `packages/litestone/docs/schema.md` § Derived & generated — why `@from`/`@@expr`
  cannot express this
- `DECISIONS.md` — where the `asSystem()`, `updateMany`, `mirror`-vs-transitions and
  child-audit rulings land
- `CLAUDE.md` § Invariants 6 and 7 — the declare-in-the-schema and redaction rules this
  has to satisfy
