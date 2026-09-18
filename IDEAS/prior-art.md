---
id: prior-art
status: assessment
dated: 2026-08-26
---

# Idea — Prior art: which projects to read, and what each one is evidence of

**Status: ASSESSMENT. A reading list, not a plan, and nothing here is a
commitment.** Dated 2026-08-26. **The confidence in each entry is stated
inline and it is not uniform** — the Ash section is written from outside
knowledge rather than from a probe of their tree, so treat every specific in it
as a lead to verify rather than a fact (`VERIFYING.md`). What is measured is the
*absence*: the greps against this repo are real and are named.

---

## Trigger

*"If you had to pick a project like FJS that is inspirational rather than
Laravel, which one."* Laravel is the wrong comparator by this project's own
stated strategy — *it will not out-feature Laravel, it can out-cohere it* — so
the useful question is which project made the same bet and is further along.

Answering it turned up a gap worth recording on its own: **Ash Framework is
cited nowhere in this repository.** Grepped across `IDEAS/`, `DECISIONS.md`,
`ARCHITECT.md`, `PHILOSOPHY.md` and `IDEAS/pros-and-cons.md` — zero occurrences. It is
the single most relevant project in existence to this one.

---

## 1. Ash Framework (Elixir) — the same bet, further down the road

**The thesis is FJS's thesis**: declare a resource once and every consumer
derives from it — the data layer, the API, validation, authorization, the admin.
Not schema-first as a code-generation step, which most of the field means by the
phrase, but **declaration as the thing the runtime enforces whether you call it
or not** — the distinction `declared-semantics.md` § *Why declaration beats a
first-class type here* makes independently.

### The convergences, which are the point

Neither project has read the other. Where two designs arrive separately at the
same distinction, the distinction is probably real; where they disagree is where
to look hardest.

| FJS arrived at | Ash has |
| --- | --- |
| `@@allow` filters, `@@gate` refuses | policies that produce a **filter** against ones that **forbid** |
| `tenancy { strategy row \| database }` | multitenancy as an `attribute` strategy against a `context` one |
| `@computed` · `@from` | calculations · aggregates |
| `@@transitions` | AshStateMachine |
| `@@log(audit)` | AshPaperTrail |
| `@@softDelete` | AshArchival |
| `@money`, shipped 2026-08-26 | AshMoney |
| a slice contributing across realms — `slices.md`, **unbuilt** | the extension protocol, which is how every row above ships |

That last row is the one to sit with. **What FJS has as an unbuilt design
(3.2, the slice installer) is the mechanism Ash's entire ecosystem is already
made of.** If the slice format is going to be argued further, it should be
argued against a working instance of the same idea.

### Two places it is ahead of exactly what is scheduled here

- **AshAdmin is 1.1.** A generated admin over declared resources — the table,
  the detail view and the filter bar — in production for years. Read it against
  `tables-from-the-seed.md`: it has already answered that file's Question 2
  (which columns belong in a table) and Question 3 (what a detail view is), and
  whether its answers are the right ones or not, it has the failure modes and
  this project does not.
- **AshAi is 4.2.** Resources exposed as model-facing tools with **the policy
  layer as the permission model** — which is `@frontierjs/mcp`'s whole claim.
  `agent-surface.md` calls scoping *the industry's actual unsolved problem*; a
  version of it has been solved on foundations of the same shape. The half worth
  reading closely is whatever they do about the approval gate, since 4.2's own
  argument is that scoping alone has two settings and both are wrong.

### Where FJS is not behind, so this does not read as *go and copy them*

- **The ordinal `@@gate` ladder has no equivalent there.** Ash answers
  authorization with policies throughout, which is the grid **without** the
  ladder — the mirror of `permission-sets.md`'s gap rather than a solution to
  it. `@@gate("2.4.4.5")` says something short and true that a policy set says
  only at length, and the open question here is how the two compose
  (`FJS-D146` rules that they do, ANDed, with the gate as the floor).
- **Ash is Postgres-shaped; the Data realm here is one file.** That decides
  different answers about backup (`FJS-552`), tenancy as a file copy, and
  sandboxes (4.25). Their assumptions do not transfer.
- **Ash stops at the API and hands the UI to LiveView.** This project owns mesa
  and sierra, which is why `x-gate`, `x-transitions`, `x-values` and
  `x-label-field` reach a browser at all. The client half of the live store
  (`FJS-D138`) has no counterpart there.
- **Committed generated artefacts as the drift mechanism** — a snapshot naming
  its own generator, reasserted by a CI phase that carries no list — is unusual
  anywhere, Ash included (`committed-artifacts.md`).

## 2. Django's admin — narrowly, and for the surface being built now

Not Django. **The admin specifically**, because it is the twenty-year-proven
answer to the exact three surfaces `tables-from-the-seed.md` argues, and its
vocabulary is a ready-made checklist for that record's Question 2:
`list_display`, `list_filter`, `search_fields`, `readonly_fields`,
`list_select_related`, `date_hierarchy`. Each is a decision this project has not
yet made about which columns a generated table shows and what it may be narrowed
by.

Django is cited three times in `IDEAS/` — for timezones (`time-and-recurrence.md`),
for money's two-column shape (`declared-semantics.md`) and for Silk
(`lantern.md`) — and **never for the admin**, which is the one thing it is most
known for.

## 3. Atlas (ariga) — one hour, against `release:check`

Classifies a schema diff as destructive or not, as a product rather than as a
phase. That is `classifyPivot` built by people for whom it is the whole company.
Worth reading for its vocabulary and for what it refuses to decide
automatically — `release-transitions.md` is the consumer.

## 4. The sync engines — the field Homestead is walking into

**Added 2026-09-16, and it opens with the same finding this paper opened with.**
Grepped before writing: the whole repository cited this field **once** — the
words *Replicache and Zero* inside [`FJS-D138`](../DECISIONS.md#fjs-d138) — plus
Convex in passing in `live-queries.md`. Five phases, three rulings
(`FJS-D298`–`FJS-D300`) and a built drive were written against none of it.

**Confidence is not uniform and is marked per claim.** The four findings under
*What it changes* were checked against the projects' own documentation on the
date above; everything in the table below that is not one of those is outside
knowledge, and is a lead to verify rather than a fact (`VERIFYING.md`).

### The reading list, and what each is evidence of

| Project | Evidence of |
| --- | --- |
| **PowerSync** | The queue-first write path, in production, over the same two databases FJS has. Its upload queue is a real table and the local write and the queue entry are ONE transaction |
| **Replicache / Zero** (Rocicorp) | Operations-replay done properly: named mutators that run optimistically, again on every rebase, and authoritatively on the server; `lastMutationID` per client as the exactly-once mechanism |
| **ElectricSQL** | **The pivot.** It began as SQLite + Postgres + bidirectional CRDT sync and dropped all of it; writes now go through the app's own backend API |
| **Triplit** | The nearest comparator to FJS's bet — one TypeScript schema, a database on both sides, queries that sync. Property-level conflict resolution, durable local storage |
| **PouchDB / CouchDB** | The canonical revision-tree design, and conflict as a STORED state rather than an event: the document carries its conflicting revisions until something resolves them |
| **Firestore offline persistence** | The most widely deployed offline write queue there is, and what it costs to make the queue invisible and unbounded — lead, not verified here |
| **SQLite session extension** | Changesets, their inverses, and a conflict handler, already inside the engine FJS runs on both sides. Cited nowhere in this repo — lead |
| **cr-sqlite** | What a CRDT costs when it lives in the storage layer rather than the application — lead |
| **Automerge / Yjs** | The byte and complexity budget of full CRDTs — lead |
| **Linear's sync engine** | An object graph, a transaction log and a bootstrap, at production scale — lead |
| **Figma multiplayer** | How far last-writer-wins per property gets without CRDTs — lead |
| **Meteor latency compensation** | The original *run the method locally, reconcile after* — lead |
| *Local-first software*, Ink & Switch | The seven ideals, and the citation `IDEAS/offline-first-and-release.md` should have carried from the start — lead |
| **Weidner, *Designing Data Structures for Collaborative Apps*** | **How to CHOOSE merge semantics per field, which is the `@@sync` vocabulary question.** Read 2026-09-16. Four rules, of which two decide entries in that table: an operation that ADDS a unique new thing wants a set of unique things and then cannot conflict at all (which is `append`, and makes it the principled answer rather than the cheap one); and *independent operations should act on independent state*, which is the argument against a row-wide `lww` and for per-column resolution. Also the deletion anomaly — a concurrent delete beside a property update leaves a row that is neither — and a warning that generalizes past CRDTs: semantics that come from a library you do not understand inside and out are a hard fix later |
| Riffle, *a reactive relational database* · Forsyth, *In search of a local-first database* | Phase 4 — reactive local reads, and which browser database. Unread, deliberately: they answer a question no phase before 4 asks |

### What it changes

**1. Queue-first, one path.** `IDEAS/homestead.md` phase 1 briefly said the
durable queue sits BEHIND an existing retry in the client. There is no such
retry — that reading was an instrument fault, recorded in that paper — and the
field does not build it that way regardless. PowerSync's SDK intercepts every local write and places it in
a persistent FIFO queue in the same transaction as the write itself, and sending
is that queue draining; there is no second path and therefore no seam where a
write is sent twice or not at all. **The FJS version of "same transaction" is the
optimistic overlay `FJS-D138` already keeps** — the intent is recorded where the
screen reads it, or the screen and the queue can disagree.

**2. A file is a second queue, and the reference is minted by the client.**
Q5 asked what happens to a `File` in a queued write and had no options. The
field has converged: metadata syncs through the ordinary path, the bytes go to
object storage, and attachments get a queue of their OWN with its own local
table, its own retry interval and immutable UUID-named objects. FJS is already
shaped for it — a `File` column stores a reference and `FileStorage` owns the
bytes — so the queued mutation carries a reference the client minted and a
second queue carries the upload.

**3. An entry clears on an acknowledgement, not on a send.** Replicache's
`lastMutationID` is *the high water mark of mutations seen from that client*,
and exactly-once falls out of it. `verify:offline` measured why that matters
here from the other end: a call can leave on a socket that has not yet noticed
the network is gone, arrive minutes later, and the screen is never told.

**4. The gate at replay has prior art and it agrees with `FJS-D300`.**
Replicache's mutator body runs again on every rebase, and its own documentation
says a guard that held at the gesture can legitimately fail on rebase, because
the server has since told the client something it did not know. That is the
ruling this repo already made, arrived at independently.

**5. Phase 5 should be approached as a question, not a plan.** ElectricSQL
abandoned bidirectional CRDT sync after building it and now handles no write
path at all. Nothing here says FJS cannot do conflict resolution; it says the
one team that shipped the ambitious version narrowed it, and a phase that
assumes the ambitious version should carry that.

### What is NOT changed by any of it

**The write still goes through the service, the gate still lives in the seed,
and the server still re-checks.** Electric's pivot landed on exactly that
arrangement from the other direction, which is the strongest available evidence
that FJS's Data boundary is not the part to soften for offline.

## Already read, so not restated here

`live-queries.md` reads Remult (a per-connection query registry, correct and
stateful, against this project's derived client-side matcher).
The client-data-lifecycle record (since deleted) read Meteor's minimongo and latency compensation.
`slices.md` reads RedwoodJS. `testing-realm.md` reads Redwood, Wasp, SvelteKit
and Supabase. `release-transitions.md` reads nine systems for what they RECORD —
Cloud Run, Workers, Helm, Nomad, NixOS, Kamal, Argo, OTP and Vercel.
`time-and-recurrence.md` reads java.time, Noda Time and Temporal.

**The pattern in that list is that this project reads well at the level of a
mechanism and had not read anything at the level of the whole bet.** Ash is that
missing altitude, which is the argument for this file existing rather than one
more paragraph inside a feature record.

## What to actually do with it

Nothing, until a specific question is open. Then: **`tables-from-the-seed.md`
before AshAdmin and Django's admin, `slices.md` before Ash's extension protocol,
`agent-surface.md` before AshAi, `permission-sets.md` against Ash policies for
where the ladder is doing work their model cannot.** A reading with no question
in hand produces a feature list, which is how a project ends up out-featuring
nobody.

## Relationship to the other files

- `IDEAS/tables-from-the-seed.md` — the record with the most to gain
- `IDEAS/slices.md` — the design whose mechanism already exists elsewhere
- `IDEAS/permission-sets.md` — the gap Ash has from the other side
- `IDEAS/agent-surface.md` — 4.2, and its approval-gate half
- `IDEAS/coherence-review.md` — the inward-facing equivalent of this file
