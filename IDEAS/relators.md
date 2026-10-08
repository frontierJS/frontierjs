---
id: relators
status: shipped
dated: 2026-09-22
---

# The relationship that is a thing, and the question it has been answering in silence

**Status: BUILT 2026-09-22, ruled [`FJS-D350`](../DECISIONS.md#fjs-d350).** The
word is `@@relator`, the behavior is `packages/litestone/src/core/parser.js`
§ `expandRelator`, and `packages/litestone/test/relator.test.ts` is what holds
it. **This file is the ARGUMENT, not the reference** — the ruling is the record
and `litestone explain @@relator` is the behavior. Every count and every model
named below is read off `example/db/schema.lite` and
`packages/basecamp/db/schema.lite` on that date, and all ten are now declared.

**Three things the build corrected in this paper**, kept rather than edited away
because each was a claim made confidently before anything ran:

1. **§ 3 and § 5 put `foreign-key-without-index` in `opportunities.js`. It is in
   `advise.js`.** `opportunities.js` has twelve rules and none of them is that
   one.
2. **§ 4's emission table under-indexed `many`.** It said the reverse indexes
   for every form. But `once` and `many: col` emit a unique LEADING with the
   first relatum, which prefix-matches it; a bare `many` emits no unique, so the
   leading relatum is as unindexed as the trailing one. `many` indexes EVERY
   relatum — without which `Subscription` would have lost an index it has today,
   which is `FJS-413` re-arriving through the feature that exists to end it.
3. **The paper named the DDL emitter as the owner. It is parser normalization.**
   `@@relator` expands into ordinary `uniqueIndex` and `index` nodes at parse,
   so the emitter, the migrator and `advise` are untouched — the same move
   `@@extensible` already makes. That is § 6's *derived, not restated* answered
   structurally rather than by hand.

**And two refusals the paper did not have**, both found by declaring the word on
real schemas rather than by design:

- **An `@@index` that LEADS with a relatum is already the reverse index and is
  doing more besides**, so nothing is emitted beside it. `StockReservation`'s
  `@@index([variantId, expiresAt])` is that case. Without this rule the word
  adds a dead b-tree, which is the cost it exists to stop paying, arriving from
  the other direction.
- **A composite primary key over exactly the relata already IS the key**, so no
  unique is emitted — which is what `litestone edge eject` writes, since a side
  table keys both dimensions. The reverse index still lands, and an ejected
  model has never had one on its trailing dimension.

**Two of § 3's seven consumers are built and four were not where this paper put
them** — § 3 · *Which of these were real* has the audit, written so nobody
repeats the probing. `upsert` refuses a repeatable pair and `litestone mutate`
now kills a relator mutant (0% → 100% on basecamp); the 409 was **already
built** when this paper claimed it was missing; addressing needs a REST layer
junction does not have; the control needs a child-collection surface the kit
does not have; and the idempotency row turned out to be a decision, which is in
§ Open questions with its options written out.

It came out of the `.lite` surface audit's gap 05, which framed it as a missing
label:

> *Litestone models them perfectly well — `WorkspaceMember`, `CartGrant`,
> `AppServer` are all Relators. Nothing says so, so no tool can tell a join
> table from an entity.*

**The framing was wrong and the correction is the paper.** A label answering
*what kind of thing is this* would be the first attribute in the language whose
only job is to be read — unexecuted, therefore ungradeable, therefore wrong
forever the first time a schema moves under it. What is actually missing is
narrower and is enforceable: **can this relationship happen twice?** That
question is answered eleven times in two apps, in four different spellings,
and stated zero times.

---

## 1. The question has a name, and the name is old

| Tradition | The word | What the classification buys |
| --- | --- | --- |
| UFO / OntoUML (Guizzardi 2005) | **Relator**, linked to its relata by «mediation» | Existential dependence is an axiom, not a convention: the minimum cardinalities of a relator's mediations must sum to ≥2 |
| UFO, continued | **material relations are derived** | `is-member-of` is not primitive — it is *founded* by the relator, which is its truthmaker. Model both and you have two origins by construction |
| UFO, continued | **Role is relationally dependent** | You are a *Student* because an Enrollment exists. Roles have a source, or they are the named anti-pattern `FreeRole` |
| Sales & Guizzardi 2015, ontological anti-patterns | **`RepRel`** — repeatable relator instances · **`RelOver`** — a relator mediating overlapping types | Empirically-uncovered error shapes that are *undetectable without the stereotype*. You cannot grade a shape nothing declares |
| Object-Role Modeling (Halpin) | **objectified fact type** / nesting | Objectification requires a uniqueness constraint over the roles, and choosing it is the modeling act. Only a reified relationship can be the subject of further facts |
| Chen 1976 | **associative entity** | The shallow version — a box with two lines and no claim about identity |
| UML | **association class** | The broken version: it forbids two instances between the same pair, so `RepRel` is baked into the notation and cannot be answered |
| Silverston, *The Data Model Resource Book* | **PARTY / PARTY ROLE / PARTY RELATIONSHIP** | The relator triad in industry dress; volume 1 rests on it |
| Fowler, *Analysis Patterns* ch. 2 | **Accountability** | A relator with a type and a time range, which is where valid time attaches |

**What none of them buys is a drawing preference.** Whether `WorkspaceMember`
is a node or an edge in a diagram is defensible both ways, and an argument for
the word that leads with generated-admin output is selling its weakest half.

---

## 2. The tree, measured

Twenty-three models across `example` and `basecamp` carry two or more
relations. Seven of them fail the shape immediately — a relatum that is
optional or `SetNull` is a contradiction, since a relator with a missing
relatum is incoherent: `ProductImage`, `Payment`, `Cart`, `JournalEntry`,
`Deployment`, `Job`, `DashboardWidget`. They are reference models wearing the
silhouette.

The rest sort into four classes, and **every one of the four is live**.

**Class 1 — once. The key is the relata, exactly.** Seven models:
`WorkspaceMember` · `ServerNetwork` · `AppNetwork` · `FlagOverride` ·
`AlertRuleChannel` · `CartLine` · `StockReservation`. `StockReservation`'s own
comment states the rule in a sentence the language should own: *One hold per
basket per shelf, mirroring the line it stands for.*

**Class 2 — many, discriminated by a thing.** `AppServer` declares
`@@unique([appId, serverId, replicaIndex])`, and `replicaIndex` is the whole
answer to *what makes two of these different*. It sits eighteen lines above
`AppNetwork`, which has the identical relata shape and stops at the pair. Two
neighbors, opposite answers, and the only difference is a third entry in a
list.

**Class 3 — many, discriminated by time.** `Subscription` relates a customer
to a plan version, `Restrict` at both ends, and declares no key at all. The
same customer may hold the same plan version twice — churn, then come back —
and what separates the two is `currentPeriodStart` / `currentPeriodEnd`. This
is the literature landing on `effective-time.md`: **when a relator repeats over
time, valid time is its identity.**

**Class 4 — many, discriminated by nothing → it is an occurrent, not a
relator.** `RecipeRun` relates a recipe to a server, cascades both ends, and
carries no key because you run it a thousand times. Set it beside `AppServer`:
identical FK shape, identical cascades, and one has a key because *app on
server* is a standing fact while *recipe run on server* is something that
happened. UFO splits these formally — relators are endurants, events are
perdurants.

### The tell nobody wrote down

**Every class-4 model copies what it read, and the copy is the statement that it
is not existentially dependent.** `RecipeRun.script`: *"The script AS RUN,
copied at dispatch. The recipe is editable; an output read against a script
that has since changed is not evidence of anything."* The same move is in
`OrderLine` (sku, description, unitPrice) and `Payslip` (periodStart/periodEnd
copied off the run). Class 1 carries no copies at all — checked, none of the
seven does.

So the copied column is already the tree's discriminator, written by hand, one
model at a time, for a reason each header states separately.

### Two that pass the shape and are not relators

`ApiKey` cascades to both `workspace` and `user` and is keyed
`[workspaceId, name]` — **the key is not over the relata**, so the foreign keys
are ownership rather than mediation. `CartGrant` has one relatum in the
database and a bearer who is not a row at all. Both read as relators today and
nothing can say otherwise; the audit's gap-05 note claims `CartGrant` as one,
which is the mistake the shape invites.

`Payslip` is the subtle one and is left open below: three relata, a key over
two of them, and copies that argue it is a document recording a relationship
rather than the relationship itself. Both readings emit identical DDL, which is
precisely why the distinction has to be declared or lost.

---

## 3. What repeatability buys, mechanically

Each of these plugs into a seam that already exists.

- **Upsert stops being a caller's guess.** `db.<model>.upsert` needs a conflict
  target. A class-1 relator *has one structurally* — the relata — so adding a
  member twice is one row with no key named. A class-3 or class-4 model has no
  conflict target, so upsert there is not merely unavailable, it is **a wrong
  answer that compiles**: upserting `RecipeRun` overwrites yesterday's run with
  today's. The same fork settles `resource.save(data, { mode })` on the client.
- **Retry safety, and whether a create needs an idempotency key.** Junction
  owns `claimIdempotency(ctx, key, config)`. A class-1 create is naturally
  idempotent and needs none; a class-3 create is not, and every retry mints a
  second booking, so the key is mandatory and its absence is a defect nothing
  reports today. Caravan splits the same way: a class-1 relator has a natural
  `dispatch({ id })`, a class-3 one must be handed a key.
- **Addressing.** Class 1 means the pair *is* the address —
  `DELETE /workspaces/:w/members/:u`, toggle semantics, no read first. Anything
  repeatable needs the id, which the UI must then hold and never show.
- **The control derives.** `controlFor(rule, {field, model})` already turns
  `@values` into a `<select>` *because the column is constrained*. This is the
  same derivation one level up: **once → a multi-select or checkbox list;
  many → a rows-with-Add ledger.** Guessing wrong is not cosmetic — a picker
  over a repeatable relation deletes occurrences on save, because deselect means
  delete.
- **The error a duplicate gets.** Class 1 → a 409 with a sentence generated
  from the relata names. Class 3/4 → 409 is unreachable, so a unique violation
  from that table is a bug rather than a user mistake. Today both arrive as one
  generic constraint error.
- **`@edge` eligibility, as a refusal.** An `@edge` field lives on a side table
  with a composite primary key over its two dimensions, so **an edge is class 1
  by construction** and a repeatable relationship can never be one. Today you
  find that out when the second row will not write. It runs the other way too:
  `litestone edge eject` promotes an edge to a model and already knows the
  answer at the moment it writes the file.
- **A mutant worth killing.** `litestone mutate` mutates the schema and runs
  the app's checks against it. Drop `replicaIndex` from `AppServer`'s key and
  **no suite in this repo fails** — the app quietly loses the ability to run two
  replicas. Declared repeatability makes that a survivor that names itself.
- **A bound gets a key it cannot otherwise have.** `@minItems` / `@maxItems`
  on a relation is the owner of *how many children a parent may have*, and it
  grades at the end of the write unit because a minimum cannot be graded any
  earlier (`core/cardinality.js`, in the tree and untracked on 2026-09-22).
  What it keys on is the PARENT: `replicas AppServer[] @maxItems(8)` bounds an
  app's replicas across every server. **A relator bound is keyed on the pair** —
  at most eight replicas of this app *on this server* — which is the same ledger
  with a composite key and is a question for that owner, not a reason for a
  second spelling here.

### Which of these were real, checked 2026-09-22 against the tree

The list above was written from the design. Probing each one before building it
moved four of the eight, so the audit is recorded here rather than left for
somebody to repeat.

| § 3 claim | Where it actually is |
| --- | --- |
| Upsert | **BUILT.** The fast path needs ONE unique column, so a pair never reaches it and every relator upsert fell to find-then-update — which on `many` matches every occurrence there has ever been and overwrites the oldest. Refused now, with `many: <col>` naming the column a `where` left out. `once` and upsert-by-id untouched |
| A mutant worth killing | **BUILT, and it needed two halves.** `relator-tighten` / `relator-loosen` produced 8 mutants on basecamp and **all 8 survived**, `AppServer many: replicaIndex → once` among them. Mutants nothing can kill are 8 permanent survivors reading as uncovered ground, so `verifyConstraints` got the probe that grades them: 0% → **100% killed**. Its second case is the load-bearing one — for `many: <col>` the same pair under a DIFFERENT discriminator must be ACCEPTED, or tightening to `once` looks correct from outside |
| `@edge` eligibility | **HALF BUILT, and the other half is unbuildable.** `litestone edge eject` writes `once`. The refusal — *a `many` relationship may not be an `@edge`* — has nowhere to fire: an edge's side table is generated, not authored, so there is no file in which somebody could write the contradiction |
| The error a duplicate gets | **ALREADY BUILT, and this row was stale when it was written.** `UniqueConflictError` (`core/errors.js`) is already a 409, already names the fields so `toFieldErrors` can mark the box, and already words a composite — *this combination is already taken (workspaceId + userId)*. The claim that *today both arrive as one generic constraint error* was false at the time. What is left is a warmer relator-specific sentence, which is worth less than the paragraph arguing for it |
| Addressing | **NOT A SEAM — a feature in another package.** Junction routes `/service/method` through `transport/router.ts`; there is no REST resource layer to hang `DELETE /workspaces/:w/members/:u` on. Building one is a junction design question that `@@relator` would INFORM and does not belong to |
| The control derives | **BLOCKED ON A SURFACE THAT DOES NOT EXIST.** `controlFor` resolves a control per COLUMN, and an FK column already gets a `picker`. Picker-against-ledger is about a parent's CHILD COLLECTION, and `<Form>` renders columns only — the kit has no child-collection surface at all. Naming a `ledger` control first is *a registry with no consumer is a name nobody can call*, this repo's own phrase. The prerequisite is `IDEAS/overview.md` 1.1's remainder, not a relator task |
| Retry safety | **NOT BUILT — it is a decision, and it is in § Open questions below.** `claimIdempotency` is opt-in on an `Idempotency-Key` header and returns `null` without one, so *mandatory* cannot mean what the row assumed |
| A bound on the pair | **UNCHANGED, and still that owner's.** `core/cardinality.js` was still untracked on 2026-09-22 |

**The pattern across the four that moved is worth more than any of them.** Every
one was a claim about a seam written from the seam's NAME rather than from its
code, and in each case the name was right and the location was not — an error
already built, a surface with no consumer, a router with no resource layer, a
refusal with no file to fire in. A paper that names seams is making checkable
claims about other packages, and this one was wrong about half of them.

---

## 4. The proposal

```
@@relator([<relata…>], once)
@@relator([<relata…>], many)
@@relator([<relata…>], many: <column>)
```

**Repeatability is required and is never defaulted.** `@@relator([a, b])` alone
is a parse error that names the choice, because answering it silently is the
one thing the word exists to prevent — and is the flaw in the first draft of
this design, which had the attribute generate a `@@unique` from a bare list.
That draft would have answered class 1 by default and left classes 2 through 4
unspellable.

The tree as it would read:

```
WorkspaceMember   @@relator([workspaceId, userId], once)
ServerNetwork     @@relator([serverId, networkId], once)
AppNetwork        @@relator([appId, networkId], once)
FlagOverride      @@relator([flagId, environmentId], once)
AlertRuleChannel  @@relator([ruleId, channelId], once)
CartLine          @@relator([cartId, variantId], once)
StockReservation  @@relator([cartId, variantId], once)

AppServer         @@relator([appId, serverId], many: replicaIndex)
RecipeRun         @@relator([recipeId, serverId], many)
Subscription      @@relator([customerId, planVersionId], many)
```

### What each form emits

| form | emits |
| --- | --- |
| `once` | `UNIQUE(relata)`, **plus an index on each trailing relatum** |
| `many: col` | `UNIQUE(relata + col)`, plus the same reverse indexes |
| `many` | the reverse indexes only, no unique |

**The reverse index is what forced the shape, and it was measured before it was
designed.** [`FJS-413`](../ISSUES_ARCHIVE.md#fjs-413) found ten unindexed foreign key
columns in `basecamp`, four of them on cascading join tables, and the pattern
was always the same: a composite leading with the other side.
`ServerNetwork` now carries the fix by hand with the defect id in its comment —
*"networkId leads no index otherwise: the `@@unique` above starts with serverId,
and the FK cascades"* — and so do `AppNetwork`, `AppServer` and
`WorkspaceMember`. Four models, one workaround, one id. § IV: *the same
workaround in the same place, over and over, is a measurement of the road.*
`@@unique` cannot know that both ends are entrances. A relator, by definition,
does.

Net on `basecamp`: four `@@unique` lines and four hand-written `@@index` lines
collapse into four declarations, and `opportunities.js`'s
`foreign-key-without-index` rule — the one that found `FJS-413` and now reports
0 — stops being reachable for this shape at all.

### The refusals, which are what make it not a tag

1. **A relatum may not be optional and may not be `SetNull`.** This is the rule
   that rejects the seven reference models above.
2. **`Cascade` and `Restrict` both pass.** Cascade says the relator dies with
   the relatum; Restrict says the relatum cannot leave while the relator lives.
   Both honor the dependence and differ only on who wins. A cascade-only rule
   would refuse `Subscription` and `Payslip`, which are relators held by
   `Restrict` for the ledger's sake.
3. **At least two listed columns must be foreign key columns.**
4. **A `@@unique` over the same columns beside it is refused** — one origin, or
   the two drift.
5. **A `many` relationship may not be an `@edge`**, and `litestone edge eject`
   writes `once`.

**What no rule reaches** is someone declaring `@@relator` on a credential row.
`ApiKey` would satisfy every refusal above. That is a modeling judgment and the
parser has no access to it.

### Scope

`once` / `many` / `many: col` is the whole of it, and it is index work only, in
the owner that already emits `@@unique` and `@@arc`.

**A `max:` argument was in the first draft and is withdrawn.** `@minItems` /
`@maxItems` on a relation already owns a bound, with a ledger graded at the
outermost commit because a minimum can be graded nowhere earlier; a `max:` here
would be a second origin for one fact. What is left over is narrow and belongs
to that owner rather than to this word — a bound keyed on the relata PAIR
instead of on the parent.

Valid time on a `many` relator stays out and waits on
`effective-time.md`'s `@@effective(from:, to:)`. `Subscription` reads `many`
today and gains a window later without its declaration changing.

---

## 5. Where it would live

- **`core/parser.js` normalization and the DDL emitter** — the owner that
  already resolves `@@arc` and `@@unique` into constraints. Checked against the
  bridge index key list: no existing seam answers *is this relationship
  repeatable*.
- **`core/catalog.js`** takes the word, which lands it in the gated
  `catalog.snapshot.md` and makes `litestone explain @@relator` work for free.
- **`core/opportunities.js`** gets a rule once the word exists, and not before:
  its contract is that *every finding names the WORD it is about*, so a
  suggestion with no word to route to cannot be written.
- **`VOCABULARY.md`** takes the noun if the noun is coined.
- **`IDEAS/ontology.md`** gains the leaf — a relationship that persists and
  has its own identity is the fork its continuant branch does not draw.

---

## 6. The nine, answered before the first edit

- **Another origin?** No, and one refusal is what keeps it that way: a
  `@@unique` over the relata alongside `@@relator` is rejected rather than
  tolerated. The declaration becomes the source and the index derives from it.
- **Concept budget?** One noun — and it charges for more than itself, because it
  opens the door to the rest of the OntoUML stereotype set (`Role`, `Phase`,
  `Kind`), which the audit's gap 06 is already asking for. The boundary that
  holds is stated once and applies to all of them: **a kind-word lands in
  `.lite` only if it generates or refuses something.** A word that only tells a
  tool what a model IS does not land.
- **Whose complexity?** The problem's. Every app relates two things and has to
  decide whether it may happen twice; twenty-three models here did.
- **Predictability?** Improves, and the measurement is `AppServer` against
  `AppNetwork` — adjacent models, opposite decisions, and no reader can tell
  deliberate from forgotten. The shape copies `@@arc([col, col])`, which is its
  structural sibling.
- **Derived, not restated?** This is the axis the first draft failed. Relator-ness
  alone *is* derivable from a fingerprint — two or more required relations with
  a unique across them was tested against both apps and missed nothing — so a
  word that only asserts it is a restatement. Repeatability is not derivable,
  because class 1 and class 4 are distinguished by an absence.
- **One owner, and does it exist?** Yes, and it is the constraint emitter. The
  recognizer half has an owner too and it is `opportunities.js`.
- **Boundary explicit?** Yes: the attribute names its relata, and every refusal
  names the offending field.
- **Failure proportional?** A missed `once` is a duplicate membership; a missed
  `many` is an overwritten occurrence or a double charge. Both are refused at
  parse rather than warned about, which is the correct side of § IV's
  *ergonomics vs. strictness* given what the mistake destroys.
- **Wrong without anything saying so — what artefact?** Today, yes and
  silently: eleven answers, no statement, and `litestone mutate` cannot kill the
  `AppServer` mutant. With the word, the artefacts are the **parser refusal**
  and the gated **`ddl.snapshot.sql`**, which carries the emitted index and the
  reverse index beside it.

**Adjudication in tension** (§ IV): *familiarity vs. precision*, over the name.
`Relator` is exact and is unknown outside ontology work; *join table* half-fits
and implies the absence of identity, which is the one thing being denied. The
row leans precision where the ecosystem word half-fits.

**Tier** (§ VII): Assessment. Dated, statused, never cited as behavior. The word
itself, once ruled, is a Register entry and a row in `catalog.snapshot.md`.

---

## Open questions

**The first is answered and the rest stand.** `@@relator` was picked
([`FJS-D350`](../DECISIONS.md#fjs-d350)) on the adjudication below — kept here
because the argument is what the record cites.

- ~~**Is the word `@@relator`?**~~ **Ruled: A.**
  - **A** — `@@relator`. Exact, traceable to the literature, and a developer who
    meets it can look it up and find fifty years of argument.
  - **B** — `@@mediates`. UFO's own word for the link, plain English, and
    verb-shaped. Against it: every model attribute in the language is a noun
    (`@@gate`, `@@arc`, `@@scope`, `@@tenant`, `@@transitions`), so it would be
    the one behaving unlike its siblings.
  - **C** — `@@link`. Familiar, teaches nothing, and half-fits in the direction
    § IV warns about.
  - **Recommend A.** B is the better English and loses on predictability;
    `@@arc([col, col])` is the sibling this copies and it is a noun.
- **Can a cardinality bound key on the relata pair rather than on a parent?**
  *At most eight replicas of this app on this server* is not
  `replicas AppServer[] @maxItems(8)`, which bounds the app across every
  server. The ledger in `core/cardinality.js` already keys and would take a
  composite one; the question is whether the spelling belongs on the relation
  field, and it is that owner's rather than this word's.
  - **A** — On the relator, which already names the pair: `@@relator([appId, serverId], many: replicaIndex, max: 8)`, with the ledger keyed on the relator's own columns.
  - **B** — On the relation field, with a qualifier: `placements AppServer[] @maxItems(8, per: server)` on `App`, so `@maxItems` stays the one spelling of a bound.
  - **C** — No new spelling: where the relator has an ordinal discriminator, bound the discriminator. `replicaIndex Int @lte(7)` under the relator's unique over `[appId, serverId, replicaIndex]` already caps the pair at eight.
  - **Recommend C** — then A once a `many` relator with no ordinal discriminator needs a bound. The one live case, `AppServer` in `packages/basecamp/db/schema.lite`, has `replicaIndex`, so C costs nothing new. When A is needed it beats B: the pair is already declared once on the relator, and B restates it from one side, and which side owns it is a choice B leaves open.
- **Still open, and now live — does the absence of the word come to mean
  something, and does anything grade it?** `@@relator` exists as of
  [`FJS-D350`](../DECISIONS.md#fjs-d350) and nothing was built for this, so a model with two cascading required
  relations and no declaration is either deliberate or forgotten. An
  `opportunities.js` rule could ask — confidence, never severity — but the
  literature's own `FreeRole` is the warning: a recognizer that fires on every
  unmarked pair trains people to ignore it.
  - **A** — Absence means nothing: a model without `@@relator` is a model, and nothing grades it.
  - **B** — A narrow opportunity in `packages/litestone/src/core/opportunities.js`: it fires only where a hand-written `@@unique` over two required cascading foreign keys is the DDL `@@relator(…, once)` would emit. It names the word and carries confidence, never severity.
  - **C** — A `fli check` rule with severity on every model with two cascading required relations and no declaration.
  - **Recommend B** — It follows `FJS-D539`: fire on a narrow shape the word would generate, never on every unmarked pair, which is how it avoids the `FreeRole` failure that C walks into. Hold it as `FJS-D539` held its rule until a probe of `example/` and `packages/basecamp/` finds a true positive, because a recognizer whose first firing is hypothetical is one nobody trusts.
- ~~**Does a create on a repeatable relator have to carry an idempotency key, and what says so?**~~ **Answered 2026-09-28 (`FJS-D539`): A — an advisory rule. `opportunities.js` or `fli check` asks it: *this service creates a model declaring `@@relator(…, many)` and no idempotency config, so a retry writes a second occurrence*. Confidence, never severity. Costs nothing to anyone who ignores it.** § 3 assumed *mandatory*, and `claimIdempotency(ctx, key,
  config)` cannot mean that: it is opt-in on an `Idempotency-Key` header and
  returns `null` when none arrives, so there is no position from which to
  require one without breaking every existing caller. The question is real
  — a `once` create is naturally idempotent and a `many` create is not, so a
  retried booking mints a second one — but only the instrument is in doubt.
  - **A** — an advisory rule. `opportunities.js` or `fli check` asks it: *this
    service creates a model declaring `@@relator(…, many)` and no idempotency
    config, so a retry writes a second occurrence*. Confidence, never severity.
    Costs nothing to anyone who ignores it.
  - **B** — enforcement at the boundary. A create on a `many` relator with no
    key is refused. Correct and unshippable as stated: every existing caller
    breaks, and the framework would be demanding a header for a write the app
    may legitimately want to repeat.
  - **C** — nothing, until an app is bitten. The word makes the hazard
    nameable; a reader who knows what `many` means can reach for a key.
  - **Recommend A** — cheap, and it satisfies `opportunities.js`'s own contract
    that *every finding names the WORD it is about*, which `@@relator` now
    does. It is the good kind of recognizer rather than the `FreeRole` kind
    warned about below, because it fires on a narrow declared shape instead of
    on every unmarked pair. **Held rather than built**: nothing in this
    workspace creates a `many` relator from a retryable path, so the rule would
    ship with no true positive to point at, and a rule whose first firing is
    hypothetical is one nobody trusts when it finally fires.

- **Still open — is `Payslip` a relator with a key over two of three relata, or a
  document that records one?** It copies `periodStart`/`periodEnd` off the run, which by
  § 2's tell argues document; its key argues class 2 with the run as the
  discriminator. Both emit identical DDL. Whichever way it resolves is the
  worked example for the distinction, and `OrderLine` and `StocktakeCount` are
  the same question.
  - **A** — A relator: `@@relator([payRunId, employeeId], once)` replaces the hand-written `@@unique` in `example/db/schema.lite`, and `payWindow` is a term it references rather than a relatum.
  - **B** — A document the run owns: no `@@relator`, the `@@unique([payRunId, employeeId])` stays, and the copies and `@immutable` figures are what say it records a relationship rather than being one.
  - **C** — Make the tell a rule: a model that copies columns off a relatum is never a relator, so `Payslip`, `OrderLine` and `StocktakeCount` resolve together as documents.
  - **Recommend B** — Under `FJS-D350` a word lands only if it generates or refuses, and `once` here would generate exactly the unique already written, so A buys a label. The copied period and the frozen figures are § 2's tell, and `FJS-D162` already treats a payslip as a document. C is the same answer, made binding before a second case has tested it.

---

## See also

- `IDEAS/ontology.md` — the modeling tree this is a leaf of; its continuant
  branch has a fork for a thing, a place and a document, and none for a
  relationship that is one
- `IDEAS/effective-time.md` — class 3's discriminator. `@@effective(from:, to:)`
  is what a relator repeating over time is identified by
- `IDEAS/polymorphic-relations.md` — the neighboring refusal: a relation's
  target is an input to the access compiler
- `packages/litestone/src/core/cardinality.js` — the audit's gap 01, being
  built in the tree on 2026-09-22 and untracked. It owns a bound, which is why
  this paper carries none
- [`FJS-413`](../ISSUES_ARCHIVE.md#fjs-413) — ten unindexed foreign keys, four on
  cascading join tables, and the four hand-written reverse indexes that are this
  proposal's measurement
- `packages/litestone/docs/edge-fields.md` § *Growing up* — `@edge` is the
  same relationship before it has identity, and `eject` is the promotion
- `packages/basecamp/db/schema.lite` — `AppServer` against `AppNetwork`,
  eighteen lines apart, opposite answers
- `example/db/schema.lite` — `StockReservation`, `Subscription`, `CartLine`,
  `Payslip`
