---
id: agent-surface
status: proposed
dated: 2026-09-10
---

# Idea — The agent surface: an MCP server derived from the seed

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. No code in this repo
implements any of it, and no package depends on MCP. Do not cite this file as
describing behavior — see `VERIFYING.md`.

**Extended 2026-08-24** with the approval gate below, from an audit of
[open-mrp/api](https://github.com/open-mrp/api) — a manufacturing ERP whose agents
run against its own public API. It is field evidence for three claims this file
already made and the answer to one of its open questions; it is still not built here.

**"Agent" in this file means an AI caller, and now means nothing else in the
repo.** `FJS-D29` (2026-08-13) gave the word to this side and renamed the fleet
process Basecamp installs to **Outpost**, under the rule *infrastructure takes
place nouns, AI takes personified nouns*. So a grep for `agent` outside historical
files is a grep for this proposal.

**Probed against the tree 2026-09-10, before any code was written.** Three claims
this file made about the seams were wrong, and the central claim was measured
rather than argued — see § *What probing changed* and § *The measurement*. Still
not built; what changed is that the design now names owners that exist.

---

## The claim

Every application now wants to be callable by an agent, and the industry's actual
unsolved problem is not *exposing* tools — it is **scoping** them. Hand-writing an
MCP server means writing a tool definition per operation, a JSON Schema per input,
a description per tool, and then inventing an authorization story from nothing,
usually as prose in a system prompt.

FrontierJS already has every input to that, and the one nobody else has:

| MCP needs | FJS already produces it |
| --- | --- |
| tool list | the service registry — `find/get/create/patch/remove` + custom methods |
| input schema per tool | `generateJsonSchema(schema)`, the same `$defs` table the browser gets |
| tool descriptions | `@@description` / field docs + the `/manifest` plugin |
| **what the caller may do** | **`@@gate`, enforced at the Data boundary** |
| result shape | the envelope (`kind`/`data`/`total`) |
| what it may reach outward | Conduit's declared targets |

The fourth row is the whole idea. Everywhere else, "limit what the agent can do" is
a prompt, a hand-rolled allowlist, or a separate API surface built for the purpose.
Here it is a number that already exists, enforced in the database layer, that the
agent cannot talk its way around because there is no handler to persuade.

## Shape

```
fli mcp:serve                    # stdio, for a local agent
fli mcp:serve --http :7100       # remote, session-authenticated
```

The server mounts the app's own services. A session carries a gate level exactly as
an HTTP request does — via `IAuth.verifySession` and `sessionGateLevel()` — so:

- an agent acting as an anonymous caller sees only what `@@gate` opens at level 0;
- an agent acting for a level-4 user gets that user's tools, that user's rows
  (`@scoped`), and never sees a `@guarded` column in any result;
- `LOCKED` operations are not exposed at all, because they are not reachable.

**Tool visibility should be derived from the gate, not just enforced by it.** An
agent that can see a `deleteUser` tool and always gets a 403 wastes turns and
invites jailbreak attempts. Compute the tool list per session level so the tool
simply is not there — `canAtLevel()` answers that for the CRUD verbs, and is
already used for the same purpose in the UI (`resource.can()`).

**It is not the whole question, and the shortfall is measured rather than
suspected**: a custom method's name is not a gate position, so `canAtLevel` alone
answers permissive for every verb an agent would actually be delegated. The
missing input is `x-transitions` — see § *The narrowing is all CRUD*, which is
where the rules and the numbers are.

## Why this is stronger here than anywhere else

- **The permission model is data, so it is auditable.** "What could this agent
  have done?" is answerable from `schema.lite` plus a level. That question has no
  answer at all for an MCP server built by hand.
- **Enforcement is below the tool layer.** A bug in tool definition cannot widen
  access, because the gate is checked in Litestone regardless of how the call
  arrived. This is the same property that makes `IDEAS/slices.md` argue a Gate on a
  Model is harder for an agent to get wrong than a check in a handler — the same
  argument, pointed at the agent instead of at the code it writes.
- **Descriptions can be honest.** The schema knows a field is an enum with three
  members, is nullable, references `Account`. Those are the facts an agent needs to
  call a tool correctly on the first attempt, and they are the facts a hand-written
  tool description gets subtly wrong.
- **Conduit bounds the blast radius outward.** An app's complete outbound surface is
  enumerable by design, so "what can this agent cause to leave the building" has an
  answer too.

## The approval gate — the half this file was missing

Everything above scopes an agent *before* it acts: compute the tool list from the
level, and the tool the agent must not call is not there. That is the right default
and it has a ceiling. Some operations are ones a caller genuinely may perform and
should not perform **unattended** — refunding money, mailing a customer, releasing a
schedule. Tool visibility has two settings for those and both are wrong: expose it
and an agent does it at three in the morning, hide it and the agent is useless for
the work people actually want delegated.

OpenMRP's answer is a third setting, and it is the one worth taking: **a protected
tool call stops the run.** The write is held as a proposal, a human approves it by
name, and only then does the run continue from where it stopped. The screenshot in
that project's README is an agent holding two writes at a gate — it is the feature
they lead with, which is a signal about what buyers ask for.

Two things make it FJS-shaped rather than a bolt-on:

- **What is held is a Service call, not a diff.** The proposal is `(service, method,
  id, data)` — a value the bridge already knows how to turn into a `ServiceContext`
  — so approving it is executing it through the ordinary path, with the gate, the
  validators, the announcement and the audit actor all unchanged. Nothing has to
  replay a write.
- **Which calls are held is derivable.** `@@transitions` already carries a per-move
  `@gate`, `@@gate`'s four positions already separate read from update from delete,
  and `retryable` already separates a race from a refusal. *Above this level, an
  agent proposes rather than writes* is a threshold on a scale that exists, not a
  new vocabulary — one number in the projection, and the second half of the answer
  to the open question below.

What it needs that does not exist: **a run that survives a restart with a human in
the middle of it.** That is 4.19 exactly — a multi-step process, resumable,
compensating, with a point past which it only goes forward — arriving from a third
direction after `release-transitions.md` phase 2 and Caravan's ladder. The
recommendation is not to build a run engine inside `@frontierjs/mcp`: it is that the agent
run is the **third** caller for the durable-workflow noun, and three callers is when
a noun gets ruled rather than invented locally for the third time. A run is a Model,
its steps are Services, and it inherits gates, audit and the derived suites — the
position 4.19 already states.

Three smaller things that come with it, all cheap once the run is a row: an agent
**memory** (a row, scoped like any other), a **run log** answerable to *what did
this agent do* (`compliance-from-the-seed.md`), and a **dry run**, which item 4
below already names and which is the same projection with every call held.

## What probing changed

Written off the source on 2026-09-10. Each of these was an owner this file named
from memory, and the tree disagreed; § IV's *doctrine vs. discovery* says the code
wins and the divergence is written down rather than left.

**1. `bridge.toContext()` is the wrong seam.** It is HTTP-shaped — it reads an
`X-Service-Method` header, a route id, a `$`-prefixed query string and a multipart
body, none of which an MCP call has. The in-process path that runs the identical
pipeline is `app.service(name)` with `{ auth: { user } }` in `CallOptions`, which
is what `@frontierjs/testing` already binds a principal through. The transport is
therefore not a fourth bridge; it is a caller.

**2. `canAtLevel()` and `buildGate()` live in Sierra**, which an API-realm package
may not import (Invariant 1). Both are thin over `@frontierjs/toolbelt/gate`'s
`levelPasses`, and the ladder already has a ruling about hand copies drifting
(`FJS-D197`). The move is to `@frontierjs/toolbelt/gate`, with Sierra importing it
— a fifth copy is the thing that ruling exists to refuse.

**3. Dispatching a tool needs the argument position of `CallOptions` per method,
and that table was hand-copied once** — as `OPTS_AT` in `@frontierjs/testing`,
which refuses an unknown method rather than guessing because a guess binds the
principal at the wrong argument and the call runs as STRANGER. **Done, ahead of
the surface** (`FJS-D258`): it is `CALL_OPTIONS_AT` in Junction now, beside the
`ServiceCaller` interface it describes, graded there against a real caller in
both directions, and the copy is deleted. Junction's check and the consumer's
refusal ask different questions — *is the table right* and *does the INSTALLED
Junction offer something this table has never heard of* — so both stay.

## The measurement

The claim under everything here is *the tool list is derived from the seed and
narrows with the standing*. It was run against `example`'s real app — 38 services,
76 models, 43 of them gated — by booting the app in process and projecting
`describe().methods` through each model's `x-gate`:

| Standing | Tools |
| --- | --- |
| STRANGER (0) | 94 |
| USER (4) | 126 |
| STAFF (5) | 203 |
| OWNER (6) | 203 |

203 tools declared, 109 of them invisible to a stranger, and no hand-written
allowlist anywhere. The projection applies the method policy first and the gate
second, and the two already agree where they overlap: `journalEntries` declares
`@@gate` 9 for update and delete AND `methods: ['find','get']`, so the locked
operations are gone before the gate is consulted.

**Which is the hole in the measurement and must be named.** No model in `example`
offers a method the policy allows and a LOCKED gate refuses, so the projection's
handling of 9 is unexercised — `levelPasses` against a bare `>=` is exactly the
`FJS-D197` shape, and this app cannot tell them apart. A fixture with that one
shape in it is the first test, not the last.

**The permissive-unknown rule is a decision, not a default.** 33 of 76 models
declare no `@@gate`, and an ungated model contributes every one of its tools at
level 0 — which is why a stranger sees 94. Sierra's rule is permissive because
hiding a control the user could have used is the quieter failure; for an agent the
same tradeoff holds with different stakes on both sides (a tool that always 403s
burns turns and invites a jailbreak attempt; a hidden one makes the agent useless).
It stays permissive and the reason is recorded here, because visibility is an
affordance and Invariant 6 already says the server enforces regardless.

## The narrowing is all CRUD, and the interesting half is ungraded

Measured the same day, one level deeper, and it changes what the projection is.
The 94 → 203 spread above is **entirely the CRUD verbs**. Run the same walk over
the CUSTOM methods alone and the answer does not move at all:

| Standing | Services offering custom tools |
| --- | --- |
| STRANGER (0) | 15 |
| USER (4) | 15 |
| STAFF (5) | 15 |

Byte-identical lists. A stranger is offered `orders.refund`, `payRuns.pay`,
`employees.setPay`, `invoices.void` and `inventory.adjust`.

**The cause is structural, not a bug in the walk.** A custom method's name is not
one of `@@gate`'s four positions, so the permissive-unknown rule answers *yes* for
every one of them — and permissive there is a WRITE. The boundary is unharmed: the
service's own hooks and the model's `@@transitions` refuse the call. But visibility
is the half this proposal leads with, and it is worthless for exactly the tools
somebody would delegate. `find` on `Product` is not what anyone wants an agent for.

**The seed already carries what the projection is missing, and it is a second
keyword rather than a heuristic.** `x-transitions` is on the generated schema per
`FJS-999`, keyed by field then by move, each carrying `{from, to, gate, system}`.
`example` declares 15 moves:

| Model.field | Moves |
| --- | --- |
| `Order.status` | pay · ship · **refund `@gate 5`** · cancel |
| `Invoice.status` | issue `@system` · settle `@system` · **void `@gate 5`** |
| `PayRun.status` | calculate `@system` · revert · **approve `@gate 5`** · pay `@system` |
| `Subscription.status` | activate · lapse · recover · cancel — all four `@system` |

Three of the fifteen carry their own gate and eight are `@system`. So three rules
fall out, in descending value:

1. **A `@system` move is visible to nobody, at any standing.** It is the verb
   half of `LOCKED` and it is the largest single subtraction available — eight of
   fifteen moves in this app, `subscriptions.activate` among them. A caller cannot
   drive one by construction, so offering it is pure jailbreak surface.
2. **A move's own `@gate` is a FLOOR on top of the model's update level, and the
   tool needs the higher of the two.** Litestone's catalog states it —
   *`@gate(N)` on a move is a floor on top of the model update level* — and
   `example` proves why the distinction is not pedantry:

   | Tool | model `update` | move `@gate` | needs |
   | --- | --- | --- | --- |
   | `orders.refund` | 4 | 5 | **5** |
   | `invoices.void` | 8 | 5 | **8** |
   | `payRuns.approve` | 5 | 5 | **5** |
   | `orders.pay` | 4 | — | **4** |

   Grading by the move's own number alone offers `invoices.void` at STAFF(5) when
   the boundary needs 8. That is a WIDENING, which is the one direction that is a
   security-shaped mistake rather than a missing affordance — the whole `Invoice`
   model is system-written here, which is why it is the row that catches it. The
   first draft of this section had that rule wrong and the app is what said so.
3. **A custom method backed by no declared move is UNKNOWN and must stay so.**
   `carts.checkout`, `payments.start`, `inventory.adjust` drive no `@@transitions`
   field. Nothing in the seed says what standing they need, so a projection that
   guessed would be inventing access. This is the case the hold exists for — not
   a default to be picked.

**The negative control, which any fix has to keep passing.** `carts.*` at
STRANGER is CORRECT: a guest basket is owned by a caller with no session at all,
through the `cartToken` claim, and `example`'s own `verify:cart` drive exists to
prove it. A rule that withheld everything at level 0 would read as a tightening
and would break the storefront. *Visible at 0* is therefore not evidence of a
hole, which is what makes this measurable rather than a matter of taste.

**What it means for the projection.** Item 1 below is no longer *`describe()` plus
`generateJsonSchema`*. A tool's visibility has three inputs — the method policy,
the model's `@@gate`, and the move's own `gate`/`system` — and the third is the
one that reaches the verbs. A projection reading the first two is the read-side
agent, which is useful and is not the claim this file makes.

## What would have to be built

1. **A tool projection.** `describe()` + `generateJsonSchema` → MCP tool
   definitions. Mechanical, and now measured; both halves exist.
2. **Per-session tool filtering** against the session's level, through the kit's
   `canAtLevel` — and over all THREE inputs, or it grades only the CRUD half (see
   § *The narrowing is all CRUD*). A `@system` move is withheld from everybody, a
   gated move takes its own number, and a custom method backed by no move stays
   unknown rather than guessed.
3. **A transport.** stdio and HTTP, dispatching through `app.service(name)` per
   change 1, so no second execution path exists to diverge from the first.
4. **A read-only mode and a dry-run mode.** Not derivable — an explicit choice,
   and the first thing anyone will ask for.
5. **A hold.** A protected call becomes a proposal row, a human approves it by
   name, and the run resumes. Depends on the durable-workflow noun (4.19) rather
   than defining one here.

**Home: `@frontierjs/mcp` — ruled 2026-09-10, `FJS-D258`.** A Junction plugin
plus a transport, outside Junction because MCP is a dependency Junction should
not acquire. The name argument, and the metaphor/plain-word split it rests on,
are in the ruling rather than restated here.

## Open questions

- ~~**Does an agent get a gate level of its own?**~~ **Answered by the approval
  gate, 2026-08-24.** The cleanest answer was always that an agent is never a
  principal — it acts *for* a session and its ceiling is that session's level — and
  the objection was the background agent with no human behind it. The hold settles
  it without a tenth level on a scale that is already too linear
  (`pros-and-cons.md` con #2): the ceiling stays the session's, and above a
  threshold the call becomes a proposal instead of a write. A background agent with
  nobody behind it is then not a caller with special standing; it is a caller whose
  every protected move waits. What remains open is **who may approve** — which is a
  grid question, not a ladder one, and therefore `IDEAS/permission-sets.md`.
- **Custom methods are the interesting tools and they dispatch by header**
  (`X-Service-Method`). MCP has no such concept, so the projection must name them
  directly — `posts.publish` — which is an argument that the header dispatch was
  always an HTTP-shaped decision leaking into the service model. *Half answered
  2026-09-10 by measurement:* they are indeed the interesting tools, and they are
  the ones the gate says nothing about. Naming is the smaller half; grading them
  off `x-transitions` is the larger, and the remainder is the third rule above —
  a custom method that drives no declared move.
- **Does the agent surface get its own audit trail?** Almost certainly yes, and
  `IDEAS/compliance-from-the-seed.md` is where it should land rather than here.
- **Rate limiting and cost.** An agent will call `find` in a loop. `ctx.directives`
  already carries `limit`; a maximum per tool is probably a projection concern.
- Does this obsolete or complement the typed browser client? They are the same
  services with different consumers, which suggests the projection is a third
  client generator, not a special case.

## See also

- `IDEAS/package-map.md` — where it sits among the proposed packages
- `IDEAS/compliance-from-the-seed.md` — the audit and disclosure half
- `IDEAS/slices.md` — the "a Gate is harder for an agent to get wrong" argument, in
  its original context
- `IDEAS/permission-sets.md` — who may approve a held call; the grid the ladder
  cannot express
- `IDEAS/operational-edge.md` 4 — durable workflows (4.19), the noun the hold needs
- `CLAUDE.md` § Bridge index — `bridge.toContext()`, `sessionGateLevel()`,
  `generateJsonSchema()`, `canAtLevel()` are the four seams this is assembled from
