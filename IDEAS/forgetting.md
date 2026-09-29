---
id: forgetting
status: proposed
dated: 2026-09-29
---

# Idea — forgetting: what erasure means, declared per column

**Status: IDEA, nothing built.** Dated 2026-09-29. Every number below was
measured by the jazzhr stressor's Phase 2 probes
([`fjs-prototypes/jazzhr/.probe/phase2/`](../../fjs-prototypes/jazzhr/.probe/phase2/))
against the real app client, its caravan queue and its audit trail, not read
from source. Do not cite this file as describing behavior — see `VERIFYING.md`.

It is [`compliance-from-the-seed.md`](compliance-from-the-seed.md) items 1–3
with a product attached, and it answers that paper's open question *anonymize
or delete*: **both are app code and both work; neither can be finished by app
code**, because the copies that survive are in stores the framework owns.

---

## 1. The product, and the hard version

An applicant tracker (jazzhr) keeps every personal fact about an applicant on
one row, `Candidate`, and points everything else at it by id. Two erasures
run on different clocks: a daily retention job forgets everybody whose every
application was rejected more than 180 days ago, and a subject request forgets
one person today, mid-pipeline, with scorecards, messages, a résumé and a
stage history. The product still sells two numbers that must not move:
*applicants by source per quarter* (R1) and *median days in each stage* (R2).

Seed: 500 applicants over 18 months through the app's own pipeline code, the
clock aged in the tables. Erasure: 288 by retention (run as the caravan job,
fired twice), 2 by subject request.

---

## 2. What app code did, and it was enough

| | R1 (total, cells changed) | R2 (4 medians) |
| --- | --- | --- |
| plain `delete()`, report from the rows | 500 → 210, 26 cells | every one moved |
| **A** — aggregate tables the move writes (`IntakeCount`, `StageSpan`) | 500 → 500, 0 | identical |
| **B** — tombstone: personal columns nulled, rows kept | 500 → 500, 0 | identical |

- **The clock is a job.** `dueForRetention` plus a loop is 15 lines; the second
  run of the day finds 0. A declared clock would have to say *every child
  rejected AND older than*, which is a query, not a column trait. **No word.**
- **The tombstone is 40 lines** (`forget.ts`). Its one schema cost:
  `name`/`email` become optional to be nullable later, and *required until
  forgotten* is `@@check("forgottenAt IS NOT NULL OR (name IS NOT NULL AND
  email IS NOT NULL)")`. It holds against `asSystem()`. What a generated form
  now thinks of `name` is Phase 3's to measure.
- **The aggregate** needs a counter upsert litestone refuses (FJS-1498) and
  took three statements.

So on the question the paper asked, **anonymize or delete needs no word for
the main tables.**

---

## 3. What app code could not reach

The erasure map, after both spellings (needles: each forgotten person's email,
unique per person; the subject requests' phone):

| Store | delete | tombstone (B) | Who owns it |
| --- | --- | --- | --- |
| main tables | 0 | 0 PII; 290 rows keyed to the forgotten, by design | app |
| `@@log` snapshots | **576** + 8 | **576** + 8 | litestone |
| `@@log` for cascaded children | **no line at all** | n/a (explicit deletes) | litestone (FJS-1497) |
| trail index sidecar (`.index.db`) | 0 | 0 | litestone |
| file store (résumés) | **288 + 2 left** | 0 | litestone plugin (FJS-1497) |
| caravan `jobs.db` payload | **1** (this week's rejection email, `done`) | **1** | caravan |
| freed SQLite pages | **209** + 4 | **90** + 4 | SQLite / litestone |
| freed pages, `secure_delete = ON` via raw SQL | | 18 | |
| freed pages, `VACUUM` after | | **0** | |
| FTS shadow, soft-deleted rows, outbox | not declared on this path | | |

Three things in that table are not app mistakes:

1. **The erasure writes a new copy.** The trail's `before` on the `delete` (or
   the tombstone's `update`) is the person's name, email and phone, written at
   the moment they were forgotten. 288 people → 576 hits, for either spelling.
   Invariant 7 redacts only `@encrypted`/`@guarded`/`@secret`, each of which
   also stops staff reading the column (FJS-1485).
2. **The trail re-identifies what was kept.** The D349 test, run on purpose:
   - *B + trail*: `SELECT id FROM candidate WHERE forgottenAt IS NOT NULL`, then
     the `candidate.create` line whose `records` is that id → **290/290**.
   - *A + trail*: each `StageSpan` (stage, source, exit day, days) matches one
     application's consecutive `stageAt` pair in its `application.update`
     snapshots (**850/850 spans unique**); that line's `candidateId` finishes the
     join → **290/290**. Coarsened to whole days and ISO weeks: **264/290**.
   - *B alone, trail purged*: 256/290 forgotten applications are the only one of
     their (job, applied day). That residue is a quasi-identifier problem every
     kept timestamp has; it is not the framework's (§ 5).
   Every join above ends on a trail line that holds a name. Take the name out of
   the trail and the first two joins end on an id that names nobody.
3. **A cascade is invisible** to `@@log` and `FileStorage` (FJS-1497), so the
   obvious verb, `delete()`, leaves every résumé on disk and tells the trail
   nothing about 288 applications.
   **Since fixed** (FJS-1497 closed); jazzhr Phase 3's re-run of the `delete`
   spelling left **0** files.

**Phase 3 added two more, both measured** (`jazzhr/.probe/phase3/`):

4. **The link's own trail line keys to the person** (FJS-1485, amended). A
   bearer's write is `actorId` = the grant row, `subjectId` = the candidate
   (FJS-D342, as ruled). After the grant is deleted and the person forgotten,
   every door answers as if the link never existed — and the line's snapshot
   still holds her email, and its `subjectId` still joins to the create line.
   Under C the snapshot half is covered by `[personal]`. The `subjectId` half is
   covered only if redaction happens AT WRITE (open question 1): an erase-time
   rewrite must find lines by `subjectId` as well as by `records`, or it misses
   every line a link holder wrote.
5. **Nullable-for-the-tombstone leaks into every form.** Spelling B makes
   `Candidate.name`/`email` optional, held by `@@check(forgottenAt IS NOT NULL
   OR …)`. The generated apply form then labels both **(Optional)**, and an
   empty submit shows *Name and email are required* above *Name (Optional) —
   must be at least 1 characters*. A `@personal` column must stay required to
   every caller and every form; only the verb may null it. That argues for C's
   verb writing below the field rules (as `asSystem()` writes below the gate)
   rather than for the app loosening the column.

**Phase 4 added one, measured** (`jazzhr/api/test/offer.test.ts`):

6. **A sealed document meets the erase verb.** The offer's signature is bound
   to the accept by `@@check((status = 'accepted') = (signedName IS NOT NULL))`
   (FJS-1512). The tombstone verb nulled `signedName` on every offer, so on an
   accepted one it would now be refused by that check, and the delete spelling
   was already refused by the offer's `onDelete: Restrict` (FJS-1454). jazzhr
   now refuses to forget a person with an accepted offer, by name, under both
   spellings: a hire is an employment record, not an applicant's data. Under C
   that is a declaration the verb must read — *these rows end the subject's
   erasability* — or `[personal]` on `signedName` walks straight into the seal.
   It is also a second case of item 5: the signature is optional in the schema
   only because it is null before the accept, so the signing box read
   **(Optional)** until the page stated `required`.

---

## 4. What it would look like in `.lite`

```prisma
model Candidate {
  name   String   @personal @length(1, 120)
  email  String   @personal @email
  phone  String?  @personal @phone
  @@subject                     // a row of this model IS a person
}

model Application {
  candidateId  Int      // → Candidate, onDelete: Cascade
  source       Source   // kept: not personal
  coverLetter  String?  @personal
  referredById String?  @personal
}

model Message {
  body String
  @@personal                    // the whole row is about the person: deleted
}
```

- **`@personal`** — a column that is about a person. The caller reads it exactly
  as the policies say (it is NOT `@encrypted`). `@@log` writes `[personal]` for
  it in every snapshot — the fifth row of the visibility table: *the caller
  reads it and the trail does not keep it*. On a required column it is required
  at create and nullable in storage, and only the erase verb may null it: the
  `@@check` above, derived.
- **`@@subject`** — where forgetting starts. `db.candidate.forget(id)` walks the
  inbound relations: a `@@personal` model's rows are deleted **one at a time,
  through the plugins** (bytes removed, a trail line each); a model with
  `@personal` columns is kept with them nulled; anything else is kept. It
  writes one trail line, `operation: 'forget'`, with no snapshot. It refuses by
  name what it cannot do — a `Restrict` child, a sealed `@immutable` personal
  column — before it changes anything. It runs its statements under
  `secure_delete` and leaves the file compacted.
- **The export falls out**: the same walk, reading instead of nulling, is the
  subject-access export compliance-from-the-seed item 3 asks for.

---

## 5. What it does not do

- **The clock.** Retention stays a job the app schedules (FJS-D36): *when* is a
  query over children, and §2 measured it as 15 lines.
- **The queue.** A job payload is whatever the app handed caravan. Caravan
  cannot know a field was `@personal` once it is JSON. Nearest honest help: an
  `advise` rule for a dispatch whose payload reads a `@personal` column, and
  pass ids, not addresses. Not built here.
- **Quasi-identifiers.** Exact timestamps on kept rows re-identify with outside
  knowledge (256/290, §3). Coarsening is the report's choice, and a schema word
  cannot know what an adversary knows.
- **Other people.** `referredById` is a colleague, not the subject; `@personal`
  nulls it with the subject's row, which is right here and is not a general
  answer for third-party data.

---

## 6. The nine, answered before the first edit

1. **Origin** — the column's declaration is the one origin for *read it*, *log
   it*, *erase it*, *export it*. Today they are four places: the policy, a
   comment, `forget.ts`, nothing.
2. **Concept** — two words: `@personal` (a column) and `@@subject` (where the
   walk starts), plus `@@personal` as the whole-row shorthand. The verb is a
   method, not a word.
3. **Complexity** — removes `forget.ts`, the `@@check`, the `forgottenAt`
   convention and the trail problem. Adds a relation walk the engine already
   half has in `include`, and the cascade-through-plugins FJS-1497 needs anyway.
4. **Predictability** — `@personal` reads exactly like an unmarked column;
   the only visible difference is in the trail, which is where it is meant to
   be.
5. **Derived** — the trail redaction, the nullable storage plus the check, the
   export, and a data map (`litestone access`) all come off the one mark.
6. **Owner** — litestone: the parser (the words), `audit-log.js` (redaction),
   the client (the verb). Junction exposes the verb as a service method; caravan
   is untouched.
7. **Boundary** — the app decides WHO and WHEN (the job, the request handler);
   the framework decides WHAT forgetting does to each column. That is the line
   §2 and §3 measured.
8. **Failure** — `forget()` refuses a `Restrict` child or an immutable personal
   column by name before any write; a half-forgotten person is the one outcome
   it may never leave.
9. **Silence** — must stay true: *after `forget(id)`, no store litestone owns
   holds a `@personal` value that row held.* The test is §3's measure script
   run as a litestone test over the main file's bytes, the trail and the file
   store. **Today: fails in three stores.**

**Tier:** Assessment. A ruling goes to `DECISIONS.md`; built behavior to
`packages/litestone/docs/schema.md`.

---

## Open questions

- **FJS-D547 — Q1: does litestone take `@personal`, and is it redacted in the trail at WRITE or rewritten at ERASE?**
  FJS-1485 waits on it: `protectedLogFields` (`packages/litestone/src/core/client.js`,
  above `redactValue`) is built from `encrypted || guarded || hashed`, each of
  which also stops the caller reading the column, so a readable column's value
  lands in `before`/`after` and no spelling keeps it out. Taking the word is
  the ruling's first half (§ 4, answer C); the options below are its second.
  - **A** — at write, always: the trail says *name changed*, never to what.
    Simple; an append-only store stays append-only. Loses the value for an
    investigation while the person is still known.
  - **B** — kept at write, rewritten for that subject's lines when `forget()`
    runs. Keeps the investigation value; turns the JSONL logger into a store
    that edits its past, and the rewrite has to reach the index sidecar and
    every rotated file.
  - **C** — A by default, B per model with an argument.
  - **Recommend A** — the trail's job is *who did what, when*; §3 shows the
    value is where every re-identification ended.

- **Q2 — What does `forget()` do to a kept row: tombstone or delete?**
  - **A** — tombstone by default (null the `@personal` columns, keep the row),
    `@@personal` for delete. The reports read the raw rows, unchanged (§2).
  - **B** — delete by default, and reports are aggregate tables the app writes.
    §2: works, costs a table per report and FJS-1498's workaround.
  *Recommendation: A.* It is what the declaration naturally says, and B is still
  open to an app that wants it.

- **Q3 — Does the retention clock get a word (`@@retain(180d, from:, when:)`)?**
  - **A** — no; a job, as measured.
  - **B** — yes, on the `@@subject`, compiled to the same sweep `$retain` runs.
  *Recommendation: A* until a second product asks for a clock that is a column
  trait rather than a query over children.

---

## See also

- [`compliance-from-the-seed.md`](compliance-from-the-seed.md) — items 1–3; this
  record answers its *anonymize vs delete* question
- `ISSUES.md` — [FJS-1485](../ISSUES.md#fjs-1485) (the row this answers),
  [FJS-1497](../ISSUES.md#fjs-1497) (cascade unseen by plugins),
  [FJS-1498](../ISSUES.md#fjs-1498) (counter upsert),
  [FJS-1454](../ISSUES.md#fjs-1454) (the delete-direction FK error),
  [FJS-1480](../ISSUES.md#fjs-1480) (the trail's own retention never runs)
- `DECISIONS.md` — FJS-D349 (the trail as a correlation hazard, measured here the
  other way), FJS-D342 (a bearer's trail row carries the subject), FJS-D36 (the
  clock is the queue's)
- [`fjs-prototypes/jazzhr/PLAN.md`](../../fjs-prototypes/jazzhr/PLAN.md) § Q1 and
  § Erasure map
