# Changes — @frontierjs/orion

## 2026-09-15 — screens, installed into `example`

The rest of phase 6, on the two things it stood on. `web/` holds orion's screens as `.mesa`
routes a host mounts with one file — `web/src/routes/automations.mount.js` in `example` is
`export { default } from '@frontierjs/orion/routes'` — so they answer under `/automations/`
inside the host's own shell. Five routes over three resources: the flows list with create and
import; a flow's page with its status moves, a run by hand and a dry run, the definition as JSON
saved as a new version with the compiler's refusal shown, its versions and its recent runs; the
runs list with the last hour's metrics; a run's page, watched live, with its trigger, its steps
and a cancel while it waits; and the credentials list with a create form that writes a secret no
screen reads back. The canvas is not built: the definition is edited as JSON until it is.

**`example` runs orion** — the schema imports `@frontierjs/orion/orion.lite`, so every shop's file
holds its own flows and runs, and `app.configure(orion({ level: shopGateLevel }))` after the queue.
The API boots with it and the poll walks every shop; the web build mounts the routes and its route
snapshot lists them. **`orion({ level })` is new, and installing found why**: the services graded
an administrator by `sessionGateLevel`, which grades `example`'s `role: 'admin'` USER(4) where the
shop's own Data boundary says 5. The option takes the app's mapping, as `createAuthPlugin`'s
`services.level` does; the method gate junction applies has the same split (`FJS-1161`).

**What is not proved is the screens in a browser.** They compile, they build and the route table
imports them; no drive has clicked through them, which is phase 7's `verify:automations`. Writing
the run screen found `FJS-1160`, a watch on an optional-chained path that does not compile.

## 2026-09-15 — a run knows its tenant

`FJS-D294`: orion in a tenanted app, under `strategy database` and `strategy row`, before it has
screens. `src/tenancy.ts` is the port the runner asks for orion's rows — `open(tenant)` for one
tenant's system client, leased from the registry's pool, and `tenants()` for the walks — with
`litestoneHost` answering it for no tenancy, a registry, and a row-tenancy client scoped by its claim.

**Every entry point names a tenant, and each carries it where the next step can read it.** A run's
Caravan job is dispatched with its tenant, which Caravan re-enters; a resume key is tagged with it,
since a resume is a key and nothing else; an activation records it, so a cron fire, a model write, a
webhook and an emit start a flow where the flow is. The poll and the sweep visit every tenant, and a
tenant that fails does not stop the others. `RunnerOptions.db` became `host`, and `actorFor` became
`withActor(actorId, tenant, fn)`, because a tenant's client is leased and cannot outlive the call.

**In a Junction app the owner is resolved by junction's own hook.** `orion()` runs a run inside
`app.runAs(owner, { tenant }, () => app.withDb(fn))`, so a model node writes through the client a
service call of the owner's would get — the tenant's file, the resolver's claims. Writes are tapped
per tenant client through `app.onTenantClient` under `strategy database`, and read their tenant off
the row under `strategy row`. A webhook path names one flow across the host and refuses a request
whose own tenant is another's. A credential and a key-value entry are read in the run's tenant, and a
conduit target is named for tenant and credential both. The services read through the caller's
client lifted to system, which keeps a row tenant's claim.

`tests/tenancy.test.ts` asks it through the real plugin against a real tenant registry and a row
tenancy app, every landing paired with the other tenant's rows; dropping the tenant from the actor,
the resume key, the webhook check, a re-dispatch or the sweep's walk each fails a row. Under
`strategy row`, a credential name and a global store key are still unique across workspaces
(`FJS-1159`).

## 2026-09-15 — services

Phase 5 of `IDEAS/orion-port.md`. `orion()` registers three services, and
`tests/services.test.ts` drives them over HTTP with principals at USER(4),
ADMINISTRATOR(5) and SYSADMIN(7), then puts eighteen calls down HTTP and a
WebSocket for four principals with `verifyTransportParity` and finds no mismatch.
Removing the app's `channels()` fails it, which is what shows the socket was
spoken to.

**`flows`** saves a version, compiled first and refused a `data.code` node below
`SYSADMIN(7)` (`FJS-D279`); lists versions; activates, pauses, archives and
restores, registering or removing the triggers on this instance; runs a flow by
hand through its `trigger.manual` and dry-runs it, each for the owner or an
administrator (`FJS-D292`); exports and imports a flow file (`FJS-D277`); and
reads and moves the layout. **`runs`** lists runs and steps, cancels a waiting
run, and answers metrics over a window. **`flowCredentials`** is the derived
verbs at ADMINISTRATOR(5). Who may act on a flow is one function: the owner
through their own client, an administrator through the system client once
graded, nobody else (`FJS-D289`). An activation whose trigger cannot register
puts the status back.

**Named events are the app's own code**: `app.orion.emit(name, payload)` starts
every active flow on this instance with a matching `trigger.event`, each as its
owner, and no service emits (`FJS-D293`). An emit inside a run starts flows.

**A dry run had never worked inside a Junction app.** The runner opened its
transaction on the actor, and `orion()`'s actor is `{ db, userId }`, so every
dry run there was a 500; the limits suite passed because its litestone host
hands in a bare client. `RunnerOptions.inTransaction` is the host's answer.

**Two gaps filed.** Cancelling a queued or running run is refused, because its
job writes each checkpoint over the cancellation (`FJS-1157`); and junction's
announcement check warns on every `flowCredentials.create`, counting the
encrypted secret the caller can never read as a missing column (`FJS-1158`).

The rest of `mockup/api-engine` — the admin API, the server and the event bus —
is deleted, with its CI allowance.

## 2026-09-15 — a flow dispatches the app's jobs and sends its notifications

**`job.dispatch` and `notify`, the two nodes the README listed and the mockup
lacked.** `job.dispatch` queues a job on the app's Caravan with the flow's owner
as the actor, under `orion:<runId>:<nodeId>`, so a stage run again after a crash
queues nothing new. `notify` sends one of the app's declared notifications to a
recipient the flow computes, inside `app.runAs(owner)`; it is not idempotent and
is not retried, because a notification has no delivery key and a transport may
already have delivered. Both are dry-run aware.

**What a flow may reach was ruled wider than the paper recommended.** Any
registered job (`FJS-D290`) and any declared notification to any recipient,
bare addresses included (`FJS-D291`). The grading is the handler's and the
activation at `ADMINISTRATOR(5)`; orion refuses only its own jobs, by the
`orion.` prefix, since dispatching `orion.run` would run a run beside its own
job. Both names are literal and checked when the flow compiles — against
Caravan's registrations and `app.notifications` — naming what the app has.

**The runner's `models` option is `catalog`** (`HostCatalog`: `models`, `jobs`,
`notifications`), one argument for everything a node's names are checked
against. `tests/plugin.test.ts` installs the real notifications plugin and
asserts the in-app row and the email; removing the owner as actor, the job
catalog, or the stable job id each fails a row.

## 2026-09-14 — a sync run survives its process, and an activation reaches every instance

**A sync webhook run is recovered after a crash** (`FJS-1156`). It runs in the
process holding the request, outside any job lease, so it now stamps
`Run.heartbeatAt` while it executes, and the sweep hands a `pending` or `running`
run whose stamp went stale to the ordinary run job, which clears the stamp and
resumes from the checkpoint. The row's proposed fix, a run job dispatched with a
delay past the deadline, was not built: an inline run outlives its deadline by
design, and that job would have run it a second time while it was still alive.
`tests/crash.test.ts` kills an inline run's process mid-stage and asserts both
halves — no hand-over while the process beats, and one once it stops.

**Activations reach every instance within one poll** (`FJS-1155`).
`syncActivations` replaces `activateAll`: it reads the active flows'
`(id, currentVersion)`, activates what this process does not hold and
deactivates what is no longer active at the version it registered. `watch(everyMs)`
runs it on a timer and `orion()` starts one at boot, every
`activationPollInterval` (5s). A flow that cannot activate reaches the new
`onActivationError` Observer once per version, and is asked again when a
webhook path an active flow held comes free. Two instances holding one cron
schedule dispatch one fire, by Caravan's minute id, so cron needed nothing more.

## 2026-09-14 — triggers and actions

Phase 4 of `IDEAS/orion-port.md`. `orion()` (`src/plugin.ts`) installs the engine
into a Junction app, and a flow can now read and write the app it runs in.

**The done-when, twice.** A flow writing a field its model does not declare
fails to compile, naming what the model accepts; a flow owned by a USER that
creates an `Invoice` gated at ADMINISTRATOR fails with the gate's own sentence.
`tests/models.test.ts` asks it of a litestone host and `tests/plugin.test.ts` of a
Junction app, where the refusal is junction's resolver grading the session
`app.runAs` rebuilt for the owner. Removing the compiler step fails four rows;
handing the run the system client instead of the owner's fails the refusal.

**The model nodes type their writes against the app's own JSON Schema.**
`model.create`, `model.patch` and `model.remove` name a literal model and literal
field names, checked against the create and update documents junction validates
requests against, so a server-assigned key is refused at author time although
the column exists. They write through the run's actor — the owner's scoped
client — and name a row by `$primaryKey`. The row a step records is the row the
owner read back, so a `@guarded` column never reaches run history.
`service.call` runs a service method inside `app.runAs(owner)`, which is proved by
a sync webhook, the one path where the owner is not already in scope.

**Triggers have one activation owner.** `activate` registers a version's cron
schedules, its `trigger.model` triggers and its webhook paths, and `deactivate`
takes them back — replacing phase 3's `scheduleFlow`. A write inside a run starts
no model-triggered flow: the test's flow writes the model it is triggered by, and
without the guard it starts itself again. `POST {prefix}/hooks/{path}` answers 202
for an async flow and the flow's own `http.respond` for a sync one
(`FJS-D280`); a sync flow that waits does not compile. The route is refused in
production without `verifyWebhook`, and the headers stored on the run pass
through `@frontierjs/toolbelt/redact`. `POST {prefix}/wait/{key}` resumes once.
Two gaps are filed: an activation reaches only its own instance (`FJS-1155`), and
a sync run is not recovered after a crash (`FJS-1156`).

**The outside world goes through its owners.** `http.request` names a
`FlowCredential` and a path and has no URL; orion's own conduit instance sends it,
with a resolver reading the encrypted secret off the row, re-registering the
target when the row's `updatedAt` moves, and carrying `runId:nodeId:attempt` as
the idempotency key (`FJS-D273`). `tests/outbound.test.ts` asserts all of it on the
wire of a local server. `ai` asks the app's `IAIModel` by name, `complete` only —
the mockup's providers and three modes are gone (`FJS-D153`). The `store` node's
port is async over `KvEntry`, scoped `flow`, `global` or `run`, and `workspaceId`
is out of the engine. `FlowCredential` gained the columns a target needs.

**The four day-one limits** (`FJS-D283`). The run job reads the kill switch again,
so a run queued before a pause is cancelled and a waiting one stays waiting.
`Flow.runsPerMinute` is counted at start. `Flow.maxWrites` is a budget the
scheduler seeds from the model nodes the checkpoint says completed, so a resumed
run counts what it wrote before it waited. A dry run executes a version — a draft
too — as its owner in a rolled-back transaction, writing no run; the nodes with an
effect outside the actor record what they would have sent, and `data.code` does
not run.

**One scheduler defect.** A node failing in a parallel stage ended the run through
`Promise.all` while a sibling was still running, so the record named a step
`running` in an ended run and the sibling's write could land after it. The stage
settles first now; the engine test fails with `Promise.all` back.

The mockup's `triggers/`, `nodes/providers/` and `store/` are deleted, replaced.
`NodeContext.fetch` is gone, since nothing calls out but through a port, and a
node context carries its `flowId`, `nodeId` and `attempt`.

## 2026-09-14 — flows run on Caravan

Phase 3 of `IDEAS/orion-port.md`. `src/runner.ts` turns a flow row into a `Run`
and one Caravan job and back: `start`, the `orion.run` job, `resume`,
`scheduleFlow` / `unscheduleFlow` / `scheduleActiveFlows`, and a per-minute
`orion.sweep`.

**A process killed mid-stage finishes on another.** `tests/crash.test.ts`
SIGKILLs a real worker with its third stage in flight and starts a second: it
reclaims the job once the first stops heartbeating, reads the checkpoint, and
completes the run. The stage before the kill ran once — the test fails with
`before: 2` when the run job ignores the checkpoint — and the job took two
attempts. Its first red was the fixture rather than orion: Caravan unrefs every
timer, because a host's server holds the process open, so a worker with no
server exited a tick after it started. The fixture holds itself open and the
test names a worker that exited.

**A resume key runs once, refused twice.** A run's `Wait` row is written by the
store in the transaction that moves it to `waiting`, so a key exists exactly
while its run waits, and the `flow.wait` node lost its registry port. `resume`
dispatches under `resume:<key>`, and the job consumes the row in the transaction
that moves the run back to `running`. Two resumes at once, and a third dispatch
after the run ended, ran the next node once and made one job; the suite asserts
both, and fails with either defense removed. The key was `Math.random`; it is 32
random bytes, being the credential a resume presents.

**A start stated twice is one run, including at once.** Two concurrent starts
under one id raced into a `UniqueConflictError` from the second insert, which
the first version of the test caught and hid; the loser's insert is now the run
the winner made. A cron fire starts its run under the fire's job id, so a retried
fire is the same run. A flow that is paused, has no version or does not compile
refuses to start and leaves no run.

**The sweep ends waits past their deadline and finds lost dispatches.** An
expiry consumes the same `Wait` row a resume would, so the two cannot both win.
A run still `pending` a minute after it was written — a crash between the insert
and the dispatch — is dispatched again under its own job id; `Run.createdAt` is
what dates it.

The engine's queue went with its polling loop: `Scheduler` runs one job and
Caravan decides which, when and how many. `runtime/queue.ts`, its six tests and
`Scheduler.run`, `stop`, `activeCount` and `concurrency` are gone, and
`ExecutionJob` lives beside the context it carries. The context records the node
a run is waiting on, which is what the store reads the key from.

## 2026-09-14 — only the owner edits a flow

`FJS-D289`. `@@allow('update', ownerId == auth().id)` on `Flow`, and the same test
through the flow on `FlowLayout` and on a version's create. An administrator is
refused too: acting on somebody else's flow goes through the phase 5 `flows`
service, so `activate`'s `@gate(5)` now grades an owner. A filtered update
answers `null` rather than throwing, since a refusal must not confirm the row
exists, so the tests assert the row. `verifyRowPolicies` joins the suite; each of
the three policies fails it and its own test when removed.

## 2026-09-14 — the data layer

Phase 2 of `IDEAS/orion-port.md`. `db/orion.lite` holds the eight models an
installed orion writes, exported as `@frontierjs/orion/orion.lite` for a host to
import, and `src/store.ts` is the engine's store over the host's litestone
client.

**The owner is an access grant, and the schema treats it as one.** A run acts as
its flow's owner (`FJS-D276`), so `Flow.ownerId` is stamped from the creator,
refused on a create naming anybody else, and `@immutable`; `FlowVersion.authorId`
records who wrote each definition. Activation is `ADMINISTRATOR(5)` on the
`activate` move (`FJS-D278`), and two ways around it are closed: a flow created
`active` is refused, and `currentVersion` does not move while a flow is active.
Each rule has a test with real principals, and each test fails with its rule
deleted. The credential model is `FlowCredential`, because `Credential` is
auth's and an app imports both; `FJS-D273`'s heading says so.

**A checkpoint is one statement, and reading it back was three quarters of its cost.**
The suite counts statements off litestone's query tap: one `update` per stage,
and one transaction of the terminal status plus a `RunStep` row per node. The
first measurement at 1,000 nodes was 4,700 µs a checkpoint, 55% of it litestone
parsing back the context the `update` had just written; skipping `RETURNING`
made it 1,200 µs against 1,000 for a raw prepared statement. `@encrypted`
costs 5,900 µs there and under a millisecond at 100 nodes — the table is in the
paper, and `bun run bench` reruns it.

**`asSystem()` does not consult `@@transitions`**, so the store suite drives
runs that complete, fail, suspend and resume and checks every status written
against `Run`'s declaration. It found a move the declaration lacked: a wait in
the first stage is the run's first checkpoint, so `suspend` is from `pending`
too.

**Two kernel defects, both about what a run is recorded as.** A run suspended at
`flow.wait` was recorded `completed`, and the terminal write would have cleared
the context its resume reads; the scheduler now checkpoints it and writes no
record, whether or not `checkpoint` was asked for. A node with no
implementation, or whose config did not resolve, was stepped over and the run
completed; it fails the run now, as the executor's own comment said it should.

`IExecutionStore` is the four calls the scheduler makes. `queryRecords` and
`getMetrics` were called by nothing but the mockup's admin API, which phase 5's
services replace with reads over the models, so they left the interface with
their 16 tests.

## 2026-09-14 — a flow expression can be written as text

`src/engine/expression/text.ts`. `compileExpression('$.trigger.body.amount > 100
&& $.lead.data.tier == \'gold\'')` parses with the parser a `.lite` policy is
parsed with (`FJS-D271`) and hands back the `Expression` the resolver already
runs. Until now the engine had no text form at all, while the UI mockup assumed
one.

**The halves split where the rulings split them.** A path, a call and a lambda
(`FJS-D284`–`FJS-D286`) compile to the engine's own nodes — `ref`, `fn`, `map`,
`filter`, `reduce`, `cond` — and run on its function table. A comparison, `&&`,
`||` and `!` compile to one new `predicate` node holding the parsed tree, which
`@frontierjs/toolbelt/predicate` answers in SQLite's three-valued logic, so an
edge condition and a row policy written the same way agree. `null` is unknown
and is falsy, so an edge whose condition is unknown does not fire.

**A filled value is a FIELD, never a literal.** The language spells `IS NULL` as
`x == null`, so a resolved value that happened to be null read as the author
having written one and turned `$.a > 1` into a presence test answering true. The
same branch answers every non-`==` operator that way for a real policy, which is
[`FJS-1152`](../../ISSUES.md#fjs-1152), filed while fixing this.

**The engine may import `@frontierjs/toolbelt` and nothing else.** `FJS-D26`
licenses it — pure functions below the dependency graph — and
`tests/engine-boundary.test.ts` now says so, with a framework package, a
third-party package and an escape as its negative controls.

## 2026-09-14 — the engine lifted out of the mockup

Phase 1 of `IDEAS/orion-port.md`, first half. The modules the plan keeps moved
from `mockup/api-engine/src/` to `src/engine/` with `git mv`: types, compiler,
expression, executor, runtime, cache, plugins, the built-in nodes, the code
worker pool and the trigger registry. The package is a workspace member now,
private, with `bun run test` and `bun run typecheck`.

**The nodes no longer import the modules later phases delete.** They took
`KVStore`, `WaitRegistry` and `AIProviderRegistry` as concrete classes over the
mockup's own SQLite and vendor code; `src/engine/ports.ts` states what they
need as interfaces, and the node suite runs against in-memory fakes of those.
The suite had been failing its setup under bun, because it opened a `sql.js`
database that was never installed, so 25 of its 55 tests ran; all 55 run now.
The OpenAI-shaped test became a stubbed provider, since vendor adapters are the
host's (`FJS-D153`).

**Typecheck found the expression type wrong, not the tests.** A pipe step after
the first may omit the operand the flowing value fills — the resolver always
handled it, and seven tests exercised it — but `Expression` required `args` and
`over`, so it is `PipeStep` now. `JSONSchema` gained the fields the built-in
descriptors already carried (`description`, `enum`, `default`, `format`), and
`NodeContext.fetch` is the call a node makes rather than bun's `fetch` object,
which also carries `preconnect`. A test compiling a flow with
`{ source, target }` edges now writes `{ from, to }`; it refused an unknown node
type before the edges mattered, so it passed either way.

`tests/engine-boundary.test.ts` is the enforcer for the engine rule: every import
under `src/engine/` is relative and stays inside it, or a Node builtin. It grades
itself on a synthetic source naming a framework package, a third-party package
and an escape.

Not carried: the event bus suite (20) and the cron, router and activator parts of
the triggers suite (45), which stay with their modules in `mockup/` until phase 4
replaces them. 349 engine tests and 3 boundary tests.
