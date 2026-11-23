---
id: claude-calls
status: proposed
dated: 2026-11-22
---

# One owner per way into Claude — the local `claude` program and the Messages API

**Status: PROPOSED.** Dated 2026-11-22. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

About thirty places call Claude, in ten codebases, and twenty-four of them build
their own call or copy another app's (measured at step 0.1). They are doing five
different jobs over two ways in, and only some job-and-way pairs have an owner.
Where none does, each new app copies the last one (FJS-4171, FJS-4252, FJS-4332).

The plan: one new package owns the **local `claude` program** — running it,
holding a chat with it, reading its files. `conduit-anthropic`, which exists, owns
the **Messages API**. Products keep their own prompts. The one job both ways share,
a single answer as JSON, gets one vendor-neutral contract so an app moves between a
developer's subscription and a deployed key without changing above the door.

## Siblings

- `IDEAS/claude-chat.md` — the UI half: one fold of events into rows, one
  `ClaudeChat` component. Its layers 1 and 2 (`readAskEvent` and the row fold) land
  in this plan's package, not `cli/core`, once Phase 2 moves `ask-claude.js`. Its Q4
  (one control protocol) is this plan's Phase 3.
- `IDEAS/claude-code.md` — the Basecamp screen over `~/.claude`. Its readers are
  the ones Phase 5 moves; the screens stay where they are.

## The five jobs

| Job | Local `claude` program | Messages API |
| --- | --- | --- |
| **A · One answer** — prompt in, text or schema JSON out | By hand: Chronicle `doors.ts`, mechanic generator `door.ts` (copy), Intake `plan.js`, Charter `builder/lib.ts`, Workbench chat recap `chat/catchup.ts`, Haven's townsfolk `agents/agents.js` (text) and desk `lib/hash/errand.js` (schema, resumable) | Chronicle (through `conduit-anthropic`), kos `domain/ai/anthropic.ts` (own `fetch`), ELA `qa-chat/*` (`@anthropic-ai/sdk`) |
| **B · A run over a folder** — fixed permissions, then stop | `cli/core/ask-claude.js` `runAsk`: `fli ai:*`, Vite ask panel, Workbench, Basecamp site edit, Haven. By hand: Workbench `launch()` and Lathe `claude.ts` work runs (FJS-4252), serpgrid `providers/claude`, the chat and serpgrid TUIs' `tools.js` (own `askArgv`, the CLI's `readAskEvent`), `scripts/headless.mjs` (the fix and frame loops) | — |
| **C · A live chat** — one long-lived process, permission prompts | Lathe `claude.ts` + `claude-protocol.ts`; Haven `lib/study/session.js` — two protocol copies | — |
| **D · An agent inside an app** — the model calls the app's services as the person | Charter `agent.ts`, `connect.ts` (`claude -p` at an app's MCP) | kos `domain/companion/*` (own SSE reader, retry, prices, fake; tools through `domain/ai/aiTools.ts` from `@frontierjs/mcp`) |
| **E · Claude Code's own files and account** — `~/.claude`, its subcommands, the login's usage | Workbench `domain/claude/*` (14 files, 3,392 lines) and `local/local-claude.ts` (`auth status`, `mcp`, `plugin`, `doctor`), `cli/core/claude-usage.js`; Lathe's copies (FJS-4332); `scripts/loop-review.mjs` and `skill-reach.mjs` read transcripts by hand; the OAuth usage read twice, Workbench `claude-quota.ts` and `headless.mjs` | — |

More facts the phases turn on:

- `ask-claude.js` is 709 lines with 51 exports, and 25 are prompts, rules or limits
  for one product. Workbench, Basecamp, Lathe (API and desktop sidecar), the chat and
  serpgrid TUIs load it from the CLI package; Haven by path.
- `conduit-anthropic` already has `createMessage`, `streamMessage`, `runToolLoop`,
  `countTokens` and a sink. Only Chronicle uses it; kos and ELA use none of it.
- Four price tables: Workbench `claude-pricing.ts`, kos `companion/pricing.ts`, ELA
  `qa-chat.limits.js`, Chronicle `shared/asks.js`.
- The OAuth usage endpoint is the claude.ai login's, not the Messages API, so it is
  job E and the package's, not `conduit-anthropic`'s.
- Basecamp's `providers/model/anthropic.ts` owns a workspace's API key and verifies
  it; it sends no prompt. Site edit hands that key to the local program, so a job-B
  run can bill an API key rather than a subscription.
- Out of scope: n8n workflows that call the API from n8n (ELA `docs/n8n/*`, Intake
  `flow/`), and Chronicle's `mockup/` sketches.

## Rulings this plan builds on

- `FJS-D153` — the boundary owns the mechanism, never the vendor; a vendor's code is a
  connector named for the vendor.
- `FJS-D890` — connectors are TypeScript and install nothing.
- `FJS-D190` — what enforces an invariant is a row in `invariants.snapshot.md`.

## Open questions

- ~~**Q1 — Does the local package live in this repo or its own?**~~ **Answered 2026-11-23 (`FJS-D2321`): A — in the tree, `packages/<name>/` beside `cli` and `mcp`, as the connectors moved into `packages/conduits/`.**
  - **A** — in the tree, `packages/<name>/` beside `cli` and `mcp`, as the connectors
    moved into `packages/conduits/`.
  - **B** — its own repo, published as a general Claude Code library.
  - **Recommend A** — every consumer is in the tree or a prototype that links it (kos
    and ELA only use the API), and some of the code assumes this repo: runs turn hooks
    off because the Stop hook runs `fli done`. Pulling it out later stays easy.

- ~~**Q2 — TypeScript or plain JavaScript?**~~ **Answered 2026-11-23 (`FJS-D2322`): A — TypeScript, added to House style's TypeScript list in `CLAUDE.md`.**
  - **A** — TypeScript, added to House style's TypeScript list in `CLAUDE.md`.
  - **B** — plain JavaScript, like `cli`.
  - **Recommend A** — most of what moves in is TypeScript already (Workbench's readers,
    about 3,400 lines; Lathe's protocol); `ask-claude.js` (704) is the one JavaScript
    part. The stream-json union is the boundary a type pays for.

- ~~**Q3 — Does it publish to `packages.frontierjs.com`?**~~ **Answered 2026-11-23 (`FJS-D2323`): A — yes, released like `cli`, so prototypes depend on it directly.**
  - **A** — yes, released like `cli`, so prototypes depend on it directly.
  - **B** — no; prototypes keep reaching it through `cli`.
  - **Recommend A** — Lathe's desktop build bundles it into its sidecar, and B keeps
    the runtime-on-the-CLI dependency this plan exists to end.

- ~~**Q4 — What is the package called?**~~ **Answered 2026-11-23 (`FJS-D2324`): A — `@frontierjs/claude`.**
  - **A** — `@frontierjs/claude`.
  - **B** — `@frontierjs/claude-code`.
  - **C** — a generic name (`agent-cli`, `local-model`).
  - **Recommend A** — named for the vendor's program as connectors are (`FJS-D153`);
    the flags, the control protocol and `~/.claude` are all Claude Code's, so a generic
    name promises a layer with one implementation. B reads like Anthropic's own
    package. The cost of A: it can read as covering the API, which stays in
    `conduit-anthropic`, so its README's first line says so.

- ~~**Q5 — One package, or one for running and one for reading files?**~~ **Answered 2026-11-23 (`FJS-D2325`): A — one.**
  - **A** — one.
  - **B** — two: running (jobs A local, B, C) and files (job E).
  - **Recommend A** — both break together when Claude Code changes, and both have the
    one dependency.

- ~~**Q6 — When may an API call be sent twice?**~~ **Answered 2026-11-23 (`FJS-D2326`): C — once on a 429 or 529 only; a dropped connection is the caller's call.**
  - **A** — never: `conduit-anthropic`'s rule, a sent request may be billed.
  - **B** — once on a 429, 529, 5xx or dropped connection before anything streamed:
    kos's rule.
  - **C** — once on a 429 or 529 only; a dropped connection is the caller's call.
  - **Recommend C** — a 429 or 529 is a refusal the API did not bill; a dropped
    connection may have run, which is the case A exists for.

- ~~**Q7 — Where does the one-answer contract's type live?**~~ **Answered 2026-11-23 (`FJS-D2327`): B — a vendor-neutral home both import (`@frontierjs/toolbelt`).**
  - **A** — `conduit-anthropic` exports it; the local package imports the type.
  - **B** — a vendor-neutral home both import (`@frontierjs/toolbelt`).
  - **C** — the local package exports it; `conduit-anthropic` imports the type.
  - **Recommend B** — nothing in `ask({ prompt, schema })` is Claude's, and a third
    door (another vendor, a local model) should not import a Claude package to answer.

- ~~**Q8 — Is an agent inside an app part of this plan?**~~ **Answered 2026-11-23 (`FJS-D2328`): A — no: its own paper in `IDEAS/`, with kos's companion as the prior art.**
  - **A** — no: its own paper in `IDEAS/`, with kos's companion as the prior art.
  - **B** — yes, as a phase here.
  - **Recommend A** — kos's loop (background tasks, approvals, history as rows) is a
    new framework feature, not a consolidation, and its tools already have an owner.

- ~~**Q9 — What happens to `junction/ai`?**~~ **Answered 2026-11-23 (`FJS-D2329`): C — keep the `app.ai` slot (an app's named models), but each entry satisfies Q7's contract with `schema` optional, and `IAIModel` goes; orion's `ai` node calls `ask`, and Phase 4's two doors register there.** Only orion uses its `AIRegistry` (step 0.4):
  orion's `ai` node sends one prompt and reads text back through
  `app.ai.get(model).complete(req)`, which is job A without a schema. `IAIModel` is
  therefore a second vendor-neutral one-answer contract, beside the one Q7 puts in
  toolbelt.
  - **A** — remove it; orion declares the interface it calls.
  - **B** — keep it as it is.
  - **C** — keep the `app.ai` slot (an app's named models), but each entry
    satisfies Q7's contract with `schema` optional, and `IAIModel` goes; orion's
    `ai` node calls `ask`, and Phase 4's two doors register there.
  - **Recommend C** — one neutral contract, not two. A gives orion a third one of its
    own, and B leaves an app writing an adapter by hand (the file's own header
    sketches one) for a door Phase 4 already builds.

- ~~**Q10 — What are the contract's names?**~~ **Answered 2026-11-23 (`FJS-D2350`): A — kit `@frontierjs/toolbelt/ask`; the request is `Question`, a way in is a `Door`, the reply `Reply` (`Answered` | `Unanswered`).** `Ask` is already `@frontierjs/claude`'s
  control-protocol permission question, beside `runAsk` and `AskEvent`.
  - **A** — kit `@frontierjs/toolbelt/ask`; the request is `Question`, a way in is a
    `Door`, the reply `Reply` (`Answered` | `Unanswered`).
  - **B** — the same types under kit `/answer`.
  - **C** — rename the claude package's `Ask` to `PermissionAsk` and call the request `Ask`.
  - **Recommend A** — toolbelt names a kit for the operation (`/redact`, `/seal`), and
    `Question` clears the collision without moving a live protocol type.

- ~~**Q11 — Where is a door's model chosen?**~~ **Answered 2026-11-23 (`FJS-D2351`): A — when the door is built, and `door(question, { model })` may override it for one question; `Reply.model` names what answered.**
  - **A** — when the door is built, and `door(question, { model })` may override it for
    one question; `Reply.model` names what answered.
  - **B** — only when the door is built; another model is another door.
  - **C** — on every call, as Chronicle's `doors.ts` does.
  - **Recommend B** — the simplest shape, and `app.ai` is then named doors; an override
    can be added later without breaking a caller.

## Phase 0 — Groundwork

Goal: the package exists, empty, with the guard against vendor drift in place.
Done when: `bun run test` passes in the new package against recorded fixtures, and
Q1–Q5 are ruled.

- [x] 0.1 Re-measure the five-jobs table against the trees, Haven's
  `lib/study/session.js` included.
  - Measured 2026-11-22 across this tree, `fjs-prototypes`, kos and ELA. Eleven
    callers the first survey missed are now in the table and in the steps below:
    Workbench's chat recap and `local-claude.ts`, Haven's `agents.js` and
    `errand.js`, `scripts/headless.mjs`, `loop-review.mjs` and `skill-reach.mjs`,
    the chat and serpgrid TUIs, Chronicle's price table, and the OAuth usage read.
- [x] 0.2 Scaffold `packages/claude/` per Q1, Q2 and Q4: `README.md`, `CLAUDE.md`,
  `PROJECT_STATE.md`, a test script, a typecheck baseline of 0, the package-host
  publish entry (Q3), and the House style TypeScript list in `CLAUDE.md`.
  - Built 2026-11-23: `@frontierjs/claude` 0.0.1, an empty `index.ts`, a manifest
    test, `claude` added to House style's TypeScript list. No hand-kept publish
    list exists (workspaces are discovered); its ring in the root Packages table
    is left open.
- [x] 0.3 Record stream-json fixtures from the installed `claude`: a read-only run,
  an edit run, a resumed run, a chat with a permission prompt and a question. The
  package's tests replay them, and a drive against the live `claude --version`
  catches a protocol change.
  - Built 2026-11-23: five scrubbed recordings from `claude` 2.1.330 in
    `packages/claude/test/fixtures/` (chats record both directions), a fixture test
    that pins each census, `test/record.ts` to re-record, and `bun run drive:live`
    to compare the installed `claude`. The permission chat's prompt was a Bash call.
- [x] 0.4 Read orion's use of `junction/ai` (Q9).
  - The only consumer is `orion/src/engine/nodes/index.ts` `makeAiNode`, with mode
    `complete` only. It sends one user message plus an optional system,
    maxTokens and temperature, and reads `content`, `model` and token counts.
    Nothing calls `stream`. No prototype, kos or ELA imports `junction/ai`.

## Phase 1 — Prompts out of `ask-claude.js`

Goal: `ask-claude.js` says how to call Claude and nothing about what to say.
Done when: it exports no prompt or rule, and the `cli`, Workbench, Basecamp and
Haven tests pass.

- [x] 1.1 The plan prompts (shape, build-plan rules, step and handoff) to a
  `cli/core/plan-prompt.js` beside `plan.js`, which owns the plan format; the review
  prompt, whose one consumer is Workbench, to Workbench. A test parses a plan shaped
  by the prompt with `parsePlan`.
  - Not all four to Workbench as first written: the Vite ask panel builds plans and
    Haven's study runs steps, and `cli` cannot import an app.
  - Done 2026-11-23: `plan-prompt.js` (with `guideList`, the one helper `buildPlanPrompt` and `editPrompt` share) and `workbench-review.ts`; `plan-prompt.test.js` parses a plan written to `PLAN_SHAPE` with `parsePlan`; Haven's `planLine` loads `plan-prompt.js`.
- [x] 1.2 Edit and content rules, edit kinds, scopes and efforts to a `cli/core`
  module beside `vite-ask.js`, which Basecamp's site edit imports.
  - Done 2026-11-23: `edit-prompt.js`; Basecamp's `site-ask.ts` loads it for `contentPrompt` and `editEffort`, Lathe's `Sessions` for `PANEL_EFFORTS`.
- [x] 1.3 Ask, question and agent rules to a `cli/core` module for `fli ai` and the
  console server; the chat and serpgrid TUIs take `askPrompt` from it. A check fails
  if `ask-claude.js` exports a prompt or rule again.
  - These three modules stay in `cli` when Phase 2 moves the rest out.
  - Done 2026-11-23: `ask-prompt.js`, and `ask-claude.test.js` fails on an export matching the rule/prompt names. The chat and serpgrid TUIs keep their own `askPrompt` (their `commands.js`) and import only `askInput` and `readAskEvent`, so neither needed repointing; `AGENT_SERVER` moved out, so the `:ask` caller passes `agent.server` to `askArgv`.

## Phase 2 — The package from `ask-claude.js`'s core

Goal: one owner for building the command line and reading the stream.
Done when: `ask-claude.js` is deleted, `rg 'cli/core/ask-claude'` finds nothing in
either tree, and the consumers' tests plus Lathe's `drive:workspace` pass.

- [x] 2.1 Move the profiles, `askArgv`, `sessionArgv`, `readAskEvent` and `runAsk`,
  with their tests.
  - `packages/claude/src/{limits,argv,events,images,run}.ts`, same 18 export names; the
    stream-json lines `readAskEvent` reads are a typed union, and `test/replay.test.ts` pins each fixture.
- [x] 2.2 Repoint `cli`, Workbench, Basecamp, Haven (no path import), Lathe and the
  chat and serpgrid TUIs in the same change, keeping no alias.
  - Done 2026-11-23: in-tree callers and the Lathe (API, sidecar `bundled.ts`), chat and serpgrid prototypes import `@frontierjs/claude` (`link:` dependency, `bun link` registered); Lathe typecheck, `api/test` (226) and `drive:workspace` (174) pass.
- [x] 2.3 The guard: nothing outside the package spawns `claude`, and the package
  imports nothing from `cli`, as an `invariants.snapshot.md` row (`FJS-D190`)
  backed by a check.
  - Done 2026-11-23: `claude-package-isolated` (Invariant 1) and `claude-spawn-owned` (Invariant 4) in `fli check`; the six files that still start `claude` are `scripts/claude-spawners.json`, a ratchet that fails when an unlisted file starts it or a listed one stops.

## Phase 3 — The live chat and work runs

Goal: one control protocol, and every Claude Code run through the package.
The chat stays on raw stream-json, as Lathe's Q20 ruled. Speaking ACP through
`@agentclientprotocol/claude-agent-acp` instead was raised and deferred by the owner
on 2026-11-22: revisit when a second agent (Codex, Gemini) is actually wanted.
Done when: Lathe and Haven hold their chats on the package's session, and no
consumer builds a chat or work-run `claude` command line itself. The one-answer
callers are Phase 4's.

- [x] 3.1 Move Lathe's `claude-protocol.ts` and `Sessions`; Lathe imports them.
  - `src/{protocol,permission,catalog,session}.ts` and `docs/control-protocol.md`; Lathe's `Sessions` is a
    map of `Session` with its diff card and env. Uncommitted, both trees (2026-11-23).
- [x] 3.2 Move Haven's study session onto it and delete its protocol copy.
  - Built, uncommitted (2026-11-23): `study/session.js` folds `Session` events (deny in Haven's words via `deny`, `always` with no rule refused); the package gained `thinking`, a `tool`'s `id` and `onExit(code, signal)`; the read-along reads through `readAskEvent`. A live Haven study chat by the owner is owed.
  - Owner rulings (2026-11-23): Haven adopts the package's protocol; each host supplies its deny wording; "always" with no suggested rule is refused; the picker's choices are Lathe's; the study pane shows the package's tool line.
- [x] 3.3 A work profile for `runAsk`; Workbench and Lathe work runs, the chat and
  serpgrid TUIs and `scripts/headless.mjs` drop their own argv. Closes FJS-4252.
  - Built, uncommitted (2026-11-23): Workbench `launch()`, `scripts/headless.mjs` and the chat and serpgrid TUIs run on `runAsk` (the read-only profile takes `bash` and `budget`, and passes `dontAsk` so an account defaulting to `auto` cannot run other Bash); Lathe's work run was already a `Session`, and its picker's `newestPerFamily` and `PICKED_MODES` live in Lathe. A real paid headless loop and a live Workbench work run are owed to the owner. FJS-4252 stays open for Chronicle's `doors.ts` (4.4).

## Phase 4 — One answer, both ways in

Goal: a single answer as JSON has one contract and two doors.
Done when: Chronicle, the mechanic generator, Intake, Charter's builder, Workbench's
chat recap and Haven's townsfolk and desk spawn no `claude` of their own, and both
doors return the same failure names.

- [x] 4.1 The contract type, where Q7 puts it. `@frontierjs/toolbelt/ask`: `Question`, `Door`,
  `Reply`, the closed `REASONS` set with `retryable` read from it, `unanswered` and
  `checkReply`, which 4.2 and 4.3 each run every reply they can give through (`FJS-D2350`,
  `FJS-D2351`).
- [x] 4.2 The local door in the package, from Chronicle's `doors.ts`. `claudeDoor` in
  `src/door.ts` over argv's `answer` profile; the door's own facts ride `run: { session,
  turns, denials }`; an MCP server's headers go in a 0600 file, never argv. Driven live
  (haiku): a schema answer, a text answer under `question.system`, an unknown model as
  `model_gone`, and a cwd `CLAUDE.md` that did not reach the answer.
  - Measured on 2026-11-23, when Charter's builder and serpgrid's draft were tried against the
    agent and read-only profiles and fit neither: both are one answer (`--output-format json`,
    `--json-schema`), so they move in 4.4. The door has to carry what they pass: a schema, an
    MCP server with request headers (Charter's bearer token), added read directories and the
    `Skill` tool (serpgrid's draft), `--no-session-persistence`, a wall-clock timeout, and
    `permission_denials` on the result.
- [ ] 4.3 The API door in `conduit-anthropic`, with the same failure names and the
  retry rule Q6 rules.
- [ ] 4.4 Move Chronicle, the mechanic generator, Intake, Charter's builder
  (`agent.ts`, `connect.ts`), serpgrid's draft (`providers/claude/index.ts`),
  Workbench's `chat/catchup.ts` and Haven's `agents.js` and `errand.js`; each
  deletes its own door. Closes FJS-4171.
- [ ] 4.5 `junction/ai` per Q9: `IAIModel` goes, `app.ai` holds entries that satisfy
  4.1's contract with `schema` optional, and orion's `ai` node calls `ask`. Orion's
  `plugin.test.ts` passes on a stub door.

## Phase 5 — Claude Code's files

Goal: one reader for each file Claude Code keeps.
Done when: Lathe's `claude-transcript.ts` and `claude-sessions.ts` are deleted and
Workbench's screens read through the package.

- [ ] 5.1 The transcript fold, the session list and `claude-usage.js`'s
  `readMessages`.
- [ ] 5.2 The rest of Workbench's readers: scan, settings, hooks, MCP, quota and
  login, and `local-claude.ts`'s subcommand runner. `headless.mjs` reads quota
  through it, and `loop-review.mjs` and `skill-reach.mjs` read transcripts through
  5.1. The screens stay in Workbench. A repo check fails on `.credentials.json` or
  `oauth/usage` outside the package; the token is read and never refreshed, since a
  refresh signs out every running `claude`.
- [ ] 5.3 Lathe deletes its copies. Closes FJS-4332.

## Phase 6 — API callers onto `conduit-anthropic`

Goal: no app calls the Messages API itself, and one table prices a model.
Done when: kos and ELA have no direct call, and Workbench, kos, ELA and Chronicle
read one price table.

- [ ] 6.1 The price table into `conduit-anthropic`; Workbench and Chronicle read it.
  `claude-quota.ts`'s token count (`/v1/messages/count_tokens`) moves onto the
  connector's `countTokens`, splitting it from the usage read 5.2 moves.
- [ ] 6.2 Run kos's `fakeAnthropic` scripts against the connector's sink: thinking
  blocks sent back unchanged, streamed tool input, `pause_turn`, the fallback beta.
- [ ] 6.3 kos onto the connector. It is live, so the owner picks when.
- [ ] 6.4 ELA's Q&A chat onto the connector. It is live, so the owner picks when.
