---
id: corpus-synthesis
status: assessment
dated: 2026-09-27
---

# Idea — the corpus read as one document

**Status: ASSESSMENT. Nothing here is a plan.** Dated 2026-09-27. It reads the other
files in `IDEAS/` and the counts in it are true for an afternoon. Each move it names is
owed its own paper or ruling before anything is built. See `VERIFYING.md`.

**Why this is not `overview.md`.** The overview ranks rows. This asks what the rows
share: which findings recur across clusters that never cite each other, and which
keystone of one cluster sits unread in another.

**How it was read.** Six readers each read one cluster in full (data semantics · time,
money and verticals · surfaces and agents · UI · deploy, ops and testing · meta and
process), about 400k words between them. The overview and the newest meta files were
read directly. Counts marked *measured* were re-run against the tree on this date; the
rest are the readers' citations and are leads.

---

## The finding, in one line

The files are less a list of ideas than 135 doors onto five facts, and each fact is
recorded most sharply in a cluster that does not know the others found it too.

---

## 1. Entropy has a second tail: the thing nothing reads

`entropy.md` counts a fact written in TWO places. The corpus's most frequent defect is
the opposite count: a thing written once that nothing READS, and a check nothing can
make FAIL. Both are silent, for the same reason — each is right about itself.

*Measured:* `already` occurs 1,784 times across `IDEAS/`, `already exists` 91 times,
and `nothing reads` / `no caller` / `pointed at nothing` / `read by nothing` about 55.

- **Checks that could not fail.** `release-transitions.md` 1g: *"~1250 green tests
  over a path that had executed zero times."* `deploy-plane.md`: `deploy:local` exited
  0 on every failure. `testing-realm.md`: 333 assertions passed with a branch deleted
  from the plugin. `performance-regression-watch.md`: *"nothing moved and nothing was
  measured are otherwise one answer."*
- **Capabilities built and read by nothing.** `tables-from-the-seed.md`: `x-filterable`
  reaches the browser and no screen reads it. `alerting.md`: junction has the store,
  basecamp the evaluator, no app both. `testing-realm.md`: 925 lines of generators,
  *"No caller."* `analytics-and-warehouse.md`: six of seven categories *"pointed at
  nothing."* `metric-store.md`: *"One missing owner holds five built things shut."*
- **What a reader found once one arrived.** Pointing two real screens at the table
  surfaces found four defects in a day (`tables-from-the-seed.md`). Resolving
  identifiers over the unit that actually runs found four live defects on a green tree
  (`scope-checking.md`).
- **The index's own failure is this one.** `overview.md` has gone stale eight times by
  one mechanism — a claim written from a grep, which reads a producer and never a
  consumer.

An artefact with no reader, a check with no failing input and code that never ran are
one defect: **no falsifier**. `process-entropy.md`'s ladder puts a grader on rung 3 and
says it costs nothing to keep; a grader with no negative control is rung 1 wearing rung
3's clothes.

**The move.** Two classes beside `restated-fields`: *orphan* (an emitted key, export or
command no consumer reads) and *unfalsified* (a grader that lands with no paired input
that turns it red). The negative control is already this repo's best habit —
`release-transitions.md` 3b, `deploy-plane.md`'s reintroduced `FJS-238`,
`testing-realm.md`'s reverted `FJS-195` — and is written down nowhere as a rule.

---

## 2. `asSystem()` and the method body are one hole under eight names

*Measured:* `asSystem` occurs 124 times across `IDEAS/`. Three readers, given different
clusters and no hint, each returned it as their cluster's keystone.

The rows it sits under: `FJS-519` (a capability on the table that decides access is
enforced by nothing), `FJS-611` (`@@transitions` bypassed), `FJS-1087` (a method body
writes through it before reading), `ontology.md` (it removes the lock `FJS-D353` takes
once-ness from), `ledger.md` (a balance `asSystem()` or a seed breaks *"without a
sound"*), `support-mode.md` (a `@capability` grant became a hook), `schema-variants.md`
(the public door onto a private table) and `scoped-sql.md`.

**Underneath: two kinds of declaration share one switch.** An *authority* rule says who
may — `@@gate`, `@@allow`, `@@capabilities`. An *integrity* rule says what must hold —
`@@transitions`, `@@check`, a balance, `@@arc`, once-ness. `asSystem()` drops both.
*Corrected 2026-09-27 by probe: it drops `@@transitions` and nothing else on the
integrity side. `@@check`, `@@arc`, `@immutable`, seals and `@unique` all hold under it.
The ruling this section asks for is `FJS-D502`, and it is narrower than written here.
Ruled 2026-09-28: `asSystem()` holds the machine and lifts only a move's `@gate` and
`@system`, and `FJS-D470` holds it to the entry too.*
**The files already sort them by hand**: `polymorphic-relations.md`,
`declared-field-state.md`, `partial-indexes.md` and `ontology.md` each push a rule into a
CHECK or a unique index *because* `asSystem()` *"cannot drop a CHECK"*. The split exists;
it is spelled as *where the rule compiles to* rather than stated.

**The method body is the other half.** `declared-method-contract.md`: *"a tool cannot
see inside a function."* Every projection — MCP, the app CLI, chat, the intent resolver,
the access snapshot — is bounded by the declared fraction: basecamp leaves roughly two
fifths of its method payloads undescribed (`app-cli.md`), and every false claim in
`run-intent-recognizer-3.md` was about undeclared code. Two proposals exist for the
contract — `FJS-D149`'s `@@actions` and `declared-method-contract.md`'s `method` block —
and neither cites the other.

Read together, Invariant 6's *"No exceptions"* is today a goal: `owed-rulings.md`
carries `D470` (create skips the transition gate), `D472` and `D473`; `D481` (a delegated orphan read by every
tenant) was ruled closed.

**The move.** A system principal drops authority and never integrity, and takes a
declared reach (`asSystem()` minus one rule) for the authority half. `@@check` is the
one integrity rule still written in raw SQL; moving it onto
`@frontierjs/toolbelt/predicate` — where `@required(where:)`, `@@index(where:)`,
`@@commitment(while:)` and the variant discriminator each already restate a restricted
grammar — gives the integrity tier one language, a field to attribute a refusal to, and
the browser evaluator `FJS-D259` built.

---

## 3. What the seed derives is a snapshot; what breaks, breaks over time

`ontology.md` sorts the world into what *is* and what *happens*, and filled one cell of
the second half. The first half is thorough. The second is built again in every realm
under a different name:

| Where | The durable run |
| --- | --- |
| Release | the deploy journal · the backfill |
| API | the outbox relay · the cron fire · `--await` (`app-cli.md`) · the approval hold (`agent-surface.md`) |
| Data | a pay run (`payroll.md`) · dunning (`billing.md`) · a bulk import (`bulk-data.md`) |
| UI / device | the Homestead queue · a conflict's held write (`conflict-as-data.md`) · a stream (`chat-surface.md`) |
| Automation | orion's runs |

Beside it: four time axes with no owner (valid, knowledge, transaction, event against
arrival — the time cluster), the audit trail asked to be five things and redaction
breaking three of them, *"nothing announces a change that was not a write"*, and the UI
reader's one-line summary of its own cluster — **compiler facts are snapshots, and the
UI realm breaks on sequences.**

**Why 4.19 never gets ruled** (inference). The deferral rule is sound — *"two narrow
mechanisms that look alike are not yet a primitive"* (2.3e) and *"one use is a choice,
two is a finding"* (`list-controller.md`). But each instance arrives in a different
realm under a different word, so no single file ever counts two. **A consumer count
taken per file cannot trip on a primitive that crosses realms.** `release-transitions.md`
says both *"4.19 stays where it is"* and *"enough to rule 4.19 rather than defer it."*

**The move.** Rule 4.19. The candidate to extract is the deploy journal — format version
from row zero, additive step kinds, `occurrenceKey`, the `attempt` term — because it is
the one proven through a crash (`deployJournalCycle`). *Struck 2026-09-27: a survey of
the six mechanisms found that the part crossing realms is the occurrence key, which is
already extracted. Claimed, ordered, resumable steps exist in the journal alone, and
compensation exists nowhere. The ruling is `FJS-D503`, and it recommends against the
extraction proposed here.*

---

## 4. Unknown is a third value with four spellings, and absence reads as yes

Spellings of *cannot tell*: `ungraded` (`agent-surface.md`), `unhomed`
(`intent-recognizer.md`), `unknown` (`classifyPivot`), the live matcher's `null`
(`live-queries.md`). Places where absence was read as permission:

- an absent `x-sortable` read as sortable (`FJS-1043`), and `publishes: 0` as the default
  bar silencing both fail-closed branches (`static-safety.md`);
- `@@check("price > 0")` on `price Int?` accepts a row with no price (`geo.md`);
- a zero vector is *"the top hit of every query, forever, with a 200"* (`embedding.md`);
- a zoned `datetime()` returns NULL and the screen is empty with a 200
  (`time-and-recurrence.md`);
- a claims resolver returning a Promise grades everyone claimless (`D472`).

*Fewer rows, status 200* is used as an explicit design criterion in three clusters that
do not cite each other (`geo.md`, `permission-sets.md`, `polymorphic-relations.md`).

**The move.** Polarity follows enforcement. On the enforcing side an unknown fails
closed and names itself; on the affordance side it may fail open only where the
enforcing side refuses by name — Invariant 6's `x-gate`, stated as a rule rather than a
case. An enforcing read that treats an absent key as permission is a `fli check` class.
The four spellings want one word, and `controlled-language.md` is where it would be
coined.

---

## 5. `IDEAS/` breaks its own entropy law

- **Status is written in up to five places and graded in none** — frontmatter, the
  header line, an `overview.md` row, `map-packages.md`, and the tree. *Measured:*
  `geo.md` says *"none of it is built"* while `@point` is in litestone's parser, DDL and
  query compiler, `toolbelt/src/geo/` exists and `verify:geo` is a drive. The readers
  found the same drift in `ontology.md`, `api-ontology.md`, `orion-port.md`,
  `app-cli.md`, `list-controller.md`, `untrusted-bytes.md`, `restore-verify.md` and
  `review-coherence.md` (which still calls `FJS-D06` open).
- **A cluster's keystone sits unread in another.** `orion-port.md` built the first real
  rig, and `rigs.md` and `map-packages.md` still ask which rig comes first —
  while orion LINKED its UI where `rigs.md` says a resource is ejected.
  `stored-templates.md` is blocked on moving the parser out of litestone, which
  `orion-port.md` did. `@retain` (`compliance-from-the-seed.md`) is a commitment
  (`ontology.md`). Support mode's `actorId` / `subjectId` / `episodeId` is the
  attribution `agent-surface.md` defers. `schema-variants.md` found two instances of the
  default-hidden partition; `@@expires` is a third.
- **The nine mostly ratify.** *Measured:* 47 of 441 rulings in `DECISIONS.md` say
  *"Ratified as built: graded on § V after the fact"*; 13 say they were graded before
  the first edit. Separately, where a paper's recommendation and the ruling differ, the
  ruling has been the more permissive one — orion three times (`D272` among them),
  `app-cli.md`'s `FJS-D397` once.
- **The grader layer's own cost is uncounted.** `process-entropy.md` prices rung 3 at
  *none*; `stressors.md` records a pinned red costing a session.

**The move.** Derive status rather than state it. Every recent paper ends with the nine,
and the ninth names the artefact that fails — a `fli check` rule id, a test, a drive.
Whether that artefact exists in the tree IS the build state; a paper whose ninth answer
is `none` is `proposed` by construction. Then the hand-written status lines go.

---

## The cheapest instrument measured anywhere in the corpus

**Support questions are probes.** Across `run-intent-recognizer-2.md` and `-3.md` the
same fifteen customer messages surfaced eleven defects, and the second run cost about
$32 in total. `stressors.md` records its own first run re-reading 418M tokens against
3.9M written. No schedule runs the first instrument.

---

## Order, if any of it is taken up

1. Rule 4.19 by extracting the deploy journal (§ 3).
2. Split `asSystem()` into authority and integrity; `@@check` onto the predicate
   grammar (§ 2).
3. *orphan* and *unfalsified* beside `restated-fields` in `entropy.md` (§ 1).
4. Derive `IDEAS/` status from the ninth answer (§ 5).
5. The polarity rule (§ 4).

## The nine (answered before the edit, 2026-09-27)

1. Origin — none added; it cites the source files and restates their verdicts only as
   pointers.
2. Concept — two candidate words, *orphan* and *unfalsified*, named as proposals for
   `entropy.md` and coined nowhere until a rule id carries them.
3. Complexity — the corpus's, not this file's; it removes none and adds a document.
4. Predictability — no behavior.
5. Derived — no; a reading is not derivable from the tree, which is why it is dated.
6. Owner — `overview.md` owns ranking; this owns nothing and links from its § See also.
7. Boundary — none crossed.
8. Failure — none; an assessment refuses nothing.
9. Silence — nothing to keep true. **none.** It goes stale the first time a cited file
   moves, and its date is the only warning.

Adjudication: *coherence vs. convention* — a cross-cluster finding that lives in no file
lives only in a session. Tier: Assessment.

## See also

- `overview.md` — the ranked index this reads across
- `entropy.md` · `process-entropy.md` — § 1 is their missing tail
- `ontology.md` · `release-transitions.md` — § 3's two halves
- `owed-rulings.md` — where § 2's defects wait
