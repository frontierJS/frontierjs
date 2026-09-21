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
test/projection.test.ts
```

## What it owns

*Which tools does this standing see, and what decided each.* Three inputs and no
others: the service's method policy (`describe().methods`, already applied), the
model's `@@gate`, and a declared move's `gate` from `x-transitions`. `@system` is not an input: it
says whose decision a move is, and the method lifting it keeps the gate (`FJS-D150`).

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
- **junction has already read the body by the time a route handler runs.**
  `transport/http.ts` parses every matched request before dispatch and `body.ts`
  reads `req.arrayBuffer()` with no clone, so `ctx.$raw.$req` is a spent Request.
  Handed to the MCP transport it answers `400 Parse error: Invalid JSON`, which
  names JSON and not the cause. `replayBody` rebuilds from `ctx.rawBody`; never
  pass `$req` through.
- **There is no `app.db` under `tenancy { strategy database }`.** One
  `ctx.locals.db` cannot be many databases, so a tenant app has no app-wide
  client — `example` is that shape. `registry.schema` is the declared way to read
  declarations without rows; opening a tenant would make listing tools CREATE a
  database file.
- **A tool name may not contain a dot.** `^[a-zA-Z0-9_-]{1,128}$`, and a failure
  invalidates the whole list rather than the one tool. `toolName` owns it, in the
  PROJECTION rather than at the transport, so one spelling exists — and two
  methods deriving one name are both withheld rather than one silently winning.
- **The keep-alive has to be under the app's idle timeout.** The SDK's SSE
  interval defaults to 15s and Bun's idle timeout to 10s, so the stream dies five
  seconds before the frame that would have saved it. Measured both ways.
- **The SDK validates the argument and it is STRICTER than the boundary.**
  `fromJsonSchema` installs a default validator when none is passed, so a tool
  argument is graded before `run()` is reached — a second engine over one schema.
  Measured: `total: "2500"` against an `Int` is refused here and coerced by the
  Data boundary, so the surface refuses a payload the app would have accepted.
  Safe (it admits nothing) and self-correcting (the message names the field), but
  it is a second rule and that is the open question, not a settled design.

## Which drive proves a change

`bun run test`, then `example`: `verify:mcp`. They are not the same question.
`test/plugin.test.ts` proves the PROTOCOL and the crossings — what junction did
to the request body before the handler saw it, and whether the level a route
reads is the level the boundary grades with — against a Junction app on a real
port. `verify:mcp` proves the ANSWERS: a real `@modelcontextprotocol/client`, a
real seed, a real gate ladder, and an app with no `app.db` at all.

**The absolute counts in `CHANGES.md` are a dated measurement and are meant to
be.** What the drive gates is the relations and the credential absence; a
typed-in count is `FJS-773`'s own failure. Run `packages/junction` too —
`customMethodGrade` and `CALL_OPTIONS_AT` are imported from it, so a change
there moves this package's answers with nothing here failing.
