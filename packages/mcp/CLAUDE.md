# @frontierjs/mcp — the inside view

**The agent surface: an MCP server derived from the seed.** Ruled `FJS-D258` —
plain name, because it owns no realm and mints no noun. It is the API realm
spoken to an agent.

**Only the projection exists.** `PROJECT_STATE.md` has what is next. Design is
`IDEAS/agent-surface.md`; do not cite that file as behavior.

## Layout

```
index.ts              the public surface — projectTools, resolveModel, the types
src/projection.ts     all of it
tests/projection.test.ts
```

## What it owns

*Which tools does this standing see, and what decided each.* Three inputs and no
others: the service's method policy (`describe().methods`, already applied), the
model's `@@gate`, and a declared move's `gate`/`system` from `x-transitions`.

It reads a NARROWED view of the generated schema on purpose — `ModelDef` declares
two keywords. Taking the whole `$def` would leave the projection free to start
grading on any keyword in it, and which three it may grade on is the design.

## Traps

- **The audience is not a parameter and must not become one.**
  `generateJsonSchema`'s `audience: 'system'` includes `@guarded` and `@secret`,
  so it puts a password hash and OAuth tokens into a TOOL DESCRIPTION — read
  before any call, by a caller whose job is reading what it is given. *The agent
  acts for the application, so give it what the application knows* is the
  sentence that gets there, and `FJS-976` is what it cost one realm over.
  `schemaViews` owns the three generator calls; do not add an option, and do not
  accept a caller's own `$defs`.
- **An absent input schema is `null`, never `{}`.** An empty object schema
  accepts anything, which is a claim an agent acts on and the boundary refuses.
- **`describe().model` is not reliably a model.** `Service.model` is optional and
  Junction defaults it to the service's own NAME, so a service with no `model:`
  reports `orders` — camelCase, plural, naming no `$def`. Every rule on that
  model then resolves to `undefined`, which permissive-unknown reads as *nothing
  is declared*: the most heavily gated service in an app comes out open and
  nothing fails. Go through `resolveModel`, and anything still unresolved belongs
  in the reported list rather than in a log.
- **A move's `@gate` is a FLOOR over the model's `update`, never a replacement.**
  `max` of the two. `invoices.void` is `@gate 5` on a model written at 8, so it
  needs 8 — and offering it at 5 is the one mistake here that misleads a caller
  about its own permissions instead of wasting a turn.
- **A name match between a custom method and a move is a CONVENTION**, not a
  declaration. It is acceptable only because of the direction it can be wrong in:
  every custom method is permissive without the lookup, so a wrong match can only
  narrow. The inverse convention would not be safe and is not attempted.
- **`ungraded` must not be filed with `model-gate` and `move-floor`.** *Nothing
  refused this* and *a rule allowed it* are different facts and only one is
  evidence.
- **This is an affordance** (Invariant 6). Nothing here is a boundary, and no
  caller of it may treat it as one.

## Which drive proves a change

There is no drive. That is the biggest thing wrong with this package: `CHANGES.md`
carries two measured tables and a claim that no credential column appears in any
tool schema, and nothing regenerates or regrades any of them.

There is no drive. `bun run test` is all there is, and the gap is named in
`PROJECT_STATE.md`. A change to `describe()`, to `generateJsonSchema`'s keywords
or to `@frontierjs/toolbelt/gate` can move this package's answers with nothing
here failing — run `packages/junction`, `packages/litestone` and
`packages/toolbelt` too.
