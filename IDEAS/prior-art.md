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
  layer as the permission model** — which is `herald`'s whole claim.
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
  different answers about backup (`FJS-540`), tenancy as a file copy, and
  sandboxes (4.25). Their assumptions do not transfer.
- **Ash stops at the API and hands the UI to LiveView.** This project owns mesa
  and sierra, which is why `x-gate`, `x-transitions`, `x-values` and
  `x-label-field` reach a browser at all. The client half of the live store
  (`FJS-D145`, `client-data-lifecycle.md`) has no counterpart there.
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
automatically — `release-transitions.md` and `FJS-D145`'s neighbors are the
consumers.

## Already read, so not restated here

`live-queries.md` reads Remult (a per-connection query registry, correct and
stateful, against this project's derived client-side matcher).
`client-data-lifecycle.md` reads Meteor's minimongo and latency compensation.
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
