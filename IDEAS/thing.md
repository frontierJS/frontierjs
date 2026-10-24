---
id: thing
status: proposed
dated: 2026-10-23
---

# Idea — Thing: input held before anyone knows what model it is

**Status: PROPOSED. Nothing is built; Q1–Q3 are ruled (`FJS-D1502`–`FJS-D1504`).** Probed against
the tree 2026-10-23. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-23): one generic record that holds whatever comes in
before its model exists, and a way to turn a pile of those into a real model
once their shape settles. The name is the owner's: **Thing**. The verb is the
owner's: **graduate**.

## The shape

A Litestone reference model, `packages/litestone/references/Thing.lite`, and
two `fli` verbs. No new package.

```prisma
model Thing {
  id           String    @id @default(ulid())
  type         String?                  // what it may become: "contact", "task". Open set; null = not known yet
  data         Json      @personal      // the content
  source       Json?     @immutable @personal  // where it came from: email id, URL, call id, who captured it
  meta         Json      @default("{}") // what is learned while sorting it: classifier guess, confidence, tags, progress
  parent       Thing?    @relation("ThingTree", fields: [parentId], references: [id], onDelete: Cascade)
  children     Thing[]   @relation("ThingTree")
  graduatedTo  Json?                    // [{ model: "Contact", id: "01J…" }]
  graduatedAt  DateTime?
  @@trait(Dates)
  @@trait(Tree)                         // parentId + rank (FJS-D1502)
}
```

- **`source` versus `meta`.** `source` is written once, when the Thing arrives,
  and `@immutable` refuses a later write at the Data boundary. `meta` is what
  changes while the Thing is being sorted. A key that could change belongs in
  `meta`; a key that answers "where did this come from" belongs in `source`.
- **`type` is a guess, not a discriminator.** Nothing branches on it except
  `fli things` and `fli things:graduate`. Whether a Thing is waiting or done is
  `graduatedAt`, so there is no second status column.
- **A parent spawns children.** An email is one Thing; the three requests in it
  are three child Things. Siblings are derived: the same `parentId`.
- **A graduated Thing is kept** (`FJS-D1504`). `graduatedTo` answers "why does Contact 12
  exist", and the Thing is that answer's before-image. Salesforce does the same
  on Lead → Convert: the Lead stays, stamped with what it became
  ([CDC lead conversion](https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_standard_objects_lead_conversion.htm)).

## Where it is used

Each of these is an app in this tree or `fjs-prototypes/`, so the reference
model comes from instances, not from a sketch.

| Instance | What arrives | Children | Graduates to |
| -------- | ------------ | -------- | ------------ |
| Intake (#43) | a clip, an email | the actions in it | a Basecamp to-do, a `Task` |
| Quo/Telnyx (#23) | a call transcript | a booking, a complaint, a callback | `Booking`, `Ticket` |
| maid.tech | a client email | "move Tuesday to Wednesday", a new contact | `Visit` change, `Contact` |
| ELA support | a chat message | — | an `ISSUES.md` row, or soft-deleted |
| A legacy port | an old row, `source: {table, oldId}` | — | the ported model, leftovers stay Things |
| A new app in discovery | "jobs", "quotes" typed in by hand | — | `model Job` once its keys settle |

**Use it for input whose model is unknown when it arrives. Input with a known
model goes into that model.** A Thing that never graduates is the failure this
design exists to make visible — see `fli things` below.

## Why not the existing names

- **Capture** (GTD; Intake `PLAN.md` 2.1 planned a `Capture` model). Capture
  names the act of arriving, and a Thing outlives the act: it is sorted,
  split and graduated after it arrives. Intake 2.1 builds on Thing instead.
- **Landing zone** (dbt sources; `data-layer-v1.md` L5). L5 keeps **one landing
  table per stream**, and that ruling stands: a stream's shape is known from
  its provider, so its rows land in their own table. Thing is the case L5 does
  not cover — input with no stream and no known shape. The two do not overlap:
  a stream with a schema never lands in Thing.
- **Lead** (Salesforce). One CRM's noun for one domain.
- **Thing** has precedent as the root type of schema.org.

## `fli things` — the readiness list

Per `type` (and a row for `null`): count, oldest, and how much the keys of
`data` vary across rows. Keys stable across N rows reads as ready to graduate.
A Thing older than a threshold and not graduated is a warning. A `graduatedTo`
naming a row that no longer exists is a warning too, because nothing else
checks it — see § What stays true.

A query over columns that already exist. No new state.

## `fli things:graduate --type X`

1. Read the Things of type X.
2. Infer a draft model from their `data`. That inferrer is `data-layer-v1.md`
   **L1** (draft a `.lite` from a sample once; a person reviews it), built once
   and used here, not a second inferrer.
3. Emit the block through Oracle's `emit` (`packages/oracle/src/emit.js`).
   `emit` takes an Oracle answer, so L1's output is an answer. **`emit` does
   not spread traits yet**, so a drafted model gets no `@@trait` until that
   lands.
4. The person accepts or edits the block; `litestone migrate` adds the table.
5. Each Thing's `data` is written as a row of the new model, and the Thing is
   stamped `graduatedTo` / `graduatedAt` in the same transaction.

## Hazards

- **Invariant 6 — one gate for every type.** Gates, `@encrypted` and
  `@personal` are per column, so a Social Security number inside `data` gets
  no field of its own to carry `@encrypted`. The reference declares `data` and
  `source` `@personal` whole (`FJS-D1503`); an instance that holds less
  loosens it. Graduation is when a field gets its own classification.
- **Typed JSON is per model, not per row.** `@type(Address)` types one column
  for every row; there is no `oneOf` keyed on `type`. None is built here:
  graduation is the typing step.
- **Not EAV.** A JSON column is the alternative Karwin recommends to
  entity-attribute-value, and Litestone already pushes a JSON path down, so a
  filter on `data.city` works today.
- **Invariant 9 holds inside `data`** only as far as the patch is a whole-column
  write. A partial update of one key in `data` is the app's code, not a patch.

## What stays true

| Must hold | Enforced by |
| --------- | ----------- |
| `source` is never rewritten | `@immutable`, refused at the Data boundary |
| A graduated Thing's row exists | **nothing** — `fli things` reports a dangling `graduatedTo`; recorded as unenforced |
| A Thing is never left unsorted forever | `fli things`' age warning; nothing refuses |

## Open questions

- ~~**Q1 — The `Tree` trait or a hand-written `parentId`.**~~ **Answered 2026-10-24 (`FJS-D1502`): A — `@@trait(Tree)`; every Thing carries `parentId` and the trait's required `rank`.**
  - **A** — `@@trait(Tree)`; every Thing carries `parentId` and the trait's
    required `rank`.
  - **B** — a hand-written `parentId`, no rank.
  - **Recommend A** — one tree shape in the house, and an email's children
    have an order; a root Thing's rank costs one column. Confidence 2.
- ~~**Q2 — How `data` and `source` are classified.**~~ **Answered 2026-10-24 (`FJS-D1503`): A — `@personal` on both in the reference, so the trail logs `[personal]`.**
  - **A** — `@personal` on both in the reference, so the trail logs
    `[personal]`.
  - **B** — the table gated owner-only, the fields unclassified.
  - **C** — both.
  - **Recommend A** — an instance that holds less loosens it; one that holds
    more is covered by default, and staff can still sort Things. Confidence 2.
- ~~**Q3 — Retention after graduating.**~~ **Answered 2026-10-24 (`FJS-D1504`): A — keep a graduated Thing forever.**
  - **A** — keep a graduated Thing forever.
  - **B** — a job deletes graduated Things after N days, as Rails Action
    Mailbox does with `incinerate_after`
    ([Incineratable](https://api.rubyonrails.org/classes/ActionMailbox/InboundEmail/Incineratable.html)).
  - **Recommend A** — the Thing is the before-image of what it became, and the
    trail already ages out on its own policy. Confidence 3.

## Phase 0 — Specimens and rulings

Goal: the reference is drawn from rows that exist.
Done when: Q1–Q3 are ruled and two instances' real input is in hand.

- [ ] 0.1 Collect twenty Intake clips and twenty Quo transcripts as Things on
  paper: `type`, `data`, `source`, `meta` for each
- [x] 0.2 Rule Q1–Q3 — `FJS-D1502`–`FJS-D1504`, each as recommended
- [ ] 0.3 `VOCABULARY.md` rows: **Thing** and **Graduate** (Data realm)

## Phase 1 — The reference model

Goal: an app can declare a Thing.
Done when: Intake's `db/schema.lite` declares it, and a write to `source` after
create is refused.

- [ ] 1.1 `packages/litestone/references/Thing.lite`, documented the way
  `Tree.lite` is: its instances, and what is left out and why
- [ ] 1.2 Intake 2.1 builds on Thing instead of `Capture`

## Phase 2 — `fli things`

Goal: a type ready to graduate is visible, and a stale one is loud.
Done when: run against Intake's dev database it lists each type with count,
oldest and key variance, and flags a dangling `graduatedTo`.

- [ ] 2.1 The readiness list
- [ ] 2.2 Age and dangling-pointer warnings

## Phase 3 — `fli things:graduate`

Goal: a type becomes a model without hand-writing it.
Done when: one Intake type graduates end to end, and every graduated Thing's
`graduatedTo` names a row that exists.

Blocked on `data-layer-v1.md` L1 and on `emit` spreading traits.

- [ ] 3.1 L1's inferrer returns an Oracle answer from rows
- [ ] 3.2 Emit, review, migrate
- [ ] 3.3 Rows moved and stamped in one transaction

## Phase 4 — The agent's pointer

- [ ] 4.1 One paragraph in the `discovery` skill: a model not known yet is a
  Thing with a `type` guess, and `fli things` says when to graduate it

## See also

- `data-layer-v1.md` — L1 (the inferrer), L5 (landing tables per stream)
- `packages/litestone/references/Tree.lite` — the tree shape Thing takes (`FJS-D1502`)
- `../fjs-prototypes/intake/PLAN.md` — the first instance
- Fowler, [Schemaless Data Structures](https://martinfowler.com/articles/schemaless/) —
  a schemaless start is for the exploratory stage, and the implicit schema exists
  anyway
