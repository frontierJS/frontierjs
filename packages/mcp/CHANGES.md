# Changes — @frontierjs/mcp

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

**A real drive, finally.** `tests/plugin.test.ts` boots a real Junction app over a
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
