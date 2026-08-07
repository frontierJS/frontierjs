# Idea — Named checkpoints and time travel, from the audit trail

**Status: IDEA. Nothing here is built.** Dated 2026-08-05. The audit trail this is
built on ships and is tested; the checkpoint layer does not exist. One claim below
was probed at a terminal rather than read — it is marked. See `VERIFYING.md`.

---

## Trigger, and why the obvious version does not work

The proposal that reached this file was a UI-realm one: *a signal graph has no VDOM
to reconcile, so snapshotting "the whole reactive graph at time T" is just
serializing signal values — time travel comes almost free.*

**It does not, here, and the reason is worth writing down once so nobody re-derives
it.** Mesa's state is not in a store:

- Component state lives in closures created by the compiled component function.
  There is no registry to walk. `watchProxy()` wraps objects reactively
  (`mesa/runtime.js`), but nothing keeps a list of every signal a page created.
- Restoring values is not restoring a page. Effects have run — a fetch was issued, a
  `<dialog>` was opened, focus moved, a third-party widget was constructed. Signals
  are re-runnable forward; the effects they fired are not undoable backwards.
- The parts of the DOM the compiler touches are known precisely, which is what makes
  fine-grained updates cheap — but "cheap to update forward" is not "invertible".

A "restore signal values" button therefore gives you a page that *looks* like time T
with a runtime that has lived through T+1. That is a debugging toy, not a feature,
and shipping it would teach the wrong thing about what the framework guarantees.

**The version that is real is one realm down.** FJS is the rare framework where the
history is already a declared, structured, first-class artifact — in the Data realm,
not the UI.

## What already exists to build on

`@@log(audit)` on a model writes a structured entry for every write, through a
logger database declared in the schema (`packages/litestone/docs/audit-logging.md`):

```js
{ operation: 'update', model: 'widget', records: [7],
  before: { id: 7, state: 'draft' },
  after:  { id: 7, state: 'live' },
  actorId: 'user_abc', actorType: 'user', createdAt: '…' }
```

Four properties matter for checkpoints, and all four are already true:

1. **Before and after are both recorded** for single-row `update()`, and `before` is
   recorded for single-row `delete()` and soft delete. A single-row write is
   therefore *invertible from the log alone*. Bulk writes name their rows but do not
   snapshot them — see the section below.
2. **The actor is attributed** via `onLog`, so a checkpoint can be described in terms
   of who did what rather than only when.
3. **Entries are queryable through the ordinary ORM** (accessor `db.auditLogs`),
   so "the history" needs no second query language.
4. **Protected values are redacted** — `@encrypted` / `@guarded` / `@secret` log as
   `[redacted]` in field entries *and* in the `before`/`after` snapshots. That is
   repo Invariant 7 and it is pinned by 8 tests.

Point 4 is the design constraint that decides the whole shape (below), and it is a
constraint to keep, not to work around.

## The idea

**A checkpoint is a name for a database state, and the audit log is the narrative
between two of them.**

```
$ fli db:checkpoint "before the Q3 import"
✓ checkpoint c_7f3a  ·  main.db 4.2 MB  ·  audit offset 18422

$ fli db:log --since c_7f3a
  18423  create  Order    [1001…1240]   240 rows   actor system   (import)
  18661  update  Customer [88]          plan: free → pro           actor u_12
  18662  delete  Order    [1002]                                   actor u_12

$ fli db:restore c_7f3a --dry-run
  would revert 241 rows across 2 models; 1 delete is not invertible (bulk)
```

Two mechanisms, deliberately distinguished:

| | **Snapshot** | **Replay** |
| --- | --- | --- |
| What it is | the database file at time T | audit entries applied forward or inverted backward |
| Restores | everything, exactly, including protected columns | only what the log recorded, never redacted values |
| Costs | disk per checkpoint (`VACUUM INTO`) | nothing at capture; a walk at restore |
| Good for | "put it back" | "what happened, and undo *this* row" |

**The snapshot is the truth; the log is the story.** Anything else puts pressure on
Invariant 7 — a replay that could reconstruct an `@encrypted` value would mean the
audit trail was holding one, which is exactly what redaction exists to prevent. So a
full restore uses the file, and replay is for *inspecting* history and for reverting
individual non-protected rows. Stating that split up front is most of the design.

## Why this is an FJS feature rather than a general one

Every database has backups and several have temporal tables. What is different here:

- **The history is declared, not configured.** `@@log(audit)` is one line in the
  schema, next to the gate and the constraints, and it travels with the model. The
  checkpoint layer needs no separate agent, no CDC pipeline, no trigger generation.
- **It is attributed and redacted by the same declarations that protect the data.**
  A checkpoint diff is safe to show a support engineer *because* the seed already
  says which columns may never appear.
- **The Data realm is a file.** SQLite makes "snapshot the whole application state"
  a copy, which is what removes the need for a bespoke history mechanism — the same
  property `compass` relies on (`IDEAS/offline-first-and-release.md`).

## What it unblocks

- **`quarry` / `fli demo` (wave 1.4).** A demo needs to be re-runnable and
  re-explainable. "Reset to `c_demo`" makes a click-through repeatable, and named
  checkpoints per persona make the gate ladder demonstrable rather than described.
- **The Suite realm (wave 3.3, `createTestEnv`).** Seed once, checkpoint, restore
  between tests. Restoring a file is faster than re-seeding and it removes the
  `createClient({ db: ':memory:' })` trap (`ISSUES.md` `FJS-015`) as a reason to
  reach for in-memory at all.
- **`marshal` (wave 4.7).** DSAR and erasure both need "what did we hold, and when",
  which is this file's subject read from the compliance side.
- **Operating an app.** Basecamp's deployments already show a step timeline; a failed
  migration wants "restore to the checkpoint the migration took".

## What would have to be built

1. **Capture.** `VACUUM INTO` to a checkpoint directory, plus the current audit
   offset and a name. Cheap and already atomic.
2. **A checkpoint registry** — id, name, timestamp, actor, schema hash, audit offset.
   The schema hash matters: restoring across a migration is a different operation
   from restoring within one, and it must refuse rather than corrupt.
3. **Inversion rules per operation** — `create` → delete by id; `update` → write
   `before`; `delete` → re-insert `before`. All three have the data they need for
   single-row writes, and *only* for those: a bulk entry names its rows without
   snapshotting them, so replay must stop at one and say so (see the section below).
4. **`fli db:checkpoint` / `db:log` / `db:restore` / `db:diff`**, with `--dry-run`
   reporting what is not invertible before it does anything.
5. **A retention policy that does not fight the logger's.** The logger database takes
   `retention 90d`; a checkpoint older than the log it references can restore by file
   but cannot narrate. Say which wins.

## The gap that blocked replay — closed 2026-08-05, but only halfway

**Probed, not read.** A schema with `@@log(audit)`, two creates, then
`updateMany({ where: { state: 'draft' }, data: { state: 'live' } })` and
`deleteMany({ where: { state: 'live' } })` used to produce:

```
entries: 2
create widget [1] before= null after= {"id":1,"name":"a","state":"draft"}
create widget [2] before= null after= {"id":2,"name":"b","state":"draft"}
```

**The bulk update and the bulk delete produced no audit entry at all.** Not a
snapshot-less entry — no entry. Two rows were modified and then destroyed on a model
declaring `@@log`, and the trail said nothing happened. `updateMany` and `deleteMany`
called `fireQuery` and never `emitLogs`; so did `removeMany`, `restore` and
`upsertMany`.

**Fixed** (`ISSUES.md` § Closed `FJS-074`, litestone `CHANGES.md`, 8 tests): all five
paths log, and a bulk op on a logged model takes `RETURNING` so its entry names the
rows by id — which also fixed `createMany`, whose entry named no rows because an
autoincrement id does not exist until SQLite assigns one.

**What that leaves for this idea.** A bulk entry records *which* rows and *what*
operation, never contents — `before`/`after` remain single-row-only. So today:

| history | detectable | invertible |
| --- | --- | --- |
| single-row `create` / `update` / `delete` / `remove` | yes | **yes**, from the log alone |
| bulk `updateMany` / `deleteMany` / `removeMany` / `restore` / `upsertMany` | yes — rows named | **no** — the row's contents were never recorded |

That is the honest position for a checkpoint feature to build on, and it is much
better than the old one: a bulk delete is now a visible discontinuity in the
narrative rather than a silent hole. **Restoring across one means restoring the
snapshot file, not replaying** — which is the snapshot-is-truth split this file
already proposes, arrived at from the other direction.

Whether bulk writes should *also* snapshot contents is a real question with a real
cost (a million-row update would write a million snapshots) and it belongs to
whoever builds replay. The cheap middle is an opt-in per model — `@@log(audit,
snapshots: all)` — rather than a global default.

## Open questions

- **Is a checkpoint a Data-realm noun, or a Release-realm one?** `fli db:checkpoint`
  puts it in Data. But "the state this deploy started from" is a Release concept, and
  `IDEAS/offline-first-and-release.md` already wants artifact kinds first-class.
- **What is the boundary of a restore?** Restoring the database does not un-send an
  email (`conduit`), un-run a job (`caravan`), or un-notify a client. The honest
  answer is that a checkpoint restores the *Data realm only*, and that this must be
  said loudly in the CLI output — the trap is someone assuming it restores the world.
- **Does a multi-database app checkpoint atomically?** Tenants are db-per-tenant, and
  a logger database is a database. A checkpoint of "the app" is a set of files, and a
  partial restore across them is a new failure mode.
- **Should the audit log gain an entry for a checkpoint itself?** It is a write, it
  has an actor, and it wants to appear in the same narrative — but it is not a row
  change and the entry shape assumes a model.
- **Does replay want to be one of Litestone's existing extension points?** It is a
  plugin-shaped thing, and `ISSUES.md` `FJS-D19` is already reconsidering what a
  Litestone Plugin is called and whether it has a name.

## See also

- `packages/litestone/docs/audit-logging.md` — the trail this is built on
- `packages/litestone/src/core/client.js` — `emitLogs` and its call sites, one per
  write path
- `ISSUES.md` § Closed `FJS-074` — the bulk-write audit gap
- `IDEAS/compliance-from-the-seed.md` — `marshal`, the same log read for audit
- `IDEAS/testing-and-ci.md` — the Suite realm, the cheapest consumer
- `IDEAS/offline-first-and-release.md` — `compass`, which relies on the same
  the-database-is-a-file property
- `CLAUDE.md` § Live hazards — the logger buffers ~1s and flushes on exit; a probe
  that reads immediately reports 0 rows and is the source of `ISSUES.md` `FJS-071`
