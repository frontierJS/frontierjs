# Changes — @frontierjs/mcp

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
