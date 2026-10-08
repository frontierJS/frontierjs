---
id: consistency
status: partial
dated: 2026-10-08
---

# Idea — Consistency: what a caller can rely on after a write

**Ruled 2026-10-08 as `FJS-D659`: A with B's warning.** `docs/CONSISTENCY.md` is written. The `asSystem()` check is FJS-2069 and the warning is FJS-2070.

Dated 2026-10-08. The rows marked *ran* were
measured by a throwaway `bun test` against `createClient({ db: ':memory:' })`
on this date; the rest are read from source at the cited line and are leads to
verify (`VERIFYING.md`). Do not cite this file as describing behavior.

Wave 5 of the vocabulary atlas, *papers before nouns*: the words for this region
come out of this paper. Siblings it does not restate:
[`conflict-as-data.md`](conflict-as-data.md) owns the merge under `@@sync(field)`
and `@@sync(manual)`; [`homestead.md`](homestead.md) owns `@@sync` and its value
set (`FJS-D298`, `FJS-D304`); [`live-queries.md`](live-queries.md) owns what a
subscription is scoped to.

---

## What exists today

Every guarantee below is real. None is stated in one place; each lives in the
comment above the code that keeps it.

| Seam | What a caller gets | Where | How known |
| --- | --- | --- | --- |
| A transaction | `BEGIN IMMEDIATE` — the write lock taken up front; serializable, because SQLite has one writer per file | `litestone/src/core/transaction.js:149`, `client.js:10785` | ran: two concurrent `$transaction`s ran A-start, A-end, B-start, B-end |
| Own write, same process | Read-your-writes, trivially: one `bun:sqlite` handle, synchronous SQL | `litestone/docs/concurrency.md` § top | ran: a read inside the callback saw the uncommitted update |
| Lost update | `@version` refuses a stale write: `VersionConflictError`, 409; an update **without** the version is refused too (`VersionRequiredError`) | `client.js:6195–6207`, `:6412` | ran: non-system update with no version threw |
| …but not for the system | `asSystem()` skips the check entirely — a stale version is accepted and the write lands | `client.js:6197` comment | ran: `version: 1` against a row at 2 succeeded |
| Revision to the browser | `x-version` names the column; the resource remembers the revision it READ per row and sends that, never the latest it heard | `litestone/src/jsonschema.js:797`, `sierra/src/resource/resource.js:900–964` | source |
| Announcement timing | Held until COMMIT (`FJS-D170`); a rolled-back write announces nothing | `junction/src/core/service.ts:540`, `litestone/src/core/cross-process.js:28` | source |
| Side effects | `ctx.afterCommit` — runs once, success path only, **at-most-once** across a crash | `service.ts:883–924` | source |
| Durable effects | `ctx.enqueue` writes an outbox row in the call's transaction; a kick after commit plus a sweep (5 s default) delivers it — **at-least-once** | `junction/src/plugins/outbox/index.ts:1–40` | source |
| Second process, same file | `database main { announce crossProcess }` records the id after commit; others re-read — at-most-once, one machine only | `cross-process.js:1–36` | source |
| Reconnect | No sequence number in frames, on purpose; a reconnect is a `resync` event and the client reloads | `junction/src/client/index.ts:1170–1182` | source |
| Offline write | Queue-first, cleared on acknowledgement, keyed for idempotent replay; refused for a Model with no `@@sync` | `sierra/src/resource/pending.js:1–30`, `FJS-D298` | source |
| Replicas | Litestream ships the WAL to object storage for recovery; nothing reads from it | `litestone/docs/replication.md` | source |
| Tenants | `strategy database` makes each tenant its own file, so a transaction is per tenant; nothing spans two | `litestone/docs/multi-tenancy.md` | source |

So the model, read off the code, is: **serializable per file, revision-checked
per row, announced after commit, effects at-most-once unless they go through the
outbox, and a gap on the wire answered by a reload.** That is a coherent model.
Nobody has written it down as one.

## The gap, as a failure an app hits

Three, in order of how often they will happen.

1. **A job overwrites a person's edit and nobody is told.** A caravan job runs
   as the system, reads an `Invoice`, does network work for two seconds, and
   writes `status` back. Meanwhile a person saved a note through the form. The
   job's write lands — `asSystem()` skips `@version` — and if the job wrote the
   whole row, the note is gone. The comment's reason (*a job is not a second
   editor*) is true of a migration and false of a job that read before it wrote.
2. **The service's author cannot answer "is this exactly-once?"** without
   reading four comments in three packages. `afterCommit` and the outbox give
   opposite crash guarantees under adjacent names; an email sent from
   `afterCommit` is silently lost on a crash, and an app that needed it
   delivered had to know to use `enqueue`.
3. **A second machine sees nothing and says nothing.** The day an app runs two
   API hosts (or a worker on another box), cross-process announce is
   one-machine by construction, live stores on host B miss host A's writes, and
   the only signal is a screen that is quietly behind. `cross-process.js`
   states this; nothing at boot does.

## Options

### **A** — State the model; close the one hole

Write the table above as `docs/CONSISTENCY.md` — one row per seam, each row a
guarantee and its failure mode — and make `asSystem()` honor a version **the
caller supplied**: absent stays exempt (a migration), present is checked (a job
that read first). Spelling, unchanged for everyone else:

```js
const inv = await $.db.asSystem().invoice.findUnique({ where: { id } })
await $.db.asSystem().invoice.update({ where: { id }, data: { status: 'sent', version: inv.version } })
// → VersionConflictError if a person saved in between
```

*Cost:* one branch at `client.js:6203`, one document. *Refuses:* nothing new is
coined; no guarantee is strengthened except the one a caller asks for by
passing the value.

### **B** — Name the delivery guarantee at the call site

A has the outbox and `afterCommit` side by side. B makes the guarantee the
word: `ctx.afterCommit(fn)` stays at-most-once, and the durable one is spelled
as what it promises rather than where it is stored —

```ts
ctx.afterCommit(() => sendToast())          // at most once — lost on a crash
ctx.enqueue('invoice.email', { id })        // at least once — survives a crash
```

— plus a dev-mode warning when an `afterCommit` callback calls a Conduit
target or mail (the effects a crash makes a person notice). *Cost:* a check in
the drain at `service.ts:904`. *Refuses:* exactly-once — the framework says
at-least-once and makes handlers idempotent by the job id (`caravan`
`dispatch({ id })` already is).

### **C** — A commit position, carried end to end

Every committed write gets a per-database monotonic position (SQLite's
`PRAGMA data_version` is per connection and does not survive restart, so a
counter row). Frames, results and the reconnect handshake carry it; a client
reads `asOf` a position and a replica or second host can answer "not yet".
This is what makes read-your-writes hold across hosts and replaces the
reconnect reload with a replay.

*Cost:* the stamp on six encode paths `client/index.ts:1176` already priced,
plus a log to replay from, plus a read replica that does not exist yet.
*Refuses:* nothing today — and that is the argument against it: it is built for
a topology no app here runs.

## Recommend A, with B's warning — why

A closes the only failure that loses data on a single machine today, and the
document is what every other row needs: each guarantee already exists and is
correct; what is missing is the page that says so. B's naming is already
right — `enqueue` *is* the durable one — so only its warning is worth taking.
C is priced against the simpler version (*Cut one level simpler*) and loses
until a second host is real; when one is, `cross-process.js`'s *one machine*
clause is the line to revisit, and a boot-time refusal ("two hosts, no shared
announce") is cheaper than C and comes first.

## Nouns

A coins none. If the page needs headings, the words are the ones the database
literature already owns, used in exactly that sense:

| Word | Sense here | Collides with |
| --- | --- | --- |
| **read-your-writes** | after a call resolves, the same caller's next read sees it | none in the tree |
| **at-most-once / at-least-once** | the crash guarantee of an effect | none; caravan's retry docs use them loosely — align |
| **revision** | the value of the `@version` column a screen read | `@version` (attribute), `x-version` (schema keyword), `version(id)` on a resource, `x-fjs-build` (the build a client runs) — **at least four senses of "version"**; the paper uses *revision* for the row value and leaves `@version` as the attribute's name |
| **position** (C only) | a per-database commit counter | `$after`/`endCursor` (a page cursor, not a commit), outbox `attempts`; would need its own ruling |

**`sync` — the open atlas collision, swept.** Live senses found:
(1) `@@sync(<policy>)`, what a Model allows offline (`FJS-D298`);
(2) `bun:sqlite` is *synchronous* (`concurrency.md`);
(3) the wasm *sync build* with `AccessHandlePoolVFS` (`DECISIONS.md:3830`);
(4) *Sync from provider* in basecamp (`DECISIONS.md:2274`);
(5) the client's `resync` event (`client/index.ts:244`);
(6) *kept in sync* as prose for a projection (`DECISIONS.md:1163`);
(7) Node `statSync`/`appendFileSync`. Only (1) is a framework noun about
consistency. This paper's position: **`sync` stays `@@sync`'s word and nothing
else's** — (5) should be read as *reload after a gap*, and a consistency page
must not use *sync* for replication, announce or outbox delivery.

## Open questions for the owner

- **`asSystem()` and a supplied version** — **A** check it when present
  (above); **B** keep the exemption and document that a job must re-read inside
  a transaction. *Recommend A* — the value arriving is the caller saying it read
  first; ignoring it is the silent kind of permissive.
- **Where the page lives** — **A** `docs/CONSISTENCY.md` at the root, beside
  `TESTING.md`; **B** a section of `litestone/docs/concurrency.md`. *Recommend A*
  — four of the rows are Junction's and two are Sierra's.
- **Second host** — refuse at boot when `announce crossProcess` is declared and
  a second host is detectable, or only document it? Detection is the hard part;
  *recommend* document now, refuse when `outpost` knows the fleet shape.
- **`resync`** — rename to say what it means (*reload*), given the sweep above?
  That is a rename with every caller moved, if taken. — **ruled `FJS-D661`: `reconnected`**,
  named for what happened, beside `connect`/`disconnect`/`reconnecting`.
