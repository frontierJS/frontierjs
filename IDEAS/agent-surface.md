---
id: agent-surface
status: idea
dated: 2026-08-04
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
simply is not there — `canAtLevel()` already answers exactly this question, and it
is already used for the same purpose in the UI (`resource.can()`).

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
recommendation is not to build a run engine inside `herald`: it is that the agent
run is the **third** caller for the durable-workflow noun, and three callers is when
a noun gets ruled rather than invented locally for the third time. A run is a Model,
its steps are Services, and it inherits gates, audit and the derived suites — the
position 4.19 already states.

Three smaller things that come with it, all cheap once the run is a row: an agent
**memory** (a row, scoped like any other), a **run log** answerable to *what did
this agent do* (`compliance-from-the-seed.md`), and a **dry run**, which item 4
below already names and which is the same projection with every call held.

## What would have to be built

1. **A tool projection.** Service registry + `generateJsonSchema` → MCP tool
   definitions. Mechanical; both halves exist.
2. **Per-session tool filtering** via `canAtLevel()` against the session's level.
3. **An MCP transport.** stdio and HTTP. Junction's bridge already turns a request
   into a `ServiceContext` and a result into a response — this is a third transport
   beside HTTP and WS, not a new execution path. Reuse `bridge.toContext()` /
   `toResponse()` or the boundary duplicates itself, which is the failure mode
   `packages/junction/src/core/envelope.ts` documents at length for the envelope.
4. **A read-only mode and a dry-run mode.** Not derivable — an explicit choice, and
   the first thing anyone will ask for.
5. **A hold.** A protected call becomes a proposal row, a human approves it by name,
   and the run resumes. Depends on the durable-workflow noun (4.19) rather than
   defining one here.

Proposed home: **`@frontierjs/herald`** (see `IDEAS/package-map.md`). It is a
Junction plugin plus a transport; it should not live inside junction, because MCP is
a dependency junction should not acquire.

## Open questions

- ~~**Does an agent get a gate level of its own?**~~ **Answered by the approval
  gate, 2026-08-24.** The cleanest answer was always that an agent is never a
  principal — it acts *for* a session and its ceiling is that session's level — and
  the objection was the background agent with no human behind it. The hold settles
  it without a tenth level on a scale that is already too linear
  (`PROS_AND_CONS.md` con #2): the ceiling stays the session's, and above a
  threshold the call becomes a proposal instead of a write. A background agent with
  nobody behind it is then not a caller with special standing; it is a caller whose
  every protected move waits. What remains open is **who may approve** — which is a
  grid question, not a ladder one, and therefore `IDEAS/permission-sets.md`.
- **Custom methods are the interesting tools and they dispatch by header**
  (`X-Service-Method`). MCP has no such concept, so the projection must name them
  directly — `posts.publish` — which is an argument that the header dispatch was
  always an HTTP-shaped decision leaking into the service model.
- **Does the agent surface get its own audit trail?** Almost certainly yes, and
  `IDEAS/compliance-from-the-seed.md` is where it should land rather than here.
- **Rate limiting and cost.** An agent will call `find` in a loop. `ctx.directives`
  already carries `limit`; a maximum per tool is probably a projection concern.
- Does this obsolete or complement the typed browser client? They are the same
  services with different consumers, which suggests the projection is a third
  client generator, not a special case.

## See also

- `IDEAS/package-map.md` — `herald`, and where it sits among the proposed packages
- `IDEAS/compliance-from-the-seed.md` — the audit and disclosure half
- `IDEAS/slices.md` — the "a Gate is harder for an agent to get wrong" argument, in
  its original context
- `IDEAS/permission-sets.md` — who may approve a held call; the grid the ladder
  cannot express
- `IDEAS/operational-edge.md` 4 — durable workflows (4.19), the noun the hold needs
- `CLAUDE.md` § Bridge index — `bridge.toContext()`, `sessionGateLevel()`,
  `generateJsonSchema()`, `canAtLevel()` are the four seams this is assembled from
