---
id: logbook
status: shipped
dated: 2026-08-31
---

**Status: PHASES 0–3 SHIPPED 2026-08-31. Phase 4 deferred.** What is described
below as *the plan* has been built and the numbers in § What is already here are
the state it replaced — read them as the diagnosis, not as the tree. Three
defects fell out of it and are closed with ids: [`FJS-616`](../ISSUES.md#fjs-616)
(every container this framework starts had an uncapped log, in all four places
one is started), [`FJS-617`](../ISSUES.md#fjs-617) (the audit trail was written
inside the container, so every deploy deleted it) and
[`FJS-618`](../ISSUES.md#fjs-618) (a jsonl model that gains an indexed field
silently stops being written — found by causing it, since phase 1 adds
`@@index([correlationId])` to the logger auto-model).

Phase 2's own test was written to be falsifiable and **it failed**, which is
recorded in place rather than smoothed over: see § Phase 2.

# Idea — `logbook`: the log line, the trail, and reading either from somewhere else

Two things in this tree are called logging and they are not the same feature.
**`ILogger` is what the process says about itself**; **`@@log(audit)` is what the
Data boundary records about a write.** One goes to stdout and is read with
`docker logs`; the other goes to a directory of JSONL beside the database. They
share no id, no destination and no reader, and neither is finished.

This is the sibling of `lantern.md` and it deliberately does not overlap it.
`lantern` asks *why was this caller refused* and owns the span tree and the
decision event. This one asks the two duller questions that come first — **what
did the process say, and what did the write record** — and the third that only
makes sense once both are answered: **how does an operator read either of them
from a machine they are not sitting at.**

Probed against the tree on 2026-08-31 (`VERIFYING.md`). Everything below with a
number was measured, and the one structural fact was measured by making the
parser refuse:

    Model 'Thing': @@log database 'main' must use driver logger (got 'sqlite')

**The audit trail cannot be a table.** That single constraint explains most of
what follows, including why basecamp runs two audit trails.

---

## What is already here

| Piece | Where | State |
| --- | --- | --- |
| Levelled logger | `junction/src/core/logger.ts` | `debug`/`info`/`warn`/`error`, `child(ns, defaults)`, pretty in dev and JSON in production, `NO_COLOR` and TTY honoured, a missing `.stack` handled |
| Writers | same | `consoleWriter`, `fileWriter` (Bun `FileSink`), `multiWriter`. An array of writers, which is Laravel's `stack` without the config file |
| Request logger | `junction/src/transport/middleware.ts:309` | exists; writes with `console[level]`, **not** through `app.logger` |
| Correlation id | `middleware.ts` `correlationId()` → `ctx.requestId`; `RequestMeta.correlationId` off `x-request-id` | two spellings, and neither reaches a log entry |
| The trail | litestone `@@log(audit)` / `@log(field, reads)` | create · update · delete · **read**, soft-delete, restore, upsert. Fire-and-forget, deferred one tick, swallowed — and the first loss per model is announced |
| Redaction | `redactValue` / `redactSnapshot` | measured: a `@secret` write logs `"[redacted]"` in the field entry **and** inside the `after` snapshot. Invariant 7 holds |
| Hand-written events | `db.$audit({ operation, model, records, actorId, meta })` | for what is not a write — a failed sign-in. Awaits and throws, where `fireLog` does neither |
| Retention | `database audit { retention 90d }` → `compactJsonl` | declared in the seed, swept oldest-first with an early return on the first line |
| Backup | `litestone backup`, deploy step `05-backup` | hot-copies SQLite and **cp's the JSONL directories beside them**. Runs in the OLD container, before the swap |
| A reader | `litestone studio` | browses logger tables, append-only so no cell edit, binds `127.0.0.1`, `--token`, `--readonly` |

Three of those rows are better than the field. Nothing else surveyed records
**which column** was written, nothing else derives redaction from a declaration
rather than a deny-list, and nothing else can log **reads**.

## The holes

1. **The app does not use its own logger.** 34 `console.*` in `junction/src`
   against 13 logger calls; 535 in `litestone/src`, routed nowhere. The worst is
   the top of the error path — `onError: (err) => console.error('[HTTP Error]', err)`
   in `core/app.ts` — so under `format: 'json'` the app's own errors are the one
   thing in the stream that is not parseable. Same for the EventBus, the
   scheduler, the loader and every plugin lifecycle error.

2. **Nothing binds a request.** `requestLogger` exists, the README wires it, the
   scaffold wires it, and `junction/tools/setup.ts` grades an app for it
   (`prod.request_logger`, `prod.correlation`) — and **neither `example` nor
   `basecamp` installs either**. Even installed, `requestLogger` writes through
   `console`, so it gets no namespace, no level filter and no writer.

3. **The correlation id reaches nothing.** Not a log entry, not an audit row,
   not a telemetry event. So an app log line and the audit row the same request
   produced cannot be joined, by anything, ever. `lantern` § *five holes* names
   the telemetry half of this; the log half is here.

4. **The audit row is thin on provenance.** `actorId` and `actorType` and
   nothing else — no url, no ip, no user agent, no tenant. Under
   `strategy database` the logger database is fleet-shared by design, so every
   tenant's rows land in one file with no column telling them apart. `onLog` can
   add all of it through `meta`, nothing does, and `meta` is explicitly not
   redacted.

5. **A bulk write records ids and no contents.** This is not new — it is the
   stated remainder of `overview.md` 0.7, which fixed the *silence* and left the
   *invertibility*, and it is what blocks 4.13.

6. **The trail cannot be a table.** Measured above. It cannot be joined to
   `User`, cannot carry an `@@allow`, cannot be paged with `findWindow`, cannot
   be replicated (`litestone replicate` says by name that it cannot cover a
   JSONL database), and cannot be read by a screen without an endpoint written
   by hand. **This is why basecamp has two** — `@@log(audit)` writes the file,
   and `api/src/core/hooks.ts` writes an `AuditEvent` row into `main` because a
   screen needed one. *(Probed 2026-08-31: the two are ALSO different documents
   — a service-level feed against a Data-boundary trail — so this row is
   evidence that the shipped trail cannot reach a screen, and is not evidence of
   redundancy. See § Phase 2.)*

7. **The trail does not survive a deploy.** The container mounts the volume at
   `/db` and the app root is `/app`, so a declared `./db/audit/` resolves inside
   the image. `AUDIT_PATH` is set by no deploy path in this repo; basecamp's
   declaration is a literal with no `env()` at all, so it cannot be redirected
   without a schema edit. `core/db-preflight.js` skips non-SQLite drivers **on
   purpose**, so nothing looks. What survives is five pre-deploy backups, from
   a step marked `optional`.

8. **The container log is unbounded.** The `docker run` in
   `commands/deploy/_module.md` sets `--restart`, `--volume`, `--env-file` and no
   log options at all, so the default `json-file` driver grows until the disk
   does not.

9. **A dropped audit write is on no metric.** `fireLog` warns once per model to
   stderr, forever. No `registerMetricsSource`, no health check. A trail that
   stopped writing reads exactly like an app doing nothing.

10. **A scaffolded app has no trail.** `fli new` writes `database main` and
    nothing else.

Holes 7 and 8 are defects rather than design gaps and belong in `ISSUES.md` with
ids of their own; this file should cite them rather than carry them.

---

## Prior art, and the shape of the field

`lantern` § *Prior art* splits the observability field into four tiers and takes
a position on two of them. This is the same exercise on the axis it left alone,
and the field is much more settled here — which is the point. There is little to
invent and a lot to catch up on.

**Everybody converged on one mechanism: a request-scoped child logger with
context bound by ambient storage.** Not a convenience — it is the feature, and
it is the same design five times.

| | Bound how | What rides along |
| --- | --- | --- |
| AdonisJS | `ctx.logger`, a pino `child({ requestId })` | the request id, on every statement |
| Laravel | `Log::withContext()` / `Log::shareContext()` | anything, across all channels, for all subsequent entries |
| Rails | `config.log_tags = [:request_id]` + `CurrentAttributes` | request id, tenant, user |
| Django | `structlog.contextvars.bind_contextvars` | request id, user id |
| NestJS | `nestjs-pino` over async local storage | id, method, url, headers |

Adonis states it as a recommendation rather than an option: *use `ctx.logger`
during HTTP requests, because the HTTP context holds a request-aware logger that
adds the current request ID to every log statement.* **FJS owns every part of
that and has wired none of it** — `enterRequest` opens the store,
`requestMeta().correlationId` is sitting in it, `logger.child()` exists, and no
caller puts the two together.

**On the trail, the field is unanimous in the other direction: it is a database
table.** `owen-it/laravel-auditing`, `paper_trail`, `audited`,
`django-auditlog` — every one of them a row, none of them a file. Their column
set is worth reading beside ours:

| laravel-auditing | litestone | |
| --- | --- | --- |
| `event` | `operation` | — |
| `auditable_type` / `auditable_id` | `model` / `records` | — |
| `old_values` / `new_values` | `before` / `after` | — |
| `user_type` / `user_id` | `actorType` / `actorId` | — |
| `url` · `ip_address` · `user_agent` · `tags` | — | **missing, all four** |
| — | `field` | **ours alone** |

The four missing ones all answer *from where*, and all four are already on
`ctx.client` and `RequestMeta`. They are a wiring problem and the same wiring as
the log line, which is why phase 1 does both at once.

**On destination, the twelve-factor position won and it is the one to adopt
without argument**: *a twelve-factor app never concerns itself with routing or
storage of its output stream and should not attempt to write to or manage
logfiles.* That makes `fileWriter` the anti-pattern rather than the thing to grow
rotation onto, and it makes the missing half an operator concern — the default
`json-file` driver *sets no size limits, and a chatty container can write
gigabytes before you notice*, which is hole 8 verbatim. **The trail is not
subject to this argument**, because it is data rather than output, which is a
second route to the same conclusion as hole 6.

**On the viewer, Laravel runs four products and they are not interchangeable**,
which is the most useful thing the field has to say about scope. `Pail` tails the
stream in a terminal. `opcodesio/log-viewer` reads and searches the log FILES in
a browser and sells itself as *forget SSH'ing onto production just to read the
logs*. `Telescope` records every request and is described by its own community as
*the wrong tool for production*. `Pulse` aggregates health over a population.
`Nightwatch` is hosted APM. `lantern` claims the Telescope tier and exports to
the Pulse tier. **Basecamp is the log-viewer tier and it is a different
product** — and the one nobody ships for a fleet, because the existing one is a
route inside the single app it is reading.

**One thing the field does not do**, worth knowing because our trail is already
append-only: none of the four audit packages makes the trail tamper-evident.
They trust the table. The technique is settled elsewhere — a hash chain where
each row commits to the previous, which CloudTrail runs with hourly signed digest
files — and it is cheap on a log that is append-only by construction.

## What FJS can do that the field cannot

Three claims, each resting on something already built, and each smaller than
`lantern`'s because most of this is parity.

**1. The trail is derived, not registered.** laravel-auditing needs a trait per
model and an `$auditInclude` list; `@@log(audit)` is one line in the seed and
`db/access.snapshot.md` already commits which models carry it. A model that
stops being audited is a diff in a file CI gates, not a discovery.

**2. Redaction is declared and cannot be forgotten.** Every other package
redacts by a deny-list maintained beside the trail. Ours reads
`$protectedFields`, so a `@secret` added today is redacted in the trail today —
and `field`-level entries mean the trail can say *this column was written* about
a column whose value it must never hold. That pairing is not available to anyone
whose audit layer sits above the ORM.

**3. It is the runtime half of an artefact set that already exists.**
`access.snapshot.md` says who may do what, `principal.snapshot.md` says who a
caller becomes, `jobs.snapshot.md` says what runs with no caller. A trail that
carries the tenant and the standing is the record of those three being obeyed,
and `compliance-from-the-seed.md` is the document that wants it.

---

## The plan

Five phases. Phase 0 is repairs and is independent of the rest — do it first
because it is a day and it prevents an outage. Phases 1 and 2 are the parity
build and are ordered. Phase 3 is the reason the user asked. Phase 4 is
optional and is the only part with a position in it.

### Phase 0 — the operator floor (S)

Three fixes, no design.

`--log-opt max-size=10m --log-opt max-file=5` on the `docker run` in
`commands/deploy/_module.md` and in `_steps-rollback/02-rollback-api.md`, which
carries its own copy of the argv.

**A path for every declared database, not just `main`.** The Dockerfile comment
warns about `DATABASE_URL` and says nothing about a second block, and
`db-preflight.js` skips non-SQLite drivers deliberately. The fix is a `fli check`
rule rather than a comment: a declared non-SQLite database whose path is not a
bound variable, in an app with a deploy block, is a trail that will be deleted.
It is the shape of `check-attachments` — *declared here, bound by the
environment* — one realm along.

`retention` and dropped-write counts through `app.registerMetricsSource`, so
hole 9 stops being a warning nobody greps for. Sources must be synchronous, so
the count is refreshed on the sweep rather than on the scrape.

### Phase 1 — one context, bound once (S/M)

**`$.log`**, a derived accessor on the ambient call object beside `$.db`, `$.me`
and `$.config`. It answers `app.logger.child(`${service}.${method}`, { correlationId, userId, tenantId })`,
resolved on every read like its siblings, refusing outside a call like its
siblings. That is Adonis's `ctx.logger` with this tree's own spelling, and the
precedent for the shape is one file over.

Then the four things that follow from it, none of which is a design decision:

`requestLogger` writes through `app.logger` rather than `console`, and so do the
seven `console.error` sites that are the app's own failures — the HTTP error
boundary first, since it is the one that matters in production.

The **correlation id becomes one thing**. `ctx.requestId` and
`RequestMeta.correlationId` are two spellings of one fact and the second is the
one `enterRequest` already owns.

**`url`, `ip`, `userAgent` and the tenant onto the audit entry**, in
`buildLogEntry`, from the request context rather than from `onLog`. A stated
`onLog` value still wins, as it does for `actorId` today.

**The correlation id onto the audit entry too.** This is the join, and it is the
whole reason phase 1 is one phase rather than two: the log line and the trail row
get the same id in the same change, or they get two ids that nearly match.

### Phase 2 — the trail may be a table (M)

Let `@@log(<name>)` name a SQLite database, with `logModel` naming a real model
in the seed. Keep `driver logger` for the append-only case; it is the right
answer for a fleet-shared trail and for volume.

What that buys is every one of hole 6's consequences reversed at once: a join to
`User`, an `@@allow` on the trail itself, `findWindow` and `$after` for a screen,
litestream replication for free, and `@@gate("5.8.9.9")` — the ledger's own
spelling — to make it append-only at the Data boundary rather than by driver
choice. `example`'s `JournalEntry` already proves that spelling works.

**The test of this phase was that basecamp deletes code** — `AuditEvent` becomes
the `logModel` and `api/src/core/hooks.ts` stops writing it by hand. **Run on
2026-08-31, and it failed**, which is what the test was for: the two trails are
answering two different questions, and hole 6 above overstates the case.

`AuditEvent` is a SERVICE-level record — one row per call, `action` is
`servers.reboot`, `subjectType` is the service, and `diff` is computed by
re-reading the row through the system client with redaction applied on purpose.
`@@log` is a DATA-BOUNDARY record — one row per model write, `operation` is
create/update/delete/read, with before/after snapshots. A custom method is
invisible to one and is the whole subject of the other; one call touching three
models is one row there and three here.

So the duplication is real and is not redundancy, and *basecamp deletes code* is
the wrong bar. What this phase actually buys stands without it and is what the
tests assert: a trail that **joins** (an audit screen shows a person, not an
id), that can be made append-only at the Data boundary with `@@gate("5.8.9.9")`
— `example`'s JournalEntry spelling, and the engine's own write still lands
because it goes through a system context at 8 — that a policy can scope, that a
cursor can page, and that litestream can replicate. What basecamp gains is the
second trail beside its first, so one screen can show *what somebody did* and
*what actually changed underneath it*.

The rule that keeps it honest: on a SQLite database `model` is **required**.
There is nothing to synthesise into, and a table the app never declared can
carry no gate, no policy, no index and no migration — which are the entire
reason to be here rather than in a directory of jsonl.

The bulk-write remainder (hole 5) is decided here or explicitly deferred to 4.13.
It is the one open question in this phase and the one that governs the schema.

### Phase 3 — reading it from somewhere else (M)

Two readers, and they are not one screen.

**`GET /logs` on the Outpost.** It has `/health`, `/exec` and `/volumes/…` and
nothing for logs, which is why `basecamp/web/src/routes/apps/[id]/index.mesa`
carries a comment saying the logs tab is absent because *nothing stores or
streams a log line*. `docker logs --tail --since` behind a signed route is that
whole tab: level filter, search, download. Signed like every other Outpost route
— it is co-resident with `/exec`, and an unsigned log route on a box that has one
is a credential leak with extra steps.

**The trail in Basecamp's own audit screen.** That screen already exists and
already does the hard part — 50 rows, a window grown from the far edge, the
keyset walk `FJS-535` was found in. Phase 2 is what lets it point at the
framework's trail instead of a parallel table, and phase 1 is what lets a row in
it carry a link to the log lines from the same request.

Not in scope, stated so it is not discovered later: aggregation across apps,
retention policy in the UI, and anything resembling Pulse. Those are the tier
`lantern` § phase 5 exports to.

### Phase 4 — the trail proves itself (S, optional) — DEFERRED

A `prev` hash column and a `hash` over the row, so a trail that has been edited
breaks its own chain, plus `litestone audit --verify` to walk it. Cheap on a log
that is append-only by construction, and it is the only claim in this document
the field does not already have.

Deliberately last. It is worth nothing until phases 0 and 2 mean the trail
survives a deploy and lives somewhere a rule can defend, and a tamper-evident
log that a deploy deletes is theatre. **Those two now hold, so the precondition
is met and the work is deferred rather than blocked** — it is the only part of
this document with a position in it, and the only part nothing in the tree is
waiting on.

**One ordering constraint**: phase 1 before phase 2. The columns decide the
model, and minting `logModel` before the provenance columns exist means writing
the schema twice and migrating an app's trail to catch up.

## What this owes the repo's own conventions

**Two `FJS-###` entries, not two paragraphs here.** Holes 7 and 8 are shipped
behaviour that is wrong today, and the house rule is an id in `ISSUES.md`. This
file should cite them.

**A `fli check` rule per hole that is statically decidable.** The unbound
database path (phase 0), an app declaring `@@log` with no deploy binding, and a
service reaching for `console.error` where `$.log` is in scope. `checks.js` is
where the live-hazard catalogue executes (`FJS-D133`) and every one of these is
currently a paragraph in `CLAUDE.md`.

**A drive.** `example`'s `verify:retro` is already the only drive that reads
`db.auditLogs`, and it reads it for the right reason — a superseded belief
survives in the trail and nowhere else. It is the natural place to assert that a
row carries its correlation id and that the id matches the call that wrote it.
The deploy half belongs in `deployJournalCycle`, which is the only thing that
runs `fli deploy` at all: **an audit row written before a deploy is still
readable after it** is one assertion and it is the whole of hole 7.

**A snapshot, if phase 2 lands.** A trail that is a model is in
`jsonschema.snapshot.md` and `access.snapshot.md` already, which is most of what
a `logbook.snapshot.md` would say. Probably nothing new is owed — worth checking
rather than assuming.

## Open questions

- **Does `$.log` shadow `app.logger` badly?** A module-scope import of the app
  logger stays correct and unbound, and the two will coexist forever. Adonis has
  exactly this split (`logger` service against `ctx.logger`) and documents the
  recommendation rather than removing the choice. Probably fine; worth stating
  in the hazard list rather than discovering.
- **Should `fileWriter` be deleted or kept?** Twelve-factor says delete. Against
  that: a CLI is not a twelve-factor process, and `fli` has somewhere it might
  legitimately write. Recommendation: keep it, document it as not for a served
  app, and never grow rotation onto it.
- **What is the trail's tenant column under `strategy database`?** One file per
  tenant makes it obvious; one fleet-shared logger database makes it a real
  question, and the answer decides whether phase 2's `logModel` is
  `@@tenant(none)` or scoped.
- **Does the bulk-write remainder belong here or in 4.13?** It is the same
  defect from two directions — this file wants contents for provenance, 4.13
  wants them for invertibility. Whoever gets there first should design for both.
- **Is the Outpost the right home for `/logs`?** It is where the machine is. The
  argument against is that Outpost is deliberately narrow and `/exec` can already
  do it — but *the caller composes the docker command* is exactly the shape that
  makes `/exec` the route nobody should be reaching for.

## See also

- `IDEAS/lantern.md` — the trace and the decision. The sibling; read § *Prior
  art* for the tiers this one deliberately does not claim
- `IDEAS/compliance-from-the-seed.md` § 6 — support mode, which *wants the audit
  trail to be complete first* and is gated on this
- `IDEAS/overview.md` 0.7 — the bulk-write remainder, stated when it was half
  fixed · 4.13 — time travel, blocked on the same remainder · 2.4 — `lantern`'s
  row
- `packages/litestone/docs/audit-logging.md` — what the trail does today
- `CLAUDE.md` § Bridge index — `$` and its derived accessors, which is the shape
  phase 1 extends
