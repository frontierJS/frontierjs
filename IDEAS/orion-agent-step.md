---
id: orion-agent-step
status: proposed
dated: 2026-10-19
source: owner, 2026-10-19 — "we will definitely want users to be able to add an agent into an Orion workflow"
---

# Idea — an agent as a step in an Orion flow

**Status: PROPOSED.** Dated 2026-10-19. Nothing here is built. Parked behind the
owner's more general agent question, which is explored first. See `VERIFYING.md`.

**The ask.** A person building a flow drops in a step where a model, not the
flow, picks the next call: it reads, calls the app's services as tools, loops,
and hands its answer to the next node.

**Why it belongs in Orion.** A flow is what Anthropic's *Building effective
agents* (Dec 2024) calls a workflow — "LLMs and tools orchestrated through
predefined code paths" — and an agent is where "LLMs dynamically direct their
own processes and tool usage." The sturdy shape is the first with the second
only where judgment is needed: the Kobami daily check is scripts that collect,
count and post around one model step that judges, and it holds up better than
the all-agent daily brief in Anthropic's *Building effective agent automations*
(Oct 2026), whose bookmarks, dedupe and post confirmation are all prompt rules.

## What exists

- **The `ai` node** (`packages/orion/src/engine/nodes/index.ts`, `makeAiNode`) —
  `complete` only, one user message, no tools, run as `ctx.actor` (the flow's
  owner through `app.runAs`). Any other `mode` is refused by name, which is where
  a loop mode would go.
- **The tool list** — `@frontierjs/mcp` already derives tools from
  `svc.describe()` and withholds what the gate would refuse (`FJS-D258`): a tool
  is a service method, and an agent is at most the person.
- **`service.call` and the model nodes** — Orion's own author-time catalog of
  what a flow may call, typed at compile time.
- **The limits** — the kill switch, runs per minute, the row ceiling and the dry
  run (`FJS-D283`). None of them is a token or cost budget.

## Open questions

- **Q1 — A mode or a node.** `ai` with `mode: 'agent'`, or its own `agent` node
  type. The node's config differs (tools, turn cap, budget) and so does its
  inspector form.
- **Q2 — Where the tool list comes from.** mcp's derived list, Orion's
  `service.call` catalog, or one list both read. Two lists would be two answers
  to *what may this principal call*.
- **Q3 — Standing.** The flow's owner, as every other node runs, or a narrowed
  principal the step declares (`narrow` only removes).
- **Q4 — Who owns the budget.** A per-step token or cost cap, and what a step
  that reaches it returns: a failure, or a result that says so. A cap that
  returns silently reads as a quiet answer.
- **Q5 — Crash and resume.** A worker SIGKILLed mid-loop: re-run the whole step,
  or checkpoint per turn. A tool call that wrote is not safe to repeat.
- **Q6 — The transcript.** Where the turns are stored, and how a tool result
  carrying a protected field is redacted in it (Invariant 7).
- **Q7 — Dry run.** What `ctx.dryRun` means for a loop whose next call depends
  on the last call's real answer.

## Phases

### Phase 0 — Decide

Goal: Q1–Q7 ruled.
Done when: each has an `FJS-D` in `DECISIONS.md`.

- [ ] 0.1 Settle the general agent shape first (the owner's prior question), then rule Q1–Q7 against it
