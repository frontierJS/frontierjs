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
- **What is missing** (probed 2026-11-02). The model port cannot call a tool:
  `IAIModel.complete` takes `{ role, content: string }` messages and answers a
  string (`packages/junction/src/ai/index.ts`), so a loop needs that port to grow
  first. The row ceiling counts only the `model.*` nodes: `service.call` never
  touches `ctx.writes` (`packages/orion/src/engine/nodes/index.ts`, `makeServiceCall`),
  so an agent writing through service tools is outside it. And the engine imports
  nothing but itself and toolbelt (`test/engine-boundary.test.ts`), so mcp's list
  can reach it only through a port.

## Open questions

Sources read 2026-11-02: Anthropic's [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents),
n8n's [AI Agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/),
Inngest's [agent tool loops](https://www.inngest.com/docs/ai-patterns/agent-tool-loops),
Restate's [durable agents](https://docs.restate.dev/ai/patterns/durable-agents) and
Zapier's [AI by Zapier](https://zapier.com/blog/zapier-agents-is-now-ai-by-zapier/)
(the Zapier and n8n limit figures from search summaries, not the pages).

- **Q1 — A mode or a node.** `ai` with `mode: 'agent'`, or its own `agent` node
  type. The node's config differs (tools, turn cap, budget) and so does its
  inspector form.
  - **A** — `ai` with `mode: 'agent'`. Cost: the manifest's `configSchema`
    (`plugins/builtins.ts`, `modes: ["complete"]`) carries tools, turn cap and
    budget that mean nothing under `complete`, and one node answers two output
    shapes.
  - **B** — its own `agent` node in the `ai` category, a `makeAgentNode` beside
    `makeAiNode`. Cost: one more node type in the catalog.
  - **Recommend B** — the engine already gives a different behavior its own type
    (`model.create`, `model.patch`, `model.remove` over one `makeModelNode`), and
    `ai` stays the one-shot. n8n ships AI Agent and Basic LLM Chain as separate
    nodes, with iterations only on the agent. Zapier went the other way and folded
    agents into one AI step, which is the reopen path. Confidence 2.
- **Q2 — Where the tool list comes from.** mcp's derived list, Orion's
  `service.call` catalog, or one list both read. Two lists would be two answers
  to *what may this principal call*.
  - **A** — mcp's derived list, through a new port the host fills from mcp's
    projection. Cost: the host plugin depends on mcp, and the compiler cannot check
    a per-principal list at author time.
  - **B** — Orion's `service.call` catalog, `{ service, method }` pairs checked at
    compile time. Cost: nothing withholds what the gate would refuse, so the model
    is offered a tool that answers 403, and it is a second answer to the question.
  - **C** — both, narrowing: the step declares its tools, checked at compile time
    against the catalog as `service.call` is, and at run time the list offered is
    that set intersected with mcp's for the principal. Cost: two sets to intersect,
    both already built.
  - **Recommend C** — mcp's projection stays the one owner of *offered to this
    principal* (`FJS-D258`), the catalog keeps the author-time check `service.call`
    has, and the step only narrows. Zapier and n8n both have the author pick each
    tool. Reopen B alone if the mcp dependency is too heavy for a first build.
    Confidence 2.
- **Q3 — Standing.** The flow's owner, as every other node runs, or a narrowed
  principal the step declares (`narrow` only removes).
  - **A** — the flow's owner, through `app.runAs` as every node runs, narrowed only
    by Q2's declared tools. Cost: a prompt injected through a tool result reaches
    whatever those tools reach at the owner's level.
  - **B** — a narrowed principal the step declares (a lower level, read-only), on
    `narrow`'s only-removes rule. Cost: a new field, and a rule for who may set it.
  - **Recommend A** — every node runs as the owner (`FJS-D283`), an agent is at
    most the person (`FJS-D258`), and the declared tool list already removes what
    the step does not name. B is the reopen path when a tool list proves too
    coarse. Confidence 2.
- **Q4 — Who owns the budget.** A per-step token or cost cap, and what a step
  that reaches it returns: a failure, or a result that says so. A cap that
  returns silently reads as a quiet answer.
  - **A** — a turn cap and a token cap on the step, summed from `usage`; reaching
    either fails the node by name with `retry: false`, as the row ceiling does.
    Cost: the partial answer is lost unless Q6 keeps the turns.
  - **B** — the cap answers `ok: true` with `stopped: 'budget'`. Cost: the quiet
    answer the question warns about, unless a later node tests `stopped`.
  - **C** — a run-wide pool on the context beside `ctx.writes`, shared by every
    agent step. Cost: a new context field, and two agents share one pool.
  - **Recommend A, and count the agent's service writes in `ctx.writes`** — only A
    has a sibling, the row ceiling's named non-retryable failure. Inngest's guide
    caps iterations and a summed token budget but returns a string at the cap,
    which is B's quiet shape; n8n's Max Iterations defaults to 10; Zapier pauses a
    run after 75 tasks, C's shape. Without the write count the ceiling is blind to
    the step (§ What exists). Confidence 2 on A, 3 on the write count.
- **Q5 — Crash and resume.** A worker SIGKILLed mid-loop: re-run the whole step,
  or checkpoint per turn. A tool call that wrote is not safe to repeat.
  - **A** — re-run the whole step, as a stage re-runs today. Cost: a write tool's
    call repeats, and so does the model spend.
  - **B** — checkpoint per turn: store each turn and tool result, and on resume
    replay the recorded results instead of calling again. Cost: a write per turn
    on the loop, and a place for it (Q6 B).
  - **Recommend B if write tools ship in the first build, A if it is read-only** —
    every durable-agent product checkpoints per call: Inngest wraps each model and
    tool call in its own `step.run()`, Restate journals each in `ctx.run()` and
    replays. A is safe only while no tool writes. Confidence 1: it turns on
    whether the first build offers write tools, which is the owner's call.
- **Q6 — The transcript.** Where the turns are stored, and how a tool result
  carrying a protected field is redacted in it (Invariant 7).
  - **A** — in the step's `RunStep.output` as `{ result, turns }`, under the read
    rule `RunStep` already has. Cost: one JSON value that grows with the loop.
  - **B** — a new `AgentTurn` model (run, node, turn, role, content) with its own
    gate and retention. Cost: a model in `orion.lite`; it is what Q5 B needs.
  - **Recommend A, with B when Q5 picks B** — the turns hold only what the owner's
    gated client returned, the same exposure as any node's output, so there is no
    new redaction path; nothing from a tool call goes to the audit trail, which
    keeps Invariant 7 where it is. n8n makes the steps an output option, off by
    default. Confidence 2.
- **Q7 — Dry run.** What `ctx.dryRun` means for a loop whose next call depends
  on the last call's real answer.
  - **A** — record only: under `ctx.dryRun` the step answers `notSent` with its
    model, tools and prompt, as `ai` and `service.call` do. Cost: a dry run shows
    the flow around the agent, never what it would do.
  - **B** — run read tools for real and record write tools. Cost: a read/write
    flag on every tool, which mcp's tool kinds (`crud`, `transition`, `custom`) do
    not carry, and the loop diverges at the first skipped write.
  - **Recommend A** — `ai`, `service.call` and `job.dispatch` all answer `notSent`,
    and running the loop inside the dry run's rolled-back transaction would not
    hold: service calls go through `app.runAs`, outside it. Reopen B once tools
    carry a read flag. Confidence 3.

## Phases

### Phase 0 — Decide

Goal: Q1–Q7 ruled.
Done when: each has an `FJS-D` in `DECISIONS.md`.

- [ ] 0.1 Settle the general agent shape first (the owner's prior question), then rule Q1–Q7 against it
