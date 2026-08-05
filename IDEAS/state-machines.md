# Idea — State machines belong in the schema

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. No `@@transitions`
attribute exists in the `.lite` grammar. Do not cite this file as describing
behavior — see `VERIFYING.md`.

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

## See also

- `IDEAS/package-map.md` — where the UI half lands (`foundry`)
- `IDEAS/framework-shape.md` item 1 — schema → Resource; this is one of the things
  a generated form would need to render correctly
- `DECISIONS.md` — where the `asSystem()` and events-vs-destinations rulings belong
- `CLAUDE.md` § Bridge index — `buildGate()` / `canAtLevel()` / `x-relations` are the
  precedents this follows exactly
