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
| `runtime/queue.ts` | 70 | delete | Caravan: `src/runner.ts` dispatches a run's job directly |
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
  db/        orion.lite — Flow, FlowVersion, FlowLayout, Run, RunStep, Wait, FlowCredential, KvEntry
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

**`packages/orion/db/orion.lite` is the schema**, imported by the host rather
than pasted, and `packages/orion/tests/store.test.ts` grades it. Eight models:
`Flow`, `FlowVersion`, `FlowLayout`, `Run`, `RunStep`, `Wait`, `FlowCredential`
and `KvEntry`. Names follow the README: `Run` rather than the mockup's
`Execution`. The credential model is not `Credential` because that is
`@frontierjs/auth`'s, and an app imports both.

**Two gate shapes.** What a person edits is gated at the level that edits it —
`Flow` and `FlowLayout` at `4.4.4.5`, `FlowVersion` at `4.4.9.8` (an edit is a
new row), `FlowCredential` at `5`. What the engine writes is 8 — `Run` and
`RunStep` read at `USER(4)` for the inspector, `Wait` and `KvEntry` not at all.

**A run acts as its owner, so the owner is an access grant** (`FJS-D276`).
`Flow.ownerId` is stamped from the creator, a create naming anybody else is
refused, and it is `@immutable`. `FlowVersion.authorId` is stamped the same way,
because the author of what runs and the standing it runs with can be two
people, and activation is approving the first. A flow is created `draft` or
refused, since a flow created `active` never meets the activation gate, and
`currentVersion` is not writable while the flow is active, so pointing a live
flow at a new definition goes through `pause` and `activate`. Only the owner
edits a flow, writes its versions or moves its layout (`FJS-D289`), an
administrator included; one acting on somebody else's flow goes through the
`flows` service, which grades the caller and writes as system, so
`activate`'s `@gate(5)` grades an owner.

**No tenant column.** Row tenancy names its own column, so the host adds one to
each model with `extend model`, the way it adds auth's. The engine's
`workspaceId` goes when the store node moves onto `KvEntry` in phase 4.

**The hot path is one write per stage, not per step.** During a run the store
does one `run.update` of `context` and `currentStage` per stage, and writes
`status` only when it moved. `RunStep` rows are written once, in the same
transaction as the terminal status, when the run ENDS — not when it suspends,
since the context already carries every step across a wait and writing at both
would take an upsert or a read. A waiting run shows its status and stage, and
its steps once it ends. `RunStep` carries no `@@log`.

**`@@transitions` on `Run` does not bind the engine.** The store writes through
`asSystem()`, which does not consult the declaration, so the store suite drives
runs that complete, fail, suspend and resume and asserts every status written
is a declared move. It found one the declaration lacked: a wait in the first
stage is the run's first checkpoint, so `suspend` is from `pending` as well.

**Resume and redaction want opposite things from the same data** (Invariant 7).
A resume needs the real values a step produced; the run history must show a
protected field as `[redacted]`. The split above is what reconciles them:
`Run.context` is `@encrypted` and cleared at a terminal state, and a step's
output is redacted as its `RunStep` row is written. For a model node that needed
no code: the row it answers is the row its OWNER's client read back, and a
non-system reader never receives a `@guarded` or `@encrypted` column, so the
protected value is absent before the step is recorded (`tests/models.test.ts`).
An `http.request` or `ai` output has no schema and is stored as returned, which
the builder should say on the node.

**What a checkpoint costs.** Measured 2026-09-14, `packages/orion/bench/checkpoint.ts`
(`bun run bench`): one `saveContext` of a context holding N node outputs of
about 230 bytes each — twice, since a context keeps each output in `nodes` and
in the node's state — over `createTestEnv`'s file database, bun 1.3.11, median
of three runs. `raw` is one prepared `UPDATE` on a second connection with the
writer's pragmas.

| Nodes | Context | raw µs | litestone µs | `@encrypted` µs |
| --- | --- | --- | --- | --- |
| 10 | 4.7 KB | 45 | 89 | 126 |
| 100 | 46.9 KB | 133 | 195 | 614 |
| 1,000 | 475 KB | 1,004 | 1,199 | 5,953 |

**The first measurement was four times this, and `RETURNING` was why.** A
litestone `update` hands back the row it wrote, so every checkpoint parsed —
and decrypted — the context it had just serialized; at 1,000 nodes that was 55%
of the time. `select: false` skips it, which is the one line that took the
plain column from 4,700 µs to 1,200. What is left over raw is the serialize.

**Encryption is the cost that remains, and it is paid per stage over the whole
context**, so a flow pays O(stages × nodes): a hundred-node flow is well under
a millisecond a stage, while a thousand-node flow with a stage per node spends
about three seconds of bookkeeping, the context growing as it goes. The profile is the cipher, the base64 and the
larger row, none of it avoidable while the column is encrypted. The lever if
that shape arrives is a checkpoint of what CHANGED in the stage rather than of
the whole context; nothing written so far needs it.

---

## Execution

`packages/orion/src/runner.ts` is this section, and `tests/runner.test.ts` and
`tests/crash.test.ts` run it against a real Caravan queue and a real litestone
database.

**A run is one Caravan job.** `start` writes a pending `Run` and dispatches
`orion.run` under `run:<runId>`. A trigger that holds an id for its own delivery
states it as the run id, so a duplicate trigger — two at once included — is one
run for all time. Inside the job the scheduler runs stages in order and nodes
within a stage in parallel. The mockup's `Scheduler.run()` polling loop, its
`concurrency` option and the in-memory queue are gone: which run, when and how
many at once is Caravan's.

**A run acts as the flow's owner** (`FJS-D276`), dispatched with
`{ actor: flow.ownerId }` whatever triggered it, so Caravan re-resolves the owner
when the job runs and a demoted owner's flows lose the access with them. Who may
activate a flow is declared on `Flow.status`: `USER(4)` drafts,
`ADMINISTRATOR(5)` activates (`FJS-D278`), and only the owner edits
(`FJS-D289`). Flows are rows, one immutable `FlowVersion` per version, with JSON
export and import for review (`FJS-D277`). A flow that is not `active`, has no
current version or does not compile refuses to start and leaves no run behind.

**A crash resumes at the stage, so a stage runs at least once.** Caravan reclaims
a job whose instance stopped heartbeating; the job loads `Run.context` and
starts at `currentStage`. Any node in that stage that finished before the crash
runs again. For an `http.request` that is a second POST. The port states this on
the node and passes a stable idempotency key (`runId:nodeId:attempt`) to conduit,
rather than checkpointing per node and paying the per-step write the speed rule
avoids. `tests/crash.test.ts` SIGKILLs a real worker process with a stage in
flight and starts another: the stage before the kill runs once, the run
completes, and the job took two attempts.

**A wait ends the job, and its `Wait` row is written with the checkpoint.** The
`flow.wait` node only answers a sentinel naming its key; the store writes the row
in the transaction that moves the run to `waiting`, so a key exists exactly while
its run waits. The key is 32 random bytes — it is the credential a resume
presents, and the mockup made it with `Math.random`. `resume(key, payload)`
dispatches `orion.run` under `resume:<key>`; the job consumes the row and moves
the run back to `running` in one transaction, then continues. A replayed key is
refused twice over: the job id makes every dispatch of it one job, and a job that
finds the row already consumed runs nothing unless it is itself a retry, whose
checkpoint already carries the payload.

**A sweep runs each minute as a Caravan cron job.** It fails a run whose wait is
past its deadline — consuming the same row a resume would, so the two cannot both
win — and dispatches again any run still `pending` a minute after it was written,
which is what a crash between the insert and the dispatch leaves.

**Cron is Caravan's schedule, following the row.** `scheduleFlow` registers the
active version's `trigger.cron` nodes and `unscheduleFlow` takes them back;
neither survives a restart, so a host calls `scheduleActiveFlows` at boot. A fire
starts its run under the fire's own job id, so a retried fire is the run it
already started. The expression must be a literal: a schedule exists before any
run does.

**A synchronous webhook cannot be dispatched.** `http.respond` answers a request
held open in memory, and a dispatched job may be claimed by another instance. A
flow whose trigger is `mode: "sync"` runs inline in the request's process with a
deadline, and a sync flow containing `flow.wait` is a compile error (`FJS-D280`).

---

## Triggers

`packages/orion/src/plugin.ts` installs these into a Junction app, and
`packages/orion/tests/plugin.test.ts` drives them through a real one.

| Trigger | Source | Notes |
| --- | --- | --- |
| model event | `trigger.model`, a subscriber on litestone's write tap (`FJS-D247`) | an Observer, post-commit and at-most-once across a crash (`FJS-D274`). **A write made by a run starts no flow** |
| cron | `trigger.cron`, Caravan `schedule`, `unschedule` on deactivate | a fire starts its run under the fire's job id |
| webhook | `trigger.webhook`, a junction raw route, `POST {prefix}/hooks/{path}` | `async` answers 202 and the run id; `sync` answers with the flow's `http.respond`, inline, with a deadline (`FJS-D280`) |
| resume | a raw route, `POST {prefix}/wait/{key}` | the key is the credential: 32 random bytes, single use |
| named event | `trigger.event`, `app.orion.emit(name, payload)` from the app's own code (`FJS-D293`) | runs as each listening flow's owner; an emit inside a run starts flows, which is how one flow chains another |
| manual | `trigger.manual`, `flows.run(id, { payload })` | the owner or an administrator (`FJS-D292`); runs as the owner (`FJS-D276`) |

**Activation is one owner.** `activate(flowId)` compiles the current version and
registers every trigger it declares — the cron schedules with Caravan, the model
triggers and webhook paths in the runner's indexes — replacing what the flow had,
and `deactivate` takes them back. A webhook path is one URL segment and belongs
to one flow, and a model trigger naming a model the app does not have is refused.
Registration is per process, so every instance runs `syncActivations` at boot and
on a timer, comparing the active flows' `(id, currentVersion)` with what it holds;
an activation made on one instance reaches the others within
`activationPollInterval`, 5s by default
([`FJS-1155`](../ISSUES.md#fjs-1155)). A flow that cannot activate is reported
once per version rather than failing the boot. The kill switch never waits on
the poll, because `start`, the run job and `resume` each read `Flow.status` again.

**A flow cannot trigger itself.** A write made inside a run — an
`AsyncLocalStorage` scope the runner opens around every run — starts no
model-triggered flow. Without it a flow writing the model it is triggered by
starts itself for ever, bounded only by a rate limit that is off by default. The
price is that no flow chains another through a write; a chain is a
`service.call` or a named event.

**A webhook is refused in production until the app verifies it.** A path is not a
credential, so `orion({ verifyWebhook })` answers whether a request may start its
flow — a provider's signature over `ctx.rawBody` — and without one the route
answers 401 under `NODE_ENV=production`, the way Caravan's admin routes do. The
trigger stored on the run carries the request's headers through
`@frontierjs/toolbelt/redact`, so a credential a caller sent is not written into
run history. A sync run is not a Caravan job, so no lease covers it: it stamps
`Run.heartbeatAt` while it executes, and the sweep hands a run whose stamp went
stale to the ordinary run job, which resumes it from its checkpoint
([`FJS-1156`](../ISSUES.md#fjs-1156)).

---

## Actions

**The node that touches the app's data is the point.** `model.create`,
`model.patch` and `model.remove` write through the run's actor — for a Junction
app, the client `$setAuth` scopes to the owner junction re-resolves — so the gate,
the row policies and the field rules refuse a node exactly as they refuse a
request. The model name must be one the schema declares before it becomes an
accessor (Invariant 8), and a row is named by the model's own key through
`$primaryKey`. **The compiler types a write at author time** against the app's
JSON Schema in create and update mode, the documents junction validates a request
against: a model the app does not have, a field its mode does not accept, and a
model or field set computed at run time each fail to compile, naming what the
model accepts. `service.call` calls the six verbs by their own calls and anything
else as a custom method, inside `app.runAs(owner)`.

The existing nodes moved onto their owners:

| Node | Became |
| --- | --- |
| `http.request` | a `credential` and a `path`, never a URL: orion's own conduit instance sends it through the target the `FlowCredential` registers (`FJS-D273`), carrying `runId:nodeId:attempt` as the idempotency key. A non-2xx is an output with `ok: false`, not a failure |
| `ai` | the app's `IAIModel` by name, `complete` only, inside `app.runAs(owner)`; the mockup's vendor providers and its embed, classify and extract modes are gone (`FJS-D153`) |
| `store` | the `KvEntry` model through an async port, scoped `flow` (the default), `global` or `run` (`FJS-D281`) |
| `flow.wait` | a sentinel; the store writes the `Wait` row with the checkpoint |
| `data.code` | unchanged; `SYSADMIN(7)` is enforced where a flow is saved, by `flows.save` and `flows.import` (`FJS-D279`) |
| `trigger.*`, `flow.*`, `data.template`, `data.parse`, `expr.pipeline` | unchanged |

**orion's conduit is its own.** A flow's secrets are `FlowCredential` rows —
encrypted, gated at 5, readable by the administrator who wrote one without the
secret — and the app's conduit resolves credentials from the environment. So the
plugin creates a conduit whose resolver reads those rows; a credential is
registered as a target on first use and again whenever its `updatedAt` moves.
Everything conduit owns per target applies unchanged, the refusal to follow a
redirect with the credential included.

Two more the README lists and the mockup lacks. **`job.dispatch`** queues any job
the app registers, with the owner as Caravan's actor (`FJS-D290`), under the job
id `orion:<runId>:<nodeId>`, so a stage run again after a crash queues nothing
new; orion's own jobs are refused by name. **`notify`** sends any notification
the app declares to any recipient the flow computes, an account id or an address
(`FJS-D291`), inside `app.runAs(owner)`. A notification carries no delivery key,
so a stage run again sends it again and a failure is not retried. Both names are
literal and are checked when the flow compiles, against Caravan's registrations
and `app.notifications`.

**Blast radius is day one** (`FJS-D283`), and each limit is asked where it is
hardest in `tests/limits.test.ts`:

- **The kill switch** is read by every trigger and again by the run job, so a run
  queued before a pause is cancelled rather than run, and a waiting run of a
  paused flow stays waiting — its key refused until the flow is active again.
- **`Flow.runsPerMinute`** is counted at `start`, not reserved: two triggers
  arriving together can both take the last slot. It bounds a runaway.
- **`Flow.maxWrites`** is a budget the scheduler seeds from the model nodes that
  completed in the checkpoint, so a resumed run counts what it wrote before it
  waited. A write in flight holds its row and a refused one gives it back.
- **A dry run** runs a version — a draft as readily as an active flow — as its
  owner inside a transaction that is rolled back, with no `Run` row written. The
  engine carries the flag: `http.request`, `service.call`, `ai` and a `store` write
  record what they would have sent in their output and do not send it, and
  `data.code` does not run, because a script can reach anything the process can.

---

## Services

`packages/orion/src/services.ts` is this section, and `packages/orion/tests/services.test.ts`
runs it over HTTP with real principals and then over both transports.

**Three services, each a model service over orion's own models**, so a read, a
create and a patch are graded by `orion.lite` like any other; what they add is
the verbs a row write cannot say. `flows` saves a version (compiled first, and
refused a `data.code` node below `SYSADMIN(7)`), lists versions, activates,
pauses, archives and restores, runs by hand, dry-runs, exports and imports a
flow file, and reads and moves the layout. `runs` lists runs and a run's steps,
cancels a waiting run, and answers metrics. `flowCredentials` is the derived
verbs alone, at `ADMINISTRATOR(5)`, with the secret written and never read back.

**Two names moved from the plan.** The credentials service is `flowCredentials`,
its model's name, rather than `credentials`, since `@frontierjs/auth` owns
`Credential`; and the metrics are a method on `runs` rather than a `metrics`
service, because `/metrics` is junction's own route.

**Who may act on a flow is one test** (`FJS-D289`, `FJS-D292`): the owner writes
through their own client, so the policies and the `activate` move's `@gate(5)`
grade them; an administrator acting on somebody else's flow writes through the
system client once the service has graded them; anybody else is refused. An
activation compiles the current version before the move and registers the
triggers after it, and a trigger that cannot register — a webhook path another
flow holds — puts the status back.

**Cancel is for a waiting run.** Its `Wait` rows are consumed in the cancel's own
transaction, so a resume or a deadline racing it loses. A queued or running run
is refused, because its job writes every checkpoint over whatever is underneath
([`FJS-1157`](../ISSUES.md#fjs-1157)).

---

## Tenancy

`packages/orion/src/tenancy.ts` is this section, and `packages/orion/tests/tenancy.test.ts`
runs it under both strategies through the real plugin (`FJS-D294`).

**Orion's models are the host's, so they are tenanted the way the host's are,**
and the runner never holds a client: it asks `open(tenant)` for one tenant's
system client — leased from the registry's pool under `strategy database`,
scoped by the claim under `strategy row` — and `tenants()` for the walks. A run's
Caravan job carries its tenant and Caravan re-enters it; a resume key is tagged
with it, because a resume is a key and nothing else; an activation records it,
so every trigger starts a flow in the flow's own tenant. The poll and the sweep
visit every tenant.

**The owner's client is junction's to build.** A run acts through
`app.runAs(owner, { tenant }, () => app.withDb(fn))`, which runs the app's own
data hook — the tenant's file, the principal resolver's claims — so a model node
writes exactly as a service call of the owner's would. `app.onTenantClient` is
how writes are heard per tenant under `strategy database`; under `strategy row`
a written row names its own tenant.

**Under `strategy row` the host adds its column to Flow, FlowCredential and
KvEntry**, and every other model reaches a Flow through its relation. Two
uniques are still across the whole table — a credential's name and a store key
— which the host cannot rewrite ([`FJS-1159`](../ISSUES.md#fjs-1159)).

---

## UI

**The React mockup is a specification, not a source.** Nothing in it ports; what
it gives is every screen, every state and a mock dataset. The rewrite is mesa over
`@frontierjs/ui`, styled with tones and treatments rather than `tokens.js`'s
colors (Invariant 13), with `Flow.mesa`, `Run.mesa` and `FlowCredential.mesa` as the
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
paper and the gate ladder passes. *Done 2026-09-14*: § Data. The store is
`LitestoneExecutionStore`; the engine's store interface lost `queryRecords` and
`getMetrics`, which only the mockup's admin API called and phase 5's services
answer from the models. Two kernel defects surfaced on the way and are fixed: a
run suspended at a wait was recorded `completed`, which would have cleared the
context its resume reads, and a node with no implementation was stepped over and
the run recorded `completed`.

**3 — Execution on Caravan.** The run job, the actor, wait and resume, cron from
a flow row. *Done when* a test kills the process mid-stage and the run completes
on restart, and a replayed resume key runs nothing. *Done 2026-09-14*:
§ Execution. The crash test's first run went red for a reason worth keeping:
Caravan unrefs its timers because a host's server holds the process open, so a
worker with no server exits a tick after it starts.

**4 — Triggers and actions.** The tap subscriber, the raw routes, the model and
service nodes with author-time typing, conduit, `IAIModel`, the credential
model, dry run and the kill switch. *Done when* a flow writing a field its model
does not declare fails to compile, and a flow run as a principal below a model's
gate is refused by that gate. *Done 2026-09-14*: § Triggers and § Actions;
`tests/models.test.ts` is the done-when against a litestone host and
`tests/plugin.test.ts` against a Junction one, where the refusal is junction's
own resolver grading the session `app.runAs` rebuilt. One scheduler defect
surfaced: a node failing in a parallel stage ended the run while its sibling was
still running, so the record named a step `running` in an ended run and the
sibling's write could land after it; the stage now settles first. The mockup's
`triggers/`, `nodes/providers/` and `store/` are deleted, being replaced.

**5 — Services.** `flows`, `runs`, `credentials`, `metrics` replace `api/`.
*Done when* `verifyTransportParity` passes over each. *Done 2026-09-15*:
§ Services, as three services rather than four. Parity passes over eighteen
calls across the three for four principals, and fails when the app's
`channels()` is removed. One defect surfaced: a dry run had never worked in a
Junction app, because the runner opened its transaction on the actor and
`orion()`'s actor is `{ db, userId }`; the host now passes `inTransaction`.
The rest of `mockup/api-engine` is deleted.

**6 — UI.** Screens in the order above, installed into `example/`. *Built
2026-09-15, not yet browser-proved*: Sierra mounts a package's routes by one file
(`FJS-D282`), and orion is tenant-aware (`FJS-D294`), because `example/` is
`strategy database` and a runner holding one client would have written every
shop's runs into the default shop's file. The list, detail, inspector and
credential screens are under `packages/orion/web/`, mounted at `/automations/`;
the definition is edited as JSON and the canvas is not built. Installing found
that the services graded an administrator by junction's default mapping rather
than the app's, which `orion({ level })` answers (`FJS-1161`). Phase 7's drive is
what proves the screens.

**7 — Dogfood.** A drive in `example/` (`verify:automations`) with rows in both of
`DRIVES.md`'s tables, then one real automation in basecamp. Anything orion needs
and cannot express is filed against the framework, per the README.

*Status 2026-09-15: the `example` half is done.* `verify:automations` passes 37
assertions and has a row in both tables. Building it found `FJS-1162`–`FJS-1166`,
all fixed — two in orion's model nodes, a missing channel, and three below orion
(toolbelt's `make()`, `<Form>`, mesa's `{#each}`) — and `FJS-1167`, which
question 24 ruled (`FJS-D295`: the owner or an administrator) and is closed. The
basecamp automation is not started.

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
- ~~**18 — Who may edit a flow they do not own?**~~ **Answered 2026-09-14 (`FJS-D289`): A — owners only: `@@allow('update', ownerId == auth().id)` on `Flow`, `FlowLayout` and version creates, with administrators editing through the phase 5 `flows` service after its own gate check.** `Flow` is gated `4.4.4.5` and
  carries no row policy, so any `USER(4)` may rename another person's draft,
  write a new version of it or pause it. A run acts as the owner (`FJS-D276`),
  so an edit by somebody else changes what the owner's standing does, and
  `FlowVersion.authorId` now records who did.
  - **A** — owners only: `@@allow('update', ownerId == auth().id)` on `Flow`,
    `FlowLayout` and version creates, with administrators editing through the
    phase 5 `flows` service after its own gate check.
  - **B** — the gate only. Any `USER(4)` edits any flow, and activation at
    `ADMINISTRATOR(5)` is the review, showing each version's author.
  - **Recommend A** — B makes the review the only thing between a colleague and
    the owner's standing, and a review of a JSON definition is not one anybody
    reads closely. A costs administrators a service path rather than the model's
    own update, and it is expressible in the file today.
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
- ~~**19 — Which jobs may a flow's `job.dispatch` start?**~~ **Answered 2026-09-14 (`FJS-D290`): C — any registered job, as the owner, with nothing further.** A job handler is app
  code written against data app code dispatched, and many write through
  `asSystem()`; a flow is written by a `USER(4)` and activated at
  `ADMINISTRATOR(5)`, so whatever the node may dispatch is reachable with data a
  user chose.
  - **A** — only jobs the app names in `orion({ jobs: [...] })`. A flow naming any
    other fails to compile, by name; the job runs with Caravan's actor set to the
    flow's owner.
  - **B** — any registered job, with the node gated at `SYSADMIN(7)` where a flow
    is saved, as `data.code` is (`FJS-D279`).
  - **C** — any registered job, as the owner, with nothing further.
  - **Recommend A** — the list is the app saying which handlers grade their own
    input, and it is checked at author time where the model nodes are. B leaves
    the node to the few who could write the job themselves, and C hands a
    system-writing handler to anyone who can draft a flow.
- ~~**20 — Whom may a flow's `notify` address, and with what?**~~ **Answered 2026-09-14 (`FJS-D291`): B — any declared notification, to any recipient a flow computes, an id or an email address.**
  - **A** — the app names the notifications a flow may send in
    `orion({ notifications: [...] })`, and a recipient is an account id read
    through the owner's own client on the auth user model, so the row it
    addresses is one the owner can read and the email comes off that row. No bare
    addresses.
  - **B** — any declared notification, to any recipient a flow computes, an id
    or an email address.
  - **C** — the owner only: a flow notifies the person it runs as.
  - **Recommend A** — B makes every user who can draft a flow a sender of the
    app's own mail to any address, and C cannot say *tell the lead's rep*. A
    bounds reach by the Data boundary the model nodes already answer to: whoever
    the owner cannot read, the owner cannot notify.
- ~~**21 — Who may start a flow by hand?**~~ **Answered 2026-09-15 (`FJS-D292`): A — the owner, or an `ADMINISTRATOR(5)`: the test `FJS-D289` applies to an edit, applied to a run.** A run acts as its flow's owner whatever
  started it (`FJS-D276`), so `flows.run(id, payload)` and `flows.dryRun` hand the
  caller the owner's standing for one run, with a payload the caller chose.
  - **A** — the owner, or an `ADMINISTRATOR(5)`: the test `FJS-D289` applies to an
    edit, applied to a run.
  - **B** — anyone who can read the flow (`USER(4)`).
  - **Recommend A** — B lets any user run an administrator's flow with their own
    payload, which is the escalation `FJS-D276` rules out by trigger; A is the
    rule a flow's edits already follow, so there is one answer to *who may act on
    this flow*.
- ~~**22 — How is a named event emitted?**~~ **Answered 2026-09-15 (`FJS-D293`): A — `app.orion.emit(name, payload)` only, called by the app's own code; an app that wants it over HTTP wraps it in a service method of its own and grades that.** `trigger.event` starts every active flow
  listening for a name, each as its own owner.
  - **A** — `app.orion.emit(name, payload)` only, called by the app's own code; an
    app that wants it over HTTP wraps it in a service method of its own and grades
    that.
  - **B** — an `events` service with `emit`, open to `USER(4)`.
  - **C** — an `events` service with `emit`, gated at `ADMINISTRATOR(5)`.
  - **Recommend A** — whoever may emit starts other people's flows with a payload
    of their choosing, and which callers may do that is the app's to say; a
    webhook needs a signature in production for the same reason. A is also the
    smallest surface, and B or C can be added without changing it.
- ~~**23 — Which tenancy does orion support first, and before or after the screens?**~~ **Answered 2026-09-15 (`FJS-D294`): A — tenancy first: a run records its tenant, its job carries it, the store and the runner reach that tenant's database, and activation, the poll and the sweep walk every tenant — for both strategies, graded against `example` and a row-tenancy fixture. Then the screens, installed into `example/`.**
  Phase 6 installs orion into `example/`, which is `tenancy { strategy database }`:
  a shop is a file. Orion's runner holds ONE system client, so installed there
  every run, flow and wait would be written to the default shop's file whatever
  shop the flow belongs to. `basecamp` is `strategy row`, and a run started with
  no request in scope has no tenant claim to act under. Caravan already records a
  job's tenant and re-enters it, which is the seam either answer builds on.
  - **A** — tenancy first: a run records its tenant, its job carries it, the
    store and the runner reach that tenant's database, and activation, the poll
    and the sweep walk every tenant — for both strategies, graded against
    `example` and a row-tenancy fixture. Then the screens, installed into
    `example/`.
  - **B** — the screens first, installed into a harness app inside the package
    with no tenancy; tenancy after, before phase 7's drive.
  - **C** — row tenancy only for now, and install into `basecamp` first; database
    tenancy later.
  - **Recommend A** — screens built against a host no real app resembles are
    screens the tenancy work reopens, since every read they make crosses the
    tenant boundary; A costs the most before a pixel, and it is the work every
    host needs.
- ~~**24 — Who may read a run, its steps and a flow?**~~ **Answered 2026-09-15 (`FJS-D295`): A — the owner or an administrator. A row policy on the row's own owner (`Run.actorId`, and `RunStep` one hop through `run`, `Flow.ownerId`), and an administrator reads through the services, which grade the caller and read as system — `FJS-D289`'s rule for writing, applied to reading. The trigger is recorded as the OWNER reads the row (`$readAs`), so an owner does not see a column only the writer could.** (`FJS-1167`) `Run` reads at
  USER(4) and `RunStep` too, with no row policy, and a model trigger records the
  row as the WRITER read it. `Flow` reads at 4 with none either. Orion's gates
  assume USER means a member of the organization; `example` grades its shoppers
  4 on purpose, so measured there a shopper reads another customer's whole row
  out of `/runs` while `GET /customers/9` answers her 404. A broadcast on `runs`
  is graded by the same rule, so it reaches exactly who a GET does.
  - **A** — the owner or an administrator. A row policy on the row's own owner
    (`Run.actorId`, and `RunStep` one hop through `run`, `Flow.ownerId`), and an
    administrator reads through the services, which grade the caller and read as
    system — `FJS-D289`'s rule for writing, applied to reading. The trigger is
    recorded as the OWNER reads the row (`$readAs`), so an owner does not see a
    column only the writer could.
  - **B** — ADMINISTRATOR(5) reads all three, with the trigger recorded as the
    owner reads it. Automations become an administrator's screen; staff keep
    drafting through the services and read nothing back.
  - **C** — orion ships no read rule beyond the gate, and a host whose USER is
    wider than its staff adds its own `@@allow('read', …)` with `extend model`.
  - **Recommend A** — B and C both still leave a run holding columns its readers
    may not read, and C makes every host rediscover the hole; A follows the
    owner-or-administrator rule the services already use for every write, so a
    screen's reads and writes agree about who a flow belongs to.
