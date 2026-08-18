# Changes — @frontierjs/junction

## 2026-08-18 — an app-level default publisher (`FJS-334`)

Junction had two ways to broadcast and both were per service: `channel:` on the
definition, and a `publish()` hook in `after`. Feathers has a third —
`app.publish(fn)`, one catch-all deciding where every service event goes — and
it is how a tenant-shaped app writes *everything a caller may hear goes to their
own account channel* once instead of once per service.

The shape everyone reaches for was not merely undocumented, it was **refused**:
`app.hooks({ after: { all: [publish(fn)] } })` trips `refuseDoubleBroadcast` for
every service that also declares `channel:` — which is every model service in
`example` and `basecamp` — so an app-level publish hook was a boot failure. The
refusal is right, both really do send, but it left the catch-all with no
spelling at all, and the resulting shape is a rule holding for twenty services
written twenty times, where the missed one is a screen that silently never
updates.

`app.channels.publishDefault(fn)` is that spelling, and the whole of the design
is that it is a **default, not a second broadcaster**: it is consulted only
where a service declares nothing, so it composes with `channel:` rather than
racing it and cannot put one record on the wire twice. The three states a
service already had are what make that work — `channel: 'posts'` says where and
is not asked the default, `channel: false` is the declared opt-out and refuses
it, absent asks the app.

**Function only, no string form.** A string would name one channel for every
service in the app, which is precisely the shape that hands a subscriber rows no
`@@allow` would have let them read — the reason broadcasting is opt-in at all
(`DECISIONS.md` § API design, 2026-08-02). A function is handed the record and
the `ctx`, so the app decides per record, and returning `null` skips that one.

**The report is the other half, because this inverts a failure mode.** Before
it, forgetting `channel:` meant a screen that never updates — visible, and
yours. After it, the same omission puts records on the wire under a rule written
for other services, which nothing on the server can see. So the channels plugin
reports at `boot()` which services fall through to the default, and only when a
default is registered: with none, that list is the ruled, intended state and
would fire on nearly every service in every app, which is how a warning gets
trained out. It extinguishes itself — `channel: false` drops a service from the
list, so an app that has read it once and meant it never sees it again.

`describe()` gained `channel` with it, a summary a JSON reader can hold: the
name for the string form, `true` for a function, `false` for the opt-out, `null`
for a service that declares nothing. `null` is not `false` — one asks the
default, the other refuses it.

Eleven tests in `tests/publish-default.test.ts`, against the **real** channel
manager rather than a stub with a recording `publish`: the whole question is
which channel a frame resolves onto, and a stub that ignores the resolver
answers it by construction. Three mutants, all killed — dropping the fallback,
firing the report unconditionally, and a no-op unsubscribe. Verified: junction
1209 + 11 pass, typecheck clean, `example`'s `verify:live` 14/14.

## 2026-08-17 — `@version` reaches the Data boundary (`FJS-335`)

Litestone's JSON Schema property set is **mode-dependent**, not just its
`required[]`: `@version` is emitted for `update` and omitted for `create`.
Junction derived one document — `generateJsonSchema(c.$schema)`, no options, so
`mode: 'create'` — and compiled both validators from it. The patch validator
therefore had no `version` property, `parse()` dropped the caller's value as an
unknown key, and litestone refused the write for not carrying one.

Every patch of every `@version` model was a 400 saying the version was missing,
from a request that had sent it. The feature did not work through a service at
all.

Nothing was red because junction's own `@version` tests call `svc.patch(ctx)`
directly, where no hook runs. That also made the bulk guard — *a bulk patch
cannot carry a version, it is per row* — unreachable in a real app, since
`autoValidate` had already removed the key it tests for.

`_deriveJsonSchema` now caches per mode, and the patch validator is compiled
from the create property set **plus the version column** — not from the update
document whole. That distinction is the trap in fixing it: the update document
also carries `@id`, litestone writes what it is given, and
`update({ where: { id: 1 }, data: { id: 99 } })` moves the row and answers 99.
Taking the whole thing would have let any caller rewrite a primary key through
a PATCH.

Four tests in `tests/real-litestone-client.test.ts` run through `autoValidate`
before the service, including that one; three fail against the version of this
fix they each guard.

## 2026-08-17 — `cors()` allows the headers the client itself sends (`FJS-336`)

The default allow-list was `Content-Type, Authorization, X-API-Key`. The browser
client sends `X-Service-Method` to address a custom method over HTTP,
`X-Workspace-Id` on every call once `setWorkspace()` has been used, and
`callService` reads `Idempotency-Key`. None was allowed, so a cross-origin
preflight refused the request and it never arrived.

This is invisible in both apps here: a service call takes the socket when one is
connected, and CORS does not apply to a WebSocket. The HTTP path is the
fallback, and the fallback was dead — measured from basecamp's own page, where
`fetch` with `X-Workspace-Id` from `:8020` to `:8120` answers
`TypeError: Failed to fetch`.

All three are junction's own protocol headers, so they belong in the default
rather than in every app's config.

## 2026-08-17 — `normalizeOrderBy` is exported

`autoSort` VALIDATES a request's `$orderBy` — it asks `db.$checkOrderBy` and
answers a 400 naming the key — and then leaves the value RAW on
`ctx.directives`. A service that wants to honour it therefore has to parse the
three spellings (`'name'`, `'-createdAt'`, `{ name: 'asc' }`) itself, and doing
that in a service is how the grammar acquires a second definition.

`normalizeOrderBy`, `comparatorFor` and `compareValues` are now on the package's
public surface. `core/sort.ts` is already named in the Bridge index as *the one
reading of `orderBy`*; this is that sentence being true from outside the
package too.

## 2026-08-17 — services autoload in the test lifecycle too (`FJS-333`)

`autoload-services` was `needsHost: true`. `_startForTest` skips those — they
bind a port, read a config file, install signal handlers — and this one does
none of that: it reads a directory and builds objects.

The cost was invisible until an app was mounted by `@frontierjs/testing` for the
first time. Every call answered `NotFound: Service 'projects' not found` — a 404
that reads like a wrong service name rather than an app with no services in it,
which sends you looking at the wrong thing entirely.

The flag is dropped. A missing directory is already a silent no-op, so an app
that autoloads nothing is unaffected. What a test still cannot reach is
`_junction.services.dir`: `load-config` IS `needsHost`, so `junction.config.js`
is not read there — an app that wants its services mounted in a test states
`autoload:` on `createApp` directly, which is also the only form that survives
`Bun.main` pointing at the test runner instead of the entry point.

1193 tests green.

## 2026-08-17 — services autoload in the test lifecycle (`FJS-332`)

`autoload-services` was `needsHost: true`. The test lifecycle skips those, so an
app mounted by `@frontierjs/testing` started with **no services at all** and
every call answered `NotFound: Service 'x' not found` — a 404 that reads like a
wrong name rather than an app that never loaded anything.

The flag is dropped. Registering services reads a directory and builds objects;
it binds nothing, and a missing directory is already a silent no-op, so running
it without a host costs nothing.

`load-config` is still `needsHost`, which is the one thing a test cannot reach:
`junction.config.js` is not read, so `_junction.services.dir` is unavailable and
an app that wants its services in a test states `autoload:` directly. The
default resolves `./services` beside `Bun.main`, and under `bun test` that is
the test runner — so an explicit path is the right answer there regardless.

Found by making basecamp the first consumer of `@frontierjs/testing`. It is
plausibly why that package had no consumers: the first thing anyone does with it
is call a service.

## 2026-08-17 — the pretty log line: key=value, and no ANSI into a pipe

1193 tests, 0 fail. Typecheck clean. Presentation only — the JSON writer, the
file writer and the `LogEntry` shape are untouched, so nothing a collector reads
changed.

**A boot line's `data` was `JSON.stringify`'d onto the end as one dim blob**, so
the line carrying the most information was the least readable thing on screen:
five keys of braces and quotes at the moment an app comes up. It renders as
`key=value` now, key dim and value bright, a string quoted only when it holds a
space or an `=`. This is the first half of `FJS-D37` §2 — a runtime log is a
stream and gets a stream's format.

**Undefined values are dropped, because `JSON.stringify` dropped them.** The app
banner passes two (`prefix`, `docs`), which the blob had been hiding and the new
renderer showed on every boot; `null` is kept, since stringify kept it and a
stated null is an answer where an absent key is not. Found by reading the suite's
own output after the change.

**The pretty writer emitted escape codes unconditionally**, so `bun run api > log`
recorded them as log content. It now honours `NO_COLOR`/`FORCE_COLOR`/TTY, the
same rule `packages/cli/core/color.js` already applied. `env.ts` was the only
other raw-ANSI writer in `src/` and imports the gate rather than restating the
predicate — env validation runs before an app, and therefore before its logger,
exists, so its two lines stay direct writes to stderr.

## 2026-08-17 — `ctx.transients`, the fifth context field (`FJS-D23`)

1186 tests + 6 new, 0 fail. Typecheck clean.

`autoValidate` now validates the `@transient` keys a model declares with that
model's own rules and then LIFTS them off `ctx.data` onto `ctx.transients`. The
value has to leave the payload: litestone refuses a transient key by name, so a
service passing `ctx.data` on whole would fail the write rather than the field.

`transients` is a context field rather than a corner of `locals`, and the line
between them is who writes it — `locals` is scratch a hook keeps its own state
in, `transients` is call INPUT the framework parsed, the way `directives` is the
input the bridge splits off a query. Fresh `{}` per call, does not propagate, no
seed option, `{}` on a model that declares none. `tests/context-contract.test.ts`
asserts both halves by running them.

**A bulk write carrying one is refused by name.** The rows a service receives are
the ones that PASSED validation — `partitionBulk` parks the rest — so an
index-aligned array of per-row values would pair one row's credential with
another row.

The compiler found the third context factory: `app.ts`'s internal-call `makeCtx`,
which a required field surfaced and a search for `locals: {}` had missed.

## 2026-08-17 — a durable effect: `ctx.enqueue` and the outbox relay (`FJS-D35`)

1186 tests, 0 fail. Typecheck clean.

`ctx.afterCommit(fn)` runs an effect only if the call succeeded and the
transaction committed. It buys nothing against a **crash**: the process dies
between the commit and the callback and the effect is never done, with nothing
anywhere recording that it was owed.

`ctx.enqueue(job, payload)` writes a row inside the call's own transaction
instead, so the intent commits with the write or rolls back with it, and a relay
hands it to `app.jobs` afterwards.

**Two verbs, not one verb with a flag.** A closure cannot be written to a table.
Everything durable has to be addressed by name, so the API says so rather than
letting the first crash say it.

```ts
ctx.afterCommit(() => app.conduit.send(…))   // a function  — dies with the process
await ctx.enqueue('order.shipped', { id })   // name + payload — survives it
```

**The row is in the app's own database and can be nowhere else, which is
measured.** Litestone opens one connection per declared `database` block and has
exactly one transaction manager, over main's write connection: a probe writing
to two databases inside `$transaction` and then throwing rolled main back and
left the other row standing. `$attach` does not help either — SQLite's atomic
multi-file commit needs rollback-journal mode on every attached file, and both
Caravan's queue and litestone's tenants run WAL.

So `db/outbox.lite` ships here, `@@gate("8")`, and is IMPORTED rather than
pasted — the split `@frontierjs/auth` already makes, because machinery that
changes when this package changes has to reach an installed app. `fli
outbox:install` writes the import line; `outboxSchemaFragment(db)` is the
in-memory alternative for an app assembling one schema string.

**Refusals by name, never degradation.** Outside a transaction, on a schema with
no `OutboxMessage`, and with no relay installed — a row nothing delivers is
worse than a refusal. The transaction test asks `db.$inTransaction` (new in
litestone, on every client flavour) rather than reading the `transactional:`
declaration: a hook can run against a method the declaration does not name.

**Delivery is at-least-once and no version of it is not.** The queue is a
separate SQLite file, so the insert there and the delivery mark here cannot be
one transaction. The relay dispatches under the OUTBOX ROW's id and caravan's
`dispatch({ id })` treats a taken primary key as work already queued, so a crash
in between replays into a no-op instead of a second email.

`app.configure(outbox())` installs the relay — `requires: ['caravan']`, and boot
refuses a schema with no model by name rather than waiting for the first
`enqueue`.

**`transport/outbox.ts` is now `transport/send-queue.ts`**, with `flushOutbox` →
`flushSendQueue`, `dropOutbox` → `dropSendQueue` and `OutboxSocket` →
`SendQueueSocket`. Two unrelated things called an outbox in one package is a
trap, and the WebSocket one was the casual name — it is a send buffer that holds
a frame Bun dropped, where the transactional outbox is a pattern with a
literature. `wsSend` is unchanged: it is what anyone debugging a lost frame
greps for. Older entries below name the new path. A committed call kicks it without awaiting; the timer is the recovery
sweep for what a crash left behind, not the latency of an ordinary effect.

`GET /metrics` answers `outbox: { pending, delivered, failed, lastPassAt }`,
contributed through `app.registerMetricsSource` rather than mounted as a second
endpoint. *How many effects are owed* is the first question asked when something
did not arrive, and there was no way to ask it without opening the database. The
counters cover both drivers because `app.outbox.deliver()` is the one place
either goes through; `pending` is a COUNT and therefore a query, refreshed once
per relay pass rather than once per scrape — a metrics endpoint that queries per
request is a load amplifier pointed at your own database. A source must be
synchronous, since `/metrics` assigns `fn()` straight into the body.

*11 tests here against a real Litestone client; the delivery half is 16 more in
caravan, where a real queue exists to hand rows to. Eight mutants, all killed —
two only after they exposed missing tests (the claim's compare-and-set, and the
cross-process primary-key collision).*

## 2026-08-17 — the typecheck baseline is gone, and eleven type defects with it (`FJS-034`)

1176 tests, 0 fail — unchanged. `scripts/typecheck-baselines.json` no longer
names junction: 138 → 0, and absent means 0.

The row said the rest was test ergonomics and reached no user. Half of it was.
The other half was the tests being the only code in this repo that uses junction
the way an app does — so an error in `tests/` was an error a user gets, written
down in the one place nobody was reading it as one.

**A custom method's `ctx` was an implicit `any`.** `ServiceDefinition`'s
`[method: string]: unknown` contextually types nothing, so the documented shape

```ts
createService({ name: 'servers', async reboot(ctx) { … } })
```

is a hard error in any app with `noImplicitAny` on and a silently untyped `ctx`
in every app without it. The index signature is now `ServiceDefinitionValue` — a
union carrying exactly ONE function type, which contextually types the
function-valued keys and still accepts every option value. `| unknown` collapses
straight back to `unknown`, which is why the obvious widening does not work.

**`ctx.result` is `unknown`.** It was declared as the envelope alone, which is
narrower than every assignment the framework itself makes — including two of its
own, both of which carried a cast to get past it. A short-circuiting `before`
hook may set a plain value, a cache hit replays whatever was stored, and
`toResponse` handles a bare `Response`. Read the payload with `resultData()` and
the whole answer with `unwrapResult()`, which is what the email-hook docs already
did by hand.

**`createBaseService` returns a `BaseServiceDefinition`.** Its return type was
built from `Service`, whose `hooks` is the registration METHOD rather than the
map — so `createService({ ...createBaseService({ model }) })`, the spread this
file documents, did not compile.

**`app.events.on('x', () => seen.push(n))` compiles.** `EventHandler` was
`=> Promise<void> | void`, and TypeScript's return-a-value-where-void-is-expected
rule applies to a bare `void` and not to a union containing one — while `emit`
already tests the return for `.then` and ignores anything else. The type now says
that: `=> unknown`.

**`config: { http: { helmet: false } }` was a type error twice over and a silent
data loss once.** `AppOptions.config` was a one-level `Partial<AppConfig>` while
`deepMerge` merges all the way down (`DeepPartial` now), `AppConfig['http']`
never declared `helmet` although `app.ts` read it through a cast, and
`createTestApp` spread its config SHALLOWLY — so naming one key of `http` dropped
`cors`, `ddos`, `powered` and `maxBodySize`. It deep-merges now, like `createApp`.

Four more of the same shape:

- `bridge.toContext`'s `model` was required and read nowhere. It defaults to
  `service`, which is what `internal()` has always passed.
- `OriginList` refused a single origin string that `cors()`'s own `isAllowed` has
  always had a `typeof origins === 'string'` branch for. `combineOrigins` wraps a
  bare string into the one-element list csrf needs, which takes neither a
  wildcard nor a bare string.
- `OAPathItem` names its five verbs, so `paths['/posts'].post` is an operation
  rather than `OAOperation | OAParameter[]`.
- `partitionBulk<T>` demanded the parse callback return `T`, while both callers
  return a coerced record. `<TIn, TOut = TIn>`.

**Two things that never ran at all.** `test:example` and `test:all` passed
`example/test.ts` as a FILTER, and bun matches a filter by `.test`/`.spec` in the
filename — the path form runs the 26 tests that had been silently skipped. And
`makeWsApp` in `index.test.ts` called an unimported `channels`, so it could only
ever have thrown; nothing called it.

Test-side: `tests/helpers.ts` owns the two casts this suite kept rewriting —
`stubbable` for a fetch stub (Bun's `typeof fetch` carries `preconnect`, so no
plain function is assignable to it) and `asRecord` for a key the type does not
declare, which is Invariant 5 working rather than a gap. 18 duplicate imports
removed from `index.test.ts`, and a `let` assigned inside a callback replaced by
a collector wherever flow analysis had narrowed it to `null`.

Three of the eleven were in litestone and are in its own `CHANGES.md`.


## 2026-08-16 — `ctx.afterCommit()`, the phase an `after` hook is not (`FJS-089`)

1176 tests (10 new), 0 fail. Baseline unchanged at 138.

`after` means after the METHOD. Hooks run in sequence, so an `after` hook that
sends an email runs, a later one throws, and the client is told the call failed
with the email already gone — and once `transactional:` landed, the row was
rolled back while the email stayed sent, which is worse. Rails states the choice
as `after_save` vs `after_commit`; only the first existed here.

`ctx.afterCommit(fn)` is the second. Queued from any phase, drained once in
`callService` on `!ctx.error && !pipelineError` — after the announcement, before
`idem.settle`, so a replay cannot be told the call is finished while its effects
are still running.

**Under `transactional:` it is after the commit for free, which is what makes it
small.** The transaction is an `around` hook, so `runPipeline` has already
returned by the time the drain runs: no transaction state is read, nothing is
kept in step, and one drain point serves both the transactional and the ordinary
case. The queue lives on the CONTEXT rather than on `ctx.locals.db`, which that
hook reassigns mid-pipeline — a callback queued before the swap and one queued
after it both run.

**Observer tier** (`FJS-D06`). A throw is logged and emitted as
`junction.aftercommit.error`, never reported as the call failing: the write is
committed and the broadcast is out, so a 500 would tell the client a write
failed that did not. The callbacks after it still run.

`withAfterCommit()` is the one owner — the two builders in `bridge.ts`, the
internal one in `app.ts`, and `callService` for a context built by hand. The
argument type is the context minus the two fields it adds, so a builder's
literal is still checked against everything else it owes.

**What this is not is durability.** A crash between the commit and the callback
loses the effect and nothing is recorded. That is the transactional outbox, and
it is open as `FJS-D35` with the question that blocks it: the row has to be in
the app's own database on the connection the pipeline already writes through,
and Caravan's queue is a different SQLite file — so `dispatch()` from a hook
buys retries, not atomicity.

Ten tests against a real Litestone client, both guards mutation-checked: drop
the drain and eight fail, drop the success guard and the two failure-path tests
fail.

## 2026-08-16 — a worker receives its setup data (`FJS-271`)

1166 tests (7 new), 0 fail. Baseline unchanged at 138.

`createThread(path, data)` exported a second parameter that went nowhere, and
the file's own header said *"Worker scripts receive data"*. **The filed
diagnosis was wrong in the useful direction**: `workerData` is not part of the
web `WorkerOptions`, so it looked undelivered — but on Bun 1.3.11 it IS
delivered, and only to `node:worker_threads`. Inside the worker
`globalThis.workerData`, `self.workerData` and `Bun.workerData` are all
`undefined`, which is exactly what the original measurement probed. So the fix
is a read half, not the protocol decision the row was waiting on: no envelope,
no `init` handler, no reserved message name.

`workerData()` is that half, and it answers **`undefined`** where Node answers
`null` — on the main thread and in a worker given none alike, because a caller
cannot act on the difference between *nobody passed anything* and *somebody
passed nothing*, and `?? fallback` should read the same in both places.

**Setup and work stay apart**, which is what makes this cheap: setup is read
once at module scope, work arrives per message on the loop the pool already
drives. A worker written against `workerHandler` cannot confuse the two because
they never share a channel.

Three things came with it:

- **`createPool(path, count, data)`** — a pool had no way to configure its
  workers at all.
- **One `spawn()`**, the only place a `Worker` is constructed. A pool respawns
  after an error, and a respawned worker built without the setup data serves a
  different configuration than its siblings from the first failure onward.
- **A pool now REJECTS on a handler that threw.** `workerHandler` posts
  `{ __error: true, message }` back — a worker cannot reject its caller's
  promise from inside itself — and `exec()` resolved with that envelope: the
  caller's `await` succeeded, the failure arrived as a property nobody reads,
  and `stats.completed` counted it as work done. Found while writing the tests.

`tests/workers.test.ts` runs real threads, because the whole question is what a
second thread receives and a stand-in answers whatever it was written to answer
— which is how a documented, exported parameter shipped going nowhere.

## 2026-08-16 — the schema's types reach the browser (`FJS-018`)

1159 tests (5 new), 0 fail. Baseline unchanged at 138; `src/` stays at zero.

Litestone has generated `Post`/`PostCreate`/`PostWhere` for as long as it has
had a typegen, and the browser client has been generic since it was written.
Nothing joined them, so every browser call was `Record<string, unknown>` and an
app that wanted better hand-wrote the shape — which is what the `Seeder` type in
`example/fullstack/app.ts` was, and it is deleted.

**One registry, augmented rather than passed.** `ServiceTypes` is an empty
exported interface here; `litestone types --augment junction` emits the module
augmentation that fills it, keyed by SERVICE name, and `service('posts')` and
`resource('posts')` infer from it with no type argument at any call site. That is
the same mechanism `app.claim` uses for a slot an app fills (Invariant 5), and it
is the one that survives a call site nobody edits: a type parameter has to be
restated everywhere, which is the thing being removed.

**Nothing changes for an app that generates nothing.** With the registry empty
`keyof ServiceTypes` is `never`, so the inferring overload matches no call and
every one falls through to the open overload. `service<Post>('posts')` also still
resolves — an explicit argument fails the first overload's constraint and falls
through rather than erroring, which is asserted rather than assumed.

**The mapping in `ServiceRow` is load-bearing and cost an hour.** A proxy is
generic over `T extends Record<string, unknown>`, and a TypeScript INTERFACE —
which is what a generated row is — does not satisfy that: only a type alias of an
object type gets the implicit index signature. Passed straight through, the
constraint failed and the fallback took over, so the whole feature compiled,
inferred nothing, and looked finished. Mapping the members
(`{ [P in keyof ServiceTypes[K]]: … }`) satisfies the constraint and still
refuses an undeclared column.

**`ResourceResult.service` was untyped** — a bare `ServiceProxy`, so
destructuring `{ service }` off a resource dropped the row type the caller had
just asked for. Now `ServiceProxy<T>`.

`tests/client-types.test.ts` is the proof and it COMPILES: the real generator's
output, junction's real client behind the package specifier the augmentation
names, `tsc --noEmit` over the fixture. The negative half rides the same run —
`@ts-expect-error` is itself an error when the line it marks type-checks, so the
day inference silently widens back, the fixture fails.

## 2026-08-16 — `changed`: a write that cannot name its row still announces (`FJS-307`)

1160 tests (10 new), 0 fail. Baseline unchanged; `src/` stays at zero.

The tap installed for `FJS-010` dropped every event whose `result` was null,
which is one line and two whole classes of write: a bulk statement that answers
`{count}` and never built the rows, and a `select: false` write that skipped its
RETURNING. So a job doing `createMany` left every open tab stale — the same
defect `FJS-010` closed, one method over.

Litestone now says which it is (`scope`), and a rowless event is broadcast as
**`changed`**, carrying `{ model, operation, count }`. One name for all three
operations, because the only honest answer on the other side is the same for
each: ask the query again. Which operation it was travels in the payload for a
bus subscriber that wants it.

**`where` reaches the bus and never the wire.** The bus is in-process and can
hold the caller's filter; a channel goes to every subscribed browser, and a
filter is made of the caller's own values — `deleteMany({ where: { resetToken } })`
would otherwise put one on a socket. The two payloads differ by that field and
the test asserts both halves.

The browser store answers `changed` with the reload it already gives an
undecidable record, coalesced per burst, and the `*` catch-all skips the name —
without that, `{ model, operation, count }` would be upserted into the store as
if it were a row. Not `stale`: that counter is for a gap the list knows the
shape of, and *some unknown rows moved* is not one.

Not proved end to end. `example` has no bulk write reachable from a request, so
the frame is asserted here and the store's answer in the client suite; the link
between them is the frame dispatch every other event already uses.

## 2026-08-16 — a write nothing announced now announces (`FJS-010`)

1144 tests (9 new), 0 fail. Baseline 138, unchanged; `src/` stays at zero.

`callService` is the single announcement point, so a mutation that never went
through a service told nobody — a `db.asSystem()` write in a job, a raw route
writing through the client, a Litestone plugin. Every open tab kept the stale
row with a 200. `announceDataWrites(app, db)` installs a `$tapEvents` tap at
`createApp({ db })` and routes what it sees into the same bus + channel fan-out
callService uses, so there is still one shape of announcement.

**Suppression is keyed on the service NAME, and that is the substance.** Every
service write passes the tap too, so without a check each mutation would go out
twice. The first version asked *am I inside a service call* and swallowed the
audit row an `orders` after-hook writes — a different service, genuinely
unannounced, and `orders created` says nothing about it. Measured, then
narrowed: the ALS holds the announcing service and the tap compares. A nested
call re-runs it with its own name, so the innermost scope is the one that will
announce.

The ALS is read inside a `setImmediate` callback and works because the scope
propagates through scheduling. If that ever stops holding, every service write
announces twice — `tests/data-write-announcement.test.ts` is what says so.

**Two limits, both reported rather than guessed.** A **function** `channel:`
resolver takes `(rows, ctx)` and an orphan write has no ServiceContext to hand
it, so that service gets the bus and one named warning per process; inventing a
ctx would pass the app's own resolver a principal nobody authenticated. And a
model no service is built over is silent by design — an app may have tables its
API does not expose.

The `$tapEvents` probe is wrapped in a `try`: a Litestone client throws on an
unknown property, so feature-detection is itself a throwing expression, and an
older client has to leave `createApp` standing rather than take it down. That
was a real failure, caught by the stub client in `accessor-resolution.test.ts`.

Not installed for `createApp({ tenants })` — there the client is per request
rather than per app, so there is no single client to tap.

## 2026-08-16 — `rateLimit` is typed for both contexts, because it always ran on both (`FJS-063`)

It returns a **`BridgeHook`** — `(ctx: ServiceContext | TransportContext) => void`
— rather than `Hook`. The parameter is wider, so it stays assignable to `Hook`
and a `before:` map is unchanged.

Nothing about the behaviour moves. This hook is a service before-hook AND the
limiter `@frontierjs/auth` puts on its own `/auth/*` routes, which are plain
handlers; both things it reads go through accessors written for either shape,
and the comment above it has named auth as the reason since `FJS-017`. The
signature was the only part that had not caught up, and nothing said so because
auth typed those handlers `any` — which is what closing `FJS-063` removed.

## 2026-08-16 — the template directives, and what `$search` was answering (`FJS-306`, `FJS-292`)

**`$withTemplates` / `$onlyTemplates` reach the Data boundary.** `QueryDirectives`
declares them, `parseQuery` reads them off `ctx.directives` and off the `$`-in-
query fallback alike, the service forwards them to `findMany`/`findUnique`/
`findFirst`, and the browser client emits them on both wires. Same pair as
`withDeleted`/`onlyDeleted`, one Data-realm feature over — an app declaring
`@@hasTemplates` could not ask for a template from anywhere above Litestone.

**`$search` on a model that HAS `@@fts` was answering nothing.** `table.search()`
returns the rows, ranked; the find branch destructured `{ rows, total }` off that
array, so a search that matched came back `{"limit":20,"offset":0}` — no data, no
total, status 200. The same shape as the `restoreMany` that never existed
(`FJS-245`): a method typed on `LitestoneTable` that nothing executed. The type
now says `Promise<unknown[]>`, the rows are the rows, and the envelope's total is
a second id-only pass, skipped when the first page is short enough to BE the
total. The four visibility flags reach `search()` too.

Below `@@fts`, Litestone now refuses by name with a 400 rather than a bare Error
that arrived as a 500 (`FJS-292`); `errors.snapshot.md` records the new class,
and picks up the lock and soft-delete-unique rows that had gone stale in it.


## 2026-08-16 — the browser client speaks `directives`, and can finally say all eight (`FJS-290`)

1129 tests. Typecheck **138, baseline lowered from 139**.

`FindParams` was two things wearing one name. It held `query` — the filters —
alongside `limit`/`offset`/`orderBy`/`select`/`populate`, so the container was
both halves of a split the rest of the framework keeps apart (Invariant 10). And
it named five of the eight directives, so `$search`, `$withDeleted` and
`$onlyDeleted` had a server that read them (`parseDirectives`), a URL grammar
that carried them, a type in `core/context.ts` that named them — and no way for
`client.service(x).find(…)` to ask. Sierra inherited the hole: a `.lite`
declaring `@@softDelete` gave an app a restore flow it could not build a list
screen for, and FTS5 search was reachable only by hand-writing a URL.

Both are one fix. The second argument is now a **`QueryDirectives`** — the same
declaration the bridge reads — and filters are the first argument, always.

`QueryDirectives` moved to **`src/core/directives.ts`**, a module that imports
nothing. It had to: the browser client needs the type and `core/context.ts`
imports `node:async_hooks`, which does not exist in a browser and would ride
into every bundle on a type-only import a build step failed to erase.
`context.ts` re-exports it, so every existing import keeps resolving.

`directiveParams(d)` is the one table both wire builders read, replacing two
hand-written field-by-field walks. That duplication is how `$populate` came to
be emitted over HTTP and not over the socket once — a difference nothing can see
from the call site, since the client prefers the socket whenever one is up. The
parity test now asserts against `DIRECTIVE_PARAMS` rather than a hand-written
list, in both directions: every name emitted is a name the bridge strips, and
every directive declared is a directive emitted.

`$first` and `$wrap` stay out of the type and are passed by the one call site
that needs them — they are transport-only and have no structured form on the
other side, which is exactly the line `@frontierjs/toolbelt/directives` already
draws between `DIRECTIVE_PARAMS` and `TRANSPORT_PARAMS`.

One escape hatch is new and has one caller: `get(id, directives, _wire)`. The
WebSocket→HTTP fallback holds a frame whose directives are already in `$`
spelling, and parsing them back so this method could re-emit them would be a
second translation of the convention on the client — where the point of the
shared table is one per boundary.

Also fixed: the module header's own example was `find({ query: { status: 'online' } })`,
a Feathers idiom that filters on a column named `query`. With `FJS-289` landed
the same afternoon, that now answers a 400 naming the key instead of an empty list.

## 2026-08-16 — a provider is what Junction calls (`FJS-D10`)

1129/1129 tests pass (+5, `tests/session-verifier.test.ts`). Typecheck baseline
unchanged.

`IAuth` declares six required methods. This package invokes two of them:
`verifySession`, on the HTTP path and the WS upgrade, and `sessionFor`, behind
`runAs`. `login`, `logout`, `createUser` and `deleteUser` are called by
`@frontierjs/auth`'s own `/auth/*` routes and by nothing here — so an app
authenticating against something it already had was stubbing four methods that
would never run, and a stub that throws cannot be told apart from a provider
that works until the day something calls it.

`createApp({ auth })` and `setAuth()` now take **`SessionVerifier`**, and the
whole of it is `{ verifySession }` with `sessionFor` optional. The absence of
`sessionFor` stays LOUD — `runAs` throws by name rather than downgrading a
caller to STRANGER(0).

**It is derived, not declared beside `IAuth`** — `Pick<IAuth, 'verifySession'> &
Partial<IAuth>` — and both halves earn their place. A hand-written member list
drifts the moment `IAuth` grows a method. And `Partial` is what keeps a FULLER
provider assignable: TypeScript's excess-property check rejects an object
literal carrying a key the target does not name, so a narrow interface listing
only `verifySession` refused `{ verifySession, login, … }`, which is exactly the
provider it exists to accept. That was measured, not predicted — the first shape
broke four call sites in this repo's own examples and tests.

`tests/auth-cookie.test.ts` is the receipt: three of its stub providers were
written `: IAuth { … } as IAuth`, casting past five methods they do not
implement. The casts are gone.

**`createSchema` takes an optional type parameter.** `createSchema<CreateOrder>({
… })` makes `parse()` answer `CreateOrder` instead of `Record<string, unknown>`,
with the field map constrained to that type's keys so a missing or invented one
is a compile error. The type is STATED rather than inferred, and that is the
ruling: a model service is validated by `autoValidate` off the generated JSON
Schema and writes no schema at all, so this is the hatch for a shape the seed
does not describe — and for that shape the author already holds the type.
Inferring it instead means building zod inside a framework whose thesis is that
types come from the seed. Untyped calls are unchanged.


## 2026-08-16 — `resolveAccessor`: the derived hooks were asking a question the client could not answer (`FJS-289`)

1129 tests, 4 of them new here. Typecheck clean.

`autoFilter` and `autoSort` passed `accessorOpt ?? ctx.service` straight to
`$checkWhere` / `$checkOrderBy`. A service that declares no `model:` is named
for its URL, which is plural, and both check functions answer `[]` for an
accessor they do not know — the same value they answer for *no problems*. So the
hooks read *I cannot judge this* as *this is fine* and validated nothing.

Measured on `example`, whose four services all omit `model:`:
`GET /api/orders?bogusColumn=7` answered **200 with an empty list**, plus a
Litestone warning on stderr that no client can see. That is the exact
silent-empty-screen `FJS-109` created the hook to end — working for nobody who
used the default.

**The sort half was masked.** Litestone throws on a bad `orderBy` at execution
where a bad `where` only warns, so `?$orderBy=-bogus` answered 400 from the
backstop while the hook above it did nothing. One of the two looked correct and
neither was.

`resolveAccessor(client, accessor)` is the fix and the one owner. It resolves
off `$schema` rather than probing, because no probe can separate the two
meanings of `[]`. `getTable` and `_gateLevels` had walked `accessorCandidates`
since the naming slip that silently disabled authentication; the hooks that ASK
rather than LOOK UP never got it.

Every existing test declared `model:` explicitly, which is why the coverage was
green throughout. The new describe omits it — the shape the autoloader produces.
Verified by reverting: the filter test goes red, the sort test does not, which
reproduces the masking.

## 2026-08-16 — `app.provide` is `app.claim`, and metrics get a real seam (`FJS-D06`)

1120/1120 tests pass. Typecheck baseline unchanged.

`app.provide(name, value)` never provided anything. It takes a name on the app
object and throws if something already holds it — Fastify's `decorate`, and the
error message it has always thrown says *already claimed*. Now the verb agrees:
**`app.claim(name, value)`**. The rename exists because `FJS-D06` gave `Provider`
a meaning — a third party the app speaks to, an identity provider or a payment
provider — and a verb that means *claim a namespace* standing next to a noun
that means *Stripe* is two concepts one keystroke apart.

**`_metricsProviders` was the same word in a third sense** — a thing that
supplies a number — and it was also a private field two packages reached into
behind an `instanceof Map` guard. Conduit's own `docs/AUDIT.md` had written down
what that costs: rename the field and metrics disappear with **no error
anywhere**, because a guard that fails just skips. So the field became
`_metricsSources` and the reach-in became a declared seam,
**`app.registerMetricsSource(name, fn)`**.

That is the half worth keeping. Conduit now calls it unguarded — it imports
Junction's own `App` type, so a missing seam is a compile error — while Caravan
keeps a presence check, because Caravan legitimately runs against hosts that are
not Junction apps at all. The integration tests on both sides drive a REAL app,
which is what makes a skew between the packages loud instead of silent.

Breaking for anything calling `app.provide()` or writing `app._metricsProviders`
directly: caravan, conduit, notifications, webhooks and basecamp, all updated.


## 2026-08-16 — per-request tenants (`FJS-D05`)

`createApp({ tenants })` takes a Litestone tenant registry and installs
`withTenantDb` **in place of** `withLitestoneDb`: one `ctx.locals.db`, and two
hooks assigning it would leave which wins to hook order. Each call resolves its
tenant, and the resolution is **asked rather than re-derived** —
`registry.tenantFor({ host, headers, principal })` applies the `resolve` the
schema declares (a subdomain, a header, a claim), so this side contributes only
what a transport has and what a refusal's status code is. A second reading of
`resolve subdomain` living up here is how two answers to one question drift.

Work with no request behind it — a job, a scheduled sweep, a webhook replay —
names its tenant with `{ locals: { tenantId } }`, which is what `locals` being
hand-down-able is for. No tenant resolvable is a 400 naming how the schema says
to name one; an unknown tenant is a 404.

Row tenancy needs no hook and fails the other way round: the schema's own
policies scope every query, so a **signed-in** principal carrying no claim
matches no row and every screen is an empty list with a 200 — indistinguishable
from a tenant with no data, and almost always a missing `sessionFields` entry.
`tenantClaimGuard` refuses that by name on a scoped service. Anonymous is
deliberately not its business: nobody is not a caller missing a claim.

## 2026-08-16 — `app.principal()` / `app.runAs()`, the seam deferred work runs through

1120 tests, unchanged — the behaviour is proved from Caravan, which is its only
caller. Typecheck clean.

`auth` propagating (below) fixed calls *inside* a request. Work that outlives
one — a job, a retry, a scheduled sweep — still had no principal, because the
store is gone by the time it runs. Two members answer it, and neither is
Caravan-specific: `app.principal()` reads who is in scope from somewhere holding
no `ctx`, and `app.runAs(userId, fn)` opens a scope for a principal **resolved
now**, so `fn` makes ordinary service calls that name nobody.

`createApp({ system })` is the third piece: the principal an app is when it acts
on its own behalf, for work nobody asked for. Declaring none gives `null` rather
than an invented identity — inventing one would hand every app a privileged
principal it never requested.

`IAuth.sessionFor(userId)` is new and optional: build a session for a caller
presenting no credential. **It proves nothing**, so it must never be wired to
anything a request can name. A provider lacking it makes `runAs(userId, …)`
throw by name rather than quietly downgrade to STRANGER(0), which is the bug
this exists to remove.

`createTestApp({ system })` forwards it — a test that cannot declare a system
principal cannot tell that answer apart from *no principal*.



## 2026-08-15 — `auth` propagates, and `ctx.params` is gone (`FJS-D03`)

**The contract said `auth` propagated and it did not.** Measured: a nested
`ctx.app.service('inner').find()` from inside a service saw `null`, while
`core/context.ts` documented the field as *"Frozen. PROPAGATES across internal
calls (carry caller identity so authz stays consistent)."* An internal context
was built from `opts.auth` alone — there was no ambient anything — so every
boundary that starts a call chain began at STRANGER(0) unless a human threaded it
by hand. That is the same root cause as the Caravan job hazard, and why
`example` carries an `app-ref.ts` singleton and `{ auth: { user: SYSTEM as never } }`
in every job.

It propagates now, and it needed no new machinery: the principal joins
`RequestMeta` in the `AsyncLocalStorage` store the transport **already** wraps a
whole request in, so nothing is threaded and no caller object is rebuilt. Three
rules, all executed in `tests/context-contract.test.ts`:

- a call naming no principal inherits the one in scope, **at any depth**
- an explicit `{ user: null }` stays anonymous — **absent is not null**, tested
  with `in` rather than `??`, which is what preserves *read this as a stranger
  would*
- a call whose principal DIFFERS re-scopes, so a sub-call made as somebody else
  passes **that** principal to its own children rather than the request's

`client` propagates by the same route, for the same reason: an audit hook three
calls deep has no other way to reach the IP of the request that caused the write.
It is information, never authority.

A test that pinned the old behaviour — *"app.service() without params makes an
anonymous call"* — is rewritten. Its own comment called that an "anonymous system
call", which is the opposite thing: STRANGER(0), not level 8.

**`ctx.params` is gone from both contexts.** Path captures are `ctx.route`
everywhere in Junction — `TransportContext`, `WsContext` and `ServiceContext` —
and Sierra keeps `page.params`. Deleted rather than aliased: in Feathers `params`
is the whole context bag, that idiom keeps arriving here (`ctx.params.user`,
`ctx.params.headers`, `app.service(x).get(id, ctx.params)`), and a field of that
name holding *something else* is how a role check reads `undefined` and passes
for everyone. Absent, the idiom throws.

The guidance that told people to thread `ctx.params` — in this package's own
`app.ts` comments — is rewritten, since there is now nothing to thread.

`CLAUDE.md` gains **§ The two contexts**: which one you are holding and when,
where they must agree, where they deliberately differ, and the four fields with
their four different rules.

## 2026-08-16 — `client.auth`, and the token gets one owner (FJS-D20)

The browser client could sign in and could not do anything else: no register, no
`me`, no password reset, and `logout()` cleared the token locally without telling
the server — so a sign-out left the session row valid until it expired. Nothing
in this repo had ever called `POST /auth/logout`.

`client.auth` is the whole surface now — `signIn` / `signUp` / `signOut` / `me` /
`changePassword` / `sessions` / `revokeSession` / `revokeOtherSessions` /
`apiKeys` / `createApiKey` / `revokeApiKey` / `requestPasswordReset` /
`confirmPasswordReset` / `requestEmailVerification` / `verifyEmail`. It lives
here rather than in `@frontierjs/auth` because this is the object that holds the
token, opens the socket and knows both prefixes; an app writing its own sign-in
had to reproduce all three. `authenticate()` is gone — it is `auth.signIn`.

**`tokenStorage` gives the token one owner.** Sierra used to write localStorage
in its own `login()` while the client held its copy in memory, so signing in
through the client left storage empty and writing storage by hand left the socket
unauthenticated. `setToken` now persists, clears, and emits `token` so a cache
keyed on identity (Sierra's prefetch) can drop what belonged to whoever left.

**A 401 keeps the server's own sentence.** `_request` threw `Unauthorized`
without reading the body, so "Invalid credentials" never reached anyone — which
is most of what a hand-written sign-in page was doing when it re-mapped the
status itself.

`IAuth` gains five optional methods (`changePassword`, `listSessions`,
`revokeSession`, `revokeSessions`, `listApiKeys`) and `SessionContext` gains
`sessionId`; `AuthSessionInfo` and `ApiKeyInfo` are what the caller may be shown
about their own credentials — deliberately not the rows, which hold the bearer
token and the key hash.

## 2026-08-15 — a stream is not a result (`FJS-D13`)

Ruled: a stream sits **outside** the envelope and `ResultKind` stays
`single | list`. The envelope answers what a call RETURNED — one record or a page
of them, with `total`/`limit`/`offset` and the bulk protocol's `errors` — and a
stream returns nothing and then repeatedly, so every field of it is meaningless
for one.

**A third `kind` would have been silent.** It is branched on at ten sites, listed
in `core/envelope.ts`'s own header, and a new value lands in each as *not a
list* — treated as a single, `data: undefined`. That is the class of drift the
module exists to end.

**The framework already streams and already answered this the other way.**
`publish()` is an after-hook, so a pushed frame IS `ctx.result` — through
`protect()` and the whole pipeline — and `unwrapResult` strips the envelope at
the wire. Unwrap at the edge, not grow a kind.

`wrapResult` now **refuses** a `Response`, a `ReadableStream`, anything with
`getReader`, and an async iterable, by name. It used to wrap them, and both a
Response and a ReadableStream have no enumerable own properties: a service
method returning one answered `{"kind":"single","data":{}}` — an empty object
with a 200, the stream destroyed, nothing said. The refusal names where streaming
does live, because a wall that does not is worse than the bug. 5 tests.

The corollary is the half with teeth: **each frame is a result and the stream is
not.** `ctx.sse()` is a raw-route transport primitive with no `gateAuth`, no
`autoValidate`, no `protect()` and no app hooks — right for a heartbeat, wrong
for records.

## 2026-08-15 — a custom service method is a METHOD (FJS-D02)

`action` was a second noun for a set the CRUD list already defines by
exclusion, and every surface a developer touches had said *method* all along:
the declaration is `methods: ['find', 'get', 'reboot']`, the wire is
`X-Service-Method` over HTTP and a `service_call` frame naming `method` over the
socket, the pipeline carries `ctx.method`, and a refusal is `MethodNotAllowed`.
Ruled: they are methods; *custom* is the adjective where the distinction
matters.

**The wire did not change and neither did the announcement** — a custom method
still announces under its own name (`orders pay`). What changed is the
vocabulary and one public name:

- `svc.action(name, id, data, query)` → **`svc.invoke(...)`** on the browser
  client. Not `call`, which is the WS-only escape hatch already.
- `collectActions` → `collectCustomMethods`, `_actions` → `_customMethods`,
  `actionNames` → `customMethodNames` (the table-first answer), and the old
  scan-only `customMethodNames` → `scanCustomMethods`.
- `describe()` reports `customMethods`; `/metrics` `services.details.*` reports
  `customMethods`; `surface.snapshot.md` prints **custom methods**. Regenerate
  the snapshot after upgrading — the `snapshots` CI phase fails a stale one.

`ARCHITECT.md` §2 carries the vocabulary rule; `DECISIONS.md` § Naming &
vocabulary carries the ruling.

## 2026-08-15 — a live list keeps its order and knows where its page ends (FJS-270)

`Store.upsert` appended. So a list loaded `orderBy: '-createdAt'` received new
rows at the BOTTOM and one loaded `limit: 20` grew past 20 — the row was
genuinely in the query, it was in the wrong place in it, which is `FJS-011` one
field along.

`Store.place(record, idField, cmp, max)` inserts at the sorted position and moves
a row whose sort key a patch changed, in one notification. The comparator comes
from **`core/sort.ts`, which is also `parseSort`** — one reading of `-createdAt`,
or the browser orders a list differently from the query that filled it. Its value
ordering follows SQLite rather than JavaScript: NULLs first ascending and
therefore last descending, numbers before text, a Boolean as the 0/1 it is
stored as, ISO-8601 DateTime compared as text. Where it cannot be exact it says
so in the header — a non-BINARY collation, and UTF-16 code units against bytes
past ASCII.

**Paging is unanswerable from a browser and is not guessed at.** On the first
page the row pushed off the end genuinely belongs to page 2, so trimming is
right. Past page 1 a new row is refused: nothing here knows whether it belongs on
an earlier page, and putting it in would push out a row that does. A removal
leaving a gap only the server can fill is the same case. Both are counted, and
the count is `stale` on the resource — `{ get, subscribe }`, the same shape as a
Store, so anything that bridges one to a UI signal bridges this — cleared by
`load()`, for a view to render as *3 new — refresh*.

The limit and offset are read off the **envelope**, not the params: the effective
limit is the server's, and a caller naming none still got one. A service
answering no pagination metadata leaves it unknown, which turns trimming off
rather than inventing a page size. An unordered list that outgrows its page
counts rather than dropping a row at random — throwing away the row the user just
created, to honour a page size, is the worse half of that trade.


## 2026-08-15 — the consumer surface type-checks, and seven defects were under it (FJS-268, FJS-272)

An app that imports junction compiles junction: the `exports` map points at
`.ts` and nothing emits `.d.ts`, so tsc follows those imports and checks the
framework as part of the app's own program. Measured on a freshly scaffolded
app, that was **61 diagnostics from inside `node_modules` and none of its own**
— and all 61 were junction's. The other five TypeScript packages were already
clean, so this was never the framework-wide problem it was filed as.

`index.ts` + `src/**` is now **0**, from 67. The baseline fell **198 → 139**, and
what is left is `tests/` and `example/`, which no consumer compiles.

Seven things were hiding in there. In severity order:

**STARTTLS was broken against every submission server.** `src/mail/smtp.ts`
called `socket.startTls(...)`. Probed on Bun 1.3.11 that property is `undefined`
— the API is `upgradeTLS`, it takes the socket handlers again, and it returns a
PAIR whose second element is the encrypted socket. So Gmail, SendGrid, Postmark,
Office 365, anything on port 587, died with `socket.startTls is not a function`.
Nothing caught it because the only mail server the drives talk to is the dev
sink, and a sink advertises no capabilities, so the branch never ran.
`tests/smtp-starttls.test.ts` pins it and **runs out of process**:
`tests/email.test.ts` mocks the smtp shim with `mock.module`, which is
process-wide and never undone, so an in-process version passed alone and graded
a mock inside the suite.

**`timestamps()` skipped every row of a bulk create.** `ctx.data` is a row OR an
array of rows; un-narrowed, the hook set `created_at`/`updated_at` as properties
of the ARRAY. `allow()` had the identical shape and filtered nothing on a bulk
payload. Both map over the array now.

**An error's stack never reset the terminal colour.** `line += '\n' + COLOR +
stack ?? fallback + RESET` parses as `(concatenation) ?? (…)`, and a
concatenation is never nullish — so the fallback was dead and `RESET` sat on the
wrong side of the operator. An error with no `.stack` logged the word
`undefined`, and every line after ANY error stayed the error colour.

**`plugins/email/campaign/sender.ts` imported `App` one `../` short.** A
type-only import, so it never failed at runtime and every type in that file was
dead. Fixing the path revealed the file reaching `app.conduit.resolve` with no
guard — a `Cannot read properties of undefined` the first time campaign email is
configured without conduit. It states the slice of Conduit it needs, structurally
and locally, because `AppConduit` is empty here on purpose.

**The OpenAPI generator could not express a header parameter**, so the
`X-Service-Method` line — the whole custom-action calling convention — was an
excess property the spec silently dropped. Path-level `parameters` were
untypeable for the same reason.

**`RateLimitHookOptions` was exported twice from `index.ts`** (a duplicate
identifier), and `RouteSegment` was imported from `router.ts`, which does not
export it.

**`tsconfig.json` was a stale copy of `tsconfig.base.json`** with `DOM.Iterable`
missing from `lib` — so `headers.entries()` was a type error against working
code, which is the exact case the base's own comment warns about. It extends the
base now.

**The casts, and what they were hiding.** Twenty-five `as Record<string,
unknown>` assertions came out. Nine were reaching fields the types already
declared (`app.telemetry`, `app._plugins`, `app.channels`, `ctx.requestId`,
`Channel.name`). Twelve were an **undeclared middleware → transport side
channel** — a middleware runs before the response exists, so it leaves headers on
the context and `_finalizeWithHeaders` applies them at the end. That is one
contract with six fields (`__cors`, `__securityHeaders`, `__rateLimit`,
`__correlationHeaders`, `__pendingCookies`, `__status`) and it was written down
nowhere, so a middleware that misspelled a bucket compiled, ran, and dropped its
headers in silence. They are on `TransportContext` now. `Connection.__joinMeta`,
`Channel.__presenceWrapped` and the `service`/`method`/`params` fields of a
`service_call` frame got the same treatment. What remains as a cast is what is
genuinely dynamic — an action name written onto a service, a method name onto the
router — and each is a two-step with a sentence saying why.

Also: `HookType` never admitted `'method'`, which `runPipeline` sets while the
method itself runs, so a hook reading `ctx.type` could see a value the union
denied. `Bun.serve<WsData>` is stated, so the four websocket handlers agree with
the `_ws*` methods about what is on `ws.data`.

`FJS-271` is filed rather than fixed: `createThread(path, data)` passes
`workerData`, which Bun does not deliver under any name — a public API's second
parameter goes nowhere, and closing it is a protocol decision, not a type one.

## 2026-08-15 — `resource()`'s store is scoped to the query that filled it (FJS-011)

A push is an announcement about a ROW; the store is the answer to a QUERY. The
wiring applied every event to it, so a row outside the filter was added and a row
a patch had just moved out of the filter stayed in, updated in place.

`resource(name, idField, { match })` takes the decision from its caller —
`true` upserts, `false` removes, `null` means *cannot be decided from this
record* and the store reloads instead of guessing, once per burst rather than
once per event. Sierra passes a matcher built from the model's own field rules;
this package holds no schema, which is why it is passed in and not decided here.
A caller passing nothing gets exactly the old behaviour.

The query is recorded when the rows are, inside the `FJS-082` stamp check, so a
superseded load leaves neither its rows nor its filter behind. A custom action
event goes through the same door as a patch: a row can leave a list through one.

## 2026-08-15 — `deriveModelName` uses the shared inflection rules (FJS-192)

It carried its own copy — `ies`/`ses`, no irregular table — so a `people`
service resolved to the model `people`, which does not exist, and the lookup
failed open the way `accessorCandidates` exists to prevent. It now calls
`singularize` from `@frontierjs/toolbelt/inflect`; the `Service` suffix and the
camelCase are still junction's business.

The guards this copy had and the others did not — `us`, `is`, `as`, `ss`, which
stop `status` becoming `statu` — went INTO the shared module rather than being
lost to it.

## 2026-08-14 — two things on stdout that were not news

An app booting printed one `[Loader] Registered service:` line per service and
one `[Junction] anonymous hook on x.before.y` line per PHASE per METHOD. On a
21-service app that is dozens of lines before anything has been served, and the
real warnings — a duplicate service, a file with no factory, a hook map on a
method the service does not have — competed with them for the same scrollback.

They are not the same kind of thing, so they are separated now.
`core/diagnostics.ts` is the one owner of *should Junction print developer
diagnostics*, reading `DEBUG=1` — which junction's own config already maps to
`config.debug`, so this adds a reader rather than a convention.

- The loader's registration line is a diagnostic. `GET /manifest` answers the
  same question on demand.
- The anonymous-hook note is a style note, not a warning: the hook works, it
  just reads as `anonymous` in the telemetry waterfall. It now says everything
  it has to say about one service in ONE line, naming every position —
  `8 anonymous hook(s) on alerts (before.all, before.create, …)`.

**Nothing that indicates a probable defect changed.** A duplicate service, a
load failure, a missing factory, a bad hook target and every `console.warn` in
`litestone.ts` are as loud as they were. The old gate was
`NODE_ENV !== 'production'`, which is true for every developer all of the time
and is therefore not a gate.

## 2026-08-14 — `junction errors` — what a thrown value becomes, executed

`errors.snapshot.md` at this package root: every error class with its status,
one row per branch `toFrameworkError` can take, the status → class table, and
**Litestone's real error classes constructed and run through the boundary**.
`--check` byte-compares; the `snapshots` CI phase reruns it from the header the
file carries.

Every row is a value actually thrown through `toFrameworkError()`, not a table
written from the source. That matters because everything above the boundary
reads only the result: a class that gains a `status` silently stops being a 500,
and one that never had a status is silently a 500 while its message says
otherwise. Neither breaks a test, because nothing asserts on a category nobody
named.

**It found `FJS-255` on its first run.** The three lock errors —
`LockNotAcquiredError` (`retryable: true`), `LockExpiredError`,
`LockReleasedByOtherError` — each declare the one field a status cannot express
and none declares a status, so all three reach a caller as a 500 with
`retryable` intact beside it. Same shape as the transition errors before
`FJS-190`, and the same fix: if you own the class, give it a status.

Constructing them is load-bearing: `status` and `retryable` are set in the
constructor, so a row synthesised from a class NAME reports every one as a 500
with no retryable. That is exactly what the first draft did for the two classes
whose constructors take arguments a probe has to guess.


## 2026-08-14 — `junction surface` — the API surface as a committed file

The Data realm's snapshots (`litestone access`, `litestone ddl`) have an API-realm
sibling. `junction surface --app <module>` writes `surface.snapshot.md`: every
service with its policy-applied methods, its actions, what it broadcasts on, and
its hook chain **in the order it runs**; the app-level hooks that wrap every call;
every path the router mounted, prefix applied; and the plugins in configure order.
`--check` byte-compares the committed file, which is what `scripts/ci.mjs` reruns.

**Read off a BUILT app, never scanned**, because none of it is answerable from
source text: `collectActions` decides at construction whether a key is an option
or an action, `svc.pipelines()` resolves the chain a service actually runs
(`gateAuth`, `autoValidate` and friends lead it, and appear in no service file),
and `apiPrefix` moves routes registered by plugins that never mention it. The
tool asks the declared owners — `svc.describe()` and `buildRoutes()` — and
`serializeHookMap` is now exported rather than copied, so "a hook is its function
name" has one spelling.

The app module must expose the app **without listening**: a built `App`, or a
factory returning one — the same contract `@frontierjs/testing` takes as `api:`.
`--services <dir>` names the autoload directory, because that phase is `needsHost`
(it resolves against `Bun.main`) and an app whose services are all autoloaded
otherwise describes as empty.

This is what `FJS-254` closed against: `fli project:view` re-derived service
metadata with regexes over source, including its own copy of the action rule. It
reads this file now.


## 2026-08-14 — a filtered bulk PATCH/REMOVE writes row by row

`FJS-044`, ruled by `FJS-D11`. The row was filed as an ergonomics gap — bulk
create reports per-row failures, patch and remove answer `{ count }`. Probing it
found an enforcement gap underneath, which is the real reason this changed.

**Litestone does not run `@@transitions` on `updateMany`.** That is deliberate
on its side — a power tool whose caller "takes responsibility", with a note
saying to loop `update()` where transition safety matters. Junction's bulk patch
called `updateMany` directly, so the responsibility was never taken. Verified
through a real service over a real client:

```
PATCH /orders/1            {status:'shipped'}  → TransitionViolationError
PATCH /orders?status=draft {status:'shipped'}  → {"count":2}, both rows written
```

Same forbidden move. `@version` was the same shape — bumped by a bulk write,
never required — so optimistic concurrency was off for the writes touching the
most rows. Both are properties of `update()`, so both come back by calling it,
and calling it per row is also what produces a per-row outcome.

A filtered patch/remove now selects its targets and writes them individually,
answering the `{ data, errors }` list envelope bulk create already did. Gate and
row policy were enforced on the bulk path before and are unchanged; `removeMany`
cascaded correctly and that is unchanged too.

**`bulkMax`, default 1000.** One statement per row means an unbounded filter is
an unbounded number of statements under the single write lock. Over it the call
is refused naming the count, before anything is written. This is the one place
the change can break a working app.

**Only rows the caller can read are touched** — selecting the targets applies
the read policy, the write applies the update/delete one.

**A caller-supplied `@version` on a bulk patch is refused by name.** One value
cannot be right for N rows. Each row is written against the version selected
with it, so a row that moved underneath is a `VersionConflictError` in `errors`
rather than a silent overwrite.

Still no atomicity, on the same terms as bulk create — `transactional:` is how a
caller trades partial success back for all-or-nothing.

The browser client's bulk overloads promised `T[]` (patch) and `string[]` of ids
(remove) against a server that answered `{ count }`; both now say
`ListResult<T>`, which is what actually arrives.

## 2026-08-14 — every filtered restore was a 500

`FJS-245`. `PUT /{service}?filter` reached `restoreImpl`'s bulk branch, which
called `table.restoreMany({ where })` — a function a Litestone table does not
have. `LitestoneTable` declared it, so nothing typed the mistake. `restore({
where })` already takes a multi-row where and answers the rows, so the fix is
one call and it lands restore in the same envelope as the other two. No app in
the repo sets `allowBulk`, which is why no drive ever reached it.


## 2026-08-14 — `transactional:` — a declared commit scope

`FJS-089`'s write half. An `after` hook that sends an email runs, a later `after`
hook throws, and the client sees a rejected create whose row is committed and
whose email has gone. Junction had no phase meaning *the call succeeded*.

```ts
createService({ name: 'orders', model: 'Order', transactional: true })
createService({ name: 'orders', model: 'Order', transactional: ['create', 'pay'] })
```

**`around` is the only phase that wraps the after hooks**, which is what makes
this a commit scope rather than a longer before hook: the transaction covers
before → method → after, so a later `after` hook throwing rolls the write back.

Two orderings carry it and both already held. `withLitestoneDb` is an APP-level
around hook and app hooks merge first, so it runs OUTSIDE this one — the
transaction opens on the caller-scoped client, and `$setAuth(u).$transaction(…)`
passes its own proxy through, so row policies and `auth()` survive into it. And
the announcement happens in `callService` after `runPipeline`, so the write lock
is released before anything fans out to a socket.

`find`/`get` are never wrapped, excluded **by name** the same way the announcement
excludes them — a read taking `BEGIN IMMEDIATE` would serialise every reader. A
service declaring it without a Litestone client **throws naming the service**; a
declared guarantee that quietly does nothing is the failure mode this package
keeps rediscovering. `describe()` reports the resolved list.

**A nested `app.service('x')` call needs no propagation.** Planning assumed it
would escape the transaction; reading the client disproved it — every flavour
shares one write connection and one depth counter, so the inner write lands
inside the outer transaction and its reads see it. Litestone `FJS-244` is what
keeps that true under concurrency, and this feature required it first: it opens a
transaction on every mutating request, which would have made that defect the
normal path rather than a rare one.

**What it does not do.** A transaction rolls back rows, not SMTP. An email an
earlier `after` hook already sent stays sent — that half of `FJS-089` stays open,
and the route to it is the transactional outbox, which turns the effect into a
row that this mechanism can already roll back.

**What it costs.** `BEGIN IMMEDIATE` holds SQLite's single write lock for the
whole pipeline, `after` hooks included. An `after` hook doing network I/O
serialises every write in the app behind it. Off by default for that reason.

Also fixed while testing it: `createBaseService` dropped a `transactional`
declaration, so a service written with the base factory and spread through the
autoloader declared a transaction nobody opened — the same silence that once made
`methods:` do nothing through that factory. 11 tests, against a real Litestone
client rather than a stub, since the whole feature is a claim about
`$transaction`'s behaviour.

## 2026-08-13 — one rate limiter, three adapters

`FJS-017` named three symptoms of "two pipeline systems, one vocabulary". Two
were rate limiting; the third (`apiPrefix` hand-resolved in four files with two
defaults) closed separately as `FJS-012`.

**There were three limiters.** The transport middleware took `limit` / `keyFn` /
`window: 60_000`; the pipeline hook took `max` / `key` / `window: '15 minutes'`;
`@frontierjs/auth` carried a third. Same algorithm, three vocabularies, so what
you learnt from one told you nothing about the next — and they had drifted:
auth's returned before comparing on a fresh bucket, so `max: 0` let one request
through.

**Auth's fork had a stated reason and it was stale.** Its comment said the shared
hook *"operates on ServiceContext, which has `ctx.params.ip`"*. A ServiceContext
has no `params` at all — that is one of the loudest traps in this package's own
docs. The real difference was one accessor: a TransportContext carries `ip` at
the top level, a ServiceContext splits client facts into `ctx.client`.
`clientIp(ctx)` answers for both, and the hook reaches `auth` optionally, because
a sign-in route has no principal by definition. Auth's copy is gone.

`core/rate-limit.ts` owns counting, the window, the sweep, the teardown and the
refusal. The three call sites are adapters over it, differing only in how they
read a key and what they do with the verdict — the transport tier keeps its
`x-ratelimit-*` headers, because it runs where a response is still being
assembled and it is the tier that can count a flood which never reaches a
service. That difference is why the two tiers stay separate.

One vocabulary: **`max` / `window` / `key` / `message` / `skip`**, with `window`
taking a TTL string or milliseconds at both tiers, and `retryAfter` on the 429
from both. **The old names throw rather than being ignored** — a silently dropped
`limit:` leaves `max` undefined, and `count > undefined` is never true, so the
limiter would accept everything and say nothing.

**Middleware and hooks are NOT merged into one concept.** `FJS-D01` refused that
once, and the transport limiter is the argument for keeping them apart.

10 tests, and they assert what no per-copy test could: that the tiers agree.
Baseline 199 → 198.

## 2026-08-13 — one registration per route, one announcement per mutation

Two defects with one shape: **something registered twice, and nothing said so.**

**A duplicate route is now refused by name, at registration.** `Router.add()`
accepted a second registration of the same path in silence, and which copy
survived depended on something the caller cannot see — a FIXED path is written
into a map by `build()` so the LAST one won, while a DYNAMIC one is pushed onto a
list `lookup()` scans in order so the FIRST won and the later handler never ran.
The refusal is keyed on the route's SHAPE rather than its literal path, because
`/a/{id}` and `/a/{name}` accept exactly the same requests and differ only in a
name nothing outside the handler reads. Each segment carries its type: `{}` is a
legal static segment (`PARAM_PATTERN` needs a character between the braces), so a
placeholder spelt `{}` made `/a/{}` collide with `/a/{id}`.

It surfaced as **doubled CORS** — `cors()` registers `OPTIONS /*`, and `fli new`'s
own scaffold called it by hand beside the config entry that installs it at
startup, so every scaffolded app ran doubled CORS from its first boot. The headers
came out right, which is why nobody looked. Closes `FJS-225`, and the same refusal
covers any plugin claiming a path another already owns.

**A service can no longer broadcast twice.** `channel:` is announced by
`callService` at the single announcement point; the exported `publish()` hook
sends its own frame from `after`. Carrying both put the same record on the wire
twice and every subscribed tab applied it twice. The register tracked this as
*"grep before merging"* — a rule nobody can be relied on to follow and no test can
check. `publish()` now marks the hooks it produces, and `svc.pipelines()` refuses
a service carrying both, naming the method. That is the one place the **full**
effective chain is known, so an app-level `after: { all: [publish(…)] }` — the
shape that would double a whole app at once — is caught too. Marked hooks and
never names: an app may call its own hook `publish`, and suppressing a real one on
a name collision would silently stop broadcasting, which is this defect inverted.
Closes `FJS-045`, verified unrealised first — 17 basecamp services use the hook
and none also declares `channel:`.

13 tests. Suites green, typecheck at baseline, `example`: verify + **verify:live**
+ jobs, `basecamp`: verify 271/271.

## 2026-08-13 — the README's Conduit example taught two things that cannot work

Found while sweeping for `FJS-D29` (*agent* → *Outpost*), and the naming was the
smaller half.

**`kind: 'agent'` no longer exists** — the union member is `'outpost'`, so the
example as written was a type error for anyone who copied it.

**`auth: { type: 'hmac', secret: process.env.AGENT_SECRET }` never worked at all.**
A Conduit target carries a **ref**, resolved at send time; the HMAC signer reads
`ref` and nothing else. The documented form type-checks through the cast and then
fails every send with `auth_failed` naming credential `undefined` — *and* writes
the material into the registry, which `GET /conduit-targets` hands back. That is
the exact defect Basecamp hit and recorded in its own `CLAUDE.md`; the README has
been teaching it since.

Both fixed in place, with the ref/material distinction stated in the sample.

## 2026-08-13 — a service is a definition and a compiled runtime

`FJS-D01`, closing `FJS-016`. The ruling and the Feathers 5 comparison are in
`DECISIONS.md` § API design; this is what moved.

**The derived hooks install once** (`FJS-231`, found while planning this). A base
returns the MERGED hook map, the autoloader spreads a base back through
`createService`, and the second pass appended the schema-derived layer again — so
every autoloaded one-line service graded its `@@gate` and ran its validator
**twice per request**. Nothing caught it because nothing was wrong on the wire.
The four derived hooks are marked now (a WeakSet, invisible to a spread) and a
marked hook already present is skipped. Marked rather than matched by name: a
user hook called `gateAuth` is not ours, and letting it suppress the real one is
fail-open on the thing that enforces access.

**`methods:` declares.** It used to be an allow-list validated *against* a scan
of the object; it is now the source of truth, which is Feathers' shape and what
makes an action nameable after an option key — `cache`, `schema` and `channel`
were eaten by the deny-list with no error at declaration, at call, or anywhere
else. With no `methods:` the scan runs exactly as before, so every inline action
keeps working and no app in this repo changed.

**One parse step, one table.** `collectActions` runs at construction and lands in
`_actions`; dispatch, `/manifest`, the OpenAPI spec and `/metrics` read it
instead of each re-deciding what counts as an action. An action attached to a
service *after* construction still dispatches and warns once naming itself — that
was never a supported shape, but a silent 404 is the worst way to learn it.

**`describe()`** — `{ name, model, actions, methods, allowBulk, softDelete,
cache, idField, hooks, schemas? }`. The three advertisers stopped reaching into
`_meta`, `_schemas` and `_hookMap` through casts. Three readers of four
internals was three chances to describe a different service than the one that
answers the request, and `/metrics` did exactly that: it read `svc.actions`, a
key no service has, and reported `[]` for every service while `/manifest` listed
them correctly.

**`pipelines(appHooks)` is the one owner.** Gone: `_pipelines`,
`_compiledPipelines`, its hand invalidation, the four writers, the registry's
`hooks()` monkey-patch, and the three-way ladder in `callService` where the cache
**outranked the app hooks the transport had just passed**. The memo is keyed on
both inputs — the app map by identity, the service's own by a version `hooks()`
bumps — so a stale answer is unreachable rather than remembered, and a call now
always runs the hooks it was handed. One `svc.hooks()` call used to merge and
resolve twice and pass through `undefined` in between; it merges once now.

One hazard worth knowing: `app.hooks()` REASSIGNS `app._appHooks` rather than
mutating it, which is what makes identity a sound key. Anything that starts
mutating it in place defeats the memo silently.

**A built service is marked** — `Symbol.for('junction.service')`, non-enumerable,
and `createService` returns an already-marked object unchanged. The autoloader
tests the marker instead of asking `typeof service.hooks !== 'function'`, which
answered *was this built?* by inspecting one field's type. Non-enumerable
matters: `{...svc}` is a copy of the fields, not a service, and it is correctly
seen as unbuilt.

**Breaking, internals only:** `Service._pipelines` and `Service._compiledPipelines`
are gone; `Service` no longer has an index signature, so `svc.someAction` needs a
cast in TypeScript (`ServiceDefinition` keeps its signature — you *write* actions
there). Nothing outside this package read either field.

Typecheck baseline **211 → 199**, most of it one deleted line: an index signature
made `keyof Service` `string | number`, so `Omit<Service, …>` collapsed and every
`base.find` read as `unknown`.

Verified: junction 991 · testing 23 · conduit 193 · auth 88 · cli 363+25 ·
`example` verify 37 / live 14 / jobs 8 · `basecamp` verify 271/271.

## 2026-08-13 — three things you could not ask for

**The browser client can ask for a relation.** `FindParams` gained `populate`,
emitted as `$populate` on the query string and on the WebSocket frame alike.
The wire and the server had supported it from the start — the bridge parsed it,
the service destructured `include` — so the only thing missing was the way to
say it, which meant a component could not declare its own data shape and
over-fetching was a decision made server-side in a hook. The server's spelling
travels unchanged (`'customer'`, `['a','b']`, `'customer:name+email'`), so there
is one grammar rather than a client dialect. A by-id `get` carries `params` too;
they used to be accepted and dropped on that path. `FJS-084`.

**`buildRoutes(app)` and the routes half of `/manifest`.** The HTTP surface is
emergent — services auto-mount, plugins register their own — and `hasRoute()`
answers a matching question, so *what is actually mounted* had no cheap answer.
`buildRoutes` reads the router rather than rebuilding from the registry, and
splits the auto-mounted `{service}` templates from everything a plugin or the
app registered. `fli api:routes` is the caller. `FJS-091`.

It found a defect on its first run against a scaffolded app: two identical
`OPTIONS /*` routes, because the scaffold configured CORS by hand *and* through
`config.http.cors`. `FJS-225`.

**`IEventBus.stats()`** — `{ events: Record<string, number>, total }`, beside
`hasListeners` rather than replacing it. A yes/no is the wrong resolution for
anyone chasing a missing announcement, and the handler map is closure-private,
so nothing could count subscribers. An event whose last handler unsubscribed is
omitted rather than reported as zero. `FJS-143`.

**Documented rather than fixed:** `after` means after the METHOD, not after the
call succeeded. A later `after` hook throwing makes the call report failure with
an earlier hook's email already sent, and there is no commit-scoped phase to put
the effect in. README and `CLAUDE.md` now say so, with the two workarounds.
`FJS-089` stays open for the phase itself.

## 2026-08-13 — one owner for `apiPrefix`; an Idempotency-Key means something; a `$defs` miss is audible

Three things that read as handled and were not.

**`apiPrefix` moves every route the app registers, not just the service ones.**
It used to be applied by `registerServiceRoutes` alone, so a plugin's
`app.get()` landed at the root while the services beside it moved. Four plugins
in this package hand-resolved `app.config.apiPrefix` to compensate;
`@frontierjs/auth` did not, and an app under `/api` therefore served its login
at `/auth` — with the browser client's default looking for it under the prefix,
so the two ends never met. The shortcuts (`get/post/put/patch/delete`) now apply
it, `registerServiceRoutes` registers bare `/{service}` paths like every other
caller, and the four copies are gone. A route that must sit at a fixed path —
somebody else's callback URL, a probe path an orchestrator owns — is registered
on `app.http.router` directly, the layer beneath the shortcuts, which applies
nothing. The client's `authPrefix` composes with `apiPrefix` for the same
reason the plugin's `prefix` option does. `FJS-012`.

This moves paths in any app that sets a prefix, which is the fix rather than a
side effect of it: `example` now serves `/api/auth/login`, `/api/session`,
`/api/jobs` and `/api/health`, and one vite proxy entry replaced four.

**An `Idempotency-Key` executes once.** The header was parsed into request
metadata and consumed by nothing, so a double-submitted create ran twice while
carrying the value that says not to — and Conduit spends the opposite side of
the same contract outbound, asking other people's APIs for a guarantee this one
advertised and did not provide. `core/idempotency.ts` claims the key in
`callService`, the one path every transport takes, so a repeat replays the first
answer without running the pipeline: no second hook, no second write, no second
announcement. Scoped to `(service, method, principal, key)` — replay skips the
pipeline and therefore the auth checks in it, so a key shared across principals
would hand one caller another's answer. A **failed** call releases its key,
because a failed request is one the caller may retry; a duplicate arriving while
the first is still running is a **retryable** 409 rather than a second parallel
execution. `config.idempotency` (`enabled`/`ttl`/`pendingTtl`) is on by default
and inert unless a caller sends a key. `FJS-088`.

The in-flight marker carries its own short TTL. It is the one entry nothing is
guaranteed to clear — a throw between the claim and the settle would otherwise
leave a key answering 409 for a day, turning one failure into a caller who can
never retry.

**The WebSocket path establishes request metadata at all.** It wrapped nothing
in `runWithMeta`, so `requestMeta()` was `undefined` for every socket call and
the correlation id was as HTTP-only as the idempotency key. Both now ride the
frame's `meta`, beside the id and the workspace.

**A model service with no field rules says so.** `autoValidate` stored `null`
for a `$defs` miss — and for a definition that would not compile — and said
nothing either way, so a service accepted unvalidated input in silence while the
schema declared `@email`, `@length` and `@gte`. It warns once per model now,
naming the service, the spellings tried and the compiler's own message. Only
when the accessor does resolve to a table: a service with no model at all is a
supported shape, and `getTable` already names every spelling when an unused CRUD
method is called on one. `FJS-013`.

## 2026-08-12 — `ctx.id` is a string on both transports

Over HTTP the id is a path segment and can only ever be a string. Over the socket
it rides a JSON frame, so `patch(42, …)` handed a service the number `42` while
`PATCH /leads/42` handed it `'42'`. A handler comparing `ctx.id` to a row's own
id, or using it as a Map key, answered differently depending on whether a socket
was connected — and the browser client prefers the socket whenever one is up, so
the same code is correct in dev and wrong in production, or the reverse. The WS
handler now matches the transport that has no choice. `FJS-197`.

Found by `@frontierjs/testing`'s `verifyTransportParity()` on its first run
against a custom action, which is the one method shape the derived call set does
not cover.

## 2026-08-12 — a thrown status keeps its status, and a test server can bind port 0

`fromStatusCode` mapped fourteen codes to error classes and everything else to
`GeneralError`, whose `code` is 500. So an app throwing `{ status: 423 }` or
`{ status: 451 }` got a server error on the wire — not a narrower answer but a
different category, where the client stops retrying and the 5xx pages someone for
a refusal the app stated deliberately. An unmapped code in 400–599 now keeps its
status and loses only the class name, which is the part nothing on the wire reads.
`FJS-196`. It survived because every error junction itself throws has a class.

`http.start(port?)` and `http.port`. The argument overrides the configured port
for one bind and leaves configuration untouched; the getter reads back what was
bound. Together they are how a caller asks for **port 0** — an OS-chosen free
port — which is what makes a test server parallel-safe, and without the getter
there is no way to learn which port that was. `@frontierjs/testing`'s
`listen: true` is the first caller.

## 2026-08-11 — `autoSort`: an unknown `$orderBy` key is a 400, not an unsorted 200

`autoFilter`'s sibling, closing the quieter half of the same failure. An unknown
filter key at least answered an empty list, which a caller eventually notices;
an unknown sort key answered the **right rows in their original order** and said
nothing anywhere — no error, no warning, not even on the server, because the key
was quoted into SQL and resolved against the SELECT aliases, finding nothing. A
caller cannot see a sort that did not happen, so page 2 of a "sorted" list is
plausible and wrong.

```
GET /products?$orderBy=-bogusColumn   → 200, unsorted, silent
GET /products?$orderBy=shoutName      → 200, unsorted, silent  (a @computed field)
```

Both are now 400. Same division of labour as `autoFilter`: litestone's new
`db.$checkOrderBy` keeps the one definition of what is sortable, Junction
contributes the status code. The two refusals stay distinct — a field that does
not exist gets the typo suggestion litestone already computes, a `@computed`
field is told it cannot be sorted at all — because a caller can act on the
difference. A `@from` field sorts; it is SQL, not a JS function.

Installed on `find` beside `autoFilter`. A client that cannot answer the probe
no-ops rather than 500s, the same contract and for the same reason as
`FJS-117` — reading an unknown property off a Litestone client throws.

## 2026-08-10 — published to npm as `@frontierjs/junction@0.1.0`

Live on the registry, tag `latest`, public. Four manifest gaps closed first,
each of which fails at a different moment:

- **`publishConfig.access: "public"`** — a scoped package defaults to restricted,
  so the *first* publish of `@frontierjs/*` fails on payment rather than on
  anything about the code.
- **`files`** — the tarball was 131 files and 464 kB, carrying `tests/`,
  `example/`, `bun.lock`, `tsconfig.json` and the three state markdowns. Now 64
  files and 281 kB: `index.ts`, `src/`, `tools/` minus the seven repo-internal
  `check-*.mjs` audits, README and LICENSE. The bin needs `init.ts`, `setup.ts`,
  `repl.ts` and `build-app.ts` beside it, which is why `tools/` ships at all.
- **`LICENSE`** — the manifest said MIT and no file said anything.
- **`repository`** with `directory: "packages/junction"`, the monorepo form.

**Bun-only, and there is no version of this package that is not.** Node refuses
to strip types inside `node_modules`, so the import fails outright — and
compiling to JS would only move the failure later, because the transport is
`Bun.serve`, logging and static files are `Bun.file`, and cache and database
import `bun:sqlite`. `engines` already said so; the README now says it in the
first paragraph a reader arriving from npm will see, and that Quick start no
longer opens with `git clone <this repo>`.

Verified against the published artefact rather than the tree: **all 29 declared
subpath exports import from an installed copy** (the 29th, `/auth`, is
types-only, so zero runtime exports is the right answer), and the `junction` bin
runs from `node_modules/.bin`. 919 tests unchanged.

**This unblocks `@frontierjs/auth`** — it declares junction as a peer, and its
`FJS-003` fix was verifiable but unshippable while the peer was a 404. A `bun
add` of the auth tarball into an empty project now resolves junction from the
registry and imports.

## 2026-08-10 — a load that has been overtaken no longer writes the store

Closes `FJS-082`. `resource().load()` was one unconditional line — read rows,
set the store — so two overlapping loads landed in arrival order. A
search-as-you-type box typing `ac` and then `acme` showed the results for `ac`
whenever the first request was the slower one, and stayed there until the next
keystroke. Nothing threw and nothing logged.

A load is stamped when it is issued, and only the newest stamp may write the
store. The superseded request is not cancelled and its own caller still gets its
rows back: the ordering problem belongs to the shared store, not to whoever
awaited the call. `service.find()` is unchanged — it returns rows and has never
touched the store.

919 tests (was 916). The three new ones make the earlier request the slower one,
which is the only arrangement that fails.

## 2026-08-10 — a dropped WebSocket frame is held and re-sent, not lost

Bun's `ws.send()` returns the bytes written, `-1` when the frame was buffered
under backpressure, and **`0` when it was discarded**. Junction ignored that
number at all five send sites, and the `BunWS` type declared `send` as returning
`void`, so no call site could have read it.

A dropped `service_result` left the caller's promise pending until its own 30s
timeout: no error, no close, nothing logged, and a screen sitting on "Loading…"
while the server believed it had answered. A dropped `event` frame is quieter —
nothing is waiting on it, so the row is never updated and every open tab is
stale. Measured on one socket with 200 concurrent reads of a ~1MB payload: 193
never settled, and a call issued afterwards answered in 34ms, which is what makes
it read as *the socket is fine*.

`transport/send-queue.ts` is now the one owner of *put this frame on that socket*:
send, hold what was dropped, flush on `drain`. Once anything is held everything
queues behind it — a frame that jumps the queue arrives before one sent earlier,
and an event stream that reorders is worse than one that pauses. The queue is
bounded by `http.wsMaxQueued` (default 8MB); past the cap the socket is closed
with 1013, the client rejects every in-flight call and reconnects, and a consumer
that cannot keep up is told rather than quietly served nothing.

**No knob for Bun's own buffer.** `maxBackpressureLimit` is accepted and ignored
— measured on 1.3.11, a 64KB, a 1MB and a 16MB limit all start dropping at the
same ~16.9MB — so exposing it would be a control that changes nothing.

Found while probing `FJS-139` (a reload from a channel subscriber that does not
settle) and filed as `FJS-145`. It has that defect's exact signature but does not
explain its volume — three small agent reports are nowhere near 16.9MB. FJS-139
is closed separately, as not reproducible: its only reproduction turned out to be
masked inside the drive that found it, and with the mask removed basecamp passes
262/262 three runs consecutively. Which change stopped it is not known, and the
register says so rather than claiming this one did.

8 tests, both halves mutation-verified — the integration case delivers 200 of
200 frames with the send queue and 98 of 200 without it. 905 pass.

## 2026-08-10 — the METHOD decides list vs single, not the shape

`wrapResult` guessed. Any `{ data, total }` was read as a paginated list and
rebuilt from `total`/`limit`/`offset`/`data`/`errors`, whatever method produced
it. One guess, two silent failures, closed together:

- **`FJS-140`** — an action answering rows **plus** a summary lost the summary.
  `dashboards.kinds` returned `{ total, data, statSources, portalServices }`;
  the browser got the nine kinds and neither vocabulary needed to render them,
  so the picker offered widgets it could not fill in. 200, no word.
- **`FJS-144`** — a `find` answering one object was wrapped as a `single`, which
  the browser client then read as an EMPTY list. A screen rendering nothing
  while the API was correct — visible only from a browser.

`wrapResult(raw, object, method)` now reads:

    find             → a list, or ResultShapeError
    { data, errors } → a list, any method — the bulk partial-write protocol
    Array            → a list
    anything else    → a single, which unwraps whole and loses nothing

So an action keeps everything it answers, and the one method that promises a
list is the one that has to produce one. `data` must be an ARRAY to be a list:
`{ data: {…}, total: 3 }` used to pass `isListResult()` and reach the browser as
a list nothing could iterate.

`ResultShapeError` (exported from `core/envelope.ts` and re-exported by the
client, `status` 500) names the service, the method, what arrived — `typeof` for
a primitive, the key list for an object — and any keys a list envelope cannot
carry. **The browser client asks the same function**, as `find`, instead of
carrying a hand-copy of the rule; that copy is how the two ends drifted apart in
the first place. A find answering `null` throws too — a 204 is not an empty page,
and over the wire the two are indistinguishable.

Not gated on a dev flag: the browser has none it can trust, and a dev-only throw
leaves production with exactly the silent failure being removed. An app that was
already broken pays a loud error; a correct app pays nothing.

Blast radius, checked rather than assumed: ~15 list-shaped ACTIONS in basecamp
become singles, which reach the browser as the same `{ total, limit, offset,
data }` minus the wrapper — every consumer in the repo reads `.data`/`.total` or
`Array.isArray(raw) ? raw : raw?.data`, and nothing reads `envelope.kind`. Every
model `find` (Litestone's base, basecamp's `findScoped`) already answers exactly
the allowed keys. `kind` and `object` are allowed keys so that a pre-`kind`
envelope from an older server is still accepted by the client.

13 tests; 897 pass.

## 2026-08-09 — `SessionContext.credentialId`

One additive field on the interface, for the auth-provider side of `FJS-135`.
An API-key session says which user it is and, now, which credential proved it.
Without it two keys belonging to one person produce sessions that are
identical, so nothing can record per-key usage, show a key's last-used time, or
hold one key to a limit the other does not have.

Set on the `apiKey` path only; a session token leaves it absent.
`@frontierjs/auth` fills it in — see that package's CHANGES for the three
defects this was part of fixing, none of which were in Junction.

Also worth knowing, and not changed here: **the HTTP transport resolves every
Bearer token through `auth.verifySession()` and calls `IAuth.verifyApiKey`
nowhere.** That is why an issued key authenticated nothing until a provider
learned to fall through. If a third provider is ever written, that fall-through
is its job too — `transport/http.ts:385` is the only door.

## 2026-08-08 — a collection-level custom action was unreachable from the browser

The bridge dispatches on the `X-Service-Method` header **before** it looks at
`params.id`, so the server has always accepted an action about a whole service
rather than one row. The browser client interpolated the id unconditionally, so
the only way to reach one was to invent a throwaway id and post to
`/{service}/null`.

`action(name, id?, data?, query?)` now posts to the service root when `id` is
null or omitted, and carries a plain filter query: `?limit=50`, not the
`$`-prefixed directive syntax `buildQueryString` emits. An action declares its
own query vocabulary; the bridge still splits `$` keys off as directives if a
caller uses them. Values that are null are dropped rather than sent as the
string `"null"`.

Found writing basecamp's fleet-wide event feed (`servers.feed`) and its flag
`resolve` — neither has a subject row to name. 4 tests; 884 pass.

## 2026-08-06 — a capability probe must survive a client that throws

880 tests (was 879). The junction half of `FJS-117`.

`autoFilter` guarded itself with

```ts
if (typeof client?.$checkWhere !== 'function') return
```

which reads as a safe feature test and is not one here. **A Litestone client
throws on an unknown property** rather than answering `undefined` — deliberately,
so a typo'd accessor is loud — so that line is a throwing expression, and it sat
just *outside* the `try` guarding the call it protects. When `$checkWhere` turned
out to be missing from the scoped proxies, every list read by a signed-in caller
became a 500 complaining about a table nobody had written.

Litestone was fixed (it now answers on every flavour of client). This side is
fixed too, and independently: `db` is whatever the app handed `createApp`, and a
stand-in that cannot answer the question must **no-op**, not take down the
request. The probe now reads inside a `try`, and the call goes through the
captured reference rather than a second property read.

## 2026-08-06 — an unknown filter key is a 400

879 tests (was 871). Closes `FJS-109`.

```
GET /products?bogusColumn=7   →  200 {"data":[],"total":0}
GET /products?limit=100       →  200 {"data":[],"total":0}     ← belongs on $limit
GET /products                 →  200 {"data":[],"total":0}     ← genuinely empty
```

Three situations, one answer, no error. It cost an hour in `example/`'s
prerendered catalogue, which fetched, resolved, rendered "0 of 0 products" and
reported nothing wrong.

**Litestone knew the whole time.** It validates where-keys, rejects them on
writes, and on reads prints `Unknown field 'bogusColumn' … Valid fields: id,
name` — to the server's stderr, invisible to whoever typed it.

So `autoFilter` asks rather than re-deriving: `db.$checkWhere(accessor, where)`
keeps one definition of the rule, and Junction contributes only the status code.
Exactly the division `gateAuth` already makes with `@@gate`. Re-deriving it here
against JSON Schema would have drifted on relation sub-filters, `$raw`, edges and
the AND/OR/NOT descent.

The message names **every** bad key, not the first — a caller fixing a filter one
round trip at a time is what the silent 200 already put them through — plus the
typo suggestion, the filterable fields, and the directives it was probably meant
to be:

```
Unknown filter key 'nme' — did you mean 'name'?. Filterable fields on product:
id, name, price. Paging and sorting are directives, not filters — use $limit,
$offset, $orderBy, $select.
```

What does NOT trip it: `$or`/`$and`/`$not` (structure), a real directive (the
bridge has already split those off, Invariant 10), and an operator filter — the
browser client serializes `{price:{$gte:1}}` as `?price={"$gte":1}`, so the key
stays a column. A client without `$checkWhere` no-ops: *I cannot judge this* is
not *this is wrong*.

Two existing tests asserted on the **length** of a compiled `before` list and
broke on the second derived hook. Both now filter the exported `DERIVED_HOOKS`,
which is what their own comments already said they wanted — one of them in as
many words.

Worth knowing: `?price[$gte]=1` now 400s. It never worked — `rawQuery` is flat,
Junction has no bracket parsing — it just used to fail as an empty page.

## 2026-08-06 — the "model not found" message lists models

871 tests (was 869).

`getTable`'s failure message ends with *Available: …*, and it had never once
printed a list. It built one with `Object.keys(scopedDb)`, and a real Litestone
client's proxy threw on that (`FJS-014`, fixed the same day) — so the `try/catch`
around it swallowed the throw and the message silently degraded to no list, at
the moment a caller most needs one.

With enumeration working the list appeared and was **wrong**: `Available:
asSystem, author, post, query, sql`. Dropping `$`-prefixed names cannot tell a
model from a method. It now filters against `$schema.models`, using Invariant 2 —
the accessor is the model name with a lowercase first letter — so the test is
exact rather than a guess about which names look like tables.

The `try/catch` stays. `db` is whatever the app handed to `createApp`, and a
stand-in that refuses to enumerate must not turn *your model name is wrong* into
a stack trace. Its comment no longer claims Litestone is the reason.

Two tests, and they use a **real** Litestone client: every existing test in that
file used a plain object, which is precisely why the list went unverified for
four days.

## 2026-08-06 — `retryable` reaches the client

869 tests (was 866).

A status cannot say whether repeating a request could work, and a 409 is the case
where that matters most. Litestone throws two: `VersionConflictError` and
`TransitionConflictError` are races — re-read and re-apply — while
`TransitionViolationError` is a domain refusal whose own message is the right
thing to show. All three arrived as an identical `Conflict`, so a client had to
phrase every one as the weaker of the two, turning *this can never be legal* into
*try again*.

Both litestone classes already declared `retryable`; it stopped at the boundary.
`toFrameworkError` now adopts it alongside `status`, and `FrameworkError.toJSON`
serializes it **only when the originating error declared one** — an absent flag
stays absent rather than becoming a `false` that claims knowledge. Both transports
land it at `err.data.retryable`; sierra's `isStaleWrite()` is the reader.

Same contract as `status`: if you own the error class, set the field. No mapper,
no registration.

## 2026-08-06 — a session now reaches the Data boundary with an `id`

866 tests (was 842 — 24 new across `data-principal`, `patch-defaults` and
`method-policy`). Typecheck unchanged at 212.

### Row policies matched nothing, for every Junction caller

`SessionContext` names the caller `userId`. Litestone's policy language reads
`auth().id` — its documented spelling, the one `@default(auth().id)` and every
`@@allow` example in its docs use. `$setAuth(ctx.auth.user)` handed the Data
boundary a principal with **no `id`**, so:

```litestone
@@allow('read', userId == auth().id)
```

compared a column to `undefined` and matched nothing. No error, no warning — an
empty list, which reads as "there is no data" rather than "the policy could not
see who is asking".

**Gates were fine**, because `sessionGateLevel()` was written against Junction's
shape. So the translated half worked and the untranslated half failed quietly,
which is why this survived: an app with `@@gate` and no `@@allow` never notices.

New: `toDataPrincipal(user)` — the one owner of that translation, applied at both
`$setAuth` call sites (`withLitestoneDb` and `getTable`). Sibling of
`sessionGateLevel()`: same boundary, same direction, one for the ordinal gate and
one for the policy predicate. Everything else passes through by name; an explicit
`id` wins, so a caller already speaking Litestone's shape is untouched.

Found by `example/`, where a signed-in user's own notifications were invisible to
them and plainly there under `asSystem()`. It went on to uncover a second defect
it had been masking — see litestone's `CHANGES.md` for the audit log's `actorId`.

### A PATCH no longer invents values for absent keys

`jsonSchemaToJunctionSchema(model, schema, 'update')` dropped required-ness and
kept every field's `default`, and `validate()` fills a default in for any absent
key — so `PATCH /orders/3 {"note":"x"}` reached the model as a whole record. On
an ordinary column that silently reset it; on a column under `@@transitions` it
answered `409 Cannot transition order.status from 'shipped' to 'pending'`, which
reads as a broken state machine and is not one. Found by a Caravan job writing a
tracking code onto a shipped order.

### `methods:` works on both factories

The allow-list was read by `createService` and neither read nor forwarded by
`createBaseService` — the factory the loader is built around. So the same
`methods: 'readOnly'` that makes an audit trail append-only through one factory
did nothing at all through the other, and the only symptom was a write that
succeeded. It is carried through now and resolved in the one place that
validates it against the actions that exist.


## 2026-08-06 — the transport can resolve a session from a cookie

854 tests (was 842 — 12 new in `tests/auth-cookie.test.ts`). Typecheck unchanged
at 212.

`extractToken()` read only `authorization: Bearer` and `x-api-key`. So
@frontierjs/auth's documented `cookieAuth: true` set an httpOnly cookie that
**nothing ever read back**: `ctx.user` stayed null and a cookie-only request to
any protected route — including auth's own `GET /auth/me` — was 401. The mode
handed you a session you could not use. `ISSUES.md` FJS-002.

```ts
app.http.setAuthCookie('session')   // now reads it, alongside Bearer / x-api-key
```

### Off by default, and that is a security decision

Not caution about breaking things. A Bearer token has to be attached by script,
so a cross-site request cannot forge one. A cookie is attached by the browser
automatically, which is what makes CSRF possible at all — so an app takes that
exposure deliberately or not at all. What makes it safe when taken is the
`SameSite=Lax` @frontierjs/auth sets: the browser withholds the cookie from
cross-site POST/PUT/PATCH/DELETE, and those are the requests that change
something. An app that sets its own session cookie `SameSite=None` re-opens the
hole and Junction cannot tell.

### One switch, not two

The auth plugin calls `setAuthCookie('session')` from its own `register()`, so
`cookieAuth: true` simply works. Making the app *also* write
`config.auth.cookie` would have left a half-configured state that reproduces the
original bug exactly — cookie set, cookie ignored. `config.auth.cookie` remains
the path for a hand-rolled `IAuth` that issues its own cookie and has no plugin
to declare it.

### Also

- **Explicit beats ambient.** Bearer and `x-api-key` both win over the cookie, so
  "act as someone else for this one call" stays possible from a browser that is
  holding a session cookie.
- **The WebSocket upgrade reads it too.** The upgrade is an ordinary browser
  request and carries the cookie; without this a cookie-authenticated app
  connected its socket **anonymously** and every user-scoped channel stayed
  silent — with no error anywhere, because an unauthenticated socket is a legal
  state.
- **An emptied cookie is not a token.** `clearCookie()` leaves `session=` with
  `Max-Age=0`; treating `''` as a token would fire a guaranteed-failing
  `verifySession` on every request after sign-out.

7 of the 12 tests fail if the cookie branch is removed. The auth package's marker
test — `KNOWN GAP: a cookie alone does not authenticate a request`, asserting
401 — is now `a cookie alone authenticates a request`, asserting 200.

## 2026-08-06 — a custom action announces, like any other write

836 tests (was 830 — 6 new in `tests/event-origin.test.ts`). Typecheck unchanged
at 212.

An action changed a row and told nobody. `callService`'s announcement block was
gated on `AUTO_EVENT_MAP[method]`, which holds only the five CRUD writes, so
`POST /orders/4` + `X-Service-Method: pay` published nothing — not to the
channel, not to the in-process bus.

**Both halves of the seam already existed.** The browser client has listened for
action events since it was written:

```ts
// client/index.ts — "Custom action events (e.g. 'moved', 'archived') — treat
// as upserts. The server publishes them with the updated record, same as patch."
svc.on('*', (method, raw) => { … store.upsert(unwrap(raw), idField) })
```

The server never sent one. The client was waiting for post nobody was posting.

```ts
const eventName = AUTO_EVENT_MAP[method] ?? (isAction ? method : undefined)
```

An action announces under its **own** name — `orders pay`, no past tense
invented for it, matching what `publish()`'s hook form has always put on the
wire. Reads are excluded by name (`find`, `get`); an action that only reads
(search, stats, export) opts out with `ctx.dispatch = false`, the one existing
switch, which suppresses both consumers.

**Why it stayed invisible.** Every app re-issued `find()` after an action, so
the acting tab looked correct and every *other* tab went stale in silence.
Found by `example/web/test/verify-live.mjs`, a drive whose watcher tab is signed
out and never acts: it saw `orders created` and `orders removed` cross the
socket and no `pay` between them, while the row it was rendering silently kept
saying `pending`. Reverting the one line above fails 4 of its 12 assertions.
The example's orders table dropped its refetch and re-grades from the broadcast.

Recorded as [FJS-D21](../../DECISIONS.md).

## 2026-08-06 — a service can say what it does not answer (`methods:`)

830 tests (was 809). Typecheck unchanged at 212.

`createService({ model })` answered every CRUD verb through the base **with
validation**, whether or not the file declared one. Declaring only `find()` did
not make a service read-only — it made the writes invisible. Basecamp's `/audit`
is an append-only trail and an admin could `POST` a forged row into it, verified
over HTTP, and the only defence was four hand-written `MethodNotAllowed` stubs
per service. Opt-out safety, with no warning that you had not opted out.

One key, two forms:

```ts
createService({ name: 'audit', model: 'AuditEvent', methods: 'readOnly' })
createService({ name: 'tickets', methods: ['find', 'create', 'approve'] })
```

Absent means everything, so no existing service changes.

The allow-list is the general form because a narrower method set is not only
ever "read only" — the second example says *no patch, no remove, one action*,
which a boolean cannot express. `'readOnly'` is sugar on the same key rather
than a second option.

**Where the check lives is the point.** It is in `callService`, ahead of the
hook pipeline, because that is the one path every caller takes: an in-process
`app.service('audit').create()` is refused exactly as the wire is. A policy
enforced in the transport would have left jobs, engines and hooks — which is how
an audit trail actually gets written — free to do what a request cannot. Ahead
of hooks because the policy is structural rather than authorization, so there is
nothing an identity could change and no reason to run a `before` hook's side
effects for an impossible call. Accepted consequence: an anonymous caller now
gets 405 where it used to get 401.

Also:

- CRUD and actions share one list. Being *defined* is not being *offered*.
- An unknown name throws at construction — `['find','gett']` would otherwise
  silently block `get` and only read as broken after a 405 in production.
- `/manifest`, `/metrics` and the OpenAPI spec filter by the same predicate, so
  what a service answers and what it advertises cannot drift. `/manifest` also
  stops omitting `update`, which its hardcoded CRUD list had dropped.

21 tests in `tests/method-policy.test.ts`; **7 fail if the enforcement is
removed**. Ruled as `FJS-D07`, closes `FJS-004`, `DECISIONS.md` § API design.

## 2026-08-06 — a service_error frame dropped the field list

809 tests (was 806).

The server answers a failed WS service call with `FrameworkError.toJSON()` —
`{ name, message, code, data }` — and `data` is where a validation failure's
per-field list lives. The client took `message` and `code` and dropped the rest,
so the same 400 carried field errors over HTTP and nothing but a joined sentence
over the socket.

**WebSocket is the default transport**, so that was the shape a form saw in
production while the HTTP fallback it was developed against looked correct. The
rejection now carries `data`, shaped to match the HTTP path exactly (the parsed
error body goes on `.data`, so `err.data.data` is the list in both) — which is
what lets one unwrapper, sierra's `toFieldErrors`, serve both transports.

3 tests in `client-ws-errors.test.ts`, driving the real `onmessage` handler
rather than resolving the pending call by hand.

## 2026-08-04 — the client's transport rule, actually applied

803 tests (was 796).

The documented rule is in this package's README: *"CRUD methods prefer WebSocket
when connected, fall back to HTTP automatically. File uploads always use HTTP."*
WebSockets are the default when one is available; HTTP is the fallback. Two
methods did not follow it, and the fallback had a hole with no bottom.

**`action()` and `restore()` were unconditionally HTTP.** `find`, `get`,
`create`, `patch` and `remove` all check `_wsReady` first; those two never did,
which made a custom action the only service call that ignored a live connection.
The WS handler dispatches any method name generically — it passes `method`
straight to `bridge.internal` — so there was never a reason for the exception.
Both now prefer the socket. `action()` also honours the file exception, because
multipart cannot travel over it.

**The HTTP fallback recursed forever.** `_httpFallback`'s `default` branch
called `svc.call()`, which is `_wsCall()`, which routes back to `_httpFallback`
when the socket is down. A custom action with no connection bounced between the
two indefinitely — asynchronously, so no stack overflow ever pointed at it and
the call simply never settled. The default branch now calls `action()`, the HTTP
form of a custom action, and `restore` gained its own case.

Seven tests in `tests/client-transport.test.ts`, half of them on the no-socket
path. Verified in `example/` over CDP as well: clicking a transition button with
the socket up sends `orders.pay` as a WS frame and makes **zero** HTTP POSTs.

The README's dispatch-by-header section said what the HTTP form looks like
without saying it was the fallback; it now says both.

## 2026-08-04 — autoValidate says the sentence the schema declared

796 tests (was 787).

`FieldDef` gains `label` and `messages`, read from JSON Schema `title` and
`x-messages`. Every generated message in `core/schema.ts` now consults the
authored wording for the keyword that failed, and builds its fallback from the
label rather than the column name.

The point is that Sierra's `field-rules.js` does exactly the same thing from
exactly the same document. If these two disagreed the user would get one
message before the request and a different one after it — worse than either
alone. `tests/field-messages.test.ts` and
`packages/sierra/tests/field-messages.test.js` are deliberately the same
fixtures and the same expectations.

Presentation is read off the FIELD's own schema, never a `$ref` target:
Litestone titles every enum `$def` with the type name, so following the ref
would make `status OrderStatus` report itself as "OrderStatus". `mapProp` is
now a thin wrapper that attaches label/messages from the raw property around
the existing resolver.

## 2026-08-04 — the startup banner reports the Data realm

787 tests (was 781). Additive; no behaviour change to any request path.

`createApp()`'s banner covered routes, services, health and docs, and said
nothing about the database. "Is Litestone actually loaded, and against which
file?" had no answer short of issuing a request and seeing what came back.

It now prints a second line in the same startup phase:

```
INFO 🚀 shop v1.0.0     {"url":"…","routes":22,"services":3,"prefix":"/api",…}
INFO 🗄  litestone       {"models":8,"enums":1,"gated":"7/8",
                         "databases":"main → ./db/shop.db (sqlite), audit → ./db/audit (logger)"}
```

Four fields, each earning its place:

- **models / enums** — the shortest honest answer to "did the seed parse".
- **gated** as `n/total` — a schema reading `0/24` is one whose access control
  is not declared. Worth seeing daily rather than discovering in an audit.
- **databases** — name → **resolved** path and driver. This is the one that
  pays for the line: a schema declaring `database main { path … }` silently
  overrides `createClient`'s `db:` option, so the file being written is not
  always the file that was passed. Printing the resolved path makes that
  visible at boot instead of three confusing test runs later. (Verified in both
  directions — `example/` declares a path and shows it; `sierra/example` passes
  `db: ':memory:'` with no declaration and shows `:memory:`.)

`describeDataRealm()` lives in `core/litestone.ts`, beside the rest of the
Data↔API seam. It is entirely duck-typed and returns `null` — no line — for
anything that is not a Litestone client, including a raw `bun:sqlite` handle.
It also catches: `createApp({ db })` accepts Proxy-based clients that *throw*
on unknown property access (Litestone's own scoped proxy does exactly that),
and a banner helper that throws would take the app down at the last startup
phase, after the port is already open. Six tests in
`tests/describe-data-realm.test.ts`, four of them on that failure path.

Newest first. Everything below the 2026-08-02 block was applied during the
2026-07-25/26 FrontierJS pass, against the archive dated 2026-07-26
(`_built: 2026-05-27`).

## 2026-08-02 — the error boundary is extensible

`src/core/errors.ts`. `toFrameworkError()` is the single point where a thrown
value becomes an HTTP status, and it used to recognise a **closed** world:
Junction's own `FrameworkError` subclasses plus two Litestone error names by
string. Every other package's errors fell through to `GeneralError` — a 500 for
what the thrower had modelled as a 401 or a 404.

That bit `@frontierjs/auth` and `@frontierjs/caravan` independently, and each
worked around it differently: auth wrapped every one of its own routes in a
per-route try/catch that re-mapped statuses, caravan just shipped 500s.

Recognition order is now:

1. `instanceof FrameworkError`
2. a mapper registered with **`registerErrorMapper(fn)`**
3. a numeric **`status` / `statusCode` / `code` in 400–599** on the error
4. `err.name` matching a known class name (`NotFound`, `ValidationError`,
   `AccessDeniedError`, …)
5. `GeneralError` (500)

**Rule that follows from step 3: if you own the error class, give it a
`status`.** No registration, no import of Junction — which is how auth and
caravan now map statuses while depending on nothing here. Use
`registerErrorMapper` only for errors you cannot modify, e.g. a third-party
library's.

Consequence elsewhere: auth's per-route wrapper is **gone**, and its errors map
correctly everywhere rather than only on `/auth/*`. Raw routes (`app.get` /
`app.post`) can now simply throw.

---

## 2026-08-02 — plugin contract reworked

`src/core/app.ts`. Four changes, each closing a silent failure:

- **`register` is `=> void`, not `=> Promise<void>`.** `configure()` runs it
  synchronously and never awaited it, so an async `register` had its body run
  after the app was already assembled — with nothing to say so. Async setup
  belongs in `boot()`. Returning a promise from `register` now warns at runtime,
  and its rejection still aborts `start()` rather than becoming an unhandled
  rejection.
- **`requires: ['mailer']`** declares ordering. Checked once at startup, before
  any `boot()`, against both presence *and* `configure()` order.
- **`app.provide(name, value)`** is the guarded namespace claim. It assigns the
  real property — so the `AppConduit` / `AppJobs` / `AppNotify` interface
  augmentations keep resolving — but **throws if the name is taken**, replacing
  silent last-write-wins.
- **Startup is ONE named phase list**, `runStartPhases(bindHost)`. There were
  two hand-maintained sequences numbered 0, 0a, 0b, 0c, 1, 3, 4, 4.5, 4.6, 5, 6,
  7, with the test path documented as mirroring "phases 1, 4.5, 4.6" — a subset
  that could drift from the real one without any test noticing. `start()` and
  `_startForTest()` now run the same list; phases flagged `needsHost`
  (load-config, autoload-services, listen, ready-hooks, signal-handlers,
  announce) are skipped by the test path. **Add a phase to the list, never to
  one caller.**

The plugin protocol is `{ name, register, boot, ready, shutdown, requires }`.

---

## 2026-08-02 — webhook audit: four bugs, one of them a payload leak

`src/plugins/webhooks/index.ts`.

### `findForEvent` pattern-matched on the event name

```sql
events LIKE ('%"' || ? || '"%')     -- ← the parameter is a caller-supplied event name
```

SQL `LIKE` metacharacters in the **event name** therefore matched other
subscriptions. An event named `user_created` was delivered to a hook subscribed
only to `userXcreated` (`_` matches any character), and an event named `%`
fanned out to **every registration in the table**.

That is a payload leak: a partner receives correctly-signed data for an event
they never subscribed to, and the delivery looks entirely normal at both ends.

Matching is now `json_each()` equality. **Don't reintroduce pattern matching on
a caller-supplied name.**

### `updateDelivery` used `??`, so nullable columns could never be cleared

`updates.error ?? current.error` makes an explicit `null` mean "leave it alone".
A delivery that failed once and then **succeeded on retry** kept reporting the
`HTTP 500` it had recovered from, and kept a stale `next_retry_at` — so the
delivery log said a working webhook was broken.

Use `key in updates ? updates[key] : current`. This is a shape, not a one-off:
any patch helper written with `??` has the same hole.

---

## 2026-08-02 — router: fixed and dynamic routes no longer share a keyspace

`src/transport/router.ts`. The method cache was one object, with dynamic routes
stashed under the key `'D'`. A route registered at **`/D`** normalises to
exactly `'D'` and collided: `build()` threw
`methodCache.D.push is not a function`, and `lookup()` would have returned the
bucket array as if it were a route.

The cache is now `{ fixed, dynamic }` — separate fields, no shared keyspace.
Found by a test probing `hasExactRoute`.

---

## 2026-08-02 — the startup banner advertised a `/health` that might not exist

The endpoint was always fine; the **advertisement** was fiction. The banner
asked `router.hasRoute('GET', '/health')` — which is a *matching* question:
"would a request for this path match something". Every app registers
`GET /{service}`, which matches `/health`. So every app printed a health URL
whether or not `healthPlugin()` was configured.

**`hasRoute()` is a matching question, not an existence one.** Use
`hasExactRoute(method, path)` when you mean "is this endpoint mounted", and
`routePaths(method)` to list where routes actually landed. The banner uses
`routePaths`, so `healthPlugin({ path: '/internal' })` is advertised at
`/internal` instead of being claimed at `/health`.

Fixed in the same place: `hasRoute(a) ?? hasRoute(b)` never evaluated `b` — `??`
only falls through on null/undefined and `hasRoute` returns a boolean.

---

## 2026-08-02 — `/metrics` read service keys that don't exist

`svc.actions` is not a key on a service — custom methods are ordinary
function-valued properties, and three other places already had a predicate for
that. `/metrics` reported every service as having zero custom methods, and
misreported `svc.allowBulk` the same way.

Both now go through `customMethodNames()`, the same predicate manifest and
OpenAPI use.

---

## 2026-08-02 — `app.conduit` was declared twice, and conduit always lost

Junction typed `conduit?: SomeShape` on `App` while `@frontierjs/conduit`
declared the same property in a module augmentation. **Declaration merging
requires identical types**, so the augmentation silently lost and `app.conduit`
resolved to `{}` at every call site — in the editor and in `tsc`, with the code
working perfectly at runtime.

Junction now exports an empty `interface AppConduit` and types the field
`conduit?: AppConduit` (`src/core/app.ts`); conduit augments **that interface**.

**If you add another `app.<thing>` from a plugin package, use this pattern — an
empty interface exported here, augmented there — not a property redeclaration.**
Junction's typecheck baseline dropped to **212** as a result; that is the current
number, not the 214/216/224/226 in older notes.

---

## 2026-08-02 — the dialect trap took 7 "test drift" failures with it

Junction carried 7 long-standing test failures filed as drift. They were not
drift: Junction was resolving a *registry* Litestone that still spoke
`Integer/Text/Real/Blob` while the fixtures were written in the current
`Int/String/Float/Bytes` dialect.

Junction (and auth) now take litestone as a `workspace:*` dev-dependency with a
`^1.1.0` peer, so in-repo code gets the workspace parser. All 7 pass. See
`packages/litestone/CHANGES.md` for the registry half.

---

## createBaseService now carries `name`, `hooks` and custom methods

`src/core/service.ts`.

It destructured only `{ model, db, paginate, allowBulk }` and returned the seven
CRUD methods, dropping everything else. That made the documented service shape
silently wrong:

```ts
export default createBaseService({
  name:  'leads',
  model: 'lead',
  hooks: { before: { create: [authenticate] } },   // ← discarded
})
```

It type-checked. The autoloader registered it, deriving the name from the
filename, and it served requests — with no hooks. For `authenticate` that is an
authorization hole producing no error, no warning, and a service that reads
correctly in review.

Only the spread form worked, because the loader reads hooks off the object you
export via `createService({ name: deriveName(filename), ...service })`:

```ts
export default { ...createBaseService({ model: 'lead' }), hooks: { … } }
```

Both forms work now. `name` and `hooks` are carried onto the return value, and
extra function-valued options become custom service methods — mirroring
`createLitestoneService`, which already supported all three.

Guarded against leakage: reserved keys (`model`, `name`, `hooks`, `db`,
`paginate`, `allowBulk`) are never exposed as methods. `db` in particular is a
function, so without that check it would have become callable over HTTP. And
when `name` or `hooks` are omitted, no key is added at all — an explicit
`name: undefined` would override the loader's filename-derived name with
nothing.

**New:** `tests/base-service-options.test.ts` — 10 tests. Verified against both
the old and new implementations: 3 fail before the change (`name`, `hooks`,
custom methods), all 10 pass after.

## WebSocket service calls dropped the id

`src/client/index.ts`, `src/transport/channels.ts`.

Reported from a running app, once the `channels()` plugin was registered and WS
calls actually started flowing:

```
leads.patch   websocket  ✗  Bulk patch is disabled on this service (set allowBulk: true)
leads.remove  websocket  ✗  Bulk remove is disabled on this service
leads.find    websocket  ✓
```

`find` worked; anything carrying an id did not.

The browser client wrote call extras under `params`:

```ts
const params = {}
if (id != null) params.id = id
send(JSON.stringify({ type: 'service_call', …, params, data }))
```

The server read them from `meta`:

```ts
const extraParams = (parsed.meta ?? {}) as Record<string, unknown>
const paramId     = extra?.id ?? data?.id
```

Nothing matched, so `svcCtx.id` stayed null. A CRUD method with no id is a bulk
operation by definition, so the service correctly refused it — the error was
accurate and the cause was three layers away.

`WSMessage` declares `meta` and has no `params` field, so the client was the side
in the wrong. It now sends `meta`; the server accepts either, so a client that
has not been updated keeps working.

**Why it hid for so long:** with `channels()` unregistered there is no `/ws`
route, so `_wsCall()` fell back to HTTP on every call — and over HTTP the id
travels in the URL path, which is a different code path entirely. The protocol
mismatch could only surface once the WebSocket transport was genuinely in use.
The `?? data?.id` fallback also masked it for `create`-shaped payloads that
happen to carry an id.

**New:** `tools/check-ws-protocol.mjs` — asserts both ends agree on the frame.

## createApp({ db }) — the database client is now an app option

`src/core/app.ts`, `src/core/litestone.ts`, `src/core/service.ts`.

Wiring a Litestone client used to take three steps in two files:

```ts
export const withDb = withLitestoneDb(db)        // core/hooks.ts
app.hooks({ around: { all: [withDb] } })         // app.ts
```

An option with exactly one correct answer is not an option. `createApp({ db })`
now takes the client, exposes it on `app.db`, and installs the scoping itself
when the client has `$setAuth`. Plain table-shaped clients — the ones
`createBaseService` adapts — are accepted and simply get no scoping.

`config.database.url` still works and still produces a raw bun:sqlite handle;
`opts.db` takes precedence.

### The bug this exposed: only one service factory scoped

`withLitestoneDb` seeded `ctx.locals.db` with the **root** client and left
`$setAuth` to `createLitestoneService`. `createBaseService` never called it at
all. So a service written with `createBaseService` ran unscoped, and a schema
declaring

```prisma
@@allow('read', ownerId == auth().id)
```

compared against a null `auth()` and matched nothing. The service returned empty
results and looked broken; the policy was correct. **Which factory you picked
silently decided whether your row policies worked.**

`withLitestoneDb` now does the scoping itself, so both factories get a
caller-scoped client. `createLitestoneService`'s own `$setAuth` is redundant but
harmless, and is kept for apps that seed `ctx.locals.db` by hand.

### The unscoped fallback is now an error

`createBaseService` fell back to `ctx.app.db` and wrapped it with
`adaptPlainClient()`. For a Litestone client that meant running unscoped with no
warning. It fails closed — policies match nothing rather than leaking — but it
looks like broken code rather than misconfiguration. It now throws and names the
fix.

**New:** `tools/check-app-db.mjs` — 10 checks over the option's behaviour,
including anonymous requests, plain clients, and composition with later
`app.hooks()` calls.

## createLitestoneService removed

`index.ts`, `src/core/litestone.ts`, `src/core/service.ts`.

Its last remaining reason to exist was the `schema` option, which is now on
`createBaseService`. There is one service factory.

```ts
createBaseService({ name: 'leads', model: 'lead' })                    // derived
createBaseService({ name: 'leads', model: 'lead', schema: explicit })  // explicit
```

An explicit schema **replaces** the derived validator rather than stacking with
it, and a schema with no usable definition warns and falls back rather than
throwing:

```
✓ explicit schema compiles / enforced / REPLACES derived
✓ gate auth still applies
✓ unusable schema warns, falls back to derived
```

`resolveDefsKey` is exported from `litestone.ts` so the accessor → `$defs` key
mapping has one implementation rather than the guess-at-plurals chain the old
factory used.

**New:** `tools/check-explicit-schema.mjs` (8), replacing the alias checker.

### The old split, for the record

`createBaseService` and `createLitestoneService` were parallel implementations
over the same `createLitestoneBase`. The difference was invisible at the call
site and decided real behaviour — only one scoped with `$setAuth`, only one
validated. None of the three options that seemed to justify the split were
Litestone-specific:

| option | why it was not a blocker |
|---|---|
| `idField` | plain string, already understood by the shared base |
| `softDelete` | documented as *"a Junction-side override… default: trust the schema"* |
| `cache` | `CacheDeclaration` is defined in Junction core, backed by a per-app cache |

No stubs were needed — `createBaseService` simply wasn't passing them through.

**New:** `tools/check-service-options.mjs` (13).

`src/core/service.ts`, `src/core/litestone.ts`.

`createBaseService` and `createLitestoneService` were parallel implementations
over the same `createLitestoneBase`. The difference was invisible at the call
site and decided real behaviour — only one scoped with `$setAuth`, only one
validated. Both are derived from the client now, which left the split with
nothing to justify it except three options.

None of those three were Litestone-specific:

| option | why it was not a blocker |
|---|---|
| `idField` | plain string, already understood by the shared base |
| `softDelete` | documented as *"a Junction-side override… default: trust the schema"* |
| `cache` | `CacheDeclaration` is defined in Junction core, backed by a per-app cache |

So no stubs were needed — `createBaseService` simply wasn't passing them
through. It now accepts all three and carries `_meta` for the manifest and
devtools plugins.

`createLitestoneService` is a 50-line alias. The one asymmetry kept: an explicit
`schema` replaces the derived validator rather than stacking with it, for a
service whose validation should differ from its table definition.

```
✓ softDelete / cache / idField honoured
✓ gate auth still derived
✓ validation still derived
✓ explicit schema enforced — name: name is required
```

## Authentication is derived from @@gate

`src/core/litestone.ts`, `src/core/service.ts`.

A model's `@@gate` already states the minimum level per operation:

```prisma
@@gate("4")        read/create/update/delete all require USER
@@gate("0.4")      read is public; writes require USER
@@gate("2.4.4.5")  read 2, create 4, update 4, delete 5
```

Restating that as `before: { find: [authenticate], get: [authenticate], … }` on
every service is five lines saying what one line already said. Worse, the
per-operation form **cannot** be expressed that way — a public-read model had to
either drop the hooks entirely or reject anonymous reads.

`createBaseService` now installs `gateAuth(model, op)` per method, resolved at
call time:

```
✓ gate 4:       anonymous find rejected, authenticated find passes
✓ gate 0.4:     anonymous find ALLOWED, anonymous create rejected
✓ gate 0.4.4.5: read public, delete needs auth
✓ no gate:      unrestricted
✓ plain client: no-op
```

That is "authenticate by default with public exceptions", declared once in the
schema, per operation.

### Scope: only the anonymous case is derivable

Junction's contribution is the **status code**. The Gate plugin enforces the
level at the data layer, but an anonymous request reaching that far fails as a
policy error, not a 401. This rejects it at the API boundary instead.

Whether an *authenticated* user clears level 4 depends on the app's own
`getLevel()`, which Junction cannot see — so that check stays in the data layer
where it belongs. `gateAuth` only asks "does this operation require a level
above STRANGER, and is anyone logged in?"

### Ordering

Auth runs before validation — rejecting an anonymous request costs less than
parsing its body, and it produces the more useful error:

```
anonymous + invalid data     → 401 Authentication required
authenticated + invalid data → 400 email: email must be a valid email address
```

App hooks still run first, so a service can add its own checks ahead of both.

**New:** `tools/check-gate-auth.mjs` — 11 checks across gate shapes.

## Field validation is derived from the schema, not declared

`src/core/litestone.ts`, `src/core/service.ts`.

`createLitestoneService` accepted a `schema` option and compiled it into
`before.create` / `before.patch` validation hooks. `createBaseService` had no
schema option at all — so which factory you chose silently decided whether your
field rules were enforced, the same trap as the scoping bug above.

Nothing needed to be declared. A Litestone client carries its own parsed schema
on `$schema`, so `@length(1, 200)`, `@email` and `@gte(0)` were already known.
Passing `schema: generateJsonSchema(db.$schema)` to every service was
boilerplate whose only failure mode was forgetting it.

`createBaseService` now installs `autoValidate(model, mode)` hooks that resolve
everything at call time — the client is not known when a service module is
imported. Against the real smoke-test schema:

```
✓ valid data passes
✓ rejects a bad email        — email: email must be a valid email address
✓ rejects a negative value   — value: value must be at least 0
✓ rejects an over-long name  — name: name must be at most 200 characters
✓ plain client: validation no-ops
```

`@frontierjs/litestone` is a peer dependency, so the import is dynamic and its
absence tolerated — the same approach `plugins/manifest` already uses. User
hooks run first, so a `before/create` hook can still shape `ctx.data` before it
is validated.

### The accessor / model-name mismatch is fixed properly

`generateJsonSchema` keys `$defs` by model NAME (`Lead`); services address tables
by accessor (`lead`). `createLitestoneService` used one value for both lookups
and tried `name`, `model`, `name + 's'` — so `{ name: 'leads', model: 'lead' }`
matched none of them, fell through to a `try/catch`, warned, and ran with **no
validation**. Resolution now goes through the schema's own model list, so it
holds for any naming convention rather than guessing at plurals.

### A silent-failure path I introduced, then closed

The dynamic import was originally wrapped in a bare `catch { return null }`.
That is correct when the client is not a Litestone client — but when the client
*does* carry `$schema`, validation was expected, and swallowing the error would
disable field validation app-wide with no signal. It now warns once, naming the
cause.

**New:** `tools/check-auto-validation.mjs` — 6 checks against the real
smoke-test schema.

## Types imported as values broke type-stripping runtimes

`src/transport/http.ts`.

```ts
import { serveStatic, StaticOptions } from './static.ts'
import { createStats, TransportStats } from './types.ts'
```

Both second names are interfaces. Bun transpiles TypeScript fully so it erases
them silently; a runtime that *strips* types instead leaves the import in place,
the target has no such runtime export, and the module fails to instantiate:

```
SyntaxError: The requested module './types.ts' does not provide an export
named 'TransportStats'
```

That is Node's `--experimental-strip-types`, and it is the same rule
TypeScript's own `verbatimModuleSyntax` and `isolatedModules` enforce. Any
consumer outside Bun hits it on import.

Both split into `import type`. **New:** `tools/check-type-imports.mjs` — walks
`src/`, resolves each relative import, and reports names declared only as
`interface` or `type`. Currently clean across 50 files.

## Not changed, but worth knowing

Found while wiring a fullstack app against Litestone and `@frontierjs/auth`.
Neither is Junction's bug alone, but both surface here first:

- **`createLitestoneService` conflates the Litestone accessor with the model
  name.** It derives one value and uses it for two lookups: `createLitestoneBase`
  does `scopedDb[model]`, which needs the accessor (`lead`), while
  `generateJsonSchema` keys `$defs` by `model.name` (`Lead`). Neither value
  satisfies both, and the `$defs` miss doesn't throw — it `console.warn`s and
  drops auto-validation, so a service can silently accept unvalidated input.
  `LitestoneServiceConfig` probably wants the two as separate fields.

- **Auth plugin routes don't inherit `apiPrefix`.** `registerServiceRoutes`
  applies it; plugins calling `app.post()` directly do not. `@frontierjs/auth`
  defaults to prefix `/auth`, but Junction's own browser client hardcodes
  `/api/auth/login` in `authenticate()` — so with defaults on both sides they
  never meet. Apps have to set `prefix: '/api/auth'` explicitly.
