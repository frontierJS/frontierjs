---
id: orion-port
status: proposed
dated: 2026-09-14
---

# Idea — Porting orion's mockup onto FrontierJS

**Status: PROPOSED.** Dated 2026-09-14, read against the tree. Orion is not
deferred (`FJS-D275`), and its shape is ruled (`FJS-D269`–`FJS-D274`).

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
| `expression/` | 476 | keep | the evaluator; its text syntax comes from toolbelt's shared parser (`FJS-D271`) |
| `executor/` | 243 | keep | `ctx.fetch` wiring moves to conduit |
| `runtime/scheduler.ts` | 297 | keep | the stage loop; its own polling loop and concurrency go, since Caravan runs one job per run |
| `runtime/context.ts`, `helpers.ts` | 135 | keep | unchanged |
| `runtime/queue.ts` | 70 | replace | `IExecutionQueue` over `app.jobs.dispatch` |
| `runtime/store.ts` | 205 | replace | `IExecutionStore` over the litestone client |
| `cache/` | 54 | keep | in-memory stays; junction's cache is the option if a second instance needs it |
| `plugins/` | 692 | keep | the registry and descriptors |
| `nodes/index.ts` | 545 | mostly keep | per-node notes under § Actions |
| `nodes/providers/` | 362 | delete | vendor code is the app's, as adapters over conduit (`FJS-D153`) |
| `nodes/code-worker-pool.ts` | 136 | keep | behind `SYSADMIN(7)` (`FJS-D272`, `FJS-D279`) |
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

**Orion is a package installed into an app, in `@frontierjs/auth`'s shape
(`FJS-D269`).** Orion's pitch is that it
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
  web/       the builder and the inspector, as .mesa routes the host mounts (`FJS-D270`)
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

**A run acts as the flow's owner** (`FJS-D276`), dispatched with
`{ actor: flow.ownerId }` whatever triggered it, so Caravan re-resolves the owner
when the job runs and a demoted owner's flows lose the access with them. Who may
activate a flow is declared on `Flow.status`: `USER(4)` drafts,
`ADMINISTRATOR(5)` activates (`FJS-D278`). Flows are rows, one immutable
`FlowVersion` per version, with JSON export and import for review (`FJS-D277`).

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
deadline, and a sync flow containing `flow.wait` is a compile error (`FJS-D280`).

---

## Triggers

| Trigger | Source | Notes |
| --- | --- | --- |
| model event | a subscriber on litestone's write tap (`FJS-D247`) | an Observer, post-commit and at-most-once across a crash, stated in the builder (`FJS-D274`) |
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
| `http.request` | `app.conduit.send` through the target a `Credential` registers (`FJS-D273`) |
| `ai` | junction's `IAIModel` registry; the OpenAI, Anthropic and Ollama providers become example adapters in the app |
| `store` | the `KvEntry` model; `scope: "flow"` is a key prefix (`FJS-D281`) |
| `flow.wait` | the `Wait` model, as above |
| `data.code` | unchanged, refused below `SYSADMIN(7)` (`FJS-D272`, `FJS-D279`) |
| `trigger.*`, `flow.*`, `data.template`, `data.parse`, `expr.pipeline` | unchanged |

Two more the README lists and the mockup lacks: `notify` over `app.notify` and
`job.dispatch` over `app.jobs`.

**Blast radius is day one** (`FJS-D283`): a dry run against a rolled-back
transaction with outbound calls recorded and not sent, a per-flow rate limit on
runs, `paused` on `Flow.status` as a kill switch every trigger reads, and a
ceiling on the rows one run may write.

---

## UI

**The React mockup is a specification, not a source.** Nothing in it ports; what
it gives is every screen, every state and a mock dataset. The rewrite is mesa over
`@frontierjs/ui`, styled with tones and treatments rather than `tokens.js`'s
colors (Invariant 13), with `Flow.mesa`, `Run.mesa` and `Credential.mesa` as the
resources (Invariants 18 and 19). The host mounts them by adding one file under its own routes that points at the package's route directory (`FJS-D282`) — a Sierra mechanism that does not exist yet and is built in phase 6.

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

**0 — Decide.** Done: the shape is ruled (`FJS-D269`–`FJS-D283`) and the
deferral is lifted (`FJS-D275`).

**1 — Lift the kernel, and share the syntax.** Extract the `.lite` expression
grammar from litestone's parser into a toolbelt kit that litestone then imports,
with litestone's own suite and the policy oracle unchanged as the proof; orion's
text syntax is parsed by the same kit (`FJS-D271`). *Done 2026-09-14*: the
grammar and then the lexer moved into `@frontierjs/toolbelt/predicate`
(`FJS-D287`), every schema's AST byte-identical across both; the kit's second
dialect is the flow one, and orion's `compileExpression` turns its text into the
engine's nodes with conditions answered three-valued. Move the modules marked *keep* into `src/engine/`,
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

- ~~**1 — Package or application?**~~ **Answered 2026-09-14 (`FJS-D269`): B — a package installed into an app, in auth's shape: `.lite` models, a Junction plugin, the engine inside.** `FJS-D14` calls orion an application beside
  basecamp.
  - **A** — an application: its own `db/`, `api/`, `web/`, reaching other apps
    through their APIs.
  - **B** — a package installed into an app, in auth's shape: `.lite` models, a
    Junction plugin, the engine inside.
  - **Recommend B** — the write tap is in-process, author-time typing needs the
    host's schema, and a flow's principal is graded by the host's gates. A keeps
    only the last, through an HTTP hop.
- ~~**1b — If orion is a package, where do its screens live?**~~ **Answered 2026-09-14 (`FJS-D270`): A — routes the host's `web/` mounts under a prefix, built by the host's Sierra build.** No package ships
  `.mesa` screens into an app yet.
  - **A** — routes the host's `web/` mounts under a prefix, built by the host's
    Sierra build.
  - **B** — a surface of its own beside `web/`, with its own config, port and
    release.
  - **Recommend A** — Invariant 3 gives a surface its own directory when its
    config, tests and release are all different answers, and the builder's are
    the host SPA's: same session, same API, same deploy.
- ~~**2 — One expression language or two?**~~ **Answered 2026-09-14 (`FJS-D271`): C — one expression syntax and parser in toolbelt, used by both. An edge condition is evaluated by `predicate`'s three-valued rules; `map`, `pipe` and the functions stay orion's, parsed from the same syntax.** Orion's is a JSON AST over run context
  with `map`, `reduce`, `match`, `pipe` and a function table of its own, and it
  has **no text syntax** — while the UI mockup has authors typing
  `$.item.score > 0.7`, so orion needs one either way. `toolbelt/predicate` is the
  `.lite` policy language: boolean, over one record, in SQLite's three-valued
  logic and comparison rules, compiled to SQL as well and held to that half by an
  oracle; its grammar is ~150 lines inside litestone's parser. The two share
  comparisons, `&&`/`||`/`!`, paths and literals, and nothing else.
  - **A** — fully separate: orion invents its own text syntax over its AST.
  - **B** — one language and one evaluator in toolbelt, with a policy mode and a
    value mode.
  - **C** — one expression syntax and parser in toolbelt, used by both. An edge
    condition is evaluated by `predicate`'s three-valued rules; `map`, `pipe` and
    the functions stay orion's, parsed from the same syntax.
  - **Recommend C** — a condition on an edge is the question a policy asks, so it
    shares the semantics and not only the spelling, which avoids one text meaning
    two things over a null. A leaves two languages that read alike and disagree
    on null; B puts value-producing forms onto the evaluator whose safety
    argument is one compiler checked against SQL. The cost is extracting the
    grammar from litestone's parser, which toolbelt's substrate standing permits
    (`FJS-D26`).
- ~~**3 — The code node.**~~ **Answered 2026-09-14 (`FJS-D272`): B — keep it, restricted to a gate level that already implies server access.** `new Worker(…, { eval: true })` with `vm` inside is not a
  security boundary; anyone who can author a flow can reach the process.
  - **A** — ship without `data.code`; the expression language covers transforms.
  - **B** — keep it, restricted to a gate level that already implies server
    access.
  - **C** — a real sandbox: a subprocess with no network, a memory ceiling and a
    deadline.
  - **Recommend A** — B is a flag that widens the road without changing it, and C
    is its own project. Revisit when a flow needs a transform the language cannot
    express.
- ~~**4 — Outbound calls to an arbitrary URL.**~~ **Answered 2026-09-14 (`FJS-D273`): A — every call goes through a target, and a `Credential` registers one, with no auth for a public URL.** Conduit's model is a declared
  target with its own policy; a flow author types a URL.
  - **A** — every call goes through a target, and a `Credential` registers one,
    with no auth for a public URL.
  - **B** — one shared open target for anything without a credential.
  - **Recommend A** — timeouts, retries and the breaker stay per destination, and
    the credential list is also the list of everywhere this app's flows call.
- ~~**5 — Can a model trigger miss a write?**~~ **Answered 2026-09-14 (`FJS-D274`): A — the tap, with the gap stated in the builder.** The tap is at-most-once across a
  crash (`FJS-D247`).
  - **A** — the tap, with the gap stated in the builder.
  - **B** — the transactional outbox, so the trigger is written in the same
    transaction as the row.
  - **Recommend A for the first version** — B is `FJS-D228`'s territory and
    costs a write per mutation on every triggered model; offer it per flow when a
    flow cannot tolerate a miss.
- ~~**6 — Which principal does a flow run as?**~~ **Answered 2026-09-14 (`FJS-D276`): A — the flow's owner, re-resolved at run time through Caravan's actor.** It decides what every gate sees
  when a step writes.
  - **A** — the flow's owner, re-resolved at run time through Caravan's actor.
  - **B** — the user who caused the run where there is one, the owner otherwise.
  - **C** — declared per flow, owner or system, with system gated high.
  - **Recommend A** — a flow can do exactly what its owner can, and a demoted
    owner's flows lose the access with them. B makes one flow's reach vary by
    trigger, and C puts `asSystem()` behind a checkbox.
- ~~**7 — How is a flow stored?**~~ **Answered 2026-09-14 (`FJS-D277`): A — rows: `FlowVersion` holds the definition as JSON, immutable per version, with export and import as files for review.**
  - **A** — rows: `FlowVersion` holds the definition as JSON, immutable per
    version, with export and import as files for review.
  - **B** — files committed with the app, written by the builder.
  - **C** — files as the source and rows as a compiled cache.
  - **Recommend A** — it is what the mockup already does, the builder in
    production cannot write a repository, and C is two sources of truth.
- ~~**8 — Who may author and activate a flow?**~~ **Answered 2026-09-14 (`FJS-D278`): A — `USER(4)` drafts and edits; `ADMINISTRATOR(5)` activates, declared as `@@transitions` on `Flow.status`.** A flow acts with its principal's
  reach, so authoring is a privilege.
  - **A** — `USER(4)` drafts and edits; `ADMINISTRATOR(5)` activates, declared as
    `@@transitions` on `Flow.status`.
  - **B** — `ADMINISTRATOR(5)` and above only.
  - **C** — `USER(4)` authors and activates their own flows.
  - **Recommend A** — drafting is harmless and activation is the act with reach,
    and the split is declared in the schema rather than checked in a hook.
- ~~**9 — Which rung is the code node's gate?**~~ **Answered 2026-09-14 (`FJS-D279`): A — `SYSADMIN(7)`.** `FJS-D272` restricts it to a level
  that already implies server access.
  - **A** — `SYSADMIN(7)`.
  - **B** — `OWNER(6)`.
  - **Recommend A** — a tenant owner in a multi-tenant host holds no server
    access, so B would hand them more than they have.
- ~~**10 — Synchronous webhooks.**~~ **Answered 2026-09-14 (`FJS-D280`): A — a sync-triggered flow runs inline in the request's process with a deadline; a sync flow containing `flow.wait` fails to compile.** `http.respond` answers a request held open in
  memory, and a dispatched job may be claimed by another instance.
  - **A** — a sync-triggered flow runs inline in the request's process with a
    deadline; a sync flow containing `flow.wait` fails to compile.
  - **B** — no sync mode in the first version; every webhook answers 202.
  - **Recommend A** — it keeps flows that compute a response, and the deadline
    and the compile error bound it.
- ~~**11 — Where does the `store` node keep state?**~~ **Answered 2026-09-14 (`FJS-D281`): A — the `KvEntry` model, gated and tenant-scoped.**
  - **A** — the `KvEntry` model, gated and tenant-scoped.
  - **B** — junction's cache.
  - **Recommend A** — state a flow relies on must survive a restart, and a model
    is visible in studio and the inspector under the same redaction rules.
- ~~**12 — How does a package contribute routes to a host's Sierra app?**~~ **Answered 2026-09-14 (`FJS-D282`): A — the host adds one file under its own routes that points at the package's route directory, and the file-tree router follows it.** No
  mechanism exists, and `FJS-D270` needs one.
  - **A** — the host adds one file under its own routes that points at the
    package's route directory, and the file-tree router follows it.
  - **B** — `sierra.config.js` lists packages whose routes mount under a prefix.
  - **C** — build the screens inside `example/` and extract the mechanism later.
  - **Recommend A** — the mount is visible in the host's own tree and removed by
    deleting one file; B puts routes on the page that the tree does not show.
- ~~**13 — Which limits does a flow ship with on day one?**~~ **Answered 2026-09-14 (`FJS-D283`): A — all four: a dry run against a rolled-back transaction with outbound calls recorded and not sent, a per-flow rate limit on runs, `paused` on `Flow.status` as a kill switch read by every trigger, and a ceiling on rows one run may write.**
  - **A** — all four: a dry run against a rolled-back transaction with outbound
    calls recorded and not sent, a per-flow rate limit on runs, `paused` on
    `Flow.status` as a kill switch read by every trigger, and a ceiling on rows
    one run may write.
  - **B** — the kill switch and the dry run only.
  - **Recommend A** — the README calls these day-one features rather than
    hardening, and each one bounds a different way a flow edit goes wrong.
- ~~**14 — How does a flow expression name a value from the run?**~~ **Answered 2026-09-14 (`FJS-D284`): A — `$.path`, at any depth: `$.trigger.body.email`, `$.fetchLead.data.owner.id`.**
  - **A** — `$.path`, at any depth: `$.trigger.body.email`, `$.fetchLead.data.owner.id`.
  - **B** — bare names at any depth: `trigger.body.email`.
  - **Recommend A** — the `$` marks run context, so a bare name keeps meaning a
    model column under the one-hop rule, and `a.b.c` does not mean a deep path in
    one place and a refused second hop in the other.
- ~~**15 — How are functions chained in text?**~~ **Answered 2026-09-14 (`FJS-D285`): A — calls only in the first version: `lower(trim($.trigger.body.email))`.**
  - **A** — calls only in the first version: `lower(trim($.trigger.body.email))`.
  - **B** — a pipe written `|`.
  - **C** — a pipe written `|>`.
  - **Recommend A** — one form added to the grammar, and a pipe can be added
    later without breaking anything already written.
- ~~**16 — How are map, filter and reduce written in text?**~~ **Answered 2026-09-14 (`FJS-D286`): A — arrow lambdas as call arguments: `map($.items, i => mul(i.price, i.qty))`.**
  - **A** — arrow lambdas as call arguments: `map($.items, i => mul(i.price, i.qty))`.
  - **B** — JSON only in the first version.
  - **Recommend A** — the binding name is explicit and the shape is familiar;
    the cost is `=>` in the lexer. Neither grammar has arithmetic operators, so a
    product is `mul(a, b)` from the function table.
- ~~**17 — Where does the lexer live?**~~ **Answered 2026-09-14 (`FJS-D287`): A — litestone's tokenizer moves into `toolbelt/predicate`, and litestone and orion both import it.**
  - **A** — litestone's tokenizer moves into `toolbelt/predicate`, and litestone
    and orion both import it.
  - **B** — an expression-only lexer in toolbelt, held to litestone's by a
    conformance test.
  - **Recommend A** — one lexer means a string, a number or an operator cannot
    lex two ways; the tokens only orion's syntax uses exist in a schema file too,
    and no schema grammar accepts them.
