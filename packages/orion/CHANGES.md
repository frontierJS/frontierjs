# Changes — @frontierjs/orion

## 2026-09-28 — a queued or running run can be cancelled (`FJS-1157`)

`runs.cancel` ended only a waiting run, because a running job wrote its checkpoints and terminal record by id and so overwrote a cancellation written underneath it. Every run-path write in `LitestoneExecutionStore` is now an `update` whose where also says the run has not ended, selecting only the id so a miss answers null: a checkpoint that misses throws `RunEnded`, which the scheduler records as a failure, and that terminal write misses in turn and writes nothing. `store.cancel` ends any run that has not ended; a queued run's job re-reads it, finds it cancelled and returns, so Caravan's own `cancel` is not needed. Two `store.test.ts` cases, red before: a `cancels` node cancelling its own run mid-flow, and a queued run. 598 pass.

## 2026-09-28 — an activation that cannot register rolls its move back (`FJS-D502`, `FJS-D470`)

`flows.activate` made the `activate` move, and when a trigger could not register (a webhook path another flow holds) it wrote the old status back through the system client. `active -> draft` is no declared move, and `asSystem()` now holds the machine, so the write-back was refused and the flow stayed `active` with nothing registered. The move and `runner.activate` are now one `$transaction`, and the Conflict thrown inside it is the rollback. Flow's `@@deny('create', status != null && status != 'draft')` is gone: a flow starts at its `@default`, `draft`, for every creator, so the deny restated the machine. `store.test.ts` asserts the machine's refusal instead. 596 pass.

## 2026-09-25 — the tenancy test reads `ctx.caller.headers` (`FJS-D392`)

Junction renamed `ctx.client` to `ctx.caller`; this follows it.

## 2026-09-22 — `KvEntry` declares its deadline

`KvEntry` carries `@@expires(expiresAt)` ([`FJS-D352`](../../DECISIONS.md#fjs-d352)),
so an entry past its ttl reads as absent at the Data boundary and `kv.ts`'s
`live()` helper is gone. **The ttl is minted from the client's clock**
(`$now()`), not `Date.now()`, and the sweep is `deleteMany({ onlyExpired: true })`
— on the client's clock too, the one that already reads the entry as absent,
where the hand-written `expiresAt < now()` read the runner's. The two lookups
that must see a lapsed row state `withExpired`: `set`, which overwrites it in
place rather than colliding on `@@unique([scope, key])`, and `delete`, which
removes it and still answers *nothing live was there*. `litestoneKeyValue` no
longer takes a `now`; nothing passed one.

`test/kv.test.ts` is new and is the first suite over the port: five rows on a
clock staged in 2031, so a host-clock mint is born lapsed. Putting the sweep back
on the runner's clock reds its row (measured).

## 2026-09-21 — the suite directory is `test/`

**`tests/` is a surface, not a suite.** In an FJS app it sits beside `api/` and `web/` and holds
what belongs to no single surface, while a surface's own tests are its `test/` (Invariant 3). A
package is not an app — it has one `src/` — so its suite is `test/`, and this one moved. Eight
packages spelled it plural and eleven singular with nothing in the tree deciding between them,
which made the directory name a coin flip on every file added.

Its `test` script named the directory without a trailing slash, so it was the one a
path rewrite missed and the suite collected nothing until it was fixed.

## 2026-09-20 — an expression, written as the language

`compileExpression` turned `$.trigger.body.amount > 100` into the node the resolver runs, and the
other direction did not exist — so the inspector that landed this morning showed every computed
value as its tree. `expressionToText` is that direction, in `emit.ts` beside it, and
`ExpressionField.mesa` is what reaches both.

**The parser runs in the browser, and that is the one place `web/` imports the engine.** The text
form is a pure function over a closed grammar, so both ends agree by construction, and an author's
mistake has to arrive as they type rather than one round trip later. The refusal shown is the
PARSER's own sentence with the column it failed at — a second wording here would be a second
grammar. A half-typed expression is HELD rather than written, so a definition that cannot compile
never reaches the document under a save button that looks ready. It costs `text.ts`, `emit.ts` and
nothing else: the predicate kit under them is already in a sierra app's bundle, since that is what
answers `@required(where: …)` on a form.

**The grammar is a SUBSET of what the engine runs, and the emitter says so rather than inventing
syntax.** Thirteen forms compile and seven parse; `template`, `array`, `object`, `pipe`, `let` and
`match` have no text at all — a backtick is even tokenized and read by no parser. So
`expressionToText` answers `{ text }` or `{ text: null, reason }`, and a shape with no text form is
edited as the document it already was. Measured over every flow definition in this repo, 427 of 471
expression nodes have a text form; the 44 that do not are named in
[`FJS-1209`](../../ISSUES.md#fjs-1209), whose real question is whether the language litestone parses
`.lite` policies with should grow a value-assembling form.

**The only way this can be quietly wrong is a dropped bracket**, which produces text that parses and
means something else. So every emission states the tightness it is read at — the parser's own ladder,
with a comparison's operands at VALUE because the grammar hands it an `operand` — and
`test/engine/expression/emit.test.ts` compares TREES rather than strings over 41 sources: text →
Expression → text → Expression. A string comparison would pass by construction, since the emitter's
output is its own input by then. With the parenthesization removed it fails 7 of 49, and its control
is a pair that genuinely disagrees — `a && (b || c)` against `a && b || c`, false and true on the
same run — because without one, every assertion is satisfied by an emitter that brackets nothing.

591 tests from 542; `verify:automations` 63 assertions from 56.

## 2026-09-20 — the node inspector, which the node types write themselves

A flow's definition was authored in a 16-row textarea of raw JSON. Selecting a node now opens a
form, and **nothing in the package says what any node takes**: every descriptor already declared a
`configSchema`, sierra's `buildFieldRules` flattens a JSON Schema object into a rule per property
and `formFieldList` asks `controlFor` which control each rule gets, so a `trigger.webhook`'s `path`
is a text box and its `method` a select with no table anywhere naming either. The mockup carries the
other design — `NODE_CONFIG_FIELDS`, a hand-written field list per node type consulted BEFORE the
schema — and it is not ported: a table beside the descriptors is a second statement of what a node
takes, and the descriptor is the one the compiler grades against.

**`flows.nodeTypes()` is how the catalog crosses**, and it is read off the REGISTRY rather than off
`BUILTIN_DESCRIPTORS`. That is the whole reason `configSchema` can sit on a plugin manifest: a host
that installed a plugin has node types no import can see, and a built-in's form could have been
written by hand where a plugin's could not. It is a method on `flows` because there is no row —
the catalog is the same for every caller and only the plugin set varies — and it answers whole,
since a screen holding a flow needs a descriptor per node in it plus every node it may offer.

**A config value is never a plain value, and that is the shape the port could not have guessed.**
The resolver dispatches on the stored node's own `type`, so `model: 'Customer'` is written
`{ type: 'literal', value: 'Customer' }` and the same slot may instead hold
`{ type: 'ref', path: '$.trigger.record.id' }`. The schema describes what the value must RESOLVE to,
which is what picks the control; what is stored is the expression around it. So a field has two
states and the stored value says which — a literal opens on its own control and writes the wrapper
back, anything else opens on the document it is. It is also why 17 properties across the built-ins
declare no `type` at all: those are the always-computed ones, and that absence is read rather than
marked. A text form for an expression landed the same day, in the entry above.

**The inspector and the textarea are ONE model and the model is the text.** The inspector parses it,
writes a node's config into the parse, and serializes the whole definition back — so there is no
second copy to keep in step, a definition that does not parse disables the inspector rather than
diverging from it, and structure (a node, an edge, the name) stays the document's until the canvas
exists. Finding that out cost a defect in `@frontierjs/ui`: a `<Textarea>`'s value is its child
text, which the DOM ignores once anything has written to the element, so the edit was in the model
and not on the screen ([`FJS-1207`](../../ISSUES.md#fjs-1207)).

`test/node-forms.test.ts` is what makes `configSchema` true rather than declared — it was read by
nothing at all, not the compiler, not the executor — grading every built-in's schema through the
same pipeline, so a property no control can render fails the suite instead of appearing as an empty
box on a screen. 542 tests from 465; `verify:automations` 56 assertions from 37.

## 2026-09-20 — the bun floor is `1.4.0`

`engines: { bun: '>=1.0.0' }` was a number nobody had moved since it was written, and an engine range
is advisory anyway: bun runs an app whose floor it does not meet, so a machine one minor behind
reports the feature it cannot reach as MISSING rather than reporting itself as stale. `fli doctor`
grades the installed version against this floor now, which is the half a `package.json` field cannot
enforce on its own.

## 2026-09-17 — a flow's cron is on the clock, off the declaration list

Caravan's `registrations()` no longer reports a `schedule()` registration, and
`orion.cron:<flowId>:t` is one — a clock bound to a flow ROW. Nothing in the
runner changed; the cron suite asserts against `nextRuns()`, which is what that
question was always about. The job-name catalog a flow compiles against narrows
with it, which is the fix rather than the cost: a flow could offer another
flow's schedule as a job to dispatch.

## 2026-09-16 — the mockup is cut to what is still owed

`mockup/ui/` was 11 files and 14,908 lines; seven of them, 6,378 lines, are deleted. Each was
retired by something that now exists rather than by judgement: `settings.jsx` (3,485) is the
accounts, workspaces, members, invites and system-admin surface, which [`FJS-D269`](../../DECISIONS.md#fjs-d269)
made the HOST app's and not orion's; `primitives.jsx` is `@frontierjs/ui`; `mock.js` is the schema
and `test/fixtures/`; `api.js` is a REST client against `/api/executions`, a noun this package no
longer has; `tokens.js` is a color palette Invariant 13 forbids outright; `app.jsx` and
`index.html` are sierra's routing and `_module.mesa`.

What remains is the four files that are the ONLY statement of something unbuilt — the canvas, the
per-node inspector, and the screens `pages.jsx` describes that `web/routes/` does not answer.
`node-types.js` stays for the 108 lines beside the ported `ENODE_TYPES`: `NODE_CONFIG_FIELDS` is
the inspector's field list per node type, and nothing else holds it.

The three keepers still import the deleted files, which costs nothing and is the measurement worth
recording: **the mockup has no `package.json` and no vite config, so it has never been runnable**
and is a document that happens to be written in JSX. It is not a member of the workspace and is in
no `nonMembers` allowance, because there is nothing for CI to grade.

## 2026-09-16 — a host can TYPE the nodes it contributes

`@frontierjs/orion/plugin` re-exports `PluginManifest`, `NodeTypeDescriptor`, `NodeCategory`,
`INodeImplementation`, `NodeContext` and `NodeResult`. They are declared under `src/engine/`, which
an app may not import — the boundary test forbids it — so a host writing `orion({ plugins: [...] })`
had nothing to name and wrote its manifest as an object literal. TypeScript then infers
`category: string`, which is not the union, and the whole contribution fails to assign at the
`orion()` call with a hundred-line structural error about a field nobody got wrong. Found writing
basecamp's `basecamp.page` node.

Nothing about the shape changed; the types were simply unreachable.

## 2026-09-15 — an administrator reads through the row policies

[`FJS-D296`](../../DECISIONS.md#fjs-d296), closing [`FJS-1170`](../../ISSUES.md#fjs-1170).
`orion.lite`'s read policies are `owner == auth().id || auth().level >= 5`, and the services'
administrator read path — `isAdministrator`, `readerOf`, `shown` and the before/after hooks on
`find` and `get` — is deleted: every read is the caller's own client, so a protected column is
stripped by the boundary rather than by this package. **A run on somebody else's flow now reaches
an administrator's live runs screen**, since junction's fan-out grades a recipient with `$readAs`
against the same policy; `services.test.ts` asserts the fan-out's verdict for an administrator, a
manager graded 5 by the app's mapping alone, and another USER, and is red with the Run policy
reverted. The suite's app passes one mapping to its `GatePlugin` and to `orion({ level })`, as a
host must: `level` still grades an administrator acting on another person's flow.

## 2026-09-15 — a flow and its runs are read by their owner and an administrator

[`FJS-D295`](../../DECISIONS.md#fjs-d295), closing [`FJS-1167`](../../ISSUES.md#fjs-1167).
`orion.lite` reads `Flow`, `FlowVersion`, `FlowLayout`, `Run` and `RunStep` through a policy on
the row's own owner, so another USER reads none of them and a move they ask for is a 404 rather
than a 403. An administrator reads through the services: `readerOf(ctx)` for orion's own methods,
and a before hook that hands the model service's `find` and `get` the system client, with every
protected column stripped from the answer. **A model trigger records the row as the flow's owner
reads it** — the runner's new `readAs` port, which the plugin answers with `$readAs` on the owner's
client and the principal `app.withDb` now hands over — and a row the owner may not read starts
nothing. Open beside it: an administrator's runs screen does not move for another owner's run
([`FJS-1170`](../../ISSUES.md#fjs-1170)), and a shopper in `example` may still draft a flow
([`FJS-1169`](../../ISSUES.md#fjs-1169)).

## 2026-09-15 — driven in a browser, and what that found

Phase 7's drive, `example`'s `verify:automations`, runs the screens against a real shop: a flow
drafted in the drawer, a refused definition shown with the compiler's sentence, an activation, a
Customer created elsewhere starting a run that arrives on the open runs screen, the note it
wrote read back off the customer, and staff offered no move and refused one. Two defects here
([`FJS-1165`](../../ISSUES.md#fjs-1165)): **a patch may carry the model's `@version` column**,
which the catalog dropped as `readOnly` while the Data boundary demanded it, so no flow could
patch a versioned model; and **`model.remove` is litestone's `remove`**, where it was `delete`,
the purge that destroys a `@@softDelete` row. **`flows` and `runs` name a channel**
([`FJS-1166`](../../ISSUES.md#fjs-1166)), their own service name, because the engine writes every
run through the system client and junction broadcasts such a write only on a named channel; the
host joins it. The same drive found three defects below orion, filed against their packages.
**Open: who may read a run** ([`FJS-1167`](../../ISSUES.md#fjs-1167), question 24).

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

`test/tenancy.test.ts` asks it through the real plugin against a real tenant registry and a row
tenancy app, every landing paired with the other tenant's rows; dropping the tenant from the actor,
the resume key, the webhook check, a re-dispatch or the sweep's walk each fails a row. Under
`strategy row`, a credential name and a global store key are still unique across workspaces
(`FJS-1159`).

## 2026-09-15 — services

Phase 5 of `IDEAS/orion-port.md`. `orion()` registers three services, and
`test/services.test.ts` drives them over HTTP with principals at USER(4),
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
against. `test/plugin.test.ts` installs the real notifications plugin and
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
`test/crash.test.ts` kills an inline run's process mid-stage and asserts both
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
`test/models.test.ts` asks it of a litestone host and `test/plugin.test.ts` of a
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
the idempotency key (`FJS-D273`). `test/outbound.test.ts` asserts all of it on the
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

**A process killed mid-stage finishes on another.** `test/crash.test.ts`
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
`test/engine-boundary.test.ts` now says so, with a framework package, a
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

`test/engine-boundary.test.ts` is the enforcer for the engine rule: every import
under `src/engine/` is relative and stays inside it, or a Node builtin. It grades
itself on a synthetic source naming a framework package, a third-party package
and an escape.

Not carried: the event bus suite (20) and the cron, router and activator parts of
the triggers suite (45), which stay with their modules in `mockup/` until phase 4
replaces them. 349 engine tests and 3 boundary tests.
