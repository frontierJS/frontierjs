---
id: state-machines
status: shipped
dated: 2026-08-04
---

# Idea — State machines belong in the schema

**Status: SHIPPED, with a remainder.** Dated 2026-08-04. `@@transitions` parses, is
enforced at the Data boundary, reaches the client as `x-transitions` and drives
`example`'s order screen. **The reference is `packages/litestone/docs/schema.md`
§ State transitions**; this file keeps the argument for putting a state machine in
the schema, and what it resolved.

**What remains unbuilt** is one thing this file never claimed:

> `@@transitions` is a **field** machine. A **process** — checkout, onboarding,
> an approval chain: multi-step, spanning requests, resumable after a
> disconnect — is a different noun, and `ARCHITECT.md` §2 has no word for it.
> Argued in `IDEAS/declared-semantics.md` § 4, which is also where the case for
> building it out of this plus Caravan is made.

---

## The problem it solves

Every real application has a status column with rules that are never written down in
one place. An `Order` may go `pending → paid → shipped`, never `shipped → pending`,
and only an administrator may `refund`. Today those rules live in whichever service
was written first, restated in whichever service was written second, and checked
nowhere at the data layer — which is why "how did this record get into that state"
is one of the most common production questions in any system.

It is also, structurally, the same problem `@@gate` already solved. A gate says *who*
may write. A transition says *what write is legal from here*. Both are constraints
on a mutation, both are currently scattered across handlers everywhere else, and
both are knowable from the seed.

## Shape, as shipped

```
enum OrderStatus { pending paid shipped refunded cancelled }

model Order {
  id      Int         @id
  status  OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

Three things fall out, one per realm — which is the test for whether something
belongs in the seed at all:

**Data.** Litestone refuses an illegal move at the boundary, on every path, with a
compare-and-swap `WHERE` narrowed to the from-state, so two concurrent writers
cannot both win.

**API.** Each refusal carries its own status, so junction needs no mapper: an
undeclared move is `TransitionViolationError` (409), a caller below a move's gate
`TransitionGateError` (403), a lost race `TransitionConflictError` (409, with
`retryable` separating *already made* from *moved under you*), and a `@system` move
asked for by a caller `TransitionSystemError` (403).

**UI.** `db.order.transitions(row)` and sierra's `resource.transitions(row, level)`
return the moves for this record at this caller's level, refused ones included
with `refusedBy` — so a detail page renders exactly the right buttons with no
logic in the component.

## Why this fits FJS specifically

- It is a declaration that radiates into all three realms, which is the stated bar
  for the seed (`PHILOSOPHY.md`, "growth happens outward and traces back"). A rule
  that only reached the ORM would not qualify — that is the Wasp lesson recorded in
  `website/projects.json`.
- It composes with the gate rather than competing with it: `@gate(5)` on a single
  transition is a *narrower* constraint than the model's `@@gate`, in the same
  vocabulary.
- Rails and Laravel both solve this with third-party gems (`aasm`, `state_machines`,
  `spatie/model-states`). None is schema-derived, none reaches the client, and none
  carries authorization per transition. This is a case where the ecosystem has
  already demonstrated the demand and nobody has the right substrate for it.
- It makes enums load-bearing. Today an enum reaches the browser as a `$ref` into
  `$defs` and renders a `<select>`; this is the thing that makes an enum *mean*
  something.

## What the open questions became

- **Events or destinations?** Both, without a second name for every edge: a move's
  name is optional on an enum (`pending -> paid` names itself after its target)
  and required where the target says nothing about what a person did, which is a
  `Boolean` column. `db.order.transition(id, 'pay')` calls one by name.
- **Initial state and creation.** A create has no from-state and is not graded;
  `@default` is the entry.
- **Side effects** stayed hooks. The machine runs no jobs.
- **Does `asSystem()` bypass transitions?** Yes, and it says so — except a
  `@gate(9)` move, which nothing makes. The honest way for the application to make a move a
  caller may not is a `@system` move (`FJS-D150`), which keeps the model gate, the
  row policies and the audit actor that `asSystem()` drops.
- **Terminal states.** Still a one-way door by design. Studio's Access panel shows
  them (`verify:studio:access` asserts a terminal state beside a non-terminal one).
- **The full DSL** arrived as a per-enum `transitions { … }` block that desugars
  into `@@transitions` on each model using it; a gate needs the model form.

## Prior art — FSL, and the two things worth taking from it

**Raised 2026-08-17.** `finite-state-language` (neutrino38, Apache-2.0,
`0.1.1` on npm, "early design phase, implementation underway") is a zero-dependency
TypeScript DSL for stateful UI processes — a web phone tracking
`registering → ringing → connected → failed`. States declare handlers as an `on`
map plus optional `after` timers; `goto()` moves, and the description string
doubles as the debug log. The engine is an Erlang-shaped actor: events queue and
are processed one at a time with selective receive, and a machine exports itself
with `toMermaid()`.

**It is not a candidate dependency, and the reason is the seed rather than the
quality.** A machine written in TypeScript is a second place that says what may
move where, and the first one — `@@transitions` — is the one enforced at the Data
boundary, gated per edge, carried to the client as `x-transitions` and recorded in
the audit trail. Two sources for one rule is the condition Invariant 6 exists to
refuse, and only one of the two would be enforced. The maturity is the smaller
objection but a real one: Invariant 16 holds a runnable example to being verified,
and the same bar applies to what the repo leans on.

**What FSL is actually about is the noun this file's header says is missing** — a
*process*, ephemeral, spanning events rather than owning a row. It does not fill
that hole either: it has no persistence, no principal, no compensation, so it is
neither `@@transitions` nor `overview.md` 4.19's durable workflow. Cite it as
evidence the category is real and independently arrived at, not as the answer.

Two mechanisms in it are worth stealing outright, and neither requires the package:

1. **An unhandled event waits and replays on the next state change.** FSL's
   pending queue is the missing half of every race this repo has hit at a
   reconnect: a frame that arrives while the socket is down or while a resource is
   mid-`load()` is currently dropped, and the store's answer is a reload it cannot
   always justify. *Hold it, replay it when the state that could not handle it
   moves* is a smaller rule than either. Junction's outbox owns the outbound side
   of exactly this problem already (`transport/send-queue.ts`), so there is a
   precedent for where it would live.
2. **`toMermaid()` — a machine that draws itself.** A moved edge is already a diff
   — `access.snapshot.md` § State transitions lists every move — but as a table.
   A Mermaid graph per model beside it would be cheap and is not built.

Both are notes, not commitments. FSL is the argument that the *process* half has
demand, and the pending queue is the one design decision in it that FJS does not
already have an answer to.

## See also

- `IDEAS/package-map.md` — where the UI half lands (`foundry`)
- `IDEAS/framework-shape.md` item 1 — schema → Resource; this is one of the things
  a generated form would need to render correctly
- `packages/litestone/docs/schema.md` § State transitions — the reference
- `DECISIONS.md` `FJS-D150` — `@system` on a move
- `CLAUDE.md` § Bridge index — `buildGate()` / `canAtLevel()` / `x-relations` are the
  precedents this follows exactly
