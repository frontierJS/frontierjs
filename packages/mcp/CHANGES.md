# Changes — @frontierjs/mcp

## 2026-10-06 — a tool call is stamped `transport: 'mcp'` (`FJS-D609`, `FJS-1817`)

`run` passed only the principal, so the call defaulted to `'internal'` and an *is this from inside* check — basecamp's `internalOnly()` — let a viewer finish a release and a developer forge a server event. With junction's in-process `$` refusal and Litestone's tag-only `$raw`, a smuggled `$raw` at any depth is refused rather than answered (`FJS-1816`).

`test/plugin.test.ts` § *a tool call is a call from outside*, the transport and four `$raw` shapes with a control; 142 pass, typecheck clean.

## 2026-09-29 — a money column always names its currency (`FJS-D556`)

Litestone refuses a bare `@money`, so a money argument's description names the
currency or the row's currency column, and the "app's default currency"
wording is gone. The `shop.lite` fixture states `@money(USD)`.

## 2026-09-28 — a tool result never carries a protected column (`FJS-D473`)

`run` dispatches through `app.service()`, the in-process caller junction leaves ungraded, so a method returning a system write handed an agent its `@secret` and `@guarded` columns. The result now goes through junction's `withholdProtected` first. Proved in `plugin.test.ts`.

## 2026-09-26 — `replayBody` is gone; junction's `$req` carries its body (`FJS-1180`)

The transport now rebuilds `ctx.$raw.$req` from the bytes it read, so the
Request is handed to the MCP transport as-is and the first of the three traps
the plugin was arranged around is no longer one. `plugin.test.ts`'s
`initialize` answering 200 is the proof it still arrives.

## 2026-09-25 — `--help --agent`: how an agent reaches the app

**`--help --agent` at the top level is a guide for an agent**: the `claude mcp add` line
for the endpoint and tenant this run connected with (never the key), the routes the key
is offered as shell-only, then the command list. One row in `run.test.ts`, one in
basecamp's `verify:cli`.
`README.md` § Teaching an agent says why nothing is generated: the tool list already
describes itself at the caller's standing.

## 2026-09-25 — `buildCli`: an app's `cli/` as one binary

**`@frontierjs/mcp/client/build`** compiles a `cli/` surface into the release
`FJS-D397` names — `cli/dist/<name>`, one per `--target`, needing no bun, no
node_modules and no source tree. Run as `fli cli:build`. A hand-run
`bun build --compile cli/src/main.js` was measured compiling, running, and holding
none of `cli/src/routes/`, because `loadRoutes` read the missing directory as an
empty one. So every route file goes in as an entrypoint, `splitting` keeps a route
on the entry's copy of the client (without it `instanceof CallRefused` failed across
the seam, measured), and the count goes in as `process.env.FJS_CLI_ROUTES`:
`loadRoutes` inside a binary refuses a missing or mismatched count, so the hand-built
binary refuses to start with one line naming `fli cli:build`. **`routeFiles`** is the one
walk both use. `main()` prints a route-load error as one line rather than a stack.
**The sign-in hint names no `--url` when the program has a default** — the user of a
released binary has no way to fill one in. `run.test.ts` compiles a fixture surface and
runs it; removing `splitting` or the count reds a row.

**`login --api-key -` at a terminal asks** — `API key: `, unechoed, one line — where it
waited silently for an EOF. A pipe still reads stdin. `readSecret` is the option, and
`main()` gives it only when stdin is a TTY.

## 2026-09-25 — `narrow`, and a model-less CRUD verb graded by its declared gate

**`mcpPlugin({ narrow(tool, principal) })`** (`FJS-D407`, `FJS-1349`): a Guard an app
answers for an axis a standing is not — an API key's scopes. Only removes; a withheld
tool is not registered and cannot be called, breadcrumbs inherit it, and a throw fails
the list. Three rows in `plugin.test.ts`; a `narrowTo` that ignored the guard reds them.

**Over no model, a CRUD verb's declared gate grades it** (`FJS-D408`, `FJS-1342`), as
junction now enforces it: `method-gate` at the declared level, and `ungraded` where it
declares none — never `model-gate`, which named a rule that was not there. **The boot
warning names those ungraded tools** rather than every service with no model, so a fully
declared service such as basecamp's hub is not reported as graded by nothing.

## 2026-09-25 — breadcrumbs: what a one-row answer offers next

`FJS-D398`. A call answering one row — `get`, `create`, `patch`, `update`, `restore`, or
a move — carries `_meta['frontierjs/breadcrumbs']` and, when it is not empty, a second
text block for an agent reading only text: the moves the row's state allows, a `get` for
each foreign key it carries, and a `find` over the one foreign key pointing back at it.
**`src/breadcrumbs.ts` grades nothing**: each breadcrumb is a tool in the caller's own
projected list, narrowed by the row, so a move is offered at `max(model update, move
gate)` exactly as `tools/list` offers it — not off sierra's `transitionsAt()`, which is
out of reach and compares the weaker number. A second foreign key back to the same model
is ambiguous and left out; a row policy is not graded, the tool list's own limit. The CLI
prints each as the command line that runs it, on stderr so stdout stays the data (`servers
drain <id>`, `volumes find --serverId <id>`, `--query` for a column with no flag), and
under `--json` as `breadcrumbs` in the envelope. `test/fixtures/shop.lite` gained
`Customer` for the relation case. Proof: `test/breadcrumbs.test.ts` (mutation-checked:
the from-state filter, the offered filter, the ambiguity rule), the plugin rows over
real HTTP, and basecamp's `verify:cli`.

## 2026-09-25 — `--await`: a tool call held until the jobs it started finish

`FJS-D400` as amended by `FJS-D406`. A `tools/call` carrying `_meta:
{ 'frontierjs/await': true }` — the protocol's own extension slot, so no input schema
changes and a caller that never asks is answered as before — is held after the method
returns until every job the call dispatched is `done`, `failed` or `cancelled`. **The jobs
are FOUND, not declared**: the route reads the request's correlation id, which Caravan
stamped on each job at dispatch, and `src/await.ts` polls `app.jobs.findByCorrelation`,
keeping only jobs created during this call (a client may reuse an `x-request-id`). A
held call is answered as an SSE stream, since a hold outlives Bun's idle timeout and
the keep-alive frames are what keep it; each status that MOVES is sent as a
`notifications/progress` when the caller gave a progress token. The answer adds a second
text block naming each job and where it ended — what an agent reading only text is
told — and `_meta['frontierjs/jobs']`. `awaitMs` (default ten minutes) is the longest
hold. **Not seen, and said**: a job queued through the outbox (`ctx.enqueue`) and one
dispatched from inside a job carry no reliable correlation id. The CLI's `--await` sends
the key, prints progress on stderr, and exits 1 when a job did not finish `done`.
Proof: `test/await.test.ts` for the wait itself, and basecamp's `verify:cli`, where
`jobs trigger --await` answers with the very `job:run` Caravan's own table holds, already
terminal, after progress arrived; a wrong correlation id reds three rows.

## 2026-09-25 — an app's own commands: `cli/src/routes/` and `main(config)`

`src/client/routes.ts`: a file at `cli/src/routes/<service>/<method>.{js,ts}` is the
command `<service> <method>`, adding one the tool list does not carry or replacing the
derived one of its name (`FJS-D396`). A route declares the tools it `uses` and may call
no others; its flags are a JSON Schema `input` read by `argv.ts`, so `--help` and every
refusal read as a derived command's do. **`FJS-D396`'s start-up refusal is split in
two, because a client cannot tell a tool that is GONE from one this standing is not
offered**: at run time a route whose tools are not all in the caller's list is simply
not offered, and `checkRoutes(routes, tools)` — run against the app's top standing,
in the app's own drive — names a route whose tool no longer exists. `main(config)` is
an app's whole entry (`cli/src/main.js`): its name, its tenant header and the endpoint
a first `login` defaults to, with the environment still overriding per run; `bin.ts` is
the same call for an app with no `cli/`. Proof: `test/run.test.ts` § routes — a route
adding, replacing, not offered, a call outside `uses` refused, an app refusal exiting
1, `checkRoutes`, and `loadRoutes` refusing a file at the top of `routes/` — and
basecamp's `verify:cli`.

## 2026-09-25 — the app CLI keeps its command tree per build

`src/client/cache.ts`: `tools/list` — a quarter of a megabyte at basecamp's owner — is
kept under `$XDG_CACHE_HOME/<app>/tools/`, 0600, keyed by the endpoint, a DIGEST of
the key and the tenant, and answered only while the app states the build it was
listed at. The build comes off `initialize`'s own response (`x-fjs-build`,
`FJS-D160`, read through the transport's `fetch`), so a hit costs no second request.
**No build, no cache**: an app nobody deployed states none and is always listed live,
the build protocol's own rule. A standing that moved without a deploy is the one
thing the key cannot see, so a command missing from a cached tree is looked up live
before it is called *not offered*; a demotion leaves a command the app then refuses.
`FJS_CLI_TRACE=1` says on stderr where the tree came from. Proof: `test/run.test.ts`
§ the cache — one listing per build, a new build replacing it, none without a build,
another key missing, a promotion found live, and the file holding no key — and
basecamp's `verify:mcp`, whose API now states a build: live, then cache, same rows.
A cache that never hits reds that row.

## 2026-09-25 — the app CLI signs in: profiles and `login --api-key`

`src/client/profiles.ts` keeps one file per app under `$XDG_CONFIG_HOME/<app>/`,
written 0600 and replaced by a rename, one entry per profile — the endpoint, the key
and the current tenant. Four commands are the program's own and win over a service of
the same name: `login --api-key <key|-> --url <mcp>`, `logout`, `profiles` (the key
masked) and `use <tenant>`; `--profile` picks one, and the environment still
overrides a profile for one run. **A mistyped key would have signed in**: junction
reads a Bearer it cannot verify as NOBODY rather than refusing it, so `login`
compares the tool list with the key against the list with nothing, and refuses a key
the app reads as nobody without saving it. Proof: `test/run.test.ts` § profiles, and
basecamp's `verify:mcp`, which signs in with a key on stdin and then runs with no
endpoint or key in its environment; skipping the comparison reds the mistyped-key row.
**`use <tenant>` is not the spelling `FJS-D399` wrote** (`workspaces use <id>`):
`workspaces` is basecamp's noun, and a generic program cannot know an app's —
reconciled in `IDEAS/app-cli.md` § Open questions.

## 2026-09-25 — the app CLI runs: `run()` and `bin.ts`

`run(argv, opts)` connects to an app's `/mcp`, reads `tools/list` at the caller's
standing as the command tree, and runs one command; `src/client/bin.ts` is it as a
process, configured from `FJS_MCP_URL` · `FJS_TOKEN` · `FJS_TENANT_HEADER` ·
`FJS_TENANT` until profiles exist. A command not in the list is *not offered at your
standing, or does not exist* — the two cannot be told apart from the client.
`--json` is `{ ok, data }` / `{ ok: false, error }`, `--quiet` the rows alone, and the
default a table. `--help`, `<service> --help`, `<service> <method> --help`, and
`--help --agent` printing the tool's input schema verbatim. `--workspace <id>` sends
the tenant on the CONNECTION, since the list itself is graded at the role that
tenant's membership gives (`FJS-D399`); after the command it is still the tenant
unless the command has a `workspace` column, which is refused by name rather than
guessed. Exit codes: 0 ok · 1 refused by the app · 2 usage · 3 unreachable. Adds
`@modelcontextprotocol/client` as a dependency. Proof: `test/run.test.ts` for the
globals and exit codes, and basecamp's `verify:mcp` § the app CLI, which spawns the
bin — `servers find` matches the tool call, a filter matches, `--workspace` switches
tenants, and a bot key minted through `api-keys create` signs the CLI in and is
refused a write outside its scope. Sending no tenant header reds eight of its nine.

## 2026-09-25 — `@frontierjs/mcp/client`: a tool's schema read as a command line

The first piece of the app CLI (`IDEAS/app-cli.md`, `FJS-D396`–`FJS-D403`), held
here until its package is named. `commandFor(tool)` turns one `tools/list` entry into
`<service> <method>` with its flags; `parseArgs(command, argv)` turns a command line
back into the tool's arguments. **The schema types each value** — `--reference 0012`
stays text, `--limit 12a` is refused by name — and only an untyped value
(`--orderBy`) falls back to `@frontierjs/toolbelt/query`'s reading. Structure is the
wire's bracket notation (`--total[gte] 5`, `--status[in][] paid`); nested input is
JSON, `@file` or `-`. A read-only column is refused as a flag, and a column named
like the whole-payload flag (`Secret.data`) keeps it. Proof: `test/argv.test.ts`
over 526 tools captured from `example` and `basecamp` — every tool reads as a
command, every top-level argument is reachable, and every flag of every tool set at
once parses into arguments the server's own `fromJsonSchema` validator accepts;
returning an integer as text reds three rows. By kind: example 110 flags · 5 flags
plus JSON · 83 id only · 42 `--data` only; basecamp 77 · 6 · 80 · 123.

## 2026-09-25 — the tool list is graded at the standing the principal resolver answers

Under `strategy row` with `createApp({ principal: membershipClaim(…) })` the
standing is a claim the resolver adds per call, and the session carries none of it.
The plugin graded the session, so every member graded as a bare sign-in:
**measured on basecamp, the owner saw 286 tools and an admin, a developer and a
viewer 109 each, the same 109.** `standingOf` now asks through `app.withDb`, which
runs the app's resolver; with it the four answer 286 · 278 · 208 · 152. An app
with no `app.db` (`strategy database`) keeps the old path. Proof:
`test/principal-standing.test.ts`, a membership app over a real Litestone client —
admin and viewer of one workspace a role apart, and the admin naming no workspace
offered nothing; reverting `standingOf` reds two of its three.

## 2026-09-25 — `find` says what it filters on

A `find` tool's `query` was an untyped object and every directive was `{}`, so an
agent reading `orders_find` could not see that `status` is a filter or that
`limit` is a number — measured over `example`, 38 of 240 admin tools
(`IDEAS/app-cli.md` § Measured). `query` now lists the model's scalar columns,
minus any carrying `x-filterable`, each as its type OR an operator object, and
stays open for relation paths and `AND`/`OR`. The operator half is load-bearing:
the SDK validates before dispatch, and a column typed as its value alone would
refuse `{ status: { in: [...] } }`, which the Data boundary takes. Directive
types come off `@frontierjs/toolbelt/directives`' new `DIRECTIVE_SCHEMAS`.
Proof: three rows in `test/projection.test.ts` — the `x-filterable` one goes red
with the skip removed — and `verify:mcp`, where a real client sends a plain
filter, an operator filter and a mistyped `limit`.

## 2026-09-21 — the `FJS-976` notes name Litestone Studio

`README.md` and `PROJECT_STATE.md` cite the table dump that shipped `@secret`
columns in plaintext; both said *Studio*. The term is **Litestone Studio** —
`VOCABULARY.md`, and `packages/litestone/CHANGES.md` for why.

## 2026-09-21 — the suite directory is `test/`

**`tests/` is a surface, not a suite.** In an FJS app it sits beside `api/` and `web/` and holds
what belongs to no single surface, while a surface's own tests are its `test/` (Invariant 3). A
package is not an app — it has one `src/` — so its suite is `test/`, and this one moved. Eight
packages spelled it plural and eleven singular with nothing in the tree deciding between them,
which made the directory name a coin flip on every file added.

## 2026-09-20 — the bun floor is `1.4.0`

This package is bun-only and declared no `engines` at all, so it stated its runtime nowhere. An
engine range is advisory anyway — bun runs an app whose floor it does not meet — so a machine one
minor behind reports the feature it cannot reach as MISSING rather than reporting itself as stale.
`fli doctor` grades the installed version against this floor now, which is the half a
`package.json` field cannot enforce on its own.

## 2026-09-20 — a real MCP client, against the real shop

`example` mounts `mcpPlugin()` and `verify:mcp` drives it with
`@modelcontextprotocol/client` — the handshake, the capability negotiation and
the framing a person's editor runs. **Everything before this was this repo
talking to itself**: `fetch` plus a hand-written JSON-RPC envelope, which agrees
with a server that gets the protocol wrong in the same way. 22 checks.

**Three things only this can ask**, and each was a claim standing on nothing:
that a real client connects at all; that the surface works on an app with no
`app.db` (`tenancy { strategy database }`, the shape that made the first draft
serve a permanent 503 on this very app); and that the ladder holds against a
real seed rather than a fixture.

**The drive got the ladder wrong twice on its first run, and both corrections
are the content.** `sam@shop.test` carries `isStaff` and reads every order in
the shop — and is NOT level 5, so the refund move is the administrator's and not
"staff's". Worse, `sam` and `robin` are offered the **identical tool list**: a
row policy moves nobody up a rung, so **the list is the LADDER's and the rows
are the POLICY's**, two mechanisms this file had been describing as one. They
are asserted as a pair now — one list, two different order counts from it.

**What is gated is the RELATIONS, not the counts.** A stranger sees fewer than a
shopper, a shopper fewer than an administrator, nothing is lost by climbing, and
no protected column reaches any tool — with the protected set derived from what
the two audiences disagree about rather than typed, and a control that the shop
declares any. Absolute counts stay out of the drive deliberately: `FJS-773` is
what a typed-in count does when the app grows.


## 2026-09-16 — the transport, mounted inside the app that is already running

`mcpPlugin()` ships. An MCP client can reach a FrontierJS app for the first time:
`tools/list` is the projection at the caller's own standing, `tools/call` goes
through `app.service(name)` with `{ auth: { user } }` at Junction's
`CALL_OPTIONS_AT`, and the Data boundary grades it again on the way through.

**A plugin rather than a stdio process, and the reason is what a boot DOES here.**
stdio carries no request, so a server spoken to over stdin has to boot the app
itself — which starts a SECOND Caravan worker on `jobs.db` claiming the shop's
payroll and dunning jobs, runs the migration differ against the database, and
dies whole if any plugin's `boot()` fails (measured, on a caravan change in
flight). Two processes is also two event buses, so an agent's write announces to
nobody the open tabs are listening to, and a revoked session closes a socket this
process does not have. Mounted in the API: one boot, one worker, one bus, the
real `Host`, and the standing re-read per request.

**Three crossings, each of which broke and each of which is now a paired test.**

*The body is gone.* `transport/http.ts` parses every matched request before the
route handler runs and `body.ts` reads `req.arrayBuffer()` with no clone, so
handing `ctx.$raw.$req` to a fetch-style handler hands over a spent Request. The
MCP transport answers `400 Parse error: Invalid JSON`, a message about JSON with
nothing to do with the JSON. `replayBody` rebuilds it from `ctx.rawBody`;
measured both ways. **The same mistake is live in
`junction/src/auth/providers/better-auth.ts:264`** — `auth.handler(ctx.$raw.$req)`
on `app.post('/auth/{path}')`, offered by `junction init` and exercised by no app
or test here, so every sign-in through it arrives with an empty body. Filed.

*The keep-alive outlives the socket.* The SDK's SSE interval defaults to 15s and
`http.idleTimeout` to Bun's 10s: the stream is cut five seconds before the frame
that would have held it open. Measured — dead at 12s, alive past 13s with the
interval under the timeout. `keepAliveMs` defaults to 5s here.

*There is no `app.db` under `tenancy { strategy database }`.* `example` is exactly
that shape, so reading the schema off `app.db` answered null and the endpoint
would have served a permanent 503 on the flagship app in this repo.
`registry.schema` is the declared answer and is the right one rather than a
fallback: opening a tenant to read `@@gate` off a client would make LISTING TOOLS
create a database file.

**The SDK, probed rather than assumed.** `@modelcontextprotocol/server@2.0.0`'s
core transport is Web-standard — `handleRequest(req: Request): Promise<Response>`,
which is the shape a Junction raw route already returns; the Node
`IncomingMessage`/`ServerResponse` transport is the WRAPPER, not the base.
`fromJsonSchema` carries a projected schema across — and **installs a default
validator when none is passed**, which the first draft of this entry claimed it
did not. So the SDK grades every tool argument before the handler runs: a second
engine over one schema, and the two disagree. Measured: `total: "2500"` against
an `Int` column is refused by the surface and COERCED by the Data boundary, so
the agent path is stricter than the HTTP one. It fails in the safe direction and
the message names the field, so an agent corrects and retries; whether to pass a
pass-through validator and leave the grading to the one owner is open, and named
in `PROJECT_STATE.md`.

**A fourth grading input, which this package read none of for its whole first
life.** `describe().methodGates` is the level a custom method declared, and
`gateAuthAround` grades a custom verb through `customMethodGrade` — a declared
number where there is one, otherwise the model's read gate as a PRESENCE check,
and nothing at all where the model declares no `@@gate`. Reading three inputs
where the boundary reads four is how a list offers what the boundary refuses.
`customMethodGrade` is IMPORTED rather than restated: it is a pure function of two
plain records, and a fifth copy of a gate rule in this repo is the disease
`FJS-D197` named. Two verdicts follow it — `method-gate` (a number that is
compared) and `method-floor` (a session, with the level not compared). `needs`
stays `null` for the floor, because naming the read gate there would state a
requirement no caller is held to.

**Four defects in what the projection shipped, all found by trying to serve it.**

- *Every tool name was rejected outright.* A client matches `^[a-zA-Z0-9_-]{1,128}$`
  and a dot fails it, so `orders.refund` invalidated the whole list rather than
  the one tool. `orders_refund` now, derived in the projection rather than
  rewritten at the transport, so one name exists. Two methods deriving one name
  are BOTH withheld and reported — keeping either is an agent calling a name and
  the client deciding which method runs.
- *Every enum pointed at a document that was gone.* A model `$def` is lifted out
  to become one tool's input, and `#/$defs/OrderStatus` resolves against the root
  — which is then the tool schema itself. `inlineEnums`, plus a walk that carries
  in whatever refs survive with their definitions.
- *Money was an integer with nothing saying so.* `{"type":"integer","x-money":{}}`
  invites an error of a hundred times on a refund. It becomes a description; the
  SCALE is deliberately not stated, because the generator declines to resolve it
  and a number right two thirds of the time is worse than none. 21 of them over
  `example`, each naming that app's declared currency, and no `x-money` left in
  any tool schema.
- *Move tools could not be called.* A move carried no argument schema, so
  `orders.refund` was listed, correctly graded, and had no way to name a row.
  Every non-CRUD verb is dispatched through `call(name, id, data, opts)` and its
  input is now shaped to match: a move takes an id and is required to; a custom
  method with a declared type takes both; one with nothing declared keeps `data`
  open rather than guessed shut, which is `find`'s `query` rule.

`x-` keywords are dropped from every tool schema. `x-gate` and `x-transitions`
are the model's access rules and an argument schema is not where a caller's
permissions belong — the projection already answered that by deciding whether the
tool is listed. `x-transitions` was also the largest keyword on the page, paid for
in the context window of every call.

**Measured over `example` — 44 services, 248 methods.** 54 tools at STRANGER, 88
at VISITOR, 142 at USER, 245 at STAFF, 248 at SYSTEM; none withheld from
everybody. Verdicts: 186 model-gate, 12 move-floor, 13 method-gate, 16
method-floor, 21 ungraded. 236 of 248 carry an argument schema, and no collision.
The earlier numbers in this file (63/114/196, 157 of 203) are superseded twice
over — by `methodGates` and by the app itself having grown.

**The credential claim is derived now rather than asserted.** The protected set is
exactly what `audience: 'client'` and `audience: 'system'` disagree about: 12
columns across `example` (`Credential.value`, the OAuth tokens, `Session.token`,
`Cart.token` and the rest), and none reaches any tool schema. A column named
`secret` does appear — `FlowCredential.secret`, which is `@encrypted` rather than
`@guarded`, a field a caller WRITES when creating a credential. Encryption at rest
is not a read policy and the two must not be conflated.

**A real drive, finally.** `test/plugin.test.ts` boots a real Junction app over a
real Litestone client on a real port and speaks JSON-RPC to it — 13 rows, every
visibility one a PAIR a rung apart, and a move that actually moves the row.
**Two of those rows were one row that claimed the wrong thing**, and driving the
real shop is what caught it: a withheld tool is not registered for that caller at
all, so calling it answers the protocol's *unknown tool* — fail-closed, and not
the boundary. Invariant 6 needs a tool the caller IS offered and the boundary
still refuses, which is now its own row: `refund` on a PENDING order, a legal
caller making a legal call on an illegal transition, with the same tool on a paid
order beside it as the control. That is the gap `PROJECT_STATE.md` had been naming since the package
existed; what is still ungated is the numbers above, which are a hand measurement
against `example`.


## 2026-09-12 — `@system` on a move is not a grade

`FJS-1087`. `move-system` withheld every `@system` move from every standing, reading the
attribute as *no caller*. `FJS-D150` rules the opposite: `@system` says whose DECISION a move
is, `@gate` how senior a caller must be, and the method that lifts it does so on the caller's
client with `{ system: true }`, which keeps the gate and every row policy. So a `@system` move
is `move-floor` like any other and the verdict is gone. Over `example` the tools withheld from
everybody went from 4 — `invoices.settle`, `payRuns.calculate`, `payRuns.pay`,
`subscriptions.cancel` — to none; staff (5) see 207 of 209, a user (4) 122. The fixture gains
`Order.lapse`, `@system` on a model updated at 4, offered at 4 and withheld at 3, with
`invoices.issue` on a model written at 8 as the control. Restoring the withhold reds that row.

## 2026-09-12 — a tool says what to send, and the audience is not a parameter

`projectTools` takes `SchemaViews` rather than a `$defs` map, and every tool
carries an `input` — a JSON Schema and the source it came from.

**The audience moved INTO the package, which is the whole point of the change.**
`generateJsonSchema`'s `audience: 'system'` includes `@guarded` and `@secret`, so
a caller passing their own defs could put `Credential.value` and the OAuth tokens
into a TOOL DESCRIPTION — disclosed before any call is made, to a caller whose
job is reading what it is given. It is also the tempting default: *the agent acts
for the application, so give it what the application knows*. `FJS-976` is what
that reasoning cost one realm over. `schemaViews(schema, generate)` owns the
three calls and there is no way through this module to ask for the other
audience.

**Sources, never a fallback shape.** `create-mode`, `update-mode` (with `id`
stripped out of the changes, since the tool carries it as its own argument),
`declared-type` from `describe().inputs`, `id`, `query`. Anything else is `null`
— including `aggregate`, whose spec is an allow-list rather than a shape.
**`null` and not `{}`**: an empty object schema accepts anything, which is a
claim an agent will act on and the boundary will refuse.

`find`'s directive names come from `@frontierjs/toolbelt/directives` rather than
being spelled here, so a directive the Data realm grows arrives without this file
being opened — and they carry no `$`, because the prefix is wire syntax that does
not survive the bridge (Invariant 10).

**The fixture is real `.lite` source now**, parsed and run through the real
generator, replacing a hand-built `$defs` blob. A blob is a guess at what the
generator emits, and two of the three findings this package was built out of were
wrong guesses about exactly that.

Over `example`: 157 of 203 tools carry an input schema, 46 do not, and no
credential material appears in any of them. Measured against stubs — flipping
the audience to `system` reds 3 rows, leaving `id` in the patch changes reds 1,
returning `{}` instead of `null` reds 2.

## 2026-09-10 — the package, and the tool projection

`FJS-D258` named it. What landed is `projectTools()` and nothing else: the tool
list one standing may see, each answer carrying the rule that decided it.

**Three inputs, because two grade only the half nobody wanted an agent for.** The
method policy and the model's `@@gate` narrow the CRUD verbs. The custom methods
— the ones somebody would actually delegate — are not gate positions at all, so
permissive-unknown answered *yes* for every one of them: `orders.refund` and
`payRuns.pay` were offered to an anonymous caller. `x-transitions` is the third
input and it grades them.

**A move's gate is a floor over the model's update level.** Litestone's catalog
says so and `example` measures the difference: `invoices.void` is `@gate 5` on a
model written at 8.

**`describe().model` is not reliably a model**, which is the finding that makes a
projection quietly permissive rather than broken. Junction defaults it to the
service name, so `orders` names no `$def`, every rule on `Order` resolves to
`undefined`, and the most heavily gated service in an app comes out open with
nothing failing. Resolved through `@frontierjs/toolbelt/inflect` now, with what
still does not resolve REPORTED — an open tool list and an ungoverned one are
otherwise the same list.

Against `example`: 63 tools at STRANGER, 114 at USER, 196 at STAFF, 4 withheld
from every standing, 6 graded by a declared move, 31 still ungraded.

**Two shapes the tests build by hand because that app has neither**: a LOCKED
gate on a model whose service still offers the method (every `@@gate` 9 there
sits behind a method policy that removed the verb first, so the gate is never
consulted), and the `describe().model` trap. Measured against stubs — removing
the inflect resolution reds 3 rows.
