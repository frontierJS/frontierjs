---
id: orion-port
status: proposed
dated: 2026-09-14
---

# Idea — Porting orion's mockup onto FrontierJS

**Status: PROPOSED.** Dated 2026-09-14, read against the tree. Nothing here is
owed while `FJS-D14` defers orion until core leaves alpha; phase 0 is reopening
that ruling, and no code lands before it.

`packages/orion/README.md` is the intent — what orion is for and the
non-negotiables it inherits. This paper is how the two mockups under
`packages/orion/mockup/` become that, module by module, and it holds the one
performance rule the README states as § The engine is written for speed.

---

## What exists

**Two mockups, built as a standalone product and not as an FJS app.**
`mockup/api-engine` is ~7,000 lines of TypeScript source with about as many lines
of vitest tests: a flow compiler, a JSON expression language, a node executor, a
stage scheduler, a trigger system, a plugin registry, eighteen node types, and a
SQLite store of its own. Its README calls it *the SQLite of automation tools* and
its philosophy line is *no framework*. `mockup/ui` is ~15,000 lines of React JSX
over a hand-written mock dataset: a flow canvas, node pickers, a run inspector
and settings.

**The engine's core is good and survives nearly unchanged.** The compiler
produces an `ExecutionPlan` with stages and an O(1) routing table, the context is
plain JSON at every point, and every piece of infrastructure already sits behind
an interface (`IExecutionStore`, `IExecutionQueue`, `IPlanCache`,
`IPluginRegistry`, `INodeRegistry`). That is the seam the port uses: the kernel
keeps its interfaces, and FrontierJS supplies the implementations.

**Everything around the core duplicates something FrontierJS already owns**, and
three of the duplicates are weaker than the owner:

- **Credentials** are AES-GCM under an `ORION_SECRET` the store manages itself —
  `@encrypted` done a second time, with no gate on who reads them.
- **The queue is in memory.** A crash loses every queued run, and
  `resumeFrom` is only reached by the `/wait/:key` route, so a run interrupted
  mid-stage is never resumed by anything. Caravan has a durable queue, leases,
  crash reclaim and multi-instance cron.
- **Cron ANDs day-of-month with day-of-week** and says so in a comment.
  `@frontierjs/toolbelt/cron` implements cron's own rule, where the two are OR'd
  when both are restricted, so a flow scheduled `0 9 1 * 1` fires on different
  days under the two parsers.

Tenancy is a `workspaceId` threaded through every store by hand, and the HTTP
surface is a hand-rolled router of `path.match` calls with no authentication.

---

## Module by module

| Module | Lines | Verdict | Becomes |
| --- | --- | --- | --- |
| `types/` | 268 | keep | the engine's primitives, unchanged |
| `compiler/` | 786 | keep | unchanged; gains a model-action validator in phase 4 |
| `expression/` | 476 | keep | see open question 2 |
| `executor/` | 243 | keep | `ctx.fetch` wiring moves to conduit |
| `runtime/scheduler.ts` | 297 | keep | the stage loop; its own polling loop and concurrency go, since Caravan runs one job per run |
| `runtime/context.ts`, `helpers.ts` | 135 | keep | unchanged |
| `runtime/queue.ts` | 70 | replace | `IExecutionQueue` over `app.jobs.dispatch` |
| `runtime/store.ts` | 205 | replace | `IExecutionStore` over the litestone client |
| `cache/` | 54 | keep | in-memory stays; junction's cache is the option if a second instance needs it |
| `plugins/` | 692 | keep | the registry and descriptors |
| `nodes/index.ts` | 545 | mostly keep | per-node notes under § Actions |
| `nodes/providers/` | 362 | delete | vendor code is the app's, as adapters over conduit (`FJS-D153`) |
| `nodes/code-worker-pool.ts` | 136 | hold | see open question 3 |
| `events/` | 163 | replace | model events from litestone's tap, named events as a service |
| `triggers/registry.ts`, `activator.ts` | 287 | keep | rewired to the new trigger sources |
| `triggers/cron.ts` | 252 | delete | `toolbelt/cron` plus Caravan's `schedule` / `unschedule` |
| `triggers/router.ts` | 311 | replace | junction raw routes |
| `store/` (db, migrations, flows, executions, wait, kv, credentials) | 842 | delete | `.lite` models |
| `api/` | 502 | delete | junction services |
| `server.ts` | 282 | delete | the plugin's `register` / `boot` |
| `mockup/ui/` | ~15,000 | rewrite | mesa + `@frontierjs/ui`; `mock.js` becomes the factories |

**About 3,300 lines of the engine carry over, and about 2,900 are deleted in
favor of an owner that already exists.** The tests follow the code they cover.

---

## The shape

**Open question 1 decides this section, and the recommendation is a package
installed into an app, in `@frontierjs/auth`'s shape.** Orion's pitch is that it
runs inside your app, against your schema, with your gates. Three parts of that
only work in-process: litestone's write tap is a subscriber on the client
(`FJS-D247`), typing a step against a model needs that app's `generateJsonSchema`,
and a flow acting as a principal needs that app's gate resolver. A standalone
orion could reach an app only through its API, which keeps the gates and loses
the typing and the trigger.

```
packages/orion/
  db/        orion.lite — Flow, FlowVersion, FlowLayout, Run, RunStep, Wait, Credential, KvEntry
  src/
    engine/  the kernel — imports nothing from the framework
    plugin.ts  orion({ … }) — services, raw routes, the run job, the tap subscriber
    services/  flows, runs, credentials, metrics
  web/       the builder and the inspector, as .mesa (open question 1b)
```

Auth ships its schema as two `.lite` files split by owner, with the gated models
imported so an upgrade reaches an installed app; orion's models are all
orion's, so they are all imported. `example/` installs it first (the kitchen
sink exercises every package), and basecamp second, since the README's case is
basecamp's own operations.

**The engine rule, restated for the package path.** `src/engine/` imports nothing
from junction, litestone, caravan or conduit; it receives them through the
interfaces it already has. The executor checkpoints through the litestone client
directly and never through a service. The measurement behind that is
`IDEAS/operational-edge.md` § durable workflows. Phase 1 gives the import rule an
enforcer, which is the only thing that stops it being wrong silently.

---

## Data

```
model Flow        { name, status (draft · active · paused · archived, @@transitions), currentVersion, ownerId }
model FlowVersion { flow, version, definition Json, compiledAt }          -- immutable once written
model FlowLayout  { flow, layout Json }                                  -- UI positions, unversioned
model Run         { flowVersion, status (@@transitions), trigger Json, context Json @encrypted,
                    currentStage, actorId, startedAt, endedAt, error }
model RunStep     { run, nodeId, status, attempts, fromCache, startedAt, durationMs, output Json, error, logs Json }
model Wait        { resumeKey @unique, run, timeoutAt }
model Credential  { name, provider, data Json @encrypted }
model KvEntry     { scope, key, value Json, expiresAt }
```

Every model declares `@@gate` and `@@tenant`, which replaces `workspaceId`. `Run`
status gets `@@transitions` because *a completed run cannot go back to running*
is exactly what the declaration exists for. Names follow the README: `Run`
rather than the mockup's `Execution`.

**The hot path is one write per stage, not per step.** The mockup already
checkpoints the whole context once per stage, and the port keeps that: during a
run the executor does one `run.update` of `context` and `currentStage` per stage.
`RunStep` rows are written once, in one transaction, when the run reaches a
terminal state or suspends. The inspector and the metrics read `RunStep`; the
resume reads `Run.context`. `RunStep` carries no `@@log`.

**Resume and redaction want opposite things from the same data** (Invariant 7).
A resume needs the real values a step produced; the run history must show a
protected field as `[redacted]`. The split above is what reconciles them:
`Run.context` is `@encrypted` and cleared at a terminal state, and a step's
output is redacted as its `RunStep` row is written. A model-action node knows its
model, so `db.$protectedFields(accessor)` names what to redact. An `http.request`
or `ai` output has no schema and is stored as returned, which the builder should
say on the node.

**Unmeasured, and measured in phase 2:** the cost of `@encrypted` on a context
that grows with the flow. The benchmark in `operational-edge.md` wrote a small
JSON; a hundred-node context re-encrypted per stage is a different number.

---

## Execution

**A run is one Caravan job.** A trigger dispatches `orion.run` with the run id as
the job id, so a duplicate trigger is a no-op for all time rather than a second
run. Inside the job the scheduler runs stages in order and nodes within a stage
in parallel, as it does now. The mockup's `Scheduler.run()` polling loop and its
`concurrency` option are Caravan's job, and they go.

**Caravan answers most of *which principal does a flow run as*.** `dispatch`
records who asked and the worker re-resolves that user when the job runs, so a
manual run is the caller, a cron fire is the app's `system`, and `{ actor }` names
anyone else. What stays open is the policy — which of those a flow *may* run as
— and it stays in the README's open questions.

**A crash resumes at the stage, so a stage runs at least once.** Caravan reclaims
a job whose instance stopped heartbeating; the handler loads `Run.context` and
starts at `currentStage`. Any node in that stage that finished before the crash
runs again. For an `http.request` that is a second POST. The port states this on
the node and passes a stable idempotency key (`runId:nodeId:attempt`) to conduit,
rather than checkpointing per node and paying the per-step write the speed rule
avoids.

**A wait ends the job.** `flow.wait` writes a `Wait` row, the run goes to
`waiting`, and the job completes. `POST /wait/:key` dispatches `orion.run` again
under `resume:<key>`, so a replayed resume is a no-op. The hourly timeout sweep
becomes a Caravan cron job.

**A synchronous webhook cannot be dispatched.** `http.respond` answers a request
held open in memory, and a dispatched job may be claimed by another instance. A
flow whose trigger is `mode: "sync"` runs inline in the request's process with a
deadline, and a sync flow containing `flow.wait` is a compile error.

---

## Triggers

| Trigger | Source | Notes |
| --- | --- | --- |
| model event | a subscriber on litestone's write tap (`FJS-D247`) | an Observer, post-commit and at-most-once across a crash — see open question 5 |
| cron | Caravan `schedule`, `unschedule` on deactivate | `unschedule` exists for schedules that come from a row, which is this |
| webhook | a junction raw route, `/hooks/:path` | a mapper per provider verifies its own signature |
| named event | a service method, `events.emit` | runs as the caller |
| manual | `flows.run(id, payload)` | runs as the caller |
| resume | a raw route, `/wait/:key` | the key is the credential; it is long and single-use |

The `WorkflowActivator` keeps its job — compile, cache the plan, register the
triggers, and on a new version tear the old ones down first — with these as its
targets.

---

## Actions

**The mockup has no node that touches the app's data, and that node is the
point.** Phase 4 adds two:

- **`model.create` / `model.patch` / `model.remove`** run through the gated
  client as the run's principal. The model name is resolved through
  `modelNameFor` and looked up as an accessor, so a flow-authored string never
  reaches SQL (Invariant 8). The config is typed from `generateJsonSchema`, so the
  compiler refuses a flow that writes a field the model does not have — the
  README's *checked at author time rather than at 3am*.
- **`service.call`** calls `app.service(name).call(method, …)` as the run's
  principal.

The existing nodes move onto their owners:

| Node | Becomes |
| --- | --- |
| `http.request` | `app.conduit.send` — see open question 4 |
| `ai` | junction's `IAIModel` registry; the OpenAI, Anthropic and Ollama providers become example adapters in the app |
| `store` | the `KvEntry` model; `scope: "flow"` is a key prefix |
| `flow.wait` | the `Wait` model, as above |
| `data.code` | open question 3 |
| `trigger.*`, `flow.*`, `data.template`, `data.parse`, `expr.pipeline` | unchanged |

Two more the README lists and the mockup lacks: `notify` over `app.notify` and
`job.dispatch` over `app.jobs`.

**Blast radius is day one**, as the README says: a dry run that compiles and
executes against a transaction that is rolled back, a per-flow rate limit on
runs, and `paused` on `Flow` as the kill switch that the tap subscriber and the
cron both read.

---

## UI

**The React mockup is a specification, not a source.** Nothing in it ports; what
it gives is every screen, every state and a mock dataset. The rewrite is mesa over
`@frontierjs/ui`, styled with tones and treatments rather than `tokens.js`'s
colors (Invariant 13), with `Flow.mesa`, `Run.mesa` and `Credential.mesa` as the
resources (Invariants 18 and 19).

**The canvas is the expensive part and the kit has nothing for it.**
`flow-editor.jsx` is 2,752 lines — pan, zoom, drag, edge routing — and
`@frontierjs/ui` has no graph component. Build the list, detail, inspector and
settings screens first, since they are forms and tables the kit already covers,
and the canvas last. A read-only render of the plan's stages is the useful
intermediate.

The run inspector is live: `Run` and `RunStep` writes are announced, and the
inspector is a live store over them.

---

## Phases

**0 — Gate.** Reopen `FJS-D14` and amend it with open question 1's answer. Answer
questions 2 to 5. If question 1 goes to A, orion needs a project id, and the
table has none free (`FJS-1148`); as a package it binds nothing of its own. No
code.

**1 — Lift the kernel.** Move the modules marked *keep* into `src/engine/`,
unchanged. The tests move with them onto the package's runner, and `sql.js`
goes. Add the enforcer for the engine rule: a test that fails when anything under
`src/engine/` imports a framework package. *Done when* every carried test passes
under bun and that test is in `bun run test`.

**2 — Data.** Write `orion.lite`, and `IExecutionStore` over the litestone
client with the per-stage checkpoint and the terminal batch. Grade access with
`createTestEnv` and `verifyGateLadder`. Measure the checkpoint at 10, 100 and
1,000 nodes with `Run.context` encrypted. *Done when* the numbers are in this
paper and the gate ladder passes.

**3 — Execution on Caravan.** The run job, the actor, wait and resume, cron from
a flow row. *Done when* a test kills the process mid-stage and the run completes
on restart, and a replayed resume key runs nothing.

**4 — Triggers and actions.** The tap subscriber, the raw routes, the model and
service nodes with author-time typing, conduit, `IAIModel`, the credential
model, dry run and the kill switch. *Done when* a flow writing a field its model
does not declare fails to compile, and a flow run as a principal below a model's
gate is refused by that gate.

**5 — Services.** `flows`, `runs`, `credentials`, `metrics` replace `api/`.
*Done when* `verifyTransportParity` passes over each.

**6 — UI.** Screens in the order above, installed into `example/`.

**7 — Dogfood.** A drive in `example/` (`verify:automations`) with rows in both of
`DRIVES.md`'s tables, then one real automation in basecamp. Anything orion needs
and cannot express is filed against the framework, per the README.

---

## Open questions

- **1 — Package or application?** `FJS-D14` calls orion an application beside
  basecamp.
  - **A** — an application: its own `db/`, `api/`, `web/`, reaching other apps
    through their APIs.
  - **B** — a package installed into an app, in auth's shape: `.lite` models, a
    Junction plugin, the engine inside.
  - **Recommend B** — the write tap is in-process, author-time typing needs the
    host's schema, and a flow's principal is graded by the host's gates. A keeps
    only the last, through an HTTP hop.
- **1b — If orion is a package, where do its screens live?** No package ships
  `.mesa` screens into an app yet.
  - **A** — routes the host's `web/` mounts under a prefix, built by the host's
    Sierra build.
  - **B** — a surface of its own beside `web/`, with its own config, port and
    release.
  - **Recommend A** — Invariant 3 gives a surface its own directory when its
    config, tests and release are all different answers, and the builder's are
    the host SPA's: same session, same API, same deploy.
- **2 — One expression language or two?** Orion's is a JSON AST over run context
  with `map`, `reduce`, `match` and a function table of its own; `toolbelt/predicate` is the
  `.lite` policy language, boolean, over one record, in SQLite's three-valued
  logic.
  - **A** — keep orion's, and call it the flow expression language.
  - **B** — write edge conditions in the `.lite` language and keep the AST only
    for transforms.
  - **Recommend A** — the two answer different questions over different inputs,
    and B puts SQLite's null semantics on JSON that never came from SQLite. A
    condition that tests a model record is the case to revisit.
- **3 — The code node.** `new Worker(…, { eval: true })` with `vm` inside is not a
  security boundary; anyone who can author a flow can reach the process.
  - **A** — ship without `data.code`; the expression language covers transforms.
  - **B** — keep it, restricted to a gate level that already implies server
    access.
  - **C** — a real sandbox: a subprocess with no network, a memory ceiling and a
    deadline.
  - **Recommend A** — B is a flag that widens the road without changing it, and C
    is its own project. Revisit when a flow needs a transform the language cannot
    express.
- **4 — Outbound calls to an arbitrary URL.** Conduit's model is a declared
  target with its own policy; a flow author types a URL.
  - **A** — every call goes through a target, and a `Credential` registers one,
    with no auth for a public URL.
  - **B** — one shared open target for anything without a credential.
  - **Recommend A** — timeouts, retries and the breaker stay per destination, and
    the credential list is also the list of everywhere this app's flows call.
- **5 — Can a model trigger miss a write?** The tap is at-most-once across a
  crash (`FJS-D247`).
  - **A** — the tap, with the gap stated in the builder.
  - **B** — the transactional outbox, so the trigger is written in the same
    transaction as the row.
  - **Recommend A for the first version** — B is `FJS-D228`'s territory and
    costs a write per mutation on every triggered model; offer it per flow when a
    flow cannot tolerate a miss.
