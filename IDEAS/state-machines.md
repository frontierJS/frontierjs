# Idea — State machines belong in the schema

**Status: SHIPPED, with a remainder.** Dated 2026-08-04; **header corrected
2026-08-06**, when it still read *"Nothing here is built. No `@@transitions`
attribute exists in the `.lite` grammar"* — which had been false since the day
this file was written. `@@transitions` parses, is enforced at the Data boundary
(`litestone/src/core/parser.js`, `client.js`, `jsonschema.js`), reaches the
client as `x-transitions` (`sierra/src/junction/field-rules.js`) and drives
`example`'s order screen, which asserts an illegal move returns 409.
`IDEAS/overview.md` row 4.1 has said *shipped* since 2026-08-04; this file did
not, and a status header that contradicts the index is the drift `VERIFYING.md`
exists to catch.

**What remains unbuilt** is the full DSL (litestone backlog 5 — `transitionMap`
is the partial form), and one thing this file never claimed:

> `@@transitions` is a **field** machine. A **process** — checkout, onboarding,
> an approval chain: multi-step, spanning requests, resumable after a
> disconnect — is a different noun, and `ARCHITECT.md` §2 has no word for it.
> Argued in `IDEAS/declared-semantics.md` § 4, which is also where the case for
> building it out of this plus Caravan is made.

Read the design below as the argument that was made, not as a description of
what shipped.

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

## Shape

```
enum OrderStatus { pending paid shipped refunded cancelled }

model Order {
  id      Int         @id
  status  OrderStatus @default(pending)

  @@transitions(status,
    pending  -> paid,
    pending  -> cancelled,
    paid     -> shipped,
    paid     -> refunded @gate(5),
    shipped  -> refunded @gate(6))
}
```

Three things fall out, one per realm — which is the test for whether something
belongs in the seed at all:

**Data.** Litestone rejects an illegal transition the way it rejects a failed gate —
at the boundary, on every path, including `asSystem()` unless explicitly bypassed.
A row cannot reach an unreachable state, whatever wrote it.

**API.** The rejection is a `ValidationError`, which the error boundary already maps
to a 400 by name (`packages/junction/src/core/errors.ts`). Nothing new is needed at
the transport.

**UI.** `order.transitions()` returns the legal next states **for this record at this
user's level** — so a detail page renders exactly the right buttons with no logic in
the component. This is the same shape as `resource.can()`, and it reuses
`canAtLevel()` for the per-transition gate.

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

## What would have to be built

1. **Grammar + AST** for `@@transitions`, including the optional per-transition
   `@gate(n)`. Validation at parse time: every named state must be a member of the
   referenced enum, and the field must be an enum field.
2. **Enforcement in the write path.** Requires reading the current value before an
   update, which `@@gate` does not — so this is the one genuinely new mechanism, and
   the cost (an extra read, or a conditional `UPDATE ... WHERE status = ?`) should be
   settled deliberately. The conditional-update form is atomic and cheaper and should
   probably win.
3. **Emission into JSON Schema** as an `x-transitions` key, alongside `x-gate` and
   `x-relations` — the established pattern for schema facts with no wire
   representation.
4. **`resource.transitions()`** in `packages/sierra/src/junction/field-rules.js`,
   which is where `buildGate` and `canAtLevel` already live and which is deliberately
   a leaf module.

## Open questions

- **Are transitions events or destinations?** `pending -> paid` is a destination;
  `order.pay()` is an event. Events read better and are what the gem ecosystem
  offers, but they invent a second name for every edge and collide with the custom
  actions question (`ARCHITECT.md` §5). Destinations are the smaller change and can
  grow names later; do not do both at once.
- **Initial state and creation.** Is a create subject to the transition table, or is
  `@default(pending)` the only legal entry? The latter is simpler and probably right,
  but it must be stated or every implementation guesses differently.
- **Side effects.** The moment transitions exist, someone wants "on `paid`, send a
  receipt." That is a hook, and it should stay a hook — a state machine that also
  runs jobs is how this feature becomes a framework inside the framework.
- **Does `asSystem()` bypass transitions?** It bypasses gates. Transitions are an
  integrity constraint rather than an authorization one, so the honest answer is
  probably **no** — which makes them the first schema rule `asSystem()` does not
  clear, and that asymmetry needs a `DECISIONS.md` ruling.
- **Terminal states, and reopening.** `cancelled` with no outgoing edges is a
  one-way door; that is usually intended and occasionally catastrophic.

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
2. **`toMermaid()` — a machine that draws itself.** `@@transitions` is the only
   declared surface in the repo with **no committed snapshot**: routes, access,
   release, DDL, JSON Schema, surface and exports all have one, and a state
   machine is the most diagram-shaped of the lot. A `db/transitions.snapshot.md`
   with a Mermaid graph per model, gated by the `snapshots` CI phase, is cheap,
   buildable today, and turns a moved edge into a diff. Costs a generator and no
   CI edit, per the snapshot contract.

Both are notes, not commitments. The full DSL (litestone backlog 5) is still the
remainder this file is open for; FSL is the argument that the *process* half of it
has demand, and the pending queue is the one design decision in it that FJS does
not already have an answer to.

## See also

- `IDEAS/package-map.md` — where the UI half lands (`foundry`)
- `IDEAS/framework-shape.md` item 1 — schema → Resource; this is one of the things
  a generated form would need to render correctly
- `DECISIONS.md` — where the `asSystem()` and events-vs-destinations rulings belong
- `CLAUDE.md` § Bridge index — `buildGate()` / `canAtLevel()` / `x-relations` are the
  precedents this follows exactly
