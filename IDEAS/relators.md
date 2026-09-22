---
id: relators
status: proposed
dated: 2026-09-22
---

# Idea — the relationship that is a thing, and the question it has been answering in silence

**Status: IDEA. Nothing here is built.** Dated 2026-09-22. Every count and
every model named below is read off `example/db/schema.lite` and
`packages/basecamp/db/schema.lite` on that date. Do not cite this file as
describing behavior — see `VERIFYING.md`.

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
designed.** [`FJS-413`](../ISSUES.md#fjs-413) found ten unindexed foreign key
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

- **Is the word `@@relator`?**
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
- **Does the absence of the word come to mean something, and does anything
  grade it?** Once `@@relator` exists, a model with two cascading required
  relations and no declaration is either deliberate or forgotten. An
  `opportunities.js` rule could ask — confidence, never severity — but the
  literature's own `FreeRole` is the warning: a recognizer that fires on every
  unmarked pair trains people to ignore it.
- **Is `Payslip` a relator with a key over two of three relata, or a document
  that records one?** It copies `periodStart`/`periodEnd` off the run, which by
  § 2's tell argues document; its key argues class 2 with the run as the
  discriminator. Both emit identical DDL. Whichever way it resolves is the
  worked example for the distinction, and `OrderLine` and `StocktakeCount` are
  the same question.

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
- [`FJS-413`](../ISSUES.md#fjs-413) — ten unindexed foreign keys, four on
  cascading join tables, and the four hand-written reverse indexes that are this
  proposal's measurement
- `packages/litestone/docs/edge-fields.md` § *Growing up* — `@edge` is the
  same relationship before it has identity, and `eject` is the promotion
- `packages/basecamp/db/schema.lite` — `AppServer` against `AppNetwork`,
  eighteen lines apart, opposite answers
- `example/db/schema.lite` — `StockReservation`, `Subscription`, `CartLine`,
  `Payslip`
