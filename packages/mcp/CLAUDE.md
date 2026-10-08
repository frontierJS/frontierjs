# @frontierjs/mcp — the inside view

**The agent surface: an MCP server derived from the schema.** Ruled `FJS-D258` —
plain name, because it owns no realm and mints no noun. It is the API realm
spoken to an agent.

**Only the projection exists.** `PROJECT_STATE.md` has what is next. Design is
`IDEAS/agent-surface.md`; do not cite that file as behavior.

## Layout

```
index.ts                     the public surface — projectTools, resolveModel, the types
src/projection.ts            which tools a standing sees, and what decided each
src/plugin.ts                mcpPlugin — the endpoint mounted inside the running API
src/await.ts                 hold an awaited call until the jobs its correlation id names are terminal (FJS-D406)
src/breadcrumbs.ts           what a one-row answer offers next — the caller's own tools, narrowed by the row (FJS-D398)
src/client/                  `@frontierjs/mcp/client` — the terminal client's half,
  argv.ts                      a tool's input schema read as a command line
  run.ts                       one command line against an app's /mcp — globals, output, exit codes
  profiles.ts                  the signed-in credential: one 0600 file per app under XDG_CONFIG_HOME
  cache.ts                     the command tree per build (x-fjs-build) under XDG_CACHE_HOME — none without a build
  routes.ts                    cli/src/routes/<service>/<method> — declared `uses`, checkRoutes
  build.ts                     `@frontierjs/mcp/client/build` — cli/ compiled to one binary, routes inside (`fli cli:build`)
  main.ts                      an app's whole entry: main({ name, tenantHeader, url, routes })
  bin.ts                       main() for an app with no cli/ surface — FJS_* stands in for its config
  index.ts                     held here until the CLI package is named (IDEAS/app-cli.md)
test/projection.test.ts      the rules, against test/fixtures/shop.lite
test/plugin.test.ts          the endpoint inside a real Junction app on a real port
test/principal-standing.test.ts  the standing a membership resolver answers
test/await.test.ts           the wait over a reader and a clock of its own
test/breadcrumbs.test.ts     breadcrumbs against the real fixture and the real projection
test/argv.test.ts            every tool in test/fixtures/tools/ (example, basecamp) as argv
test/run.test.ts             globals, tenant header, exit codes, profiles, cache and routes, over a stubbed session
```

**`src/client/` imports nothing from the server half, and must not** — it moves
into its own package whole, and the fixtures it is graded against are captured
`tools/list` answers rather than projections run in the test, so a projection
change reaches them only when somebody recaptures (the header of `argv.test.ts`
says how).

## What it owns

*Which tools does this standing see, and what decided each.* The inputs are what
the boundary reads: the service's method policy (`describe().methods`, already
applied), the model's `@@gate`, a declared move's `gate` from `x-transitions`,
and a method's declared `gate:` (`describe().methodGates`) — which over no model
grades a CRUD verb too, as junction enforces it (`FJS-D408`). `@system` is not an
input: it says whose decision a move is, and the method lifting it keeps the gate
(`FJS-D150`).

**`narrow` is the one input an APP supplies, and it only removes** (`FJS-D407`).
It is for an axis a standing is not — an API key's scopes. A rule that IS a level
belongs in `@@gate` or a declared `gate:`, where the boundary enforces it as well;
put in `narrow`, it is a second origin nothing at the boundary agrees with.

It reads a NARROWED view of the generated schema on purpose — `ModelDef` declares
two keywords. Taking the whole `$def` would leave the projection free to start
grading on any keyword in it, and which three it may grade on is the design.
`breadcrumbs.ts` reads `x-relations` too, under its own type, and grades nothing:
a breadcrumb is a tool the projection already offered this caller, and one that
is not must never be added to make a list look complete.

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
- **The standing is the one the app's principal RESOLVER answers, never the
  session.** Under `strategy row` a membership role is a claim added per call, so
  grading `ctx.user` offered basecamp's admin and viewer one identical list.
  `standingOf` goes through `app.withDb`, which runs the resolver — and the
  resolver reads its tenant off the request, so an MCP client must send whatever
  header the app's `tenantFrom` reads (`x-workspace-id` there).
- **An awaited call's correlation id is read in the ROUTE, not in the tool
  handler.** The route runs inside junction's request scope, which is what every
  service call in the tool inherits and what Caravan stamps on the jobs they
  dispatch; reading it anywhere else is a bet on the SDK keeping the async chain.
  And an awaited call is answered as a stream (`enableJsonResponse: false`), or
  Bun's idle timeout cuts a hold longer than ten seconds with nothing said.
- **This is an affordance** (Invariant 6). Nothing here is a boundary, and no
  caller of it may treat it as one.
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
real schema, a real gate ladder, and an app with no `app.db` at all.

**The absolute counts in `CHANGES.md` are a dated measurement and are meant to
be.** What the drive gates is the relations and the credential absence; a
typed-in count is `FJS-773`'s own failure. Run `packages/junction` too —
`customMethodGrade` and `CALL_OPTIONS_AT` are imported from it, so a change
there moves this package's answers with nothing here failing.

A change under `src/client/` is proved by `basecamp`: `verify:cli`, the only
place the client runs as a person's process against a real `/mcp`, and the only
place a built binary is asked the same questions as the source.
