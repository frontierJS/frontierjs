# @frontierjs/orion — the inside view

Automations for a FrontierJS app: flows of triggers, conditions and actions, run
by an engine installed into the app (`FJS-D269`). Being ported from `mockup/`;
the plan, module by module, and the rulings it rests on are
`IDEAS/orion-port.md`. `README.md` is the intent.

## Layout

| Path | What it owns |
| --- | --- |
| `db/orion.lite` | every model an installed orion writes, imported by the host — the flows a person edits and the runs the engine writes |
| `src/tenancy.ts` | which database a run's rows are in: the `OrionHost` port, `litestoneHost` for no tenancy, a registry and row tenancy, and the tenant tag on a resume key |
| `src/store.ts` | `LitestoneExecutionStore`: the per-stage checkpoint, the terminal write, and the two ways a wait ends, over the host's system client |
| `src/runner.ts` | a flow row into a `Run` and one Caravan job, and back: start, the run job, resume, the dry run, the inline sync run, activation and the trigger indexes, the sweep |
| `src/plugin.ts` | `orion()`, the Junction plugin: the owner as the actor, the tap subscriber, the two raw routes, orion's conduit, the app's AI models, the services |
| `src/services.ts` | `flows`, `runs` and `flowCredentials`: the verbs a row write cannot say, and the one test of who may act on a flow |
| `src/models.ts` | the app's models for the model nodes: the author-time catalog off the JSON Schema, and the writes through the actor |
| `src/outbound.ts` | `http.request` over conduit, and conduit's credential resolver over `FlowCredential` |
| `src/kv.ts` | the `store` node's port over `KvEntry`, whose deadline is `@@expires(expiresAt)` minted from the client's clock |
| `src/engine/types/` | the primitives — `Flow`, `NodeDefinition`, `Edge`, `Expression`, `PipeStep`, `ExecutionPlan` |
| `src/engine/compiler/` | a flow → an `ExecutionPlan`: stages, an O(1) routing table, and every author-time refusal |
| `src/engine/expression/` | the flow expression language: `index.ts` is the evaluator and its function table, `text.ts` parses the text form with `@frontierjs/toolbelt/predicate` and compiles it |
| `src/engine/executor/` | one node: resolve its config, run it with retry, timeout and cache |
| `src/engine/runtime/` | the stage runner (`Scheduler`), the run context, and the store INTERFACE with an in-memory implementation |
| `src/engine/plugins/` | the node-type registry and the built-in descriptors |
| `src/engine/nodes/` | the built-in node implementations, and the worker pool behind `data.code` |
| `src/engine/triggers/registry.ts` | which flow answers which trigger |
| `src/engine/ports.ts` | what the nodes need from the host — the model writes, service calls, job dispatch, notifications, outbound calls, the AI models, the key-value store — and `HostCatalog`, what the compiler checks a node's names against |
| `test/engine/` | the engine's suites, one directory per module |
| `test/engine-boundary.test.ts` | the rule that `src/engine/` imports nothing outside itself but `@frontierjs/toolbelt` |
| `test/store.test.ts` | the schema's access rules with real principals, and the store's statement count and status moves against a real litestone |
| `test/runner.test.ts` | runs on a real Caravan queue: one job per run, idempotent starts and resumes, wait deadlines, a lost dispatch, cron, an activation reaching a second instance |
| `test/crash.test.ts` | a worker PROCESS SIGKILLed mid-stage, and a second one finishing the run; the same for an inline sync run, handed over by the sweep |
| `test/models.test.ts` | phase 4's done-when against a litestone host: a write typed at compile time, a write refused by the gate |
| `test/limits.test.ts` | the kill switch, runs per minute, the row ceiling and the dry run (`FJS-D283`) |
| `test/plugin.test.ts` | `orion()` in a real Junction app: the owner through `runAs`, the model trigger, both routes, conduit, AI, an app job and a real notification |
| `test/tenancy.test.ts` | orion under `strategy database` and `strategy row`, through the plugin, every landing paired with the other tenant |
| `test/services.test.ts` | the services over HTTP with real principals, and `verifyTransportParity` over all three — phase 5's done-when |
| `test/kv.test.ts` | the `store` node's port on a moved clock: a ttl lapsing with nothing written, `set` and `delete` over a lapsed key, and the sweep |
| `test/outbound.test.ts` | a flow's outside call on the wire, against a local server |
| `test/fixtures/` | `host.ts` — the schema, a node registry and test nodes that leave evidence on disk; `app.ts` — an app with two gated models, notifications' model and orion's catalog; `notifications/` — the one notification a flow sends; `worker.ts` — the process the crash test kills |
| `bench/checkpoint.ts` | what one checkpoint costs at 10, 100 and 1,000 nodes; `bun run bench` |
| `web/routes.js` | the directory a host mounts — `export { default } from '@frontierjs/orion/routes'` in a `*.mount.js` (`FJS-D282`) |
| `web/routes/` | the screens: flows, a flow, runs, a run, credentials, and the section layout |
| `web/components/` | `NodeInspector.mesa` (a node's config, one field per `configSchema` property), `ConfigValue.mesa` (one value — a literal on the schema's control, a computed one on `ExpressionField`) and `ExpressionField.mesa` (an expression as the line that parses back to it) |
| `web/resources/` | `Flow.mesa`, `Run.mesa`, `FlowCredential.mesa` — the resources the screens read through |
| `mockup/ui/components/` | four files, the specification for what is not built and not a source: `flow-editor.jsx` (the canvas), `pages.jsx` (metrics, templates, plugins, the run filter bar), and `nodes.jsx` + `node-types.js`, whose `NODE_CONFIG_FIELDS` is the design the inspector DECLINED. **It does not run** — no `package.json`, no vite — so it is read, never driven |

## What bites here

- **The actor is opaque to the engine and is not the same thing in every host.**
  A litestone host hands in a scoped client; `orion()` hands in
  `{ db, userId }`, because a service call and an AI adapter re-enter the owner
  through `app.runAs` and a client cannot. A port reads the actor through the
  shape its host gave it, never by looking.
- **A write made inside a run starts no flow.** The runner opens an
  `AsyncLocalStorage` scope around every `processJob`, and `onWrite` returns when
  one is open. A new way of running a flow that does not go through `insideRun`
  is a flow that can trigger itself for ever; `plugin.test.ts`'s echo row fails
  without the guard.
- **A model node's field names are literal or the flow does not compile.**
  Typing is against the app's JSON Schema in create and update mode, so a
  column that mode omits — a server-assigned key, a `@guarded` column — is
  refused at author time even though it exists.
- **`http.request` has no URL.** It names a `FlowCredential` and a path, and
  orion's own conduit sends it (`FJS-D273`). A non-2xx is an output with
  `ok: false`; only a call that got no answer fails the node.
- **A dry run is a flag the engine carries, and every node with an effect outside
  the actor has to read it.** A new node that calls out and does not check
  `ctx.dryRun` sends from a dry run; `notSent` is how it records instead.
- **`src/engine/` imports nothing but itself, Node builtins and
  `@frontierjs/toolbelt`**, and `test/engine-boundary.test.ts` fails the suite
  otherwise. The kit is the one package `FJS-D26` licenses everybody to import;
  a framework package is what the rule is against. A host capability
  reaches the engine as an interface in `ports.ts` or `runtime/`, supplied at
  construction. The reason is cost, not taste: a Junction service in the
  executor's loop is roughly twice a direct litestone write per checkpoint
  (`IDEAS/operational-edge.md` § durable workflows).
- **A pipe step after the first omits the operand the flowing value fills.**
  `{ type: "fn", name: "lower" }` is `lower($)`, and a `map` with no `over` maps
  over `$` — which is why `PipeStep` is its own type, and why the compiler's
  walks read a step as the `Expression` it extends and skip absent branches.
- **The worker pool is not a sandbox.** `vm` inside a worker thread keeps a
  script's scope apart and nothing else; an author reaches the process. The
  `data.code` node is gated at `SYSADMIN(7)` for that reason (`FJS-D272`,
  `FJS-D279`), and the gate is the host's to enforce — nothing in the engine
  does.
- **A checkpoint's `update` is `select: false`.** Without it litestone parses and
  decrypts the whole context it just wrote, which was three quarters of a
  1,000-node checkpoint. Any new write in `src/store.ts` on the run path wants
  the same, and `bun run bench` is how to see it.
- **`asSystem()` does not consult `@@transitions`**, and the store writes
  through it, so `Run`'s declared moves bind the engine only through
  `test/store.test.ts`'s walk. A new status the scheduler reaches needs a path
  in that walk, or an undeclared move ships green.
- **`Flow.ownerId` and `FlowVersion.authorId` are access grants.** A run acts as
  the owner (`FJS-D276`), so each is stamped from the caller, a create naming
  anybody else is refused, and the owner is `@immutable`. A create policy is
  evaluated before defaults are stamped: every rule over a create payload reads
  an absent column as NULL, which is why each one says `!= null` first.
- **`orion.lite` declares no tenant column.** Row tenancy names its own column,
  so the host adds one per model with `extend model`.
- **A value filled into a condition is a FIELD, never a literal.** The language
  spells `IS NULL` as `x == null`, so a resolved value that is null reads as the
  author having written one and turns `$.a > 1` into a presence test
  (`FJS-1152`). `answerPredicate` binds every hole into a record for that reason.
- **A run is resumed from the database, never from memory.** Every run job reads
  `Run.context`; the scheduler's `resumeFrom` is filled from it, so a change to
  what a context holds is a change to what a restarted run sees. The crash test
  is the proof and fails with `before: 2` when the checkpoint is ignored.
- **A resume key is refused twice, and both refusals are load-bearing.** The job
  id `resume:<key>` makes every dispatch of a key one job; the transaction that
  consumes the `Wait` row stops a second resume even under a different id. The
  run job falls back to the checkpoint when the row is gone only on
  `attempts > 1`, since a first attempt finding it consumed is somebody else's
  resume. `test/runner.test.ts`'s replay row fails with either removed.
- **A worker process with no server exits.** Caravan unrefs every timer, because
  a host's HTTP server holds the process open. `test/fixtures/worker.ts` holds
  itself open for that reason, and the crash test reports a worker that exited
  rather than waiting fifteen seconds for a run nobody is running.
- **`Run.heartbeatAt` set means an inline process owns the run.** A sync webhook
  run is no job, so it stamps the column and the sweep dispatches a run whose
  stamp went stale; the job clears it. A new way of running a flow outside the
  queue stamps it too, or a crash there leaves the run `running` for ever.
- **A trigger registration is this process's alone.** `activate` changes the
  instance it runs on; the others catch up on their `watch` pass. Anything that
  moves `Flow.status` or `currentVersion` needs nothing more, and anything that
  changes what a version registers without moving either is invisible to the
  poll.
- **A flow reaches every job and every notification the app has** (`FJS-D290`,
  `FJS-D291`), so the grading is the handler's: a job runs with the owner as its
  actor, and a handler writing through `asSystem()` with data it did not check is
  reachable by any activated flow. What orion refuses is its own jobs, by the
  `orion.` prefix, because a flow dispatching `orion.run` would run a run beside
  its own job.
- **`job.dispatch` is idempotent and `notify` is not.** The job id is
  `orion:<runId>:<nodeId>`, so a stage run again queues nothing; a notification
  has no delivery key, so the same stage sends it twice. A new node with an
  effect outside the run picks one of the two and says which.
- **Who may act on a flow is `writerFor` in `src/services.ts` and nowhere else.**
  The owner writes through `ctx.locals.db`, so `orion.lite`'s policies and the
  `activate` move's `@gate(5)` grade them; an administrator acting on another
  person's flow gets the system client, which consults neither, so the grading
  of that caller is the function's own check. A new method that writes through
  `system` without calling it hands every caller the system client.
- **A service method answers what it answers and announces what changed.** A
  read-shaped method sets `ctx.dispatch = false`, and one that changes a flow
  sets it to the re-read row; a projection with neither is re-read and warned
  about by junction on every call.
- **A dry run needs the host to open the transaction.** The runner's default
  calls `$transaction` on the actor, which a litestone host's actor is; a
  Junction actor is `{ db, userId }`, so `orion()` passes `inTransaction`. A
  host with a new actor shape passes its own, or every dry run is a 500.
- **An emit inside a run starts flows.** Named events are how one flow chains
  another, so `emit` does not read `insideRun` the way `onWrite` does; a flow
  emitting the event it listens for is bounded only by its `runsPerMinute`.
- **Every way into the runner names a tenant, and a new one must too** (`FJS-D294`).
  A run's job carries it, a resume key carries it, an activation records it;
  something that starts a flow without one starts it in no tenant, which under
  `strategy database` is a refusal and under `strategy row` a flow nobody can
  see. `test/tenancy.test.ts` pairs every landing with the other tenant.
- **A tenant's client is LEASED.** `host.open` and `app.withDb` hand out a
  client the pool may evict once released, so it is used inside the call that
  opened it and never kept — which is why the runner's actor is a callback, and
  why `runInline` holds its lease until the run ends rather than until it answers.
- **A config value is an Expression node, never a plain value.** The resolver
  dispatches on the stored node's own `type`, so `model: 'Customer'` is written
  `{ type: 'literal', value: 'Customer' }` and the same slot may hold
  `{ type: 'ref', path: '$.trigger.record.id' }`. A `configSchema` therefore
  describes what a value must RESOLVE to and not what is stored — which is what
  makes it a form: `buildFieldRules` + `formFieldList` pick the control for the
  literal, and the stored node's own type decides whether that control is what
  the field opens on. **A property with no `type` is an always-computed one**,
  and that absence is read rather than marked, so nothing has to be kept in step
  when a node type gains a field.
- **The node catalog is the REGISTRY's, and that is the whole of why
  `configSchema` exists.** `flows.nodeTypes()` answers `registry.descriptors()`,
  so a host's plugin node reaches a screen; a built-in's form could have been
  written by hand, a plugin's could not.
- **A screen imports the engine for ONE thing and the rule is what separates
  it.** The catalog is registry STATE and can only come from the server. The
  expression text form is a pure function over a closed grammar — `text.ts`
  reads, `emit.ts` writes — so both ends agree by construction, and an author's
  mistake has to arrive as they type; `ExpressionField.mesa` imports those two
  and nothing else under `src/`. Anything that holds state, opens a client or
  touches a run stays the server's.
- **The text grammar is a SUBSET of the Expression union**: seven of thirteen
  forms parse, so `expressionToText` answers `{ text }` or
  `{ text: null, reason }` and a `template`, an `object` or a `pipe` is edited
  as its document ([`FJS-1209`](../../ISSUES.md#fjs-1209)). The grammar is
  `@frontierjs/toolbelt/predicate`, which litestone parses `.lite` policies
  with, so widening it is a ruling and not an edit (`FJS-D271`).
- **A screen reaches nothing through `@`.** A mounted route is compiled in the
  HOST's Vite root, where `@` is the host's `src/`, so every import in `web/` is
  relative or a package name. The services are reached by their default names,
  so a host that renames one has screens that 404.
- **Who is an administrator is the app's mapping, and the host passes it TWICE.**
  Its `GatePlugin({ getLevel })` grades every read — `orion.lite`'s policies read
  `auth().level` (`FJS-D296`) — and `orion({ level })` grades an administrator
  acting on another person's flow through system, and a `data.code` save. The
  `level` default is `sessionGateLevel`, which grades a bare `role` USER(4), so
  an app grading roles its own way — `example`'s `shopGateLevel` — passes it to
  both or reads and writes disagree about who an administrator is. **Junction is
  no longer a third**: a declared method gate is graded by the same
  `GatePlugin` mapping now, asked through `db.$levelOf` (`FJS-D308`), so a host
  whose standing is a membership row is no longer refused at the API by a level
  nothing in it wrote (`FJS-1161`). What is left here is the two paths that
  reach NO client scoped to the caller — a system write and a compile-time
  refusal — which is why `orion({ level })` survives and why collapsing it into
  one option is a separate question.
- **Every read is the caller's own client** (`FJS-D295`, `FJS-D296`). The owner
  and an administrator both arrive through the row policies, so a query, a
  broadcast and a protected column agree. A read in `services.ts` through
  `systemOf` hands an administrator `Run.context` decrypted and another USER
  every row.
- **A trigger's row is the owner's view of it.** The runner asks `readAs` before
  a model trigger starts a run, and a row the owner may not read starts nothing,
  so a flow cannot hear about rows its owner cannot see. A new trigger that
  carries a row goes through the same port.
- **A run reaches a screen only through a channel the host joins.** The engine
  writes every `Run` through the system client, and junction broadcasts a write
  no service call made only on a channel the service NAMES — so `flows` and
  `runs` declare their own service name, and a host that does not join them has
  a runs screen that moves on a reload. Renaming a service renames its channel.
- **A model node's write is the app's own verb.** `model.remove` is litestone's
  `remove`, which soft-deletes a `@@softDelete` model — `delete` is the purge —
  and a patch may name the model's `x-version` column, which the Data boundary
  requires on a versioned model and update mode marks `readOnly`.
- **A run job's failure to find a run is silent by design.** A terminal run, a
  missing run and a waiting run with no key all return without error, because
  each is a replay or a job that outlived its row, and a throw would spend
  Caravan's retries on it.

## Proving a change

`bun run test` from this directory, then `bun run typecheck`. A change to the
store or to what a context holds reruns `bun run bench`, and a number that moved
goes into `IDEAS/orion-port.md` § Data, dated. A change to a screen, a service,
a node's write or what a run broadcasts then runs `example`'s
`verify:automations`, which is the only place the routes are compiled by a host
and a run reaches an open screen.
