---
id: conflict-as-data
status: proposed
dated: 2026-09-18
---

# Idea — Conflict as data: the mechanism under `@@sync(manual)` and `@@sync(field)`

**Status: PROPOSED. Nothing here is built.** Dated 2026-09-18. Read from Dolt's
own documentation rather than from its tree — every specific about Dolt below is
a lead to verify (`VERIFYING.md`). What is measured is the absence: the greps
against this repository are real and are named.

**`IDEAS/homestead.md` owns `@@sync` and its value set** (`FJS-D298`,
`FJS-D304`), and this paper does not restate either. It argues the mechanism
under two of those values, which phase 5 left as a size and a footgun, and it
**corrects two rows** in that paper's vocabulary table — struck there, in place,
pointing here.

---

## Trigger

A review of Dolt, which is a SQL database with a git commit graph inside it.
Grepped before writing: this repository cites it in **one sentence**, inside
`release-transitions.md` § *What was falsified*, for the narrow claim that
database state can participate in a rollback. The rest of what it built was
never read.

Most of it is not for here — the storage engine is the wrong bet for a framework
whose Data realm is a SQLite file, and that is argued in `prior-art.md` § 5.
**One piece is directly under a phase this repository has already scheduled.**

---

## What Dolt does that the sync engines do not

`prior-art.md` § 4 reads eleven sync engines and lands on a conflict vocabulary
drawn from timestamps and CRDTs. Dolt is in neither family: it merges the way
git merges, with a **base**.

**A three-way merge asks what CHANGED, not what is newer.** For each cell it
holds three values — the common ancestor, and what each side has now — and the
rules fall out with nothing left to decide: neither side changed it, keep it;
one side changed it, take that side, whatever the clock says; both sides changed
it to the same value, keep it and say nothing; both sides changed it
differently, that cell is a conflict and only that cell.

The consequence is the reason to read it. **Three-way needs no ruling about
whose clock is authoritative, because it never compares times.** The
`@@sync` vocabulary table prices `lww` with *a ruling on whose clock*, and
`field` — last write wins per column — inherits that ruling and adds per-field
metadata to carry it. Three-way pays neither. It asks a question both sides can
answer from what they already hold.

**And a conflict is a relation, not an exception.** Dolt lands the merge and
leaves what it could not decide in a queryable table per model — one row per
conflicted row, carrying each column three times — plus a second table holding
one count per model. Resolution is then an ordinary write, or a bulk *take one
side* for the whole model.

**So a merge does not block.** Thirty-nine held writes that apply are applied;
the fortieth is a row somebody resolves later. A device returning from a tunnel
with a day of work does not stall on the first collision.

---

## What FJS already has to build it from

The argument for doing this here rather than reading it and moving on is that
**the base already exists and nothing consumes it.**

- **The revision a write was made against** is stored — `FJS-D138` keeps it as
  the intent the screen reads, `@version` crosses to the client as `x-version`,
  and `@@sync(refuse)` already refuses a replay when the row moved. `refuse` is
  three-way with the conflict branch deleted: it detects exactly the divergence
  this needs, and then throws the information away.
- **The before-snapshot** is written by `@@log(audit)` for every instrumented
  write, per field, with protected fields redacted (Invariant 7). Where the
  revision is not enough, the narrative is there.
- **A conflict relation is a Model**, so it is not a new storage decision. It
  gets a gate, it crosses to the client as a resource, and `<Form>` already
  resolves labels and constraints from the seed — a resolution screen is a
  generated one rather than a bespoke one. That is the difference between
  *conflict storage, a screen, a resolution path* costing three things and
  costing one.
- **The accessor family already exists.** `db.$checkWhere`, `db.$readAs`,
  `db.$levelOf`, `db.$protectedFields` are the Data-realm surface junction reads
  (Bridge index § Data → API). `db.$conflicts(accessor)` belongs with them, and
  putting it there is what gives the API realm, the UI realm and the MCP surface
  the same answer without any of them coining one.

---

## What would have to be built

Ordered by what each one unblocks, not by size.

1. **The cell comparison.** Given a held write, the revision it was made
   against, and the row as it stands, produce per-column one of: unchanged,
   taken, agreed, conflicted. This is the whole of `field` and the detection
   half of `manual`, and it is one function at the Data boundary.
2. **`field` on top of it, with no metadata.** Two people editing different
   columns of one row both win, which is the outcome `field` was reached for.
   Weidner's *independent operations should act on independent state* is
   satisfied by the change set rather than by a timestamp per column.
3. **The conflict relation, and its count.** Per model, one row per conflicted
   row, each column carried as base / local / remote. The count is the artifact
   § V's last question asks for: an unresolved conflict that nothing counts is
   the failure mode of `manual`, and it is silent by construction.
4. **A resolution path that is a write.** Taking one side for one cell, for one
   row, or for a whole model. It runs through the service like any other write,
   so the gate, the hooks and the audit entry are the ones that already exist.
5. **A `fli check` rule.** A model declaring `manual` in an app that renders no
   resolution path anywhere is a pile-up waiting to happen, and it is decidable
   from the seed plus the route table.

---

## The words, which are not Dolt's

**Dolt says `base_X`, `our_X`, `their_X`, and two of those three half-fit.**
*Ours* and *theirs* are stable in git because a merge happens in one place with
one operator standing in it. On a device coming back online they are ambiguous
in the direction that matters: the server holds what several other people did,
and which side is *ours* depends on who is asking and where the merge runs.

`base` / `local` / `remote` says the same thing with the ambiguity removed, and
§ IV's *familiarity vs. precision* is the row that governs it — steal the proven
shape, reject the words when the words half-fit.

---

## What this corrects in `homestead.md`

Both rows are struck in that paper's vocabulary table, pointing here.

- **`field` is priced at *per-field metadata*.** It does not need any. The
  change set derives from a revision that is already stored, and a column nobody
  touched is not a write to be dated.
- **`manual` is priced at *conflict storage, a screen, a resolution path*, with
  CouchDB as the lead.** CouchDB keeps conflicting revisions on the document,
  which is storage without a query surface. Dolt is the better lead: the
  conflicts are a relation, which in this framework means one Model and three
  derived surfaces rather than three built ones.

**What is NOT corrected.** Phase 5 stays last, and `prior-art.md` § 4's fifth
finding stands — ElectricSQL built the ambitious version of this and dropped it.
Three-way merge is the modest version: it decides what it can decide and hands
back the rest as rows. Nothing here proposes that the framework resolve a
conflict nobody declared a policy for.

---

## Cost, and what it is not

**It is not Dolt's storage engine.** Dolt gets cell-level history from prolly
trees and pays for it on every write, in RAM and in speed, by its own account.
None of that is proposed. The comparison here runs against one held write and
one row at the moment of replay, not against a commit graph, and it disappears
entirely for a model that declares neither value.

**It is not a general merge.** It is per-cell on one row. A concurrent delete
beside a property update is still the anomaly phase 5 already carries, and
`@@softDelete` is still the archive answer to it.

**The honest unknown is what a conflicted cell means for a column with a
constraint on it.** Two valid values merged into a row that violates a
`@@unique`, a `@@transitions` move or a check is a case with no answer in this
paper.

---

## Open questions

**All three answered 2026-09-20.** The mechanism is ruled; what is left is
building it, which is phase 5 of `IDEAS/homestead.md`.

- ~~**Q1 — does `field` resolve at the Data boundary or at replay?**~~
  **Answered (`FJS-D334`): A — at the Data boundary, on the server, when the
  held write arrives, and the base row TRAVELS WITH the write.** The question
  asked where the comparison runs and not where its base comes from, and the
  second half is the one that decides the first. `@version` is a counter: it
  says the row moved and never which columns moved, so a per-column comparison
  needs the row as it was READ. `@@log(audit)`'s before-snapshot could supply
  it and is refused — it covers only models declaring the log, and Invariant 7
  redacts a protected field in it, so a conflict on a `@guarded` column would be
  undecidable for exactly the columns where being wrong costs most. The device's
  copy is untrusted INPUT and never authority: the server's row decides and the
  constraints run unchanged. **And it is what settles homestead Q10**
  (`FJS-D337`) — a device required to supply the base is a device whose copy is
  load-bearing.
- ~~**Q2 — what does a conflict relation cost a model that never has one?**~~
  **Answered (`FJS-D335`): nothing, because V1 ships no relation.** `FJS-D304`
  ships `append` and `refuse` and nothing else until an app asks, so phase 5's
  deliverable is `field` — which needs no storage at all: it either merges, two
  people having touched different columns, or it does not. Keeping both versions
  until somebody picks is `manual`, and the relation is `manual`'s cost. The
  storage for the V1 outcome already exists: `pending.js` parks a refused write
  in `rejected` rather than dropping it, so a conflict is a rejected queue entry
  carrying `base` / `local` / `remote` in place of a bare version mismatch. The
  conflict is then PER DEVICE with no fleet-wide count, which is the cost, and
  it stops being payable the day `manual` ships — at which point the relation is
  built as § *What would have to be built* describes it.
- ~~**Q3 — is a conflict resolvable by whoever is looking at it?**~~
  **Answered (`FJS-D336`): by whoever may write the ROW, and a protected column
  carries the fact of divergence and neither value.** The precedent named in the
  question was the whole answer. Resolving is a write, so the gate already
  decides and no second ladder is coined; Invariant 7 does the rest, and a
  conflict on an `@encrypted`, `@guarded` or `@secret` column offers take-local
  or take-remote with no display of either side.

---

## See also

- `IDEAS/homestead.md` — the owner of `@@sync`, its value set and phase 5. Read
  it first; this paper is one phase of it
- `IDEAS/prior-art.md` § 5 — Dolt read as a whole, including the four mechanisms
  that point somewhere other than here
- `IDEAS/prior-art.md` § 4 — the sync engines, and the conflict vocabulary this
  paper is arguing with
- `DECISIONS.md` `FJS-D138` — the stored intent that is this design's base
- `DECISIONS.md` `FJS-D298`, `FJS-D304` — the ruled form of `@@sync` and the two
  values that ship
