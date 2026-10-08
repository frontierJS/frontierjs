---
id: junction-scope
status: partial
dated: 2026-10-08
---

# Idea — Junction's edge: what it owns, and what it hosts as a battery

**Status: BUILT 2026-10-08.** Dated 2026-10-08; every count in § 1–2 was
measured on the working tree that day, before the build, with a path named. All
six questions are ruled (`FJS-D639` to `FJS-D644`), the three found while
building are ruled (`FJS-D645` to `FJS-D647`), and § 3 is built. `FJS-D644`'s
measurement was taken the same day: nothing outside junction used the email
tiers, so `plugins/email/` and `./email` are deleted, and `app.mail` stays. It is
[`litestone-scope.md`](litestone-scope.md) asked of the API realm, and the
answer is longer, because junction has grown the way litestone had not: by
hosting whatever an app needed next.

## The question this answers

*What may junction grow into, so that "done" is a state the package can reach?*

A call into one application has four axes, and each has a known end in the
prior art:

- **Admission**: who is calling and whether they may — the principal, the gate
  bridge, validation, idempotency, the rate limit, the browser's origin rules
  (an auth middleware over a policy engine).
- **Call**: the service, its methods, the three hook tiers, the context, the
  envelope, the error boundary, the commit scope and what a call owes after it
  (Feathers' services and hooks; the RPC shape).
- **Carriage**: how a call arrives and leaves — HTTP and WebSocket, routing, the
  body, static files, the frame queue, a raw route, and the typed browser client
  that is the far end (an HTTP server and its client).
- **Announcement**: what a write tells whom — the in-process bus, channels,
  grading per recipient, presence, the live half of the client (Feathers and
  Phoenix channels).

What hosts the four is the **app**: `createApp`, the plugin protocol, the one
start-phase list, config, health, shutdown. The host is where every battery
attaches, so it is where the edge is lost — a battery that the host constructs
for you is one the core knows by name.

A feature on one of the four is junction's. A feature on none of them answers a
different question.

## 1. What is in `src/` and on no axis

Core (`src/core/`) is 17,711 lines, of which 5,015 is `litestone.ts`, the Data
adapter; transport is 7,030 and the client 3,336. The rest:

| Battery | Lines | Imported by the core? | Known to the core by name? | Outside callers |
| --- | --- | --- | --- | --- |
| mail: `mail/` | 1,224 | type only — `IMail` in `app.ts` | `app.mail`, `mailerPlugin` | notifications 19, basecamp 9, example 4 |
| email tiers: `plugins/email/` | 642 | no | no | none; the `./email` subpath is imported only by junction |
| scheduler: `scheduler/` | 395 | **yes** — `createApp` constructs it ([app.ts:997](../packages/junction/src/core/app.ts#L997)); `app-model` describes it; webhooks ticks on it | `app.scheduler` | basecamp 2, caravan 1; `fli check` grades its use |
| cache: `cache/` | 386 | **yes** — `createApp` constructs it; `service.ts` for `createService({ cache })`; `idempotency.ts` for the replay store | `app.cache` | none |
| workers: `workers/` | 263 | no | no | **none anywhere, junction included** |
| AI shape: `ai/` | 175 | type only — `AIRegistry` in `app.ts` | `app.ai` | orion 3 |
| a database opener: `storage/database/` | 195 | **yes** — `createApp` opens it when `config.database.url` is set ([app.ts:1011](../packages/junction/src/core/app.ts#L1011)) | `app.db`, the second way in | basecamp's `app.ts` and `seed.js`, for the handle only |
| a vendor auth adapter: `auth/providers/better-auth.ts` | 274 | no | no | junction's own example, `tools/`, one test |
| webhooks: `plugins/webhooks/` | 1,178 | no | no | none |
| OpenAPI: `plugins/openapi/` | 738 | no | no | none |
| devtools: `plugins/devtools/` | 590 | no | no | example, basecamp |
| manifest: `plugins/manifest/` | 263 | **yes** — `core/app-model.ts` imports `buildRoutes` and `serializeHookMap` from it | no | example |
| the governed extract: `plugins/export/` | 357 | no | no | example |
| metrics: `plugins/metrics/` + `core/metrics.ts` + `transport/health.ts` | 308 + 103 + 491 | `registerMetricsSource` is core | `app.registerMetricsSource`, `registerHealthCheck` | basecamp, example, sierra |
| commitments: `plugins/commitments/` | 414 | no | no | example |
| backfill: `plugins/backfill/` + `core/backfill.ts` | 263 + **465 in core** | the core half is in core | no | `fli backfill:install`, example |
| outbox: `plugins/outbox/` + `core/outbox.ts` | 237 + **609 in core** | `ctx.enqueue` is a verb on the context | no | example |
| a scaffolder: `tools/` `init`, `setup`, `generators`, `ui`, `build-app`, `repl` | 3,903 | no | the `junction` bin | **`fli` reaches none of them**; it reaches `surface`, `errors`, `jobs`, `principal`, `notifications`, `atlas` and `call` |

Three things the table shows that a reading of `index.ts` does not:

- **The host constructs four batteries for every app** — an event bus, a
  telemetry bus, a memory cache and a scheduler — and opens a database for a
  fifth. That is the *batteries vs. smallness* tendril, by construction rather
  than by drift: a battery nobody asked for is one nobody can remove.
- **The mechanism for a battery OUTSIDE the core already exists and is used
  three times.** `AppJobs`, `AppConduit` and `AppNotify` are empty interfaces a
  package augments ([app.ts:134](../packages/junction/src/core/app.ts#L134)), so
  caravan, conduit and notifications are known to the core by slot and never
  by type. Mail, AI, cache, events and the scheduler are typed by import
  instead. Two patterns for one fact, decided by which side of the package
  boundary the battery happened to be written on.
- **Zero-user batteries exist.** Workers has no caller in the tree, junction's
  own tests included. The email tiers and the better-auth adapter have none
  outside junction.

## 2. The tangled ones

Litestone had one `driver jsonl`. Junction has three, and a fourth that is a
rule nobody has written down.

**A second database opener.** `createDatabase` opens `bun:sqlite` with pragmas
and ships its own `migrate(dir)` over numbered SQL files — a second migration
runner beside litestone's. Its one user, basecamp, takes the handle and hands
the migrations to litestone's runner ([app.ts:100](../packages/basecamp/api/src/app.ts#L100)),
and then passes `database: { url: '' }` to stop `createApp` from opening a
second one ([app.ts:177](../packages/basecamp/api/src/app.ts#L177)). Six test
files across auth and mcp pass the same empty string for the same reason. The
battery's main user is code defending against it.

**Three mail layers and a fourth beside them.** `mail/` is the `IMail` contract
with an SMTP client and a Resend adapter; `plugins/email/` is two tiers over it
(system mail over SMTP, campaign mail over a conduit target, which refuses to
run without conduit); `@frontierjs/notifications` is the rig that fans out
through `app.mail`; and basecamp carries its own `IMail` over `app.conduit`.
`FJS-659` settled the first: `IMail` stays a contract with a working default so
conduit stays optional, and a credential is a reference (`FJS-D219`). What it
did not settle is the second layer, which nothing outside junction imports.

**A second scaffolder.** `junction init`, `setup`, `generators`, `ui` and
`build-app` — 2,148 lines — scaffold a project, audit it and bundle it as
`js|binary|docker`. The Packages table says create-frontier resolves to `fli
new` *so there is one implementation of what an app looks like*, and `fli
deploy` owns the release. `fli` calls none of these; it calls the seven
snapshot and call tools, which are junction's own and stay. `repl` (1,755) is
a client of a running app rather than a scaffold, and is its own line.

**The Data realm's work over time, run in the API process.** Commitments are
litestone's Life axis (`@@commitment`, `FJS-D368`); a backfill is its Evolution
axis (`FJS-D157`); the outbox is the durable half of a call (`FJS-D35`). All
three are schema fragments under `db/`, a plugin over `app.jobs`, and a core
half that is in `src/core/` today. They are not on an axis of a *call*, and they
are not misplaced either: litestone cannot run them (Invariant 1) and caravan
is a queue, not a reader of `.lite`. What is missing is the sentence that says
so, and until it is written the next one lands wherever its author stood.

## 3. What was built (2026-10-08)

1. **The edge test** — `packages/junction/test/edge.test.ts`. Every directory
   under `src/` is classified (an axis, a battery, or `testing/`), no axis file
   imports a battery outside the allow-list, every allow-list row is still
   used, the main entry re-exports no battery, and every battery has a
   subpath. The allow-list is FIVE rows, not two: `cache/` from `app.ts`,
   `service.ts` and `idempotency.ts`, and `scheduler/` from `app.ts` — the two
   defaults `FJS-D640` keeps constructed — plus `plugins/declared.ts` from
   `app.ts`. § 1 missed that last one: `config.plugins` (`FJS-D256`) installed
   manifest, openapi and devtools by dynamic import from `core/app.ts`, and
   every `fli new` app declares `manifest: true`. The installer moved to
   `plugins/declared.ts`, so the core names one module and that module names
   the batteries. `events/` is Announcement, an axis, so it needs no row.
   `buildRoutes` and `serializeHookMap` moved into `core/app-model.ts` and are
   on the main entry.
2. **One slot pattern** — `AppCache`, `AppScheduler`, `AppMail`, `AppAI`,
   `AppEmail`, `AppOutbox`, `AppCommitments`, `AppWebhooks`, each empty in
   `app.ts` and augmented by its battery. § 1 counted mail, AI and the
   scheduler; email, outbox, commitments and webhooks were typed by inline
   `import()` on the `App` interface as well. The core's two reads of
   `app.outbox` ask for `OutboxRelay` (`core/context.ts`), the half a call needs.
3. **The deletions** — `workers/`, `storage/database/` with `config.database`
   and `config.workers`, `auth/providers/better-auth.ts`, and
   `tools/{init,setup,generators,ui,build-app}`. The `url: ''` guard was in 69
   files, not seven. Three things leaned on the opener and changed with it:
   `createTestApp` makes no database, `webhooks()` takes a required `store`
   (`createSqliteWebhookStore` over a bun:sqlite `Database`) where it read
   `app.db.db`, and `/health` lost a built-in database probe that only knew the
   opener's shape. Basecamp opens its raw handle in `api/src/core/sqlite.ts`
   (bun:sqlite plus the four pragmas the opener set): litestone's
   `openDatabase` is a bare `new Database(path)`, so *through litestone* would
   have dropped WAL and the busy timeout.
4. **The scaffolder's steps** — `fli new` and `make:*` write every file `init`
   wrote. Of `setup audit`, the one check with no home was *`.env` is
   gitignored*, now in `fli deploy:doctor`; its CORS check contradicted the
   `origins: ['*'], credentials: false` `fli new` writes on purpose and was not
   carried. `build-app`'s js and binary modes had no caller; a binary is
   `single-binary.md`'s question. The REPL keeps running, minus its `setup`
   command and a `litestone` command that shelled out to a file that did not
   exist.
5. **The work over time** — `core/outbox.ts` and `core/backfill.ts` are
   `plugins/{outbox,backfill}/engine.ts`. `ctx.enqueue` stays on the context and
   writes through `app.outbox.enqueue`, refusing with no relay.
6. **The axis column** — `context-contract.test.ts` grades every
   `ServiceContext` field against a field-to-axis table read off the interface
   in both directions; `config-surface.test.ts`'s rows carry a required `axis`.

## Open questions

- ~~**What is junction's edge?**~~ **Answered 2026-10-08 (`FJS-D639`): A — The batteries stay in junction behind a seam, as `FJS-D635` ruled for litestone. Nothing under `src/core/` or `src/transport/` imports one, a test fails if anything does, and the test's allow-list names the two ruled exceptions. Every battery is reached by its subpath and leaves the main entry, which re-exports all of them today: the subpath exists for every one but the export and metrics plugins and the better-auth adapter. A new `ctx` field, `app.` claim, config key or `src/` directory names its axis, or it is a battery.**
  Junction owns what is true about a call into one application: who may make
  it, what runs when it does, how it arrives and leaves, and what it tells
  whom. Sending mail, running work on a clock or a thread, opening a database,
  describing the app to a tool, scaffolding one, and the Data realm's work over
  time are batteries.
  - **A** — The batteries stay in junction behind a seam, as `FJS-D635` ruled
    for litestone. Nothing under `src/core/` or `src/transport/` imports one,
    a test fails if anything does, and the test's allow-list names the two
    ruled exceptions. Every battery is reached by its subpath and leaves the
    main entry, which re-exports all of them today: the subpath exists for
    every one but the export and metrics plugins and the better-auth adapter.
    A new `ctx` field, `app.` claim, config key or `src/` directory names its
    axis, or it is a battery.
  - **B** — Each battery moves to its own package. The core exports the four
    axes and the host.
  - **C** — Admit them into the core and widen the edge to name them.
  - **Recommend A** — § 1 measured every battery but five as already outside
    the core, and three of the five are the host constructing a default. A
    costs the allow-list and one moved import. B stays open as a later move
    with nothing to untangle first; `FJS-D630` already says caravan and
    conduit are batteries and not rigs, so an extracted mail package has a
    ring to land in. C is what makes "done" unreachable.
- ~~**Is the host allowed to construct a battery for you?**~~ **Answered 2026-10-08 (`FJS-D640`): B — The bus is Announcement and stays. The cache and the scheduler stay default-constructed, because two axes read the cache and `FJS-D36` already ruled the timer, but each is reached through an augmented slot rather than an imported type, so the host could be handed another. The database opener goes (next question).**
  `createApp` builds a bus, a telemetry bus, a cache, a scheduler and opens a
  database. `FJS-D36` refused deleting the scheduler because a heartbeat
  should not cost a second package.
  - **A** — As now. The four stay default-constructed and the import test
    allows them by name.
  - **B** — The bus is Announcement and stays. The cache and the scheduler
    stay default-constructed, because two axes read the cache and `FJS-D36`
    already ruled the timer, but each is reached through an augmented slot
    rather than an imported type, so the host could be handed another. The
    database opener goes (next question).
  - **C** — Only the bus is constructed; cache and scheduler become
    `app.configure(cache())` and `app.configure(scheduler())`.
  - **Recommend B** — it is A with the slot pattern made uniform, and it keeps
    `FJS-D36`. C reopens a ruling for no measured gain: nothing in the tree
    wants a second scheduler or cache implementation.
- ~~**What happens to `storage/database/`?**~~ **Answered 2026-10-08 (`FJS-D641`): B — Delete it. `createApp({ db })` is the one way in, and the client is litestone's or anything table-shaped. `config.database` leaves `junction.config.js`, the seven `url: ''` guards go with it, and basecamp opens its handle through litestone.**
  § 2: a second opener and a second migration runner, whose one user defends
  against it.
  - **A** — Keep it, for an app with no litestone.
  - **B** — Delete it. `createApp({ db })` is the one way in, and the client
    is litestone's or anything table-shaped. `config.database` leaves
    `junction.config.js`, the seven `url: ''` guards go with it, and basecamp
    opens its handle through litestone.
  - **Recommend B** — the modelless app it was kept for is served by
    `createApp({ db })` with any client, and a numbered-SQL migration runner
    is a second origin for what litestone's differ already owns. `FJS-D260`
    is the precedent: delete rather than delegate, because the shapes were
    never the same.
- ~~**What happens to the three zero-user batteries?**~~ **Answered 2026-10-08 (`FJS-D644`): B — Delete workers and the better-auth adapter; keep the email tiers behind the seam until notifications is measured against the system tier.**
  Workers (no caller anywhere), the better-auth adapter (a vendor inside the
  boundary package), and the email tiers (nothing outside junction imports
  them).
  - **A** — Keep all three as batteries behind the seam.
  - **B** — Delete workers and the better-auth adapter; keep the email tiers
    behind the seam until notifications is measured against the system tier.
  - **C** — Delete all three; the system tier's job is notifications' and the
    campaign tier is a conduit target plus a template.
  - **Recommend B, then measure C's last clause** — workers and the adapter
    have the rulings already (`FJS-D153`, `FJS-D215`: the mechanism, never
    the vendor). The email tiers are the one battery with a design argument
    (`mail/index.ts`'s division of responsibility), so the measurement is
    whether `example` and basecamp's system mail runs through notifications
    with nothing lost. If it does, C.
- ~~**Who owns the scaffolder?**~~ **Answered 2026-10-08 (`FJS-D642`): B — Delete `init`, `setup`, `generators`, `ui` and `build-app`. Any step `fli new` and `fli deploy` lack is moved into them first, named in the same change. `repl` stays as a tool against a running app.**
  § 2: 2,148 lines `fli` never calls.
  - **A** — Keep both; junction's is for an API-only app.
  - **B** — Delete `init`, `setup`, `generators`, `ui` and `build-app`. Any
    step `fli new` and `fli deploy` lack is moved into them first, named in
    the same change. `repl` stays as a tool against a running app.
  - **Recommend B** — the Packages table already states one implementation of
    what an app looks like, and an API-only app is `fli new` with one
    surface. The repl is not a scaffold and is kept on its own merits; whether
    it duplicates the devtools plugin is a later, smaller question.
- ~~**Where does the Data realm's work over time run?**~~ **Answered 2026-10-08 (`FJS-D643`): A — They stay in junction, as batteries, and the rule is written: *a schema-declared thing that needs a process and a queue is a junction battery over `app.jobs`, shipped with its `.lite` fragment.* Their core halves (`core/outbox.ts`, `core/backfill.ts`) move beside their plugins, keeping `ctx.enqueue` as the one verb on the context.**
  § 2: commitments, backfill and the outbox are on litestone's axes and run
  as junction plugins over `app.jobs`.
  - **A** — They stay in junction, as batteries, and the rule is written: *a
    schema-declared thing that needs a process and a queue is a junction
    battery over `app.jobs`, shipped with its `.lite` fragment.* Their core
    halves (`core/outbox.ts`, `core/backfill.ts`) move beside their plugins,
    keeping `ctx.enqueue` as the one verb on the context.
  - **B** — They move to caravan, which owns durable work.
  - **C** — They move to litestone, which owns their axes.
  - **Recommend A** — C breaks Invariant 1 the moment a sweep needs a
    principal (`app.runAs`), and B makes a queue read `.lite`. A is where they
    already are, with the sentence that makes the next one land in the same
    place.

- ~~**FJS-D645 — Does the edge test's allow-list carry `plugins/declared.ts`?**~~ **Answered 2026-10-08 (`FJS-D645`): A — Yes. The installer is `plugins/declared.ts`, the core names that one module, and that module names the batteries. The allow-list has a row for it citing `FJS-D256`.** Found building `FJS-D639`, which says the allow-list names *two* ruled exceptions. Building it needed a third: `config.plugins` (`FJS-D256`) installs manifest, openapi and devtools from the start phase, and every `fli new` app declares `manifest: true`. Built as **A**, pending this ruling.
  - **A** — Yes. The installer is `plugins/declared.ts`, the core names that one module, and that module names the batteries. The allow-list has a row for it citing `FJS-D256`.
  - **B** — No. `config.plugins` declares only `health`, which is on an axis. The batteries are configured by hand, and `fli new` writes `app.configure(manifestPlugin())`.
  - **C** — No. Each battery registers its own declared key when its subpath is imported, so the core holds a registry and no import.
  - **Recommend A** — it keeps `FJS-D256` and costs one row that names its ruling. B reopens `FJS-D256` and edits every scaffolded app. C makes a config key work only if something else happened to import the battery, so the key would fail silently.

- ~~**FJS-D646 — Does basecamp's raw SQLite handle open through litestone?**~~ **Answered 2026-10-08 (`FJS-D646`): A — Litestone exports an opener that applies its own WAL and busy-timeout rule, and basecamp calls it.** Found building `FJS-D641`, which says *basecamp opens its handle through litestone*. Litestone's public opener (`openDatabase`, `@frontierjs/litestone/engine`) is a bare `new Database(path)`. The pragma helpers (`applyWal`, `applyBusyTimeout`) are not exported. Built as **B**, pending this ruling.
  - **A** — Litestone exports an opener that applies its own WAL and busy-timeout rule, and basecamp calls it.
  - **B** — Basecamp opens bun:sqlite itself in `api/src/core/sqlite.ts`, with the four pragmas junction's opener set.
  - **C** — Basecamp builds the litestone client first and takes `$rawDbs.main` for conduit's store and the health probe. Migrations then need another way in before the client opens.
  - **Recommend A** — `applyWal` exists because WAL-before-timeout threw `SQLITE_BUSY` (`FJS-655`, `FJS-729`), and B copies the pragma order without the retry. A puts that rule in one place and keeps the ruling's wording.

- ~~**FJS-D647 — Which of the deleted scaffolder's checks and build modes does `fli` owe?**~~ **Answered 2026-10-08 (`FJS-D647`): A — None beyond the `.env` check. A binary is `single-binary.md`'s question.** Found building `FJS-D642`, which says to move any step `fli` lacks before deleting. One step was moved: *`.env` is gitignored*, now in `fli deploy:doctor`. These were not:
  - setup's CORS-`'*'`-in-production check, which contradicts the `origins: ['*'], credentials: false` that `fli new` writes on purpose
  - demo or stub auth in production, the rate limiter, the drain timeout and *a test exists*, which were advice
  - `build-app`'s js and binary modes, which had no caller

  Built as **A**, pending this ruling.
  - **A** — None beyond the `.env` check. A binary is `single-binary.md`'s question.
  - **B** — Also port *stub auth in production* to `deploy:doctor`.
  - **C** — Restore `build-app` as `fli api:build`.
  - **Recommend A** — the remaining checks either disagree with what `fli new` writes or only advise, and a build mode with no caller is not a step `fli deploy` lacks.

## The nine, for the edge

1. **Origin.** One sentence, in one ruling; the axis column derives from it.
   The import test's allow-list is the same ruling read by a machine.
2. **Concept.** No new noun. *Battery* is ordinary English by `FJS-D394`; the
   four axes are named from existing rulings (`FJS-D391` for Call, `FJS-D06`
   for the tiers, `FJS-D175` for grading) and the host is `createApp`.
3. **Complexity.** The problem's own: an API layer accretes what the app
   needed next, and the adjudication is *batteries vs. smallness*.
4. **Predictability.** Better. One slot pattern where there are two, and a
   feature's home decided by one question.
5. **Derived.** The import test reads the tree; the axis column is read by two
   tests that already run each field and each key.
6. **Owner.** § IV already owns the rule; this applies it. The database opener
   and the scaffolder each stand beside an existing owner, which is the
   failure the owner question exists to catch.
7. **Boundary.** The subpaths make the edge visible to a caller, and the
   augmented slot makes a battery's absence a type error rather than an
   `undefined`.
8. **Failure.** A core import of a battery fails the suite — a structural
   change, never an accident worth a warning. A deleted battery fails at
   install with the version bump as the notice, which is the pre-alpha rate.
9. **Silence.** What must stay true is that the core and the transport import
   no battery and name no battery's type. `test/edge.test.ts` fails when it
   stops. A new field or key naming an axis is graded by the two contract
   tests.

**Tier:** each ruling is Register. The sentence that states the edge is in
`packages/junction/CLAUDE.md`, beside *Junction owns no file store*.
